// The detail panel: one ship (specs, voyage, weather, fares, booking) or one port (who is alongside).
import { $, $$, esc, fmtDate, fmtDateY, fmtTime, fmtShort, num, shortPort, ago } from './util.js';
import { fmtLat, fmtLon, compass, densify } from '../geo.js';
import { money } from '../data/pricing.js';
import { SRC, SRC_LABEL } from '../data/ais.js';
import { PORT, SEA } from '../sim.js';

const el = () => $('#panel');
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'the cruise line'; } };

// Side-profile drawing generated from the ship's size, in its line's colour.
function silhouette(ship, color) {
  const L = 60 + Math.min(240, (ship.length - 180) * 1.25), x0 = (320 - L) / 2, x1 = x0 + L, decks = ship.gt > 200000 ? 6 : ship.gt > 140000 ? 5 : ship.gt > 90000 ? 4 : ship.gt > 50000 ? 3 : 2;
  const dh = 5.2, top = 62 - decks * dh; let s = '';
  for (let d = 0; d < decks; d++) {
    const inset = 10 + d * (L * 0.022), y = 62 - (d + 1) * dh, a = x0 + inset + (d === decks - 1 ? L * 0.1 : 0), b = x1 - inset * 1.7 - L * 0.06;
    s += `<rect x="${a.toFixed(1)}" y="${y.toFixed(1)}" width="${(b - a).toFixed(1)}" height="${dh - 0.9}" rx="1" fill="#eef3f8"/>`;
    s += `<line x1="${(a + 4).toFixed(1)}" x2="${(b - 4).toFixed(1)}" y1="${(y + 2.3).toFixed(1)}" y2="${(y + 2.3).toFixed(1)}" stroke="#0b1826" stroke-width="1.1" stroke-dasharray="1.6 2.2" opacity="0.55"/>`;
  }
  const fx = x0 + L * 0.3;
  return `<svg class="sil" viewBox="0 0 320 84" role="img" aria-label="Side profile of ${esc(ship.name)}">
    <path d="M${fx} ${top} l3 -11 h${L * 0.07} l2 11 z" fill="${color}"/>
    <rect x="${x0 + L * 0.62}" y="${top - 5}" width="${L * 0.09}" height="5" rx="1" fill="#eef3f8"/>
    ${s}
    <path d="M${x0} 62 H${x1 + 2} L${x1 - L * 0.07} 76 H${x0 + 5} Z" fill="${color}"/>
    <path d="M${x0 + 3} 71.5 H${x1 - L * 0.045} L${x1 - L * 0.07} 76 H${x0 + 5} Z" fill="#0b1826" opacity="0.45"/>
    <line x1="${x0 - 14}" x2="${x1 + 18}" y1="77" y2="77" stroke="#5fd4e6" stroke-width="1" opacity="0.5" stroke-dasharray="14 5 4 5"/>
  </svg>`;
}

function fareCard(app, ship, v, isThis) {
  const p = app.pricing.priceFor(v, ship.line), url = app.pricing.bookingUrl(ship, v), ports = app.fleet.ports;
  const a = ship.stops[v.i0].port, b = ship.stops[v.i1].port, route = a === b ? `${shortPort(ports[a].name)} round trip` : `${shortPort(ports[a].name)} to ${shortPort(ports[b].name)}`;
  let price;
  if (p.state === 'live' || p.state === 'demo') price = `<b>${esc(money(p.pricePerPerson, p.currency))}</b><small>per person · ${esc(p.cabin)}</small>`;
  else price = `<b style="font-size:12px;color:var(--muted)">Price unavailable</b>`;
  const foot = p.state === 'demo' ? `<span class="badge demo">Demo price</span><small>Sample figure, not a real fare</small>`
    : p.state === 'live' ? `<span class="badge live">Scraped</span><small>${esc(p.occupancy)} occupancy${p.taxesIncluded ? '' : ', excl. taxes'} · as of ${esc(fmtDateY(Date.parse(p.asOf)))} ${esc(fmtTime(Date.parse(p.asOf)))} UTC</small>`
    : `<small>${esc(p.reason || 'No price on file for this sailing')}</small>`;
  const meta = p.state === 'demo' ? `${p.occupancy} occupancy, excl. taxes · as of ${fmtShort(Date.parse(p.asOf))}` : '';
  return `<div class="sail${isThis ? ' this' : ''}">
    <div class="n">${esc(v.name)}</div>
    <div class="price">${price}</div>
    <div class="m">${esc(fmtDateY(v.dep, ports[a].tz))} · ${v.nights} nights · ${esc(route)}${meta ? `<br>${esc(meta)}` : ''}</div>
    <div class="foot"><span>${foot}</span></div>
    <div class="foot"><button type="button" class="btn" data-goto="${v.dep}">View on globe</button>
      <a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener">Book on ${esc(host(url))}</a></div>
  </div>`;
}

