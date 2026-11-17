// The detail panel: one ship (position, where it is going, where it has been, weather, specs) or one port
// (who is alongside and who is heading there). Every fact here comes from AIS or the weather feeds.
import { $, esc, fmtDate, fmtDateY, fmtTime, num, shortPort, ago, relative } from './util.js';
import { fmtLat, fmtLon, compass, densify, distNm } from '../geo.js';
import { SRC, SRC_LABEL, NAV } from '../data/ais.js';
import { PORT, SEA } from '../fleet.js';

const el = () => $('#panel');
const DAY = 864e5, HOUR = 36e5;
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'the cruise line'; } };
let regionNames = null;
const country = (c) => {
  if (!c || c.length !== 2) return c || '';
  try { regionNames = regionNames || new Intl.DisplayNames(['en'], { type: 'region' }); return regionNames.of(c) || c; } catch { return c; }
};
const placeName = (p) => `${shortPort(p.name)}${p.country && country(p.country) !== shortPort(p.name) ? `, ${country(p.country)}` : ''}`;
const lineSite = (line) => { try { const u = new URL(line.book.replaceAll('{code}', '').replaceAll('{date}', '')); return `${u.origin}/`; } catch { return null; } };
const stamp = (ms) => `${fmtDate(ms)} ${fmtTime(ms)} UTC`;

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

