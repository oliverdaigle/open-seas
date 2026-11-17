// Open Seas: boot, the frame loop, and the small amount of state everything else shares.
// Data layer (js/data/*) and rendering layer (js/render/*) only meet here.
import { CONFIG } from './config.js';
import { getJSON, setSource } from './data/sources.js';
import { AIS, SRC, stopped } from './data/ais.js';
import { Weather } from './data/weather.js';
import { buildFleet, REC, PORT, SEA } from './fleet.js';
import { angle, gcPoint, destination, distNm, NM_PER_RAD } from './geo.js';
import { Globe } from './render/globe.js';
import { ShipLayer } from './render/ships.js';
import { WeatherFX } from './render/weatherfx.js';
import { Timeline } from './ui/timeline.js';
import { renderShipPanel, updateShipPanel, renderPortPanel, bindPanel } from './ui/panel.js';
import { initChrome } from './ui/chrome.js';
import { $ } from './ui/util.js';

const DAY = 864e5, HOUR = 36e5, MIN = 6e4;
const HISTORY = 7 * DAY;             // how far back the timeline reaches: the collector keeps a week of tracks
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const app = (window.openSeas = {
  time: { t: Date.now(), rate: 1, playing: true, live: true, min: Date.now() - HISTORY, max: Date.now() },
  sel: { ship: null, port: null, follow: false },
  opts: { trails: true, heat: false },
  filter: { line: '' },
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

  let done = 0; const step = () => status('Loading the planet…', (++done / 7) * 60);
  const load = (f) => getJSON(`${CONFIG.DATA_BASE}${f}.json`, 30000).then((d) => { step(); return d; });
  const [ships, ports, lines] = await Promise.all([load('ships'), load('ports'), load('lines'), globe.loadTextures(step)]);
  status('Listening for ships…', 70);
  app.lines = lines;
  const fleet = (app.fleet = buildFleet(ships, ports));
  app.weather = new Weather(); app.ais = new AIS(fleet);
  await Promise.all([app.weather.start(), Promise.race([app.ais.start(), new Promise((r) => setTimeout(r, 8000))])]);
  status('Plotting the fleet…', 90);

  const n = fleet.ships.length;
  app.buf = new Float32Array(n * REC); app.modes = new Uint8Array(n); app.seen = new Float64Array(n);
  app.ships = new ShipLayer(globe, fleet, lines, $('#labels'));
  app.fx = new WeatherFX(globe, app.weather);
  app.timeline = new Timeline(app);
  app.weather.onChange(() => app.timeline.draw());
  bindPanel(app); initChrome(app); bindGlobe();
  window.addEventListener('hashchange', route);

  status('Ready', 100); ready = true;
  $('#intro').classList.add('gone'); setTimeout(() => $('#intro').remove(), 1900);
  if (!route()) {
    const view = { lat: 38, lon: -35, dist: 2.9 };
    if (reduced) Object.assign(globe.c, view), Object.assign(globe.t, view);
    else globe.flyTo(view, 4200).then(() => { if (!globe.dragging && !app.sel.ship) globe.idleSpin = true; });
  }
}

// ---- time: the last week up to this minute ----
const nearNow = () => Math.abs(app.time.t - Date.now()) < 5 * MIN;
app.setTime = (t) => { app.time.t = Math.max(app.time.min, Math.min(app.time.max, t)); app.time.live = false; app.dirty = true; };
app.pause = () => { app.time.playing = false; app.time.live = false; };
app.play = () => { if (nearNow()) return app.goNow(); app.time.playing = true; app.time.live = false; };
app.togglePlay = () => (app.time.playing ? app.pause() : app.play());
app.setRate = (r) => { app.time.rate = r; app.time.live = r === 1 && app.time.playing && nearNow(); };
app.goNow = () => { Object.assign(app.time, { t: Date.now(), rate: 1, playing: true, live: true }); app.dirty = true; };

// ---- state of one ship at the selected time, from AIS only ----
app.shipState = (ship, out = {}) => {
  const p = app.ais.positionAt(ship.id, app.time.t);
  if (!p) { out.status = 0; out.src = SRC.NONE; out.seen = 0; out.port = -1; return out; }
  Object.assign(out, p); out.status = stopped(p) ? PORT : SEA; out.port = app.ais.portIndex(ship.id, p);
  return out;
};

// ---- selection ----
app.flyToShip = (ship) => { const s = app.shipState(ship); if (s.status) app.globe.flyTo({ lat: s.lat, lon: s.lon, dist: Math.max(0.12, Math.min(0.55, app.globe.t.dist)) }, 1700); };
app.selectShip = (id, o = {}) => {
  const ship = app.fleet.byId.get(id); if (!ship) return false;
  app.setFollow(false); app.sel.ship = ship; app.sel.port = null; app.ships.selected = ship.index; app.trackKey = '';
  if (!o.quiet) renderShipPanel(app, ship);
  if (o.fly) { if (app.shipState(ship).status) app.flyToShip(ship); else toast(`${ship.name} hasn’t been heard on AIS yet, so it isn’t on the globe.`); }
  return true;
};
app.selectPort = (code, o = {}) => {
  const p = app.fleet.ports[code]; if (!p) return;
  app.setFollow(false); app.sel.ship = null; app.sel.port = code; app.ships.selected = -1; app.ships.showTrack(null);
  renderPortPanel(app, code);
  if (o.fly) app.globe.flyTo({ lat: p.lat, lon: p.lon, dist: Math.min(0.35, app.globe.t.dist) }, 1700);
};
app.clearSelection = () => { app.setFollow(false); app.sel.ship = null; app.sel.port = null; app.ships.selected = -1; app.ships.showTrack(null); $('#panel').hidden = true; };
app.setFollow = (on) => {
  app.sel.follow = on && !!app.sel.ship;
  app.globe.follow = app.sel.follow ? () => { const s = app.shipState(app.sel.ship, followState); return s.status ? [s.lat, s.lon] : null; } : null;
  if (app.sel.follow) app.globe.t.dist = Math.min(app.globe.t.dist, 0.3);
};
const followState = {};
// Redraw the selected ship's track and destination leg when time or data moves on.
function refreshTrack() {
  const ship = app.sel.ship; if (!ship) return;
  const t = app.time.t, s = app.shipState(ship), v = app.ais.voyages.get(ship.id), seen = app.ais.lastSeen(ship.id);
  const key = `${ship.id}:${Math.floor(t / (10 * MIN))}:${seen}:${v?.at || 0}`; if (key === app.trackKey) return; app.trackKey = key;
  const track = app.ais.trackUntil(ship.id, t); if (s.status) track.push([s.lat, s.lon]);
  const showDest = v?.port && v.port.lat !== undefined && Math.abs(t - Date.now()) < 6 * HOUR;
  app.ships.showTrack(track, s.status ? [s.lat, s.lon] : null, showDest ? v.port : null);
}

// ---- line filter ----
app.applyFilter = () => {
  const { line } = app.filter; if (!line) { app.ships.highlight = null; return; }
  app.ships.highlight = new Set(app.fleet.ships.filter((s) => s.line === line).map((s) => s.index));
};

// ---- ships heading into a storm's forecast cone in the next five days ----
// Each ship is projected along the great circle to the destination it broadcasts, at its reported speed,
// stopping there; with no destination, along its current course for two days.
function findAlerts() {
  app.alerts.clear(); const storms = app.fx.storms; app.ships.alerts = app.alerts; if (!storms.length) return;
  const o = {};
  for (const ship of app.fleet.ships) {
    const s = app.shipState(ship, o); if (!s.status || s.src === SRC.LAST) continue;
    const v = app.ais.voyages.get(ship.id), dest = v?.port?.lat !== undefined ? v.port : null, sp = Math.max(s.sog, s.status === SEA ? 8 : 0);
    const total = dest ? distNm(s.lat, s.lon, dest.lat, dest.lon) : 0;
    const at = (h) => {
      if (dest && total > 1) return gcPoint([s.lat, s.lon], [dest.lat, dest.lon], Math.min(1, (sp * h) / total));
      return h > 48 ? null : destination(s.lat, s.lon, s.cog ?? s.hdg, sp * h);
    };
    for (const st of storms) {
      const track = [{ h: 0, lat: st.lat, lon: st.lon }, ...st.forecast]; let hit = false;
      for (const pt of track) { const p = at(pt.h); if (p && angle(p[0], p[1], pt.lat, pt.lon) * NM_PER_RAD < Weather.coneRadiusNm(pt.h)) { hit = true; break; } }
      if (hit) { app.alerts.add(ship.index); app.alertStorm = st.name; }
    }
  }
}

// ---- deep links: #ship-queen-mary-2 or #ship-queen-mary-2-at-202611171200 ----
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
let acc = { panel: 0, stats: 9, alerts: 9 };
function tick(dt) {
  const T = app.time, { globe } = app, now = Date.now();
  T.max = now; T.min = now - HISTORY;
  if (T.live) T.t = now;
  else if (T.playing) { T.t += dt * 1000 * T.rate; if (T.t >= T.max) app.goNow(); }
  T.t = Math.max(T.min, Math.min(T.max, T.t));
  const trailMs = Math.max(1.5, Math.min(30, globe.c.dist * 14)) * HOUR;
  app.ais.apply(app.buf, app.modes, app.seen, T.t, trailMs);
  globe.setTime(T.t); globe.update(dt);
  app.fx.update(T.t, dt, T.playing && T.rate > 60);
  app.ships.update(app.buf, app.modes, { trails: app.opts.trails, heat: app.opts.heat, storms: app.fx.storms, portLabel: app.sel.port });
  globe.render();
  app.timeline.update();

  const fast = app.dirty; app.dirty = false;
  if ((acc.panel += dt) > 0.3 || fast) {
    acc.panel = 0;
    if (app.sel.ship) { refreshTrack(); updateShipPanel(app); }
    else if (app.sel.port && fast) renderPortPanel(app, app.sel.port);
  }
  if ((acc.stats += dt) > 1 || fast) { acc.stats = 0; app.refreshStats(); }
  if ((acc.alerts += dt) > 1.5 || fast) { acc.alerts = 0; findAlerts(); }
}

boot().catch((e) => { console.error(e); status(`Could not start: ${e.message}. If you opened index.html directly, run it from a local server instead (see README).`); setSource('ais', 'error', e.message); });
