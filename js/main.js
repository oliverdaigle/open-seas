// Open Seas: boot, the frame loop, and the small amount of state everything else shares.
// Data layer (js/data/*) and rendering layer (js/render/*) only meet here.
import { loadItineraries } from './data/itinerary.js';
import { Pricing } from './data/pricing.js';
import { DemoAISAdapter, LiveAISAdapter, SRC } from './data/ais.js';
import { Weather } from './data/weather.js';
import { setSource } from './data/sources.js';
import { buildFleet, stateAt, REC, SEA } from './sim.js';
import { angle, NM_PER_RAD } from './geo.js';
import { Globe } from './render/globe.js';
import { ShipLayer } from './render/ships.js';
import { WeatherFX } from './render/weatherfx.js';
import { Timeline } from './ui/timeline.js';
import { renderShipPanel, updateShipPanel, renderPortPanel, bindPanel } from './ui/panel.js';
import { initChrome } from './ui/chrome.js';
import { $ } from './ui/util.js';

const DAY = 864e5, HOUR = 36e5;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const app = (window.openSeas = {
  time: { t: Date.now(), rate: 1, playing: true, live: true, min: 0, max: 0 },
  sel: { ship: null, port: null, follow: false },
  opts: { trails: true, heat: false },
  filter: { line: '', region: '' }, finder: { from: Date.now(), to: Date.now() + 120 * DAY, max: 1500, nights: '', region: '', hits: [] },
  alerts: new Set(), alertStorm: '',
});

function toast(msg, ms = 5000) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), ms); }
app.toast = toast;
const status = (msg, pct) => { $('#intro-status').textContent = msg; if (pct !== undefined) $('#intro-bar').style.width = `${pct}%`; };

async function boot() {
  let globe;
  try { globe = app.globe = new Globe($('#gl')); } catch (e) { status('This browser could not start WebGL, which the globe needs.'); throw e; }
  globe.t.dist = globe.c.dist; globe.idleSpin = false;
  let last = performance.now(), ready = false;
  const frame = (now) => { const dt = Math.min(0.1, (now - last) / 1000); last = now; if (ready) tick(dt); else { globe.setTime(Date.now()); globe.update(dt); globe.render(); } requestAnimationFrame(frame); };
  requestAnimationFrame(frame);

  let done = 0; const step = () => status('Loading the planet…', (++done / 5) * 70);
  const [data] = await Promise.all([loadItineraries().then((d) => { step(); return d; }), globe.loadTextures(step)]);
  status('Plotting the fleet…', 82);
  app.data = data; app.lines = data.lines;
  const fleet = (app.fleet = buildFleet(data));
  app.pricing = new Pricing(data.lines); app.weather = new Weather();
  await Promise.all([app.pricing.load(), app.weather.start()]);

  const now = Date.now(), from = Date.parse(data.meta.from), to = Date.parse(data.meta.to);
  app.time.min = Math.max(from + 2 * DAY, now - 30 * DAY); app.time.max = Math.min(to - 14 * DAY, now + 365 * DAY);
  if (app.time.max - now < 200 * DAY) toast(`The demo itineraries end ${new Date(to).toISOString().slice(0, 10)}. After that only ships seen by AIS move.`, 9000);
  if (now > app.time.max || now < app.time.min) { app.time.t = Math.min(app.time.max, Math.max(app.time.min, now)); app.time.live = false; app.time.playing = false; }

  app.demoAis = new DemoAISAdapter(data, fleet); app.liveAis = new LiveAISAdapter(fleet);
  app.modes = new Uint8Array(fleet.ships.length); app.seen = new Float64Array(fleet.ships.length);
  // Wait briefly for collected AIS positions, so a shared ship link opens on the ship's real position.
  await Promise.race([app.liveAis.start(), new Promise((r) => setTimeout(r, 4000))]);
  app.ships = new ShipLayer(globe, fleet, data.lines, $('#labels'));
  app.fx = new WeatherFX(globe, app.weather);
  app.timeline = new Timeline(app);
  app.weather.onChange(() => app.timeline.draw());
  bindPanel(app); initChrome(app); bindGlobe();
  window.addEventListener('hashchange', route);

  status('Ready', 100); ready = true;
  $('#intro').classList.add('gone'); setTimeout(() => $('#intro').remove(), 1900);
  if (!route()) {
    if (reduced) Object.assign(globe.c, { lat: 22, lon: -66, dist: 2.9 }), Object.assign(globe.t, { lat: 22, lon: -66, dist: 2.9 });
    else globe.flyTo({ lat: 22, lon: -66, dist: 2.9 }, 4200).then(() => { if (!globe.dragging && !app.sel.ship) globe.idleSpin = true; });
  }
}