export function renderShipPanel(app, ship) {
  const line = app.lines[ship.line], t = app.time.t, s = app.shipState(ship), ports = app.fleet.ports;
  const v = s.voy >= 0 ? ship.voyages[s.voy] : null, real = Date.now();
  const sisters = app.fleet.ships.filter((o) => o.line === ship.line && o.class === ship.class && o.id !== ship.id);
  const upcoming = ship.voyages.filter((o) => o.dep > Math.max(t, real) && o !== v).slice(0, 4);
  const thisBookable = v && v.dep > real;
  let voyage = `<p class="note">No sailing on file for this ship at the selected time.</p>`;
  if (v) {
    const rows = [];
    for (let i = v.i0; i <= v.i1; i++) {
      const st = ship.stops[i], p = ports[st.port], first = i === v.i0, last = i === v.i1;
      const when = first ? st.dep : st.arr, hrs = first ? `dep ${fmtTime(st.dep, p.tz)}` : last ? `arr ${fmtTime(st.arr, p.tz)}` : `${fmtTime(st.arr, p.tz)}–${fmtTime(st.dep, p.tz)}`;
      rows.push(`<li data-stop="${i}"><span class="d">${esc(fmtDate(when, p.tz))}</span><span>${esc(p.name)}</span><span class="h">${hrs}</span></li>`);
    }
    voyage = `<p class="voy-name">${esc(v.name)}</p>
      <p class="voy-dates">${esc(fmtDateY(v.dep, ports[ship.stops[v.i0].port].tz))} to ${esc(fmtDateY(v.arr, ports[ship.stops[v.i1].port].tz))} · ${v.nights} nights · port times are local</p>
      <div class="bar" aria-hidden="true"><i data-f="progress"></i></div>
      <canvas class="minimap" width="724" height="362" aria-label="Map of this itinerary"></canvas>
      <ul class="calls">${rows.join('')}</ul>`;
  }
  el().innerHTML = `
    <div class="p-head">
      <button type="button" class="x" data-close aria-label="Close">×</button>
      <p class="p-line"><span class="dot" style="background:${line.color}"></span>${esc(line.name)}</p>
      <h2 class="p-name">${esc(ship.name)}</h2>
      <div class="p-badges" data-f="badges"></div>
    </div>
    <div class="p-sec">
      ${silhouette(ship, line.color)}
      <div class="p-actions">
        <button type="button" class="btn" data-follow aria-pressed="${app.sel.follow}">Follow this ship</button>
        <button type="button" class="btn" data-share>Copy link</button>
      </div>
    </div>
    <div class="p-sec">
      <div data-f="alert"></div>
      <dl class="readout">
        <div><dt>Speed</dt><dd data-f="sog">–</dd></div>
        <div><dt>Heading</dt><dd data-f="hdg">–</dd></div>
        <div><dt>Position</dt><dd data-f="pos" style="font-size:13px">–</dd></div>
        <div><dt data-f="nextlbl">Next port</dt><dd data-f="next" style="font-size:13px">–</dd></div>
      </dl>
    </div>
    <div class="p-sec"><h3>Voyage at the selected time ${app.data.realShips.has(ship.id) ? '' : '<span class="badge demo" title="A typical itinerary for this ship, not the line’s published schedule">Demo itinerary</span>'}</h3>${voyage}</div>
    <div class="p-sec"><h3>Weather at the ship</h3>
      <dl class="readout" data-f="wx"><div><dt>Wind</dt><dd>…</dd></div><div><dt>Waves</dt><dd>…</dd></div><div><dt>Sea</dt><dd>…</dd></div><div><dt>Air</dt><dd>…</dd></div></dl>
      <p class="note" data-f="wxsrc"></p>
    </div>
    <div class="p-sec"><h3>Fares and booking</h3>
      ${thisBookable ? fareCard(app, ship, v, true) : ''}
      ${upcoming.map((o) => fareCard(app, ship, o, false)).join('') || (thisBookable ? '' : '<p class="note">No future sailings on file.</p>')}
      <p class="note">Booking links open the cruise line’s own site. Always confirm the fare there.</p>
    </div>
    <div class="p-sec"><h3>Ship</h3>
      <dl class="spec">
        <div><dt>Built</dt><dd>${ship.year}</dd></div><div><dt>Tonnage</dt><dd>${num(ship.gt)} GT</dd></div><div><dt>Guests</dt><dd>${num(ship.pax)}</dd></div>
        <div><dt>Length</dt><dd>${ship.length} m</dd></div><div><dt>Flag</dt><dd>${esc(ship.flag)}</dd></div><div><dt>IMO</dt><dd>${ship.imo || 'not on file'}</dd></div>
        <div><dt>Class</dt><dd>${esc(ship.class)}</dd></div>
      </dl>
      ${sisters.length ? `<h3 style="margin-top:14px">Sister ships</h3><div class="chips">${sisters.map((o) => `<button type="button" data-ship="${o.id}">${esc(o.name)}</button>`).join('')}</div>` : ''}
    </div>`;
  el().hidden = false; el().scrollTop = 0;
  el()._ship = ship; el()._voy = v; el()._wxT = -1e18; el()._port = null;
  updateShipPanel(app, true);
}

