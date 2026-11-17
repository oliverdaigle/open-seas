// Everything around the globe: search, layers, fleets, data sources, tour, sound.
import { $, $$, esc, fmtDateY, fmtTime, num, shortPort, ago } from './util.js';
import { getSources, getSource, onSourceChange, MODES } from '../data/sources.js';
import { RAMPS, rampCss } from '../render/weatherfx.js';
import { SRC } from '../data/ais.js';
import { PORT, SEA } from '../fleet.js';

const pop = () => $('#pop');
const heard = (app, ship) => { const t = app.ais.lastSeen(ship.id); return !t ? 'not heard yet' : Date.now() - t < 45 * 6e4 ? 'live' : ago(t); };
let open = null;

const head = (title, sub = '') => `<div class="pop-head"><div><h2>${esc(title)}</h2>${sub ? `<p class="note" style="margin:-4px 0 12px">${sub}</p>` : ''}</div><button type="button" class="x" data-close aria-label="Close">×</button></div>`;

const views = {
  // ---- layers ----
  layers(app) {
    const L = app.fx.layers, row = (id, label, sub, on, ramp) => `<label class="toggle"><input type="checkbox" id="layer-${id}" data-layer="${id}" ${on ? 'checked' : ''}><span>${label}<small>${sub}</small></span>${ramp ? `<span class="ramp"><i style="background:${rampCss(ramp)}"></i><span><b>${RAMPS[ramp].min}</b><b>${RAMPS[ramp].max} ${RAMPS[ramp].unit}</b></span></span>` : ''}</label>`;
    const live = app.weather.covers(app.time.t);
    pop().innerHTML = head('Layers', `${live ? '<span class="badge live">Live</span> Weather from Open-Meteo for the selected time.' : '<span class="badge demo">Modelled</span> The weather feed did not answer, so these layers are modelled until it does.'}`)
      + row('wind', 'Wind', 'Animated particles, brighter where it blows harder', L.wind)
      + row('clouds', 'Clouds', 'Satellite mosaic for past days, modelled otherwise', L.clouds)
      + row('precip', 'Precipitation', 'Radar near now, forecast grid elsewhere', L.precip, 'precip')
      + row('sst', 'Sea-surface temperature', 'Ocean only', L.sst, 'sst')
      + row('waves', 'Wave height', 'Significant wave height, ocean only', L.waves, 'waves')
      + row('storms', 'Tropical storms', 'Forecast cone, and a flag on ships heading into it', L.storms)
      + row('trails', 'Ship wakes', 'A fading trail behind every ship underway', app.opts.trails)
      + row('heat', 'Port congestion', 'Ports glow by the number of ships alongside', app.opts.heat);
    pop().onchange = (e) => {
      const id = e.target.dataset.layer; if (!id) return;
      if (id === 'trails' || id === 'heat') app.opts[id] = e.target.checked; else { L[id] = e.target.checked; app.fx.dirty = true; }
    };
  },
  // ---- data sources ----
  sources() {
    pop().innerHTML = head('Data sources', 'Where every layer comes from and how fresh it is. Nothing on this globe is simulated.')
      + getSources().map((s) => `<div class="src"><b>${esc(s.label)}</b><span class="badge ${s.mode}">${MODES[s.mode]}</span><p>${esc(s.provides)}${s.detail ? `. ${esc(s.detail)}` : ''}</p><time>${s.updated ? `Updated ${esc(fmtDateY(s.updated))} ${fmtTime(s.updated)} UTC (${esc(ago(s.updated))})` : 'Not updated yet'}</time></div>`).join('')
      + `<p class="note">Ship specifications are hand-entered from public figures. Weather marked Modelled is a fallback used only when a feed doesn’t answer.</p>`;
    pop().onchange = null;
  },
  // ---- search and filters ----
  search(app) {
    pop().innerHTML = head('Search')
      + `<label class="field"><span>Ship, cruise line or port</span><input type="search" id="search-q" placeholder="Try “Queen”, “Viking” or “Miami”" autocomplete="off"></label>
      <label class="field"><span>Show only line</span><select id="search-line"><option value="">All lines</option>${Object.entries(app.lines).map(([id, l]) => `<option value="${id}" ${app.filter.line === id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
      <ul class="list" id="search-out"></ul>`;
    const out = $('#search-out'), q = $('#search-q');
    const run = () => {
      const s = q.value.trim().toLowerCase(), rows = [];
      if (s.length >= 2) {
        for (const ship of app.fleet.ships) if (ship.name.toLowerCase().includes(s) || app.lines[ship.line].name.toLowerCase().includes(s)) rows.push(`<li><button type="button" data-ship="${ship.id}"><span class="t"><span class="dot" style="background:${app.lines[ship.line].color}"></span>${esc(ship.name)}</span><span class="v">${esc(heard(app, ship))}</span><span class="s">${esc(app.lines[ship.line].name)} · ${ship.year} · ${num(ship.gt)} GT</span></button></li>`);
        for (const [code, p] of Object.entries(app.fleet.ports)) if (p.name.toLowerCase().includes(s) || p.country.toLowerCase().includes(s)) rows.push(`<li><button type="button" data-port="${code}"><span class="t">${esc(p.name)}</span><span class="v">Port</span><span class="s">${esc(p.country)}</span></button></li>`);
      }
      out.innerHTML = rows.slice(0, 30).join('') || (s.length >= 2 ? '<li class="note">Nothing matches.</li>' : '');
    };
    q.addEventListener('input', run); q.focus({ preventScroll: true });
    pop().onchange = (e) => { if (e.target.id === 'search-line') { app.filter.line = e.target.value; app.applyFilter(); } };
  },
  // ---- fleets ----
  fleet(app) {
    const id = app.fleetLine || app.sel.ship?.line || 'royal-caribbean', ships = app.fleet.ships.filter((s) => s.line === id).sort((a, b) => b.year - a.year), yr = new Date().getFullYear();
    const maxGt = Math.max(...ships.map((s) => s.gt)), byClass = new Map(); for (const s of ships) { if (!byClass.has(s.class)) byClass.set(s.class, []); byClass.get(s.class).push(s); }
    pop().innerHTML = head('Fleets', 'The ships this site tracks, grouped into sister-ship classes, with when AIS last heard each one.')
      + `<label class="field"><span>Cruise line</span><select id="fleet-line">${Object.entries(app.lines).map(([k, l]) => `<option value="${k}" ${k === id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
      <dl class="spec" style="margin-bottom:12px"><div><dt>Ships</dt><dd>${ships.length}</dd></div><div><dt>Average age</dt><dd>${(ships.reduce((a, s) => a + yr - s.year, 0) / ships.length).toFixed(1)} yr</dd></div><div><dt>Guest berths</dt><dd>${num(ships.reduce((a, s) => a + s.pax, 0))}</dd></div></dl>`
      + [...byClass].map(([cls, list]) => `<h3 style="margin-top:12px">${esc(cls)} class · ${list.length}</h3><ul class="list" style="margin-top:0">${list.map((s) => `<li><button type="button" data-ship="${s.id}"><span class="t">${esc(s.name)}</span><span class="v">${esc(heard(app, s))}</span><span class="s agebar"><i style="width:${(s.gt / maxGt * 100).toFixed(0)}%"></i><em>${Math.round(s.gt / 1000)}k</em></span></button></li>`).join('')}</ul>`).join('')
      + `<p class="note">Bars show gross tonnage relative to the largest ship in the fleet. AIS is picked up near coasts, so a ship far offshore can go unheard for days.</p>`;
    pop().onchange = (e) => { if (e.target.id === 'fleet-line') { app.fleetLine = e.target.value; views.fleet(app); } };
  },
};

export function initChrome(app) {
  const show = (name) => {
    open = open === name ? null : name;
    $$('#tools button[data-pop]').forEach((b) => b.classList.toggle('on', b.dataset.pop === open));
    if (!open) { pop().hidden = true; return; }
    views[open](app); pop().hidden = false; pop().scrollTop = 0;
  };
  app.openPop = (name) => { if (open !== name) show(name); };
  $$('#tools button[data-pop]').forEach((b) => b.addEventListener('click', () => show(b.dataset.pop)));
  pop().addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.close !== undefined) show(open);
    else if (t.dataset.ship) app.selectShip(t.dataset.ship, { fly: true });
    else if (t.dataset.port) app.selectPort(t.dataset.port, { fly: true });
  });
  onSourceChange(() => { if (open === 'sources') views.sources(app); refreshBadge(); });
  const refreshBadge = () => {
    const a = getSource('ais'), b = $('#mode-badge');
    b.textContent = a.mode === 'live' ? 'Live AIS' : a.mode === 'error' ? 'AIS offline' : 'Connecting';
    b.className = `badge ${a.mode === 'live' ? 'live' : a.mode === 'error' ? 'error' : ''}`;
    b.title = `${a.detail || a.provides} Open Data sources for details.`;
  };
  refreshBadge();
  $('#mode-badge').addEventListener('click', () => app.openPop('sources'));
  $('#zoom-in').addEventListener('click', () => app.globe.zoomBy(0.6)); $('#zoom-out').addEventListener('click', () => app.globe.zoomBy(1.6));

  // ---- "right now at sea" ----
  app.refreshStats = () => {
    let live = 0, shown = 0, sea = 0, port = 0; const counts = new Map(), o = {};
    for (const ship of app.fleet.ships) {
      const s = app.shipState(ship, o); if (!s.status) continue;
      shown++; if (s.src === SRC.LIVE || s.src === SRC.ESTIMATED) live++;
      if (s.src === SRC.LAST) continue;
      if (s.status === SEA) sea++; else { port++; if (s.port >= 0) { const c = app.fleet.portCodes[s.port]; counts.set(c, (counts.get(c) || 0) + 1); } }
    }
    const busy = [...counts].sort((a, b) => b[1] - a[1])[0], missing = app.fleet.ships.length - shown;
    $('#stats').innerHTML = `<span title="Heard on AIS in the last 45 minutes"><b>${live}</b> live</span><span><b>${sea}</b> underway</span><span><b>${port}</b> stopped</span>`
      + `<span title="Ships AIS has not heard in the last 30 days are not drawn"><b>${missing}</b> not heard yet</span>${busy && busy[1] > 1 ? `<span>Busiest port <b>${esc(shortPort(app.fleet.ports[busy[0]].name))}</b> · ${busy[1]}</span>` : ''}`;
  };

  // ---- cinematic tour ----
  let touring = 0;
  const say = (text) => { const c = $('#caption'); c.hidden = !text; c.textContent = text || ''; };
  const wait = (ms, id) => new Promise((r) => setTimeout(() => r(id === touring), ms));
  app.stopTour = () => { if (touring) { touring = 0; say(''); $('#btn-tour').classList.remove('on'); } };
  app.tour = async () => {
    if (touring) return app.stopTour();
    const id = (touring = Math.random()); $('#btn-tour').classList.add('on'); app.clearSelection(); if (open) show(open);
    const o = {}, heardShips = app.fleet.ships.filter((s) => { const st = app.shipState(s, o); return st.status && st.src !== SRC.LAST; });
    const pick = heardShips.slice().sort((a, b) => (app.ais.voyages.has(b.id) - app.ais.voyages.has(a.id)) || b.gt - a.gt)[0];
    const storm = app.weather.stormsAt(app.time.t)[0];
    const steps = [
      async () => { app.goNow(); say(`Every marker is a cruise ship where AIS last heard it. ${heardShips.length} of the ${app.fleet.ships.length} tracked ships have been heard in the last six hours.`); await app.globe.flyTo({ lat: 38, lon: -35, dist: 2.9 }, 2600); return wait(4200, id); },
      pick && (async () => { app.selectShip(pick.id, { fly: true, quiet: true }); const v = app.ais.voyages.get(pick.id); say(`${pick.name}. Amber is the track it has actually sailed${v ? `; dashed is the way to ${v.port && !v.port.unresolved ? shortPort(v.port.name) : `“${v.dest}”`}, the destination it is broadcasting` : ''}.`); return wait(7000, id); }),
      storm && (async () => { app.clearSelection(); app.fx.layers.storms = true; say(`${storm.name}. The cone is projected from its current motion. Ships heading into it are flagged.`); await app.globe.flyTo({ lat: storm.lat + 3, lon: storm.lon, dist: 0.55 }, 2600); return wait(5200, id); }),
      async () => { app.clearSelection(); app.pause(); app.setTime(Date.now() - 24 * 36e5); app.setRate(3600); app.play(); say('Replaying the last 24 hours of real AIS reports at one hour per second.'); await app.globe.flyTo({ lat: 45, lon: -10, dist: 1.6 }, 2600); return wait(9000, id); },
      async () => { app.goNow(); say('Back to now. Click any ship for where it is going, where it has been and the weather around it.'); await app.globe.flyTo({ lat: 38, lon: -35, dist: 2.2 }, 2600); return wait(3500, id); },
    ].filter(Boolean);
    for (const step of steps) { if (id !== touring || !(await step())) break; }
    if (id === touring) app.stopTour();
  };
  $('#btn-tour').addEventListener('click', () => app.tour());
  app.globe.on('input', () => app.stopTour());

  // ---- ambient ocean (synthesised, no audio file) ----
  let audio = null;
  $('#btn-sound').addEventListener('click', () => {
    const btn = $('#btn-sound');
    if (audio) { audio.gain.gain.linearRampToValueAtTime(0, audio.ctx.currentTime + 0.6); const a = audio; audio = null; setTimeout(() => a.ctx.close(), 800); btn.setAttribute('aria-pressed', 'false'); return; }
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)(), buf = ctx.createBuffer(1, ctx.sampleRate * 6, ctx.sampleRate), d = buf.getChannelData(0); let last = 0;
      for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.2; }      // brown noise
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520;
      const gain = ctx.createGain(); gain.gain.value = 0; const swell = ctx.createGain(); swell.gain.value = 0.6;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.11; const depth = ctx.createGain(); depth.gain.value = 0.35; lfo.connect(depth); depth.connect(swell.gain); lfo.start();
      src.connect(lp); lp.connect(swell); swell.connect(gain); gain.connect(ctx.destination); src.start();
      gain.gain.linearRampToValueAtTime(0.5, ctx.currentTime + 1.5);
      audio = { ctx, gain }; btn.setAttribute('aria-pressed', 'true');
    } catch { app.toast('This browser would not start audio.'); }
  });
}
