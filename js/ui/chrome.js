// Everything around the globe: search, cruise finder, layers, fleets, data sources, tour, sound.
import { $, $$, esc, fmtDateY, fmtTime, num, shortPort, ago } from './util.js';
import { getSources, onSourceChange, MODES } from '../data/sources.js';
import { money } from '../data/pricing.js';
import { RAMPS, rampCss } from '../render/weatherfx.js';
import { PORT, SEA } from '../sim.js';

const pop = () => $('#pop');
let open = null;

const head = (title, sub = '') => `<div class="pop-head"><div><h2>${esc(title)}</h2>${sub ? `<p class="note" style="margin:-4px 0 12px">${sub}</p>` : ''}</div><button type="button" class="x" data-close aria-label="Close">×</button></div>`;

const views = {
  // ---- layers ----
  layers(app) {
    const L = app.fx.layers, row = (id, label, sub, on, ramp) => `<label class="toggle"><input type="checkbox" id="layer-${id}" data-layer="${id}" ${on ? 'checked' : ''}><span>${label}<small>${sub}</small></span>${ramp ? `<span class="ramp"><i style="background:${rampCss(ramp)}"></i><span><b>${RAMPS[ramp].min}</b><b>${RAMPS[ramp].max} ${RAMPS[ramp].unit}</b></span></span>` : ''}</label>`;
    const live = app.weather.covers(app.time.t);
    pop().innerHTML = head('Layers', `${live ? '<span class="badge live">Live</span> Weather from Open-Meteo for the selected time.' : '<span class="badge demo">Climatology</span> The selected time is outside the forecast window, or the feed is offline, so weather is modelled.'}`)
      + row('wind', 'Wind', 'Animated particles, brighter where it blows harder', L.wind)
      + row('clouds', 'Clouds', 'Satellite mosaic for past days, modelled otherwise', L.clouds)
      + row('precip', 'Precipitation', 'Radar near now, forecast grid elsewhere', L.precip, 'precip')
      + row('sst', 'Sea-surface temperature', 'Ocean only', L.sst, 'sst')
      + row('waves', 'Wave height', 'Significant wave height, ocean only', L.waves, 'waves')
      + row('storms', 'Tropical storms', 'Forecast cone, and a flag on ships whose route crosses it', L.storms)
      + row('trails', 'Ship wakes', 'A fading trail behind every ship underway', app.opts.trails)
      + row('heat', 'Port congestion', 'Ports glow by the number of ships alongside', app.opts.heat);
    pop().onchange = (e) => {
      const id = e.target.dataset.layer; if (!id) return;
      if (id === 'trails' || id === 'heat') app.opts[id] = e.target.checked; else { L[id] = e.target.checked; app.fx.dirty = true; }
    };
  },
  // ---- data sources ----
  sources() {
    pop().innerHTML = head('Data sources', 'Each source switches to live on its own, and falls back to demo on its own.')
      + getSources().map((s) => `<div class="src"><b>${esc(s.label)}</b><span class="badge ${s.mode}">${MODES[s.mode]}</span><p>${esc(s.provides)}${s.detail ? `. ${esc(s.detail)}` : ''}</p><time>${s.updated ? `Updated ${esc(fmtDateY(s.updated))} ${fmtTime(s.updated)} UTC (${esc(ago(s.updated))})` : 'Not updated yet'}</time></div>`).join('')
      + `<p class="note">Ship specifications are hand-entered from public figures. Check them before relying on them.</p>`;
    pop().onchange = null;
  },
  // ---- search and filters ----
  search(app) {
    const regions = [...new Set(Object.values(app.fleet.templates).map((t) => t.region))].sort();
    pop().innerHTML = head('Search')
      + `<label class="field"><span>Ship, cruise line or port</span><input type="search" id="search-q" placeholder="Try “Icon”, “Viking” or “Cozumel”" autocomplete="off"></label>
      <div class="row2">
        <label class="field"><span>Show only line</span><select id="search-line"><option value="">All lines</option>${Object.entries(app.lines).map(([id, l]) => `<option value="${id}" ${app.filter.line === id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Sailing in</span><select id="search-region"><option value="">Any region</option>${regions.map((r) => `<option ${app.filter.region === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
      </div><ul class="list" id="search-out"></ul>`;
    const out = $('#search-out'), q = $('#search-q');
    const run = () => {
      const s = q.value.trim().toLowerCase(), rows = [];
      if (s.length >= 2) {
        for (const ship of app.fleet.ships) if (ship.name.toLowerCase().includes(s) || app.lines[ship.line].name.toLowerCase().includes(s)) rows.push(`<li><button type="button" data-ship="${ship.id}"><span class="t"><span class="dot" style="background:${app.lines[ship.line].color}"></span>${esc(ship.name)}</span><span class="v">Ship</span><span class="s">${esc(app.lines[ship.line].name)} · ${ship.year} · ${num(ship.gt)} GT</span></button></li>`);
        for (const [code, p] of Object.entries(app.fleet.ports)) if (p.name.toLowerCase().includes(s) || p.country.toLowerCase().includes(s)) rows.push(`<li><button type="button" data-port="${code}"><span class="t">${esc(p.name)}</span><span class="v">Port</span><span class="s">${esc(p.country)}</span></button></li>`);
      }
      out.innerHTML = rows.slice(0, 30).join('') || (s.length >= 2 ? '<li class="note">Nothing matches.</li>' : '');
    };
    q.addEventListener('input', run); q.focus({ preventScroll: true });
    pop().onchange = (e) => { if (e.target.id === 'search-line') app.filter.line = e.target.value; if (e.target.id === 'search-region') app.filter.region = e.target.value; app.applyFilter(); };
  },
  // ---- find me a cruise ----
  finder(app) {
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10), f = app.finder, now = Date.now();
    const regions = [...new Set(Object.values(app.fleet.templates).map((t) => t.region))].sort();
    pop().innerHTML = head('Find me a cruise', 'Pick dates and a budget. Matching sailings light up on the globe.')
      + `<div class="row2"><label class="field"><span>Sail after</span><input type="date" id="find-from" value="${iso(f.from)}" min="${iso(now)}" max="${iso(app.time.max)}"></label>
        <label class="field"><span>Sail before</span><input type="date" id="find-to" value="${iso(f.to)}" min="${iso(now)}" max="${iso(app.time.max)}"></label></div>
      <div class="row2"><label class="field"><span>Budget per person</span><input type="number" id="find-max" value="${f.max}" min="100" step="50" inputmode="numeric"></label>
        <label class="field"><span>Nights</span><select id="find-nights">${[['', 'Any'], ['2-5', '2 to 5'], ['6-8', '6 to 8'], ['9-14', '9 to 14'], ['15-40', '15 or more']].map(([v, l]) => `<option value="${v}" ${f.nights === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
      <label class="field"><span>Region</span><select id="find-region"><option value="">Anywhere</option>${regions.map((r) => `<option ${f.region === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
      <div class="p-actions"><button type="button" class="btn primary" id="find-go">Show matches</button><button type="button" class="btn" id="find-clear">Clear</button></div>
      <p class="note" id="find-note"></p><ul class="list" id="find-out"></ul>`;
    const run = () => {
      f.from = Date.parse($('#find-from').value) || now; f.to = (Date.parse($('#find-to').value) || now) + 864e5; f.max = +$('#find-max').value || 1e9; f.nights = $('#find-nights').value; f.region = $('#find-region').value;
      const [n0, n1] = f.nights ? f.nights.split('-').map(Number) : [0, 99], hits = [];
      for (const ship of app.fleet.ships) for (const v of ship.voyages) {
        if (v.dep < Math.max(f.from, now) || v.dep > f.to || v.nights < n0 || v.nights > n1 || (f.region && v.region !== f.region)) continue;
        const p = app.pricing.priceFor(v, ship.line); if ((p.state !== 'demo' && p.state !== 'live') || p.pricePerPerson > f.max) continue;
        hits.push({ ship, v, p });
      }
      hits.sort((a, b) => a.p.pricePerPerson - b.p.pricePerPerson);
      const anyDemo = hits.some((h) => h.p.state === 'demo');
      $('#find-note').innerHTML = hits.length ? `${num(hits.length)} sailings on ${new Set(hits.map((h) => h.ship.id)).size} ships, cheapest first. ${anyDemo ? '<span class="badge demo">Demo prices</span> ' : ''}Each price is in its own currency.` : 'No sailings match. Try a wider date range or a higher budget.';
      $('#find-out').innerHTML = hits.slice(0, 40).map((h, i) => `<li><button type="button" data-hit="${i}"><span class="t"><span class="dot" style="background:${app.lines[h.ship.line].color}"></span>${esc(h.ship.name)}</span><span class="v">${esc(money(h.p.pricePerPerson, h.p.currency))}</span><span class="s">${esc(h.v.name)} · ${esc(fmtDateY(h.v.dep))} · from ${esc(shortPort(app.fleet.ports[h.ship.stops[h.v.i0].port].name))}</span></button></li>`).join('');
      f.hits = hits; app.setHighlight(hits.length ? new Set(hits.map((h) => h.ship.index)) : null, hits.slice(0, 40).map((h) => [h.ship, h.v]));
    };
    $('#find-go').addEventListener('click', run);
    $('#find-clear').addEventListener('click', () => { f.hits = []; $('#find-out').innerHTML = ''; $('#find-note').textContent = ''; app.setHighlight(null, []); });
    pop().onchange = null;
    if (f.hits && f.hits.length) run();
  },
  // ---- fleets ----
  fleet(app) {
    const id = app.fleetLine || app.sel.ship?.line || 'royal-caribbean', ships = app.fleet.ships.filter((s) => s.line === id).sort((a, b) => b.year - a.year), yr = new Date().getFullYear();
    const maxGt = Math.max(...ships.map((s) => s.gt)), byClass = new Map(); for (const s of ships) { if (!byClass.has(s.class)) byClass.set(s.class, []); byClass.get(s.class).push(s); }
    pop().innerHTML = head('Fleets', 'Ships in this demo dataset, grouped into sister-ship classes.')
      + `<label class="field"><span>Cruise line</span><select id="fleet-line">${Object.entries(app.lines).map(([k, l]) => `<option value="${k}" ${k === id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
      <dl class="spec" style="margin-bottom:12px"><div><dt>Ships</dt><dd>${ships.length}</dd></div><div><dt>Average age</dt><dd>${(ships.reduce((a, s) => a + yr - s.year, 0) / ships.length).toFixed(1)} yr</dd></div><div><dt>Guest berths</dt><dd>${num(ships.reduce((a, s) => a + s.pax, 0))}</dd></div></dl>`
      + [...byClass].map(([cls, list]) => `<h3 style="margin-top:12px">${esc(cls)} class · ${list.length}</h3><ul class="list" style="margin-top:0">${list.map((s) => `<li><button type="button" data-ship="${s.id}"><span class="t">${esc(s.name)}</span><span class="v">${s.year}</span><span class="s agebar"><i style="width:${(s.gt / maxGt * 100).toFixed(0)}%"></i><em>${Math.round(s.gt / 1000)}k</em></span></button></li>`).join('')}</ul>`).join('')
      + `<p class="note">Bars show gross tonnage relative to the largest ship in the fleet.</p>`;
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
    else if (t.dataset.hit !== undefined) { const h = app.finder.hits[+t.dataset.hit]; app.pause(); app.setTime(h.v.dep + 2 * 36e5); app.selectShip(h.ship.id, { fly: true }); }
  });
  onSourceChange(() => { if (open === 'sources') views.sources(app); refreshBadge(); });
  const refreshBadge = () => {
    const s = getSources(), live = s.filter((x) => x.mode === 'live').map((x) => x.id), core = ['ais', 'itineraries', 'prices'].filter((id) => !live.includes(id));
    const b = $('#mode-badge'); b.textContent = core.length === 3 ? 'Demo data' : core.length ? 'Part demo' : 'Live'; b.className = `badge ${core.length ? 'demo' : 'live'}`;
    b.title = core.length ? `Simulated: ${core.map((id) => s.find((x) => x.id === id).label.toLowerCase()).join(', ')}. Open Data sources for details.` : 'All core sources are live.';
  };
  refreshBadge();
  $('#mode-badge').addEventListener('click', () => app.openPop('sources'));
  $('#zoom-in').addEventListener('click', () => app.globe.zoomBy(0.6)); $('#zoom-out').addEventListener('click', () => app.globe.zoomBy(1.6));

  // ---- "right now at sea" ----
  app.refreshStats = () => {
    let sea = 0, port = 0, pax = 0; const counts = new Map();
    for (const ship of app.fleet.ships) {
      const s = app.shipState(ship); if (!s.status) continue;
      pax += ship.pax; if (s.status === SEA) sea++; else { port++; const c = ship.stops[s.stop]?.port; if (c) counts.set(c, (counts.get(c) || 0) + 1); }
    }
    const busy = [...counts].sort((a, b) => b[1] - a[1])[0];
    $('#stats').innerHTML = `<span title="Sum of double-occupancy capacity of ships on a voyage at the selected time"><b>${num(pax)}</b> guest berths afloat</span><span><b>${sea}</b> underway</span><span><b>${port}</b> in port</span>${busy ? `<span>Busiest port <b>${esc(shortPort(app.fleet.ports[busy[0]].name))}</b> · ${busy[1]}</span>` : ''}`;
  };

  // ---- cinematic tour ----
  let touring = 0;
  const say = (text) => { const c = $('#caption'); c.hidden = !text; c.textContent = text || ''; };
  const wait = (ms, id) => new Promise((r) => setTimeout(() => r(id === touring), ms));
  app.stopTour = () => { if (touring) { touring = 0; say(''); $('#btn-tour').classList.remove('on'); } };
  app.tour = async () => {
    if (touring) return app.stopTour();
    const id = (touring = Math.random()); $('#btn-tour').classList.add('on'); app.clearSelection(); if (open) show(open);
    const t0 = Date.now(), july = Date.UTC(new Date(t0).getUTCFullYear() + (new Date(t0).getUTCMonth() > 5 ? 1 : 0), 6, 10, 20);
    const biggest = app.fleet.ships.slice().sort((a, b) => b.gt - a.gt).find((s) => app.shipState(s).status === SEA) || app.fleet.ships[0];
    const storm = app.weather.stormsAt(app.time.t)[0];
    const steps = [
      async () => { app.goNow(); say(`Every marker is a cruise ship: ${app.fleet.ships.length} of them, positioned for this exact minute.`); await app.globe.flyTo({ lat: 24, lon: -62, dist: 2.9 }, 2600); return wait(3200, id); },
      async () => { app.selectShip(biggest.id, { fly: true, quiet: true }); say(`${biggest.name}, ${num(biggest.gt)} gross tons. The wake shows where it has just been.`); return wait(6500, id); },
      storm && (async () => { app.clearSelection(); app.fx.layers.storms = true; say(`${storm.name}${storm.simulated ? ' (simulated for the demo)' : ''}. The cone is the forecast track. Ships whose route crosses it are flagged.`); await app.globe.flyTo({ lat: storm.lat + 3, lon: storm.lon, dist: 0.55 }, 2600); return wait(5200, id); }),
      async () => { app.clearSelection(); app.pause(); app.setTime(july); say('Scrub forward to July. The fleet has crossed the Atlantic for the Mediterranean season.'); await app.globe.flyTo({ lat: 40, lon: 14, dist: 0.7 }, 3000); return wait(4500, id); },
      async () => { say('The same July evening in Alaska: Glacier Bay, Juneau and the Inside Passage.'); await app.globe.flyTo({ lat: 57.5, lon: -137, dist: 0.42 }, 3200); return wait(4500, id); },
      async () => { app.setRate(3600); app.play(); say('At one hour per second, a week of sailing takes under three minutes.'); await app.globe.flyTo({ lat: 30, lon: -150, dist: 2.9 }, 2600); return wait(6000, id); },
      async () => { app.goNow(); say('Back to now. Click any ship to open its voyage, weather and fares.'); await app.globe.flyTo({ lat: 22, lon: -70, dist: 1.5 }, 2600); return wait(3500, id); },
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