function drawMinimap(app, ship, v, s) {
  const cv = $('.minimap', el()); if (!cv) return;
  const c = cv.getContext('2d'), W = cv.width, H = cv.height, ports = app.fleet.ports;
  // unwrap longitudes so a Pacific crossing draws as one continuous line
  const pts = []; let prev = null;
  for (let i = v.i0; i < v.i1; i++) { const g = ship.stops[i].geom; if (!g) continue; for (const p of densify(g.pts, 2)) { let lon = p[1]; if (prev !== null) while (lon - prev > 180) lon -= 360; if (prev !== null) while (lon - prev < -180) lon += 360; prev = lon; pts.push([p[0], lon]); } }
  if (!pts.length) return;
  let la0 = 90, la1 = -90, lo0 = 1e9, lo1 = -1e9; for (const [la, lo] of pts) { la0 = Math.min(la0, la); la1 = Math.max(la1, la); lo0 = Math.min(lo0, lo); lo1 = Math.max(lo1, lo); }
  let spanLa = Math.max(5, (la1 - la0) * 1.35), spanLo = Math.max(10, (lo1 - lo0) * 1.3); if (spanLo < spanLa * 2) spanLo = spanLa * 2; else spanLa = spanLo / 2;
  const cLa = (la0 + la1) / 2, cLo = (lo0 + lo1) / 2, L0 = cLo - spanLo / 2, T0 = Math.min(90, cLa + spanLa / 2);
  const X = (lo) => ((lo - L0) / spanLo) * W, Y = (la) => ((T0 - la) / spanLa) * H;
  c.globalCompositeOperation = 'source-over'; c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
  const tiles = [[app.globe.water.tWaterW.value.image, -180], [app.globe.water.tWaterE.value.image, 0]];
  c.imageSmoothingEnabled = true;
  for (const [img, west] of tiles) if (img && img.width > 4) for (const k of [-1, 0, 1]) {
    const a = west + 360 * k, b = a + 180; if (b < L0 || a > L0 + spanLo) continue;
    c.drawImage(img, X(a), Y(90), X(b) - X(a), Y(-90) - Y(90));
  }
  c.globalCompositeOperation = 'multiply'; c.fillStyle = 'rgb(24,58,92)'; c.fillRect(0, 0, W, H);
  c.globalCompositeOperation = 'lighten'; c.fillStyle = 'rgb(16,22,30)'; c.fillRect(0, 0, W, H);
  c.globalCompositeOperation = 'source-over';
  c.strokeStyle = '#ffb547'; c.lineWidth = 3; c.lineJoin = 'round'; c.beginPath(); pts.forEach(([la, lo], i) => (i ? c.lineTo(X(lo), Y(la)) : c.moveTo(X(lo), Y(la)))); c.stroke();
  c.font = '500 19px "Spline Sans Mono", ui-monospace, monospace'; c.textBaseline = 'middle';
  const seen = new Set(); let ref = pts[0][1];
  for (let i = v.i0; i <= v.i1; i++) {
    const code = ship.stops[i].port; if (seen.has(code)) continue; seen.add(code);
    const p = ports[code]; let lo = p.lon; while (lo - ref > 180) lo -= 360; while (lo - ref < -180) lo += 360;
    const x = X(lo), y = Y(p.lat); c.fillStyle = '#fff'; c.beginPath(); c.arc(x, y, 5, 0, 7); c.fill();
    const name = shortPort(p.name), tw = c.measureText(name).width, right = x + 10 + tw < W - 4;
    c.fillStyle = 'rgba(2,8,16,0.75)'; c.fillRect(right ? x + 7 : x - 11 - tw, y - 12, tw + 6, 24); c.fillStyle = '#e7eef7'; c.fillText(name, right ? x + 10 : x - 8 - tw, y + 1);
  }
  if (s.status) { let lo = s.lon; while (lo - ref > 180) lo -= 360; while (lo - ref < -180) lo += 360; c.fillStyle = '#5fd4e6'; c.strokeStyle = '#02040a'; c.lineWidth = 3; c.beginPath(); c.arc(X(lo), Y(s.lat), 8, 0, 7); c.fill(); c.stroke(); }
}