export function renderShipPanel(app, ship) {
  const line = app.lines[ship.line], site = lineSite(line), info = app.ais.info.get(ship.id) || {};
  const sisters = app.fleet.ships.filter((o) => o.line === ship.line && o.class === ship.class && o.id !== ship.id);
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
        <div><dt>Course</dt><dd data-f="hdg">–</dd></div>
        <div><dt>Position</dt><dd data-f="pos" style="font-size:13px">–</dd></div>
        <div><dt>Heading to</dt><dd data-f="next" style="font-size:13px">–</dd></div>
      </dl>
    </div>
    <div class="p-sec"><h3>Where it’s going</h3><div data-f="voyage"></div></div>
    <div class="p-sec"><h3>Where it’s been</h3>
      <canvas class="minimap" width="724" height="362" aria-label="Map of the track this ship has sailed"></canvas>
      <div data-f="history"></div>
    </div>
    <div class="p-sec"><h3>Weather at the ship</h3>
      <dl class="readout" data-f="wx"><div><dt>Wind</dt><dd>…</dd></div><div><dt>Waves</dt><dd>…</dd></div><div><dt>Sea</dt><dd>…</dd></div><div><dt>Air</dt><dd>…</dd></div></dl>
      <p class="note" data-f="wxsrc"></p>
    </div>
    <div class="p-sec"><h3>Itinerary and booking</h3>
      <p class="note" style="margin-top:0">Ships broadcast only their next destination, not the whole cruise. The full published itinerary is on the cruise line’s site.</p>
      ${site ? `<div class="p-actions" style="margin-top:10px"><a class="btn primary" href="${esc(site)}" target="_blank" rel="noopener">Open ${esc(host(site))}</a></div>` : ''}
    </div>
    <div class="p-sec"><h3>Ship</h3>
      <dl class="spec">
        <div><dt>Built</dt><dd>${ship.year}</dd></div><div><dt>Tonnage</dt><dd>${num(ship.gt)} GT</dd></div><div><dt>Guests</dt><dd>${num(ship.pax)}</dd></div>
        <div><dt>Length</dt><dd>${ship.length} m</dd></div><div><dt>Flag</dt><dd>${esc(ship.flag)}</dd></div><div><dt>IMO</dt><dd>${ship.imo || 'not on file'}</dd></div>
        <div><dt>Class</dt><dd>${esc(ship.class)}</dd></div><div><dt>MMSI</dt><dd>${info.mmsi || '–'}</dd></div><div><dt>Matched by</dt><dd>${info.by === 'imo' ? 'IMO number' : info.by === 'type' ? 'name + type' : info.by === 'name' ? 'name' : '–'}</dd></div>
      </dl>
      ${sisters.length ? `<h3 style="margin-top:14px">Sister ships</h3><div class="chips">${sisters.map((o) => `<button type="button" data-ship="${o.id}">${esc(o.name)}</button>`).join('')}</div>` : ''}
    </div>`;
  el().hidden = false; el().scrollTop = 0;
  el()._ship = ship; el()._wxT = -1e18; el()._port = null; el()._key = '';
  updateShipPanel(app, true);
}

// A small map of the track sailed (amber), where the ship is (cyan) and where it is going (dashed).
function drawMinimap(app, ship, s, dest) {
  const cv = $('.minimap', el()); if (!cv) return;
  const c = cv.getContext('2d'), W = cv.width, H = cv.height, raw = app.ais.trackUntil(ship.id, app.time.t);
  if (s.status) raw.push([s.lat, s.lon]);
  if (!raw.length) { cv.hidden = true; return; } cv.hidden = false;
  const pts = []; let prev = null;
  const unwrap = (lon) => { if (prev !== null) { while (lon - prev > 180) lon -= 360; while (lon - prev < -180) lon += 360; } prev = lon; return lon; };
  for (const p of raw.length > 1 ? densify(raw, 2) : raw) pts.push([p[0], unwrap(p[1])]);
  const end = pts[pts.length - 1], d = dest && dest.lat !== undefined ? [dest.lat, unwrap(dest.lon)] : null;
  const all = d ? [...pts, d] : pts;
  let la0 = 90, la1 = -90, lo0 = 1e9, lo1 = -1e9; for (const [la, lo] of all) { la0 = Math.min(la0, la); la1 = Math.max(la1, la); lo0 = Math.min(lo0, lo); lo1 = Math.max(lo1, lo); }
  let spanLa = Math.max(3, (la1 - la0) * 1.4), spanLo = Math.max(6, (lo1 - lo0) * 1.3); if (spanLo < spanLa * 2) spanLo = spanLa * 2; else spanLa = spanLo / 2;
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
  c.globalCompositeOperation = 'source-over'; c.lineJoin = 'round';
  if (d && s.status) { c.strokeStyle = '#5fd4e6'; c.lineWidth = 2.5; c.setLineDash([10, 8]); c.beginPath(); c.moveTo(X(end[1]), Y(end[0])); c.lineTo(X(d[1]), Y(d[0])); c.stroke(); c.setLineDash([]); }
  if (pts.length > 1) { c.strokeStyle = '#ffb547'; c.lineWidth = 3; c.beginPath(); pts.forEach(([la, lo], i) => (i ? c.lineTo(X(lo), Y(la)) : c.moveTo(X(lo), Y(la)))); c.stroke(); }
  c.font = '500 19px "Spline Sans Mono", ui-monospace, monospace'; c.textBaseline = 'middle';
  const label = (la, lo, text) => {
    const x = X(lo), y = Y(la); c.fillStyle = '#fff'; c.beginPath(); c.arc(x, y, 5, 0, 7); c.fill();
    const tw = c.measureText(text).width, right = x + 10 + tw < W - 4;
    c.fillStyle = 'rgba(2,8,16,0.75)'; c.fillRect(right ? x + 7 : x - 11 - tw, y - 12, tw + 6, 24); c.fillStyle = '#e7eef7'; c.fillText(text, right ? x + 10 : x - 8 - tw, y + 1);
  };
  const seen = new Set();
  for (const call of app.ais.calls.get(ship.id) || []) { if (call.from > app.time.t || seen.has(call.name)) continue; seen.add(call.name); prev = end[1]; label(call.lat, unwrap(call.lon), shortPort(call.name)); }
  if (d) label(d[0], d[1], shortPort(dest.name));
  if (s.status) { c.fillStyle = '#5fd4e6'; c.strokeStyle = '#02040a'; c.lineWidth = 3; c.beginPath(); c.arc(X(end[1]), Y(end[0]), 8, 0, 7); c.fill(); c.stroke(); }
}

const arrived = (s, v) => s.status === PORT && v?.port?.lat !== undefined && distNm(s.lat, s.lon, v.port.lat, v.port.lon) < 6;

function voyageHtml(app, ship, s) {
  const v = app.ais.voyages.get(ship.id), t = app.time.t, real = Date.now();
  if (!v) return `<p class="note" style="margin:0">${s.status ? 'This ship hasn’t broadcast a destination since the site started listening. Ships repeat it every 6 minutes, so it usually appears within a few collections.' : 'Not heard on AIS yet.'}</p>`;
  const p = v.port, rows = [];
  rows.push(`<p class="voy-name">${p && !p.unresolved ? esc(placeName(p)) : esc(v.dest || 'No destination set')}</p>`);
  rows.push(`<p class="voy-dates">Broadcast as “${esc(v.dest)}” · updated ${esc(ago(v.at))}${p?.unresolved ? ' · port not recognised' : ''}</p>`);
  const dl = [];
  if (arrived(s, v)) rows.push(`<p class="note" style="margin:0 0 10px">Alongside at its broadcast destination now. The crew usually sets the next port when the ship sails.</p>`);
  if (v.eta) dl.push(`<div><dt>${arrived(s, v) ? 'Arrived (ETA)' : 'ETA'}</dt><dd style="font-size:13px">${esc(fmtDate(v.eta))}${v.etaTimeKnown ? ` ${fmtTime(v.eta)} UTC` : ''}<br><small>${esc(relative(v.eta, real))}</small></dd></div>`);
  if (p && p.lat !== undefined && s.status && !arrived(s, v) && Math.abs(t - real) < 6 * HOUR) {
    const nm = distNm(s.lat, s.lon, p.lat, p.lon), hrs = s.sog > 3 ? nm / s.sog : null;
    dl.push(`<div><dt>Distance</dt><dd style="font-size:13px">${num(nm)} nm${hrs ? `<br><small>about ${hrs < 48 ? `${Math.round(hrs)} h` : `${(hrs / 24).toFixed(1)} days`} at ${s.sog.toFixed(0)} kn</small>` : ''}</dd></div>`);
  }
  if (v.draught) dl.push(`<div><dt>Draught</dt><dd style="font-size:13px">${v.draught.toFixed(1)} m</dd></div>`);
  if (dl.length) rows.push(`<dl class="readout">${dl.join('')}</dl>`);
  rows.push(`<p class="note">The crew enters the destination and ETA into the ship’s AIS transponder. It is the ship’s own word, usually the next port of call.</p>`);
  return rows.join('');
}

function historyHtml(app, ship) {
  const t = app.time.t, calls = (app.ais.calls.get(ship.id) || []).filter((c) => c.from <= t).slice().reverse();
  const nm = app.ais.sailedNm(ship.id, t, t - 7 * DAY), first = (app.ais.tracks.get(ship.id) || [])[0];
  const parts = [];
  if (first) parts.push(`<p class="note" style="margin-top:0">${nm > 1 ? `${num(nm)} nm sailed in the last 7 days of tracking. ` : ''}Tracked since ${esc(fmtDateY(first.t))}.</p>`);
  if (calls.length) {
    parts.push(`<ul class="calls">${calls.map((c) => {
      const here = t - c.to < 3 * HOUR, sameDay = fmtDate(c.from) === fmtDate(c.to);
      const span = c.to - c.from < 20 * 6e4 ? fmtTime(c.from) : sameDay ? `${fmtTime(c.from)}–${fmtTime(c.to)}` : `${fmtTime(c.from)} to ${fmtDate(c.to)} ${fmtTime(c.to)}`;
      return `<li class="${here ? 'cur' : 'done'}"><span class="d">${esc(fmtDate(c.from))}</span><span>${esc(placeName(c))}${here ? ' · here now' : ''}</span><span class="h">${span} UTC</span></li>`;
    }).join('')}</ul><p class="note">Port calls are worked out from AIS: times when the ship was moored or stopped next to a port.</p>`);
  } else if (first) parts.push('<p class="note">No port calls recorded yet. They appear once AIS hears the ship moored or stopped next to a port.</p>');
  else parts.push('<p class="note" style="margin-top:0">Not heard on AIS yet, so there’s no track to show.</p>');
  return parts.join('');
}

export function updateShipPanel(app, force) {
  const p = el(), ship = p._ship; if (!ship || p.hidden) return;
  const t = app.time.t, s = app.shipState(ship), real = Date.now(), f = (k) => $(`[data-f="${k}"]`, p), v = app.ais.voyages.get(ship.id);
  const b = [];
  if (!s.status) b.push('<span class="badge warn">Not heard on AIS yet</span>');
  else {
    b.push(`<span class="badge ${s.src === SRC.LIVE ? 'live' : s.src === SRC.LAST ? 'warn' : ''}">${SRC_LABEL[s.src]} AIS position</span><span class="badge">Heard ${esc(ago(s.seen))}</span>`);
    b.push(`<span class="badge">${esc(NAV[s.nav] || (s.status === PORT ? 'Stopped' : 'Under way'))}</span>`);
  }
  f('badges').innerHTML = b.join('');
  f('alert').innerHTML = app.alerts.has(ship.index) ? `<div class="alertbox">On its way to its broadcast destination, this ship would cross the forecast cone of ${esc(app.alertStorm || 'a storm')} within five days.</div>` : '';
  f('sog').innerHTML = s.status ? `${s.sog.toFixed(1)} <small>kn</small>` : '–';
  f('hdg').innerHTML = s.status === SEA ? `${String(Math.round(s.cog ?? s.hdg) % 360).padStart(3, '0')}° <small>${compass(s.cog ?? s.hdg)}</small>` : s.status === PORT ? `<small>${s.port >= 0 ? `at ${esc(shortPort(app.fleet.ports[app.fleet.portCodes[s.port]].name))}` : 'stopped'}</small>` : '–';
  f('pos').textContent = s.status ? `${fmtLat(s.lat)} ${fmtLon(s.lon)}` : '–';
  $('[data-f="next"]', p).previousElementSibling.textContent = arrived(s, v) ? 'At' : 'Heading to';
  f('next').innerHTML = v ? `${esc(v.port && !v.port.unresolved ? shortPort(v.port.name) : v.dest || '–')}${v.eta ? `<br><small>ETA ${esc(fmtDate(v.eta))}${v.etaTimeKnown ? ` ${fmtTime(v.eta)} UTC` : ''}</small>` : ''}` : '<small>not broadcast yet</small>';
  // the slower sections only when something they show has changed
  const key = `${Math.floor(t / (10 * 6e4))}:${app.ais.lastSeen(ship.id)}:${v?.at || 0}:${s.status}`;
  if (force || key !== p._key) {
    p._key = key;
    f('voyage').innerHTML = voyageHtml(app, ship, s);
    f('history').innerHTML = historyHtml(app, ship);
    drawMinimap(app, ship, s, v?.port && Math.abs(t - real) < 6 * HOUR ? v.port : null);
  }
  if (s.status && Math.abs(t - p._wxT) > 45 * 6e4) {
    p._wxT = t; const token = (p._wxTok = Math.random());
    app.weather.pointWeather(s.lat, s.lon, t).then((w) => {
      if (p._wxTok !== token || p._ship !== ship) return;
      f('wx').innerHTML = `<div><dt>Wind</dt><dd>${w.windKn.toFixed(0)} <small>kn from ${compass(w.windDir)}</small></dd></div>
        <div><dt>Waves</dt><dd>${w.waveM.toFixed(1)} <small>m</small></dd></div>
        <div><dt>Sea</dt><dd>${w.sstC.toFixed(1)} <small>°C</small></dd></div>
        <div><dt>Air</dt><dd>${w.tempC.toFixed(0)} <small>°C · cloud ${Math.round(w.cloud)}%</small></dd></div>`;
      f('wxsrc').innerHTML = `${w.live ? '<span class="badge live">Live</span>' : '<span class="badge demo">Modelled</span>'} ${esc(w.source)}${w.live ? '' : '. The live feed did not answer.'}`;
    });
  } else if (!s.status) { f('wx').innerHTML = ''; f('wxsrc').textContent = 'Shown once the ship has a position.'; }
}

export function renderPortPanel(app, code) {
  const p = app.fleet.ports[code], t = app.time.t, here = [], soon = [], recent = [], o = {}, real = Date.now();
  const near = (q) => q && q.lat !== undefined && distNm(q.lat, q.lon, p.lat, p.lon) < 6;
  for (const ship of app.fleet.ships) {
    const s = app.shipState(ship, o);
    if (s.status === PORT && s.port >= 0 && app.fleet.portCodes[s.port] === code) here.push([ship, s.src]);
    const v = app.ais.voyages.get(ship.id);
    if (v && near(v.port) && !(s.status === PORT && s.port >= 0 && app.fleet.portCodes[s.port] === code) && (!v.eta || v.eta > real - 6 * HOUR)) soon.push([v.eta || Infinity, ship, v]);
    const call = (app.ais.calls.get(ship.id) || []).filter((c) => near(c) && c.from <= t && t - c.to < 7 * DAY && t - c.to > 3 * HOUR).pop();
    if (call) recent.push([call.to, ship, call]);
  }
  soon.sort((a, b) => a[0] - b[0]); recent.sort((a, b) => b[0] - a[0]);
  const row = (ship, sub) => `<li><button type="button" data-ship="${ship.id}"><span class="t"><span class="dot" style="background:${app.lines[ship.line].color}"></span>${esc(ship.name)}</span><span class="v">${num(ship.pax)}</span><span class="s">${esc(sub)}</span></button></li>`;
  el().innerHTML = `
    <div class="p-head"><button type="button" class="x" data-close aria-label="Close">×</button>
      <p class="p-line">${esc(p.country)} · port</p><h2 class="p-name">${esc(shortPort(p.name))}</h2>
      <div class="p-badges"><span class="badge">Local time ${fmtTime(t, p.tz)}</span><span class="badge live">From AIS</span></div></div>
    <div class="p-sec"><h3>Alongside or at anchor · ${here.length} ${here.length === 1 ? 'ship' : 'ships'}</h3>
      ${here.length ? `<ul class="list">${here.map(([s, src]) => row(s, `${app.lines[s.line].name}${src === SRC.RECENT || src === SRC.LAST ? ' · last heard here' : ''}`)).join('')}</ul>` : '<p class="note">AIS shows none of the tracked ships here at the selected time.</p>'}</div>
    <div class="p-sec"><h3>Heading here</h3>
      ${soon.length ? `<ul class="list">${soon.slice(0, 14).map(([eta, s, v]) => row(s, v.eta ? `ETA ${fmtDate(v.eta, p.tz)}${v.etaTimeKnown ? ` ${fmtTime(v.eta, p.tz)} local` : ''}` : `Destination “${v.dest}”`)).join('')}</ul>` : '<p class="note">No tracked ship is broadcasting this port as its destination.</p>'}</div>
    <div class="p-sec"><h3>Called here in the last week</h3>
      ${recent.length ? `<ul class="list">${recent.slice(0, 14).map(([, s, c]) => row(s, `${fmtDate(c.from, p.tz)} ${fmtTime(c.from, p.tz)} to ${fmtDate(c.to, p.tz) === fmtDate(c.from, p.tz) ? '' : `${fmtDate(c.to, p.tz)} `}${fmtTime(c.to, p.tz)} local`)).join('')}</ul>` : '<p class="note">No recorded calls yet.</p>'}</div>`;
  el().hidden = false; el().scrollTop = 0; el()._ship = null; el()._port = code;
}

export function bindPanel(app) {
  el().addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.close !== undefined) app.clearSelection();
    else if (t.dataset.ship) app.selectShip(t.dataset.ship, { fly: true });
    else if (t.dataset.follow !== undefined) { app.setFollow(!app.sel.follow); t.setAttribute('aria-pressed', String(app.sel.follow)); }
    else if (t.dataset.share !== undefined) app.share(t);
  });
}