// ---- time ----
const nearNow = () => Math.abs(app.time.t - Date.now()) < 5 * 6e4;
app.setTime = (t) => { app.time.t = Math.max(app.time.min, Math.min(app.time.max, t)); app.time.live = false; app.dirty = true; };
app.pause = () => { app.time.playing = false; app.time.live = false; };
app.play = () => { app.time.playing = true; app.time.live = app.time.rate === 1 && nearNow(); };
app.togglePlay = () => (app.time.playing ? app.pause() : app.play());
app.setRate = (r) => { app.time.rate = r; app.time.live = r === 1 && app.time.playing && nearNow(); };
app.goNow = () => { Object.assign(app.time, { t: Date.now(), rate: 1, playing: true, live: true }); app.dirty = true; };

// ---- state of one ship at the selected time ----
app.shipState = (ship, out = {}) => {
  const t = app.time.t, live = app.liveAis?.positionAt(ship.id, t);
  stateAt(app.fleet, ship, t, out); out.src = SRC.DEMO; out.seen = 0;
  if (live) Object.assign(out, { lat: live.lat, lon: live.lon, hdg: live.hdg, sog: live.sog, status: live.sog > 0.5 ? SEA : 1, src: live.src, seen: live.seen });
  return out;
};

// ---- selection ----
app.flyToShip = (ship) => { const s = app.shipState(ship); if (s.status) app.globe.flyTo({ lat: s.lat, lon: s.lon, dist: Math.max(0.12, Math.min(0.55, app.globe.t.dist)) }, 1700); };
app.selectShip = (id, o = {}) => {
  const ship = app.fleet.byId.get(id); if (!ship) return false;
  app.setFollow(false); app.sel.ship = ship; app.sel.port = null; app.ships.selected = ship.index; app.shownVoy = undefined;
  if (!o.quiet) renderShipPanel(app, ship);
  if (o.fly) app.flyToShip(ship);
  return true;
};
app.selectPort = (code, o = {}) => {
  const p = app.fleet.ports[code]; if (!p) return;
  app.setFollow(false); app.sel.ship = null; app.sel.port = code; app.ships.selected = -1; app.ships.showVoyage(null);
  renderPortPanel(app, code);
  if (o.fly) app.globe.flyTo({ lat: p.lat, lon: p.lon, dist: Math.min(0.35, app.globe.t.dist) }, 1700);
};
app.clearSelection = () => { app.setFollow(false); app.sel.ship = null; app.sel.port = null; app.ships.selected = -1; app.ships.showVoyage(null); $('#panel').hidden = true; };
app.setFollow = (on) => {
  app.sel.follow = on && !!app.sel.ship;
  app.globe.follow = app.sel.follow ? () => { const s = app.shipState(app.sel.ship, followState); return s.status ? [s.lat, s.lon] : null; } : null;
  if (app.sel.follow) app.globe.t.dist = Math.min(app.globe.t.dist, 0.3);
};
const followState = {};

// ---- highlight: cruise finder results win over the line / region filter ----
app.setHighlight = (set, voyages) => { app.finderSet = set; app.ships.showVoyages(voyages || []); app.applyFilter(); };
app.applyFilter = () => {
  if (app.finderSet) { app.ships.highlight = app.finderSet; return; }
  const { line, region } = app.filter; if (!line && !region) { app.ships.highlight = null; return; }
  const set = new Set(), o = {};
  for (const ship of app.fleet.ships) {
    if (line && ship.line !== line) continue;
    if (region) { const s = app.shipState(ship, o); if (s.voy < 0 || ship.voyages[s.voy].region !== region) continue; }
    set.add(ship.index);
  }
  app.ships.highlight = set;
};