export function updateShipPanel(app, force) {
  const p = el(), ship = p._ship; if (!ship || p.hidden) return;
  const t = app.time.t, s = app.shipState(ship), ports = app.fleet.ports, real = Date.now(), f = (k) => $(`[data-f="${k}"]`, p);
  const v = s.voy >= 0 ? ship.voyages[s.voy] : null;
  if (!force && v !== p._voy) return renderShipPanel(app, ship);        // crossed into another sailing
  const b = [];
  if (s.src === SRC.DEMO) {
    b.push(`<span class="badge demo" title="Position computed from the demo itinerary, not from AIS">Demo position</span>`);
    b.push(`<span class="badge">${Math.abs(t - real) < 3 * 6e4 ? 'Estimated from schedule' : t < real ? 'Reconstructed' : 'Scheduled'}</span>`);
  } else b.push(`<span class="badge ${s.src === SRC.LIVE ? 'live' : s.src === SRC.STALE ? 'warn' : ''}">${SRC_LABEL[s.src]} AIS</span><span class="badge">Last seen ${esc(ago(s.seen))}</span>`);
  b.push(`<span class="badge">${s.status === PORT ? 'In port' : s.status === SEA ? 'Underway' : 'No schedule'}</span>`);
  f('badges').innerHTML = b.join('');
  f('alert').innerHTML = app.alerts.has(ship.index) ? `<div class="alertbox">Route crosses the forecast cone of ${esc(app.alertStorm || 'a storm')} within five days.</div>` : '';
  f('sog').innerHTML = s.status ? `${s.sog.toFixed(1)} <small>kn</small>` : '–';
  f('hdg').innerHTML = s.status === SEA ? `${String(Math.round(s.hdg) % 360).padStart(3, '0')}° <small>${compass(s.hdg)}</small>` : s.status === PORT ? '<small>alongside</small>' : '–';
  f('pos').textContent = s.status ? `${fmtLat(s.lat)} ${fmtLon(s.lon)}` : '–';
  if (s.status && s.stop >= 0 && s.src === SRC.DEMO) {
    const cur = ship.stops[s.stop], nx = ship.stops[s.stop + 1];
    if (s.status === PORT) { f('nextlbl').textContent = cur.dep ? 'Sails' : 'In port'; f('next').innerHTML = `${esc(shortPort(ports[cur.port].name))}${cur.dep ? `<br><small>${esc(fmtDate(cur.dep, ports[cur.port].tz))} ${fmtTime(cur.dep, ports[cur.port].tz)} local</small>` : ''}`; }
    else if (nx) { f('nextlbl').textContent = 'Next port'; f('next').innerHTML = `${esc(shortPort(ports[nx.port].name))}<br><small>ETA ${esc(fmtDate(nx.arr, ports[nx.port].tz))} ${fmtTime(nx.arr, ports[nx.port].tz)} local</small>`; }
  } else if (v && s.status) f('next').innerHTML = '<small>see itinerary</small>';
  if (v) {
    f('progress').style.width = `${Math.max(0, Math.min(100, ((t - v.dep) / (v.arr - v.dep)) * 100)).toFixed(1)}%`;
    $$('.calls li', p).forEach((li) => { const i = +li.dataset.stop, st = ship.stops[i]; li.className = st.dep !== null && t > st.dep ? 'done' : (s.status === PORT && i === s.stop) ? 'cur' : (s.status === SEA && i === s.stop + 1) ? 'next' : (i === v.i1 && t > st.arr) ? 'done' : ''; });
    if (force || !p._mapT || Math.abs(t - p._mapT) > 20 * 6e4) { p._mapT = t; drawMinimap(app, ship, v, s); }
  }
  if (s.status && Math.abs(t - p._wxT) > 45 * 6e4) {
    p._wxT = t; const token = (p._wxTok = Math.random());
    app.weather.pointWeather(s.lat, s.lon, t).then((w) => {
      if (p._wxTok !== token || p._ship !== ship) return;
      f('wx').innerHTML = `<div><dt>Wind</dt><dd>${w.windKn.toFixed(0)} <small>kn from ${compass(w.windDir)}</small></dd></div>
        <div><dt>Waves</dt><dd>${w.waveM.toFixed(1)} <small>m</small></dd></div>
        <div><dt>Sea</dt><dd>${w.sstC.toFixed(1)} <small>°C</small></dd></div>
        <div><dt>Air</dt><dd>${w.tempC.toFixed(0)} <small>°C · cloud ${Math.round(w.cloud)}%</small></dd></div>`;
      f('wxsrc').innerHTML = `${w.live ? '<span class="badge live">Live</span>' : '<span class="badge demo">Demo</span>'} ${esc(w.source)}${w.live ? '' : '. Not a forecast.'}`;
    });
  }
}

