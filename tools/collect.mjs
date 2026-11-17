// Open Seas live-data collector. GitHub Actions runs it every 20 minutes (.github/workflows/live.yml)
// and deploys the site with the files it writes to data/live/:
//   ais.json       AISStream.io positions, broadcast destinations and port calls for the ships in
//                  data/ships.json                                          needs AISSTREAM_API_KEY
//   forecast.json  Open-Meteo wind, cloud and rain grid                     refreshed every 3 hours
//   marine.json    Open-Meteo waves and sea-surface temperature grid        refreshed every 3 hours
//   storms.json    NOAA National Hurricane Center active storms             every run
//   status.json    what each step did, for the logs and for debugging
// When a source fails, its last good file is carried forward from the deployed site,
// so one bad run never blanks the page.
//
// Local run: node tools/collect.mjs   (env: AISSTREAM_API_KEY, SITE_URL, AIS_SECONDS, FORCE_WEATHER)
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';

const ROOT = new URL('../', import.meta.url);
const OUT = new URL('data/live/', ROOT);
const SITE = (process.env.SITE_URL || '').replace(/\/+$/, '');
const KEY = (process.env.AISSTREAM_API_KEY || '').trim();
const AIS_URL = process.env.AIS_URL || 'wss://stream.aisstream.io/v0/stream';
const LISTEN_S = Number(process.env.AIS_SECONDS || 600);
const DEBUG_AIS = !!process.env.DEBUG_AIS;
const FORCE_WEATHER = !!process.env.FORCE_WEATHER;
const MIN = 6e4, HOUR = 36e5;
const WX_EVERY = 3 * HOUR - 15 * MIN;
const GX = 18, GY = 11;             // weather grid: every 20 degrees of longitude, 15 of latitude (matches js/data/weather.js)

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const errText = (e) => (e?.name === 'AbortError' ? 'timed out' : `${e?.message || e}${e?.cause ? ` (${e.cause.code || e.cause.message || e.cause})` : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url, ms = 30000) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'open-seas-collector (GitHub Actions)' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}
// The copy of a file on the currently deployed site, or null.
async function previous(name) {
  if (!SITE) return null;
  try { return await getJSON(`${SITE}/data/live/${name}?v=${Date.now()}`, 20000); } catch { return null; }
}
const save = (name, data) => writeFile(new URL(name, OUT), JSON.stringify(data));

// ---------------------------------------------------------------- weather
async function grid(url, vars, extra) {
  const lats = [], lons = [];
  for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) { lats.push(-75 + 15 * j); lons.push(-180 + 20 * i); }
  const names = vars.split(','), out = { at: Date.now(), source: url, times: null, v: Object.fromEntries(names.map((n) => [n, []])) };
  for (let c = 0; c < lats.length; c += 50) {
    const q = `${url}?latitude=${lats.slice(c, c + 50).join(',')}&longitude=${lons.slice(c, c + 50).join(',')}&hourly=${vars}${extra}&past_days=7&forecast_days=7&timeformat=unixtime&timezone=GMT`;
    let res, last;
    for (const [suffix, wait] of [['&temporal_resolution=hourly_6', 0], ['', 3000], ['&temporal_resolution=hourly_6', 15000]]) {
      try { if (wait) await sleep(wait); res = await getJSON(q + suffix, 60000); break; } catch (e) { last = e; log(`${url.split('/')[2]} rows ${c}-${c + 49}: ${errText(e)}, retrying`); }
    }
    if (!res) throw last;
    for (const loc of [].concat(res)) {
      const tt = loc.hourly.time, stride = tt.length > 1 && tt[1] - tt[0] < 6 * 3600 ? Math.round(6 * 3600 / (tt[1] - tt[0])) : 1;
      if (!out.times) out.times = tt.filter((_, k) => k % stride === 0).map((s) => s * 1000);
      for (const n of names) out.v[n].push(loc.hourly[n].filter((_, k) => k % stride === 0).map((x) => (x === null ? null : Math.round(x * 10) / 10)));
    }
  }
  const got = out.v[names[0]].length;
  if (got !== GX * GY) throw new Error(`expected ${GX * GY} grid points, got ${got}`);
  return out;
}

async function weather(slot, url, vars, extra) {
  const prev = await previous(`${slot}.json`);
  if (prev?.times && !FORCE_WEATHER && Date.now() - prev.at < WX_EVERY) {
    await save(`${slot}.json`, prev);
    return { ok: true, at: prev.at, note: 'carried forward, still fresh' };
  }
  try {
    const g = await grid(url, vars, extra);
    await save(`${slot}.json`, g);
    return { ok: true, at: g.at, note: `fetched ${g.times.length} time steps` };
  } catch (e) {
    if (prev?.times) await save(`${slot}.json`, prev);
    return { ok: false, at: prev?.at ?? null, error: errText(e), note: prev ? 'kept the previous grid' : 'no grid available' };
  }
}

async function storms() {
  try {
    const j = await getJSON('https://www.nhc.noaa.gov/CurrentStorms.json', 30000);
    const data = { fetchedAt: new Date().toISOString(), activeStorms: j.activeStorms || [] };
    await save('storms.json', data);
    return { ok: true, at: Date.now(), note: `${data.activeStorms.length} active` };
  } catch (e) {
    const prev = await previous('storms.json');
    if (prev) await save('storms.json', prev);
    return { ok: false, error: errText(e), note: prev ? 'kept the previous list' : 'no list available' };
  }
}

// ---------------------------------------------------------------- ships (AIS)
// ais.json, schema 2. For every ship AIS has heard in the last 30 days:
//   track   [[t, lat, lon, sog, cog, hdg, nav], ...]  every ping from the last 3 h, one per 10 min back to
//           24 h, one an hour back to 7 days, and always the newest (a ship seen weeks ago keeps its last position)
//   voyage  what the ship itself broadcasts: destination text, the port it decodes to, ETA, draught
//   est     the shipping-lane route from the last report to that destination, for estimating where the
//           ship is between reports (data/marnet.json, routed here with Dijkstra)
//   calls   port calls detected from the track (moored or stopped next to a port)
//   ais     what the transponder says about the ship itself: IMO number, length, beam
const norm = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const PASSENGER = (type) => type >= 60 && type <= 69;
const KEEP_TRACK = 7 * 864e5, KEEP_LAST = 30 * 864e5;
const NM = 3440.065, D2R = Math.PI / 180;
const distNm = (a, b, c, d) => {
  const p1 = a * D2R, p2 = c * D2R, h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(((d - b) * D2R) / 2) ** 2;
  return 2 * NM * Math.asin(Math.min(1, Math.sqrt(h)));
};
// AISStream times look like "2026-11-17 14:15:16.123456789 +0000 UTC"
function aisTime(s) {
  const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(\.\d{1,3})?/.exec(s || '');
  return (m && Date.parse(`${m[1]}T${m[2]}${m[3] || ''}Z`)) || Date.now();
}
// AIS ETA has month, day, hour and minute (UTC) but no year: take the occurrence nearest to now.
function etaTime(e, now) {
  if (!e || !(e.Month >= 1 && e.Month <= 12) || !(e.Day >= 1 && e.Day <= 31)) return null;
  const timeKnown = e.Hour >= 0 && e.Hour <= 23 && e.Minute >= 0 && e.Minute <= 59, y = new Date(now).getUTCFullYear();
  const at = (yy) => Date.UTC(yy, e.Month - 1, e.Day, timeKnown ? e.Hour : 12, timeKnown ? e.Minute : 0);
  const t = [at(y - 1), at(y), at(y + 1)].sort((a, b) => Math.abs(a - now) - Math.abs(b - now))[0];
  return { t, timeKnown };
}

// Port lookup: the site's own cruise ports (with coordinates) first, then UN/LOCODE seaports.
async function portBook() {
  const cruise = JSON.parse(await readFile(new URL('data/ports.json', ROOT), 'utf8'));
  const sea = JSON.parse(await readFile(new URL('data/seaports.json', ROOT), 'utf8'));
  const byName = new Map(), add = (key, p) => { if (!key) return; const l = byName.get(key) || []; l.push(p); byName.set(key, l); };
  const cruiseList = Object.entries(cruise).map(([id, p]) => ({ id, name: p.name.split(/[,(]/)[0].trim(), country: p.country, lat: p.lat, lon: p.lon, cruise: true }));
  for (const p of cruiseList) {
    const full = cruise[p.id].name;
    add(norm(p.name), p);
    for (const alt of (full.match(/\(([^)]+)\)/) || [])[1]?.split('/') || []) add(norm(alt), p);   // "Cape Liberty (Bayonne)"
    for (const alt of full.split(/,| at /).slice(1)) add(norm(alt.replace(/\(.*\)/, '')), p);         // "Perfect Day at CocoCay", "George Town, Grand Cayman"
  }
  // Two-letter country codes for the site's cruise ports, so "BS CCY" can find CocoCay by its code.
  const ISO = { US: 'USA', BS: 'Bahamas', ES: 'Spain', IT: 'Italy', JP: 'Japan', GR: 'Greece', AU: 'Australia', MX: 'Mexico', GB: 'United Kingdom', NZ: 'New Zealand', NO: 'Norway',
    FR: 'France', CA: 'Canada', PT: 'Portugal', HR: 'Croatia', TR: 'Türkiye', IE: 'Ireland', DE: 'Germany', MY: 'Malaysia', TH: 'Thailand', KR: 'South Korea', NC: 'New Caledonia',
    VU: 'Vanuatu', BM: 'Bermuda', HN: 'Honduras', BZ: 'Belize', KY: 'Cayman Islands', JM: 'Jamaica', DO: 'Dominican Republic', TC: 'Turks and Caicos', PR: 'Puerto Rico',
    VI: 'US Virgin Islands', VG: 'British Virgin Islands', SX: 'Sint Maarten', KN: 'St. Kitts and Nevis', AG: 'Antigua and Barbuda', GP: 'Guadeloupe', MQ: 'Martinique',
    LC: 'St. Lucia', BB: 'Barbados', AW: 'Aruba', CW: 'Curaçao', BQ: 'Bonaire', GI: 'Gibraltar', MC: 'Monaco', MT: 'Malta', ME: 'Montenegro', MA: 'Morocco', NL: 'Netherlands',
    DK: 'Denmark', PL: 'Poland', SE: 'Sweden', FI: 'Finland', EE: 'Estonia', SG: 'Singapore', VN: 'Vietnam', TW: 'Taiwan', CN: 'China' };
  for (const [code, [name, lat, lon]] of Object.entries(sea)) if (lat !== undefined) add(norm(name), { code, name, country: code.slice(0, 2), lat, lon });
  const nearest = (list, lat, lon) => list.slice().sort((a, b) => distNm(lat, lon, a.lat, a.lon) - distNm(lat, lon, b.lat, b.lon))[0];
  // A destination string as crews type it: "GIGIB", "US MIA", "ESAGP<>ESMLN", "PIRAEUS GRE", "MIAMI>NASSAU".
  function resolve(raw, lat, lon) {
    const s = String(raw || '').toUpperCase().replace(/\s+/g, ' ').trim();
    if (!s || /^(X+|N\/?A|NONE|NIL|TBA|TBN|FOR SALE|[.\-_ ]+)$/.test(s)) return null;
    // "FROM>TO": only the last leg is the destination. If it can't be decoded, show what the crew typed.
    const part = s.split(/<>|=>|>|\/|\bTO\b|\bVIA\b|\s-\s/).map((p) => p.replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean).pop();
    if (!part) return null;
    {
      const m = /^([A-Z]{2}) ?([A-Z2-9]{3})$/.exec(part);
      const own = m && cruise[m[2]] && cruise[m[2]].country === ISO[m[1]] ? cruise[m[2]] : null;
      if (own) return { code: m[1] + m[2], name: own.name.split(/[,(]/)[0].trim(), country: m[1], lat: own.lat, lon: own.lon };
      if (m && sea[m[1] + m[2]]) {
        const code = m[1] + m[2], [name, plat, plon] = sea[code];
        const known = (byName.get(norm(name)) || []).filter((p) => p.cruise || p.code === code);
        const best = known.length ? nearest(known, plat ?? lat, plon ?? lon) : null;
        const pl = plat ?? best?.lat, po = plon ?? best?.lon;
        return { code, name, country: code.slice(0, 2), ...(pl !== undefined ? { lat: pl, lon: po } : {}) };
      }
      const words = part.split(' ');
      for (let k = words.length; k >= 1; k--) {
        const list = byName.get(words.slice(0, k).join(''));
        if (!list) continue;
        const best = nearest(list, lat, lon);
        if (distNm(lat, lon, best.lat, best.lon) > 6500) continue;
        return { ...(best.code ? { code: best.code } : {}), name: best.name, country: best.country, lat: best.lat, lon: best.lon };
      }
    }
    return { name: part, unresolved: true };
  }
  // The port a stopped ship is lying at, if any.
  function at(lat, lon) {
    let best = null, bd = 6;
    for (const p of cruiseList) { const d = distNm(lat, lon, p.lat, p.lon); if (d < bd) { bd = d; best = p; } }
    if (best) return best;
    bd = 3;
    for (const [code, [name, plat, plon]] of Object.entries(sea)) { if (plat === undefined || Math.abs(plat - lat) > 0.1) continue; const d = distNm(lat, lon, plat, plon); if (d < bd) { bd = d; best = { code, name, country: code.slice(0, 2), lat: plat, lon: plon }; } }
    return best;
  }
  return { resolve, at };
}

// Listen to the worldwide AISStream feed for `seconds`, passing every message to onMessage.
function listen(onMessage, seconds) {
  return new Promise((resolve) => {
    const until = Date.now() + seconds * 1000, dec = new TextDecoder();
    let ws, error = null, opened = false, done = false, reconnects = 0;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); try { ws?.close(); } catch {} resolve({ opened, error }); };
    const timer = setTimeout(finish, seconds * 1000);
    const connect = () => {
      try { ws = new WebSocket(AIS_URL); } catch (e) { error = errText(e); return finish(); }
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        opened = true;
        ws.send(JSON.stringify({ APIKey: KEY, BoundingBoxes: [[[-90, -180], [90, 180]]], FilterMessageTypes: ['PositionReport', 'ShipStaticData'] }));
      };
      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(typeof e.data === 'string' ? e.data : dec.decode(e.data)); } catch { return; }
        if (m.error) { error = `AISStream: ${m.error}`; return finish(); }
        onMessage(m);
      };
      ws.onerror = (e) => { if (!error) error = e?.message || 'connection error'; };
      ws.onclose = () => {
        if (done) return;
        if (Date.now() < until - 15000 && reconnects++ < 3) { log('AIS connection closed early, reconnecting'); error = null; setTimeout(connect, 2000); }
        else finish();
      };
    };
    connect();
  });
}

// Group stopped pings next to the same port into calls: [{ name, code?, country, lat, lon, from, to }].
function detectCalls(track, ports) {
  const calls = [];
  for (const [t, lat, lon, sog, , , nav] of track) {
    if (!(nav === 5 || nav === 1 || sog < 0.6)) continue;
    const p = ports.at(lat, lon); if (!p) continue;
    const last = calls[calls.length - 1];
    if (last && last.name === p.name && t - last.to < 8 * HOUR) last.to = t;
    else calls.push({ name: p.name, ...(p.code ? { code: p.code } : {}), ...(p.id ? { port: p.id } : {}), country: p.country, lat: p.lat, lon: p.lon, from: t, to: t });
  }
  return calls;
}
function mergeCalls(old = [], fresh = []) {
  const out = old.map((c) => ({ ...c }));
  for (const c of fresh) {
    const same = out.find((o) => o.name === c.name && c.from - o.to < 8 * HOUR && o.from - c.to < 8 * HOUR);
    if (same) { same.from = Math.min(same.from, c.from); same.to = Math.max(same.to, c.to); } else out.push(c);
  }
  return out.sort((a, b) => a.from - b.from).filter((c) => Date.now() - c.to < KEEP_LAST).slice(-15);
}
function thin(track, now) {
  const out = []; let lastKept = -Infinity;
  track.forEach((p, i) => {
    const age = now - p[0], newest = i === track.length - 1, step = age < 3 * HOUR ? 0 : age < 24 * HOUR ? 10 * MIN : 60 * MIN;
    if (newest ? age < KEEP_LAST : age < KEEP_TRACK && p[0] - lastKept >= step) { out.push(p); lastKept = p[0]; }
  });
  return out;
}

// Point f of the way along the great circle from a to b ([lat, lon]).
function gc(a, b, f) {
  const v = ([la, lo]) => [Math.cos(la * D2R) * Math.cos(lo * D2R), Math.cos(la * D2R) * Math.sin(lo * D2R), Math.sin(la * D2R)];
  const p = v(a), q = v(b), w = Math.acos(Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2])));
  if (w < 1e-9) return a;
  const k1 = Math.sin((1 - f) * w) / Math.sin(w), k2 = Math.sin(f * w) / Math.sin(w), x = p.map((c, i) => c * k1 + q[i] * k2);
  return [Math.asin(Math.max(-1, Math.min(1, x[2]))) / D2R, Math.atan2(x[1], x[0]) / D2R];
}

// Shortest route along the world's shipping lanes (data/marnet.json) from a ship to a port, then pulled
// straight wherever open water allows (data/water.bin: 0.1 degree land/sea grid from the globe's own mask).
async function seaRouter() {
  const net = JSON.parse(await readFile(new URL('data/marnet.json', ROOT), 'utf8'));
  const water = await readFile(new URL('data/water.bin', ROOT));
  const wet = (lat, lon) => {
    const r = Math.min(1799, Math.max(0, Math.floor((90 - lat) * 10))), c = ((Math.floor((lon + 180) * 10) % 3600) + 3600) % 3600, k = r * 3600 + c;
    return (water[k >> 3] >> (7 - (k & 7))) & 1;
  };
  // A straight run that stays at sea, ignoring the last 4 nm at each end (ports sit on the coast).
  const clear = (a, b) => {
    const d = distNm(a[0], a[1], b[0], b[1]), n = Math.ceil(d / 2);
    for (let k = 1; k < n; k++) { const f = k / n; if (d * f < 4 || d * (1 - f) < 4) continue; const p = gc(a, b, f); if (!wet(p[0], p[1])) return false; }
    return true;
  };
  const straighten = (pts) => {
    const out = [pts[0]]; let i = 0;
    while (i < pts.length - 1) { let j = pts.length - 1; while (j > i + 1 && !clear(pts[i], pts[j])) j--; out.push(pts[j]); i = j; }
    return out;
  };
  const nodes = [], index = new Map(), adj = [];
  const node = (lon, lat) => { const k = `${lon},${lat}`; let i = index.get(k); if (i === undefined) { i = nodes.length; index.set(k, i); nodes.push([lat, lon]); adj.push([]); } return i; };
  for (const line of net.lines) for (let j = 1; j < line.length; j++) {
    const a = node(...line[j - 1]), b = node(...line[j]); if (a === b) continue;
    const d = distNm(nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1]); adj[a].push([b, d]); adj[b].push([a, d]);
  }
  const edge = new Map();                                          // join the lanes across the antimeridian
  nodes.forEach(([lat, lon], i) => { if (Math.abs(lon) !== 180) return; const o = edge.get(lat); if (o !== undefined) { adj[i].push([o, 0]); adj[o].push([i, 0]); } else edge.set(lat, i); });
  // Snap only to the main connected network, never to a stray fragment of lane.
  const comp = new Int32Array(nodes.length).fill(-1), size = [];
  for (let i = 0; i < nodes.length; i++) {
    if (comp[i] >= 0) continue; const c = size.length, stack = [i]; comp[i] = c; let n = 0;
    while (stack.length) { const u = stack.pop(); n++; for (const [v] of adj[u]) if (comp[v] < 0) { comp[v] = c; stack.push(v); } }
    size.push(n);
  }
  const main = size.indexOf(Math.max(...size));
  const nearest = (lat, lon) => { let best = -1, bd = Infinity; nodes.forEach(([a, b], i) => { if (comp[i] !== main || Math.abs(a - lat) > 8) return; const d = distNm(lat, lon, a, b); if (d < bd) { bd = d; best = i; } }); return best; };
  // Dijkstra from the destination, so every node knows its distance to it and its next step towards it.
  function fromDest(src) {
    const n = nodes.length, dist = new Float64Array(n).fill(Infinity), next = new Int32Array(n).fill(-1), heap = [[0, src]]; dist[src] = 0;
    const push = (x) => { heap.push(x); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    while (heap.length) { const [d, u] = pop(); if (d > dist[u]) continue; for (const [v, w] of adj[u]) if (d + w < dist[v]) { dist[v] = d + w; next[v] = u; push([dist[v], v]); } }
    return { dist, next };
  }
  // Drop points that add nothing to the shape (Douglas-Peucker in degrees, never across the antimeridian).
  const simplify = (pts, tol) => {
    if (pts.length < 3) return pts;
    let far = 0, fi = 0; const [a, b] = [pts[0], pts[pts.length - 1]];
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i], dx = b[1] - a[1], dy = b[0] - a[0], len = Math.hypot(dx, dy) || 1e-9;
      const d = Math.abs(dy * (p[1] - a[1]) - dx * (p[0] - a[0])) / len + (Math.abs(p[1] - pts[i - 1][1]) > 180 ? 1e3 : 0);
      if (d > far) { far = d; fi = i; }
    }
    return far <= tol ? [a, b] : [...simplify(pts.slice(0, fi + 1), tol).slice(0, -1), ...simplify(pts.slice(fi), tol)];
  };
  return function route(lat, lon, dlat, dlon) {
    const direct = distNm(lat, lon, dlat, dlon);
    const goal = nearest(dlat, dlon); if (goal < 0) return null;
    const { dist, next } = fromDest(goal);
    let best = -1, bd = Infinity;                                  // the lane node that gets this ship there soonest
    nodes.forEach(([a, b], i) => { if (Math.abs(a - lat) > 3 || dist[i] === Infinity) return; const d = distNm(lat, lon, a, b); if (d > 200) return; const total = d + dist[i] + distNm(nodes[goal][0], nodes[goal][1], dlat, dlon); if (total < bd) { bd = total; best = i; } });
    if (clear([lat, lon], [dlat, dlon]) || best < 0 || direct < 25 || bd > direct * 3) return clear([lat, lon], [dlat, dlon]) || direct < 400 ? { nm: Math.round(direct), path: [[lat, lon], [dlat, dlon]] } : null;
    const pts = [[lat, lon]]; for (let i = best; i >= 0; i = next[i]) { pts.push(nodes[i]); if (i === goal) break; } pts.push([dlat, dlon]);
    const path = straighten(simplify(pts, 0.03)).map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)]);
    let nm = 0; for (let i = 1; i < path.length; i++) nm += distNm(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
    return { nm: Math.round(nm), path };
  };
}

async function ais() {
  const ships = JSON.parse(await readFile(new URL('data/ships.json', ROOT), 'utf8'));
  const byId = new Map(ships.map((s) => [s.id, s])), byName = new Map(ships.map((s) => [norm(s.name), s]));
  const byImo = new Map(ships.filter((s) => s.imo).map((s) => [s.imo, s]));
  const ports = await portBook();
  const prev = await previous('ais.json');
  const prevShips = prev?.schema === 2 ? prev.ships || {} : {};
  const now = Date.now();

  // MMSI -> { id, by }: 'imo' (IMO number matched), 'type' (name matched and the vessel says it carries
  // passengers) or 'name' (name only). blocked: MMSIs known to be namesakes.
  const mmsi = new Map(Object.entries(prev?.mmsi || {}).filter(([, m]) => byId.has(m.id)));
  const blocked = new Set(prev?.blocked || []);
  const strongFor = (id) => [...mmsi.entries()].find(([, m]) => m.id === id && m.by !== 'name');
  const anyFor = (id) => [...mmsi.entries()].find(([, m]) => m.id === id);
  const drop = (mm) => { mmsi.delete(mm); blocked.add(mm); };

  const pings = new Map(), statics = new Map(), pending = new Map(), stats = { messages: 0, positions: 0, staticReports: 0, matchedPositions: 0, emptyNames: 0, confirmed: 0, rejected: 0 };
  const addPing = (id, p) => {
    let list = pings.get(id); if (!list) pings.set(id, list = []);
    const last = list[list.length - 1];
    if (last && p[0] <= last[0] && last[7] === p[7]) return;
    if (last && last[7] === p[7] && list.length > 1 && p[0] - list[list.length - 2][0] < 2 * MIN) list[list.length - 1] = p;
    else list.push(p);
    stats.matchedPositions++;
  };
  // A vessel found by name becomes the ship only once it confirms it carries passengers and is about the right length.
  const accept = (mm, id, by) => {
    for (const [k, v] of mmsi) if (v.id === id && k !== mm) mmsi.delete(k);
    mmsi.set(mm, { id, by }); stats.confirmed++;
    for (const p of pending.get(mm)?.pings || []) addPing(id, p);
    pending.delete(mm);
  };
  const dbg = new Map();
  const onMessage = (m) => {
    stats.messages++;
    const meta = m.MetaData || {}, mm = String(meta.MMSI ?? '');
    if (m.MessageType === 'PositionReport' && !String(meta.ShipName || '').trim()) stats.emptyNames++;
    if (!mm || blocked.has(mm)) return;
    if (m.MessageType === 'ShipStaticData') {
      stats.staticReports++;
      const sd = m.Message?.ShipStaticData || {}, imo = +sd.ImoNumber || 0, type = +sd.Type || 0;
      if (DEBUG_AIS && PASSENGER(type)) dbg.set(mm, { mmsi: mm, name: String(sd.Name || meta.ShipName || '').trim(), imo, type, dest: sd.Destination });
      const dim = sd.Dimension || {}, len = (+dim.A || 0) + (+dim.B || 0), beam = (+dim.C || 0) + (+dim.D || 0);
      const imoShip = imo && byImo.get(imo);
      if (imoShip) accept(mm, imoShip.id, 'imo');      // an IMO match beats any name match
      else {
        const cur = mmsi.get(mm), ship = cur ? byId.get(cur.id) : byName.get(norm(sd.Name || meta.ShipName));
        if (!ship) return;
        const badLength = len > 20 && ship.length && (len < ship.length * 0.8 || len > ship.length * 1.2);
        if ((ship.imo && imo && imo !== ship.imo) || (type && !PASSENGER(type)) || badLength) { drop(mm); pending.delete(mm); stats.rejected++; return; }   // a namesake
        if (PASSENGER(type) && !strongFor(ship.id)) accept(mm, ship.id, 'type');
      }
      if (mmsi.has(mm)) statics.set(mm, { at: aisTime(meta.time_utc), dest: String(sd.Destination || '').trim(), eta: sd.Eta, draught: sd.MaximumStaticDraught,
        callSign: String(sd.CallSign || '').trim(), imo, len, beam });
      return;
    }
    if (m.MessageType !== 'PositionReport') return;
    stats.positions++;
    const entry = mmsi.get(mm), named = entry ? null : byName.get(norm(meta.ShipName));
    if (!entry && (!named || strongFor(named.id))) return;     // not one of ours, or the ship is already confirmed elsewhere
    const pr = m.Message?.PositionReport || {};
    const lat = pr.Latitude ?? meta.latitude, lon = pr.Longitude ?? meta.longitude;
    if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180) || (lat === 0 && lon === 0)) return;
    const sog = pr.Sog >= 0 && pr.Sog < 102.3 ? pr.Sog : 0, cog = pr.Cog >= 0 && pr.Cog < 360 ? pr.Cog : 0;
    const hdg = pr.TrueHeading >= 0 && pr.TrueHeading < 360 ? pr.TrueHeading : cog, nav = pr.NavigationalStatus ?? 15;
    const p = [aisTime(meta.time_utc), +lat.toFixed(5), +lon.toFixed(5), +sog.toFixed(1), +cog.toFixed(1), hdg, nav, mm];
    if (entry) return addPing(entry.id, p);
    const w = pending.get(mm) || { id: named.id, pings: [] }; pending.set(mm, w);   // held until its static report confirms it
    const last = w.pings[w.pings.length - 1]; if (!last || p[0] - last[0] >= 2 * MIN) w.pings.push(p);
  };

  let result = { opened: false, error: 'No AISStream key has been added to the repository yet' };
  if (KEY) { log(`AIS: listening for ${LISTEN_S} s`); result = await listen(onMessage, LISTEN_S); }
  const end = Date.now(), route = await seaRouter();

  // Merge with the deployed copy. Old data survives only while its vessel is still assigned to the ship.
  const out = {};
  for (const ship of ships) {
    const id = ship.id, mm = anyFor(id)?.[0], old = prevShips[id] && prevShips[id].mmsi === mm ? prevShips[id] : null;
    const fresh = (pings.get(id) || []).filter((p) => p[7] === mm).map((p) => p.slice(0, 7));
    const byT = new Map([...(old?.track || []), ...fresh].map((p) => [p[0], p]));
    const track = thin([...byT.values()].sort((a, b) => a[0] - b[0]), end);
    if (!track.length) continue;
    const last = track[track.length - 1];
    const st = mm && statics.get(mm);
    let voyage = old?.voyage || null;
    if (st) {
      const eta = etaTime(st.eta, now);
      voyage = { dest: st.dest, at: st.at, port: ports.resolve(st.dest, last[1], last[2]), ...(eta ? { eta: eta.t, etaTimeKnown: eta.timeKnown } : {}),
        ...(st.draught > 0 ? { draught: st.draught } : {}), ...(st.callSign ? { callSign: st.callSign } : {}) };
    }
    const calls = mergeCalls(old?.calls, detectCalls(fresh.length ? track.filter((p) => p[0] >= fresh[0][0] - 8 * HOUR) : [], ports));
    const facts = st ? { ...(st.imo ? { imo: st.imo } : {}), ...(st.len > 20 ? { length: st.len, beam: st.beam } : {}) } : old?.ais;
    // Underway with a destination: the lane route there, for estimating where it is until it is heard again.
    let est = old?.est && old.est.from === last[0] ? old.est : null;
    const dp = voyage?.port, moving = last[3] >= 3 && last[6] !== 1 && last[6] !== 5;
    if (!est && moving && dp && dp.lat !== undefined && end - last[0] < 3 * 864e5 && voyage.at >= last[0] - 24 * HOUR && distNm(last[1], last[2], dp.lat, dp.lon) > 10) {
      const r = route(last[1], last[2], dp.lat, dp.lon); if (r) est = { from: last[0], to: dp.name, ...r };
    }
    out[id] = { mmsi: mm, by: mmsi.get(mm)?.by, track, ...(voyage ? { voyage } : {}), ...(est ? { est } : {}), ...(calls.length ? { calls } : {}), ...(facts && Object.keys(facts).length ? { ais: facts } : {}) };
  }
  const heardNow = [...pings.keys()].filter((id) => out[id]?.track.some((p) => end - p[0] < LISTEN_S * 1000 + MIN));
  const ok = !!KEY && result.opened && !(result.error && stats.messages === 0);
  const data = {
    schema: 2, generatedAt: new Date(end).toISOString(), status: !KEY ? 'no-key' : ok ? 'ok' : 'error', ...(ok ? {} : { error: result.error || 'AISStream sent no data' }),
    window: { seconds: KEY ? LISTEN_S : 0 }, stats: { ...stats, shipsHeard: heardNow.length, shipsKnown: Object.keys(out).length, estimated: Object.values(out).filter((o) => o.est).length },
    mmsi: Object.fromEntries(mmsi), blocked: [...blocked], ships: out,
  };
  await save('ais.json', data);
  if (DEBUG_AIS) {
    log(`AIS debug: ${dbg.size} passenger vessels sent static data`);
    for (const r of [...dbg.values()].slice(0, 120)) log(`  ${r.mmsi} ${JSON.stringify(r.name)} type=${r.type} imo=${r.imo} dest=${JSON.stringify(r.dest || '')}`);
  }
  const names = heardNow.map((id) => { const v = out[id].voyage; return `${byId.get(id).name}${v ? ` -> ${v.port?.name || JSON.stringify(v.dest)}` : ''}`; });
  return { ok, at: end, error: data.error, note: `${stats.messages} messages, ${heardNow.length} heard now, ${Object.keys(out).length} of ${ships.length} known: ${names.join('; ') || 'none'}` };
}

// ---------------------------------------------------------------- run
await mkdir(OUT, { recursive: true });
const status = { generatedAt: new Date().toISOString() };
const step = async (name, fn) => {
  try { status[name] = await fn(); } catch (e) { status[name] = { ok: false, error: errText(e) }; }
  const s = status[name]; log(`${name}: ${s.ok ? 'ok' : 'FAILED'}${s.error ? ` (${s.error})` : ''}${s.note ? ` - ${s.note}` : ''}`);
};
await Promise.all([
  step('forecast', () => weather('forecast', 'https://api.open-meteo.com/v1/forecast', 'wind_speed_10m,wind_direction_10m,cloud_cover,precipitation', '&wind_speed_unit=ms')),
  step('marine', () => weather('marine', 'https://marine-api.open-meteo.com/v1/marine', 'wave_height,sea_surface_temperature', '')),
  step('storms', storms),
  step('ais', ais),
]);
await save('status.json', status);
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = Object.entries(status).filter(([k]) => k !== 'generatedAt')
    .map(([k, s]) => `| ${k} | ${s.ok ? 'ok' : 'failed'} | ${(s.error || '').replace(/\|/g, '/')} | ${(s.note || '').replace(/\|/g, '/')} |`);
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Live data\n\n| Source | Result | Error | Detail |\n|---|---|---|---|\n${rows.join('\n')}\n`);
}