// ---- ships whose next five days cross a storm's forecast cone ----
function findAlerts() {
  app.alerts.clear(); const storms = app.fx.storms; if (!storms.length) { app.ships.alerts = app.alerts; return; }
  const t = app.time.t, o = {};
  for (const ship of app.fleet.ships) for (const st of storms) {
    const track = [{ h: 0, lat: st.lat, lon: st.lon }, ...st.forecast]; let hit = false;
    for (let i = 0; i < track.length && !hit; i++) {
      stateAt(app.fleet, ship, t + track[i].h * HOUR, o);
      if (o.status === SEA && angle(o.lat, o.lon, track[i].lat, track[i].lon) * NM_PER_RAD < Weather.coneRadiusNm(track[i].h)) hit = true;
    }
    if (hit) { app.alerts.add(ship.index); app.alertStorm = st.name; }
  }
  app.ships.alerts = app.alerts;
}

// ---- deep links: #ship-icon-of-the-seas or #ship-icon-of-the-seas-at-202707041200 ----
function route() {
  const m = /^#ship-(.+?)(?:-at-(\d{12}))?$/.exec(location.hash); if (!m || !app.fleet.byId.has(m[1])) return false;
  if (m[2]) { const s = m[2]; app.pause(); app.setTime(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12))); }
  app.selectShip(m[1]); const s = app.shipState(app.sel.ship);
  if (s.status) app.globe.flyTo({ lat: s.lat, lon: s.lon, dist: 0.45 }, reduced ? 1 : 3600);
  return true;
}
app.share = async () => {
  const d = new Date(app.time.t), p = (n) => String(n).padStart(2, '0');
  const hash = `ship-${app.sel.ship.id}${app.time.live ? '' : `-at-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`}`;
  history.replaceState(null, '', `#${hash}`);
  let framed = false; try { framed = window.top !== window; } catch { framed = true; }
  if (framed) return toast('The page address now points at this ship and moment. Use the page’s own share link to send it.');
  try { await navigator.clipboard.writeText(location.href); toast('Link copied. It opens this ship at this moment.'); }
  catch { toast(`Copy this address: ${location.href}`, 9000); }
};

function bindGlobe() {
  const { globe, ships } = app;
  globe.on('hover', (x, y) => { const k = ships.pickShip(x, y, 16); ships.hover = k; $('#gl').classList.toggle('point', k >= 0 || !!ships.pickPort(x, y, 10)); });
  globe.on('click', (x, y, type) => {
    const r = type === 'touch' ? 30 : 18, k = ships.pickShip(x, y, r);
    if (k >= 0) return app.selectShip(app.fleet.ships[k].id);
    const port = ships.pickPort(x, y, r - 4); if (port) return app.selectPort(port);
    if (app.sel.ship || app.sel.port) app.clearSelection();
  });
}

// ---- the frame ----
let acc = { panel: 0, stats: 9, alerts: 9, filter: 0 };
function tick(dt) {
  const T = app.time, { globe } = app;
  if (T.live) T.t = Date.now();
  else if (T.playing) { T.t += dt * 1000 * T.rate; if (T.t >= T.max) { T.t = T.max; T.playing = false; } }
  const trailMs = Math.max(1.5, Math.min(30, globe.c.dist * 14)) * HOUR;
  app.demoAis.request(T.t, trailMs);
  const buf = app.demoAis.buf;
  app.liveAis.apply(buf, app.modes, app.seen, T.t);
  globe.setTime(T.t); globe.update(dt);
  app.fx.update(T.t, dt, T.playing && T.rate > 60);
  app.ships.update(buf, app.modes, { trails: app.opts.trails, heat: app.opts.heat, storms: app.fx.storms, portLabel: app.sel.port });
  globe.render();
  app.timeline.update();

  const fast = app.dirty; app.dirty = false;
  if ((acc.panel += dt) > 0.3 || fast) {
    acc.panel = 0;
    if (app.sel.ship) {
      const s = app.shipState(app.sel.ship);
      if (s.voy !== app.shownVoy) { app.shownVoy = s.voy; app.ships.showVoyage(app.sel.ship, s.voy >= 0 ? app.sel.ship.voyages[s.voy] : null); }
      updateShipPanel(app);
    } else if (app.sel.port && fast) renderPortPanel(app, app.sel.port);
  }
  if ((acc.stats += dt) > 1 || fast) { acc.stats = 0; app.refreshStats(); }
  if ((acc.alerts += dt) > 1.5 || fast) { acc.alerts = 0; findAlerts(); }
  if ((acc.filter += dt) > 2 && app.filter.region && !app.finderSet) { acc.filter = 0; app.applyFilter(); }
}

boot().catch((e) => { console.error(e); status(`Could not start: ${e.message}. If you opened index.html directly, run it from a local server instead (see README).`); setSource('itineraries', 'error', e.message); });