export function renderPortPanel(app, code) {
  const p = app.fleet.ports[code], t = app.time.t, here = [], soon = [];
  for (const ship of app.fleet.ships) {
    const s = app.shipState(ship);
    if (s.status === PORT && s.src === SRC.DEMO && ship.stops[s.stop]?.port === code) here.push(ship);
    for (const st of ship.stops) if (st.port === code && st.arr > t && st.arr < t + 7 * 864e5) { soon.push([st.arr, ship]); break; }
  }
  soon.sort((a, b) => a[0] - b[0]);
  const row = (ship, sub) => `<li><button type="button" data-ship="${ship.id}"><span class="t"><span class="dot" style="background:${app.lines[ship.line].color}"></span>${esc(ship.name)}</span><span class="v">${num(ship.pax)}</span><span class="s">${esc(sub)}</span></button></li>`;
  el().innerHTML = `
    <div class="p-head"><button type="button" class="x" data-close aria-label="Close">×</button>
      <p class="p-line">${esc(p.country)} · port</p><h2 class="p-name">${esc(shortPort(p.name))}</h2>
      <div class="p-badges"><span class="badge">Local time ${fmtTime(t, p.tz)}</span><span class="badge demo">Demo schedule</span></div></div>
    <div class="p-sec"><h3>In port together · ${here.length} ${here.length === 1 ? 'ship' : 'ships'} · ${num(here.reduce((a, s) => a + s.pax, 0))} guests</h3>
      ${here.length ? `<ul class="list">${here.map((s) => row(s, app.lines[s.line].name)).join('')}</ul>` : '<p class="note">No ships alongside at the selected time.</p>'}</div>
    <div class="p-sec"><h3>Arriving in the next 7 days</h3>
      ${soon.length ? `<ul class="list">${soon.slice(0, 14).map(([at, s]) => row(s, `${fmtDate(at, p.tz)} ${fmtTime(at, p.tz)} local`)).join('')}</ul>` : '<p class="note">No calls scheduled this week.</p>'}</div>`;
  el().hidden = false; el().scrollTop = 0; el()._ship = null; el()._port = code;
}

export function bindPanel(app) {
  el().addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.close !== undefined) app.clearSelection();
    else if (t.dataset.ship) app.selectShip(t.dataset.ship, { fly: true });
    else if (t.dataset.goto) { app.pause(); app.setTime(+t.dataset.goto + 2 * 36e5); app.flyToShip(el()._ship); }
    else if (t.dataset.follow !== undefined) { app.setFollow(!app.sel.follow); t.setAttribute('aria-pressed', String(app.sel.follow)); }
    else if (t.dataset.share !== undefined) app.share(t);
  });
}
