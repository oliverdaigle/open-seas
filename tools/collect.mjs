// Open Seas live-data collector. GitHub Actions runs it every 20 minutes (.github/workflows/live.yml)
// and deploys the site with the files it writes to data/live/:
//   ais.json       AISStream.io positions for the ships in data/ships.json   needs AISSTREAM_API_KEY
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
const LISTEN_S = Number(process.env.AIS_SECONDS || 150);
const FORCE_WEATHER = !!process.env.FORCE_WEATHER;
const MIN = 6e4, HOUR = 36e5;
const KEEP_MS = 24 * HOUR;          // ping history kept per ship
const STEP_MS = 2 * MIN;            // at most one stored ping per ship every two minutes
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
const norm = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const PASSENGER = (type) => type >= 60 && type <= 69;
// AISStream times look like "2026-11-17 14:15:16.123456789 +0000 UTC"
function aisTime(s) {
  const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(\.\d{1,3})?/.exec(s || '');
  return (m && Date.parse(`${m[1]}T${m[2]}${m[3] || ''}Z`)) || Date.now();
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

async function ais() {
  const ships = JSON.parse(await readFile(new URL('data/ships.json', ROOT), 'utf8'));
  const byId = new Map(ships.map((s) => [s.id, s])), byName = new Map(ships.map((s) => [norm(s.name), s]));
  const byImo = new Map(ships.filter((s) => s.imo).map((s) => [s.imo, s]));
  const prev = await previous('ais.json');
  const now = Date.now(), base = { schema: 1, generatedAt: new Date(now).toISOString() };

  // MMSI -> { id, by } where by is 'imo' (IMO number matched), 'type' (name matched and the vessel
  // says it carries passengers) or 'name' (name only). blocked: MMSIs known to be namesakes.
  const mmsi = new Map(Object.entries(prev?.mmsi || {}).filter(([, m]) => byId.has(m.id)));
  const blocked = new Set(prev?.blocked || []);
  const strongFor = (id) => [...mmsi.entries()].find(([, m]) => m.id === id && m.by !== 'name');
  const anyFor = (id) => [...mmsi.entries()].find(([, m]) => m.id === id);
  const drop = (mm) => { mmsi.delete(mm); blocked.add(mm); };

  const pings = new Map(), stats = { messages: 0, positions: 0, staticReports: 0, matchedPositions: 0 };
  const onMessage = (m) => {
    stats.messages++;
    const meta = m.MetaData || {}, mm = String(meta.MMSI ?? '');
    if (!mm || blocked.has(mm)) return;
    if (m.MessageType === 'ShipStaticData') {
      stats.staticReports++;
      const sd = m.Message?.ShipStaticData || {}, imo = +sd.ImoNumber || 0, type = +sd.Type || 0;
      const imoShip = imo && byImo.get(imo);
      if (imoShip) {                                   // an IMO match beats any name match
        for (const [k, v] of mmsi) if (v.id === imoShip.id && k !== mm) mmsi.delete(k);
        mmsi.set(mm, { id: imoShip.id, by: 'imo' });
        return;
      }
      const cur = mmsi.get(mm), ship = cur ? byId.get(cur.id) : byName.get(norm(sd.Name || meta.ShipName));
      if (!ship) return;
      if ((ship.imo && imo && imo !== ship.imo) || (type && !PASSENGER(type))) { if (cur) drop(mm); return; }   // a namesake
      if (PASSENGER(type) && !strongFor(ship.id)) {
        for (const [k, v] of mmsi) if (v.id === ship.id && k !== mm) mmsi.delete(k);
        mmsi.set(mm, { id: ship.id, by: 'type' });
      }
      return;
    }
    if (m.MessageType !== 'PositionReport') return;
    stats.positions++;
    let entry = mmsi.get(mm);
    if (!entry) {
      const ship = byName.get(norm(meta.ShipName));
      if (!ship || anyFor(ship.id)) return;          // unknown, or the ship already has a vessel assigned
      entry = { id: ship.id, by: 'name' }; mmsi.set(mm, entry);
    }
    const pr = m.Message?.PositionReport || {};
    const lat = pr.Latitude ?? meta.latitude, lon = pr.Longitude ?? meta.longitude;
    if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180) || (lat === 0 && lon === 0)) return;
    const sog = pr.Sog >= 0 && pr.Sog < 102.3 ? pr.Sog : 0, cog = pr.Cog >= 0 && pr.Cog < 360 ? pr.Cog : 0;
    const hdg = pr.TrueHeading >= 0 && pr.TrueHeading < 360 ? pr.TrueHeading : cog;
    const p = [aisTime(meta.time_utc), +lat.toFixed(5), +lon.toFixed(5), +sog.toFixed(1), +cog.toFixed(1), hdg, mm];
    let list = pings.get(entry.id); if (!list) pings.set(entry.id, list = []);
    const last = list[list.length - 1];
    if (last && p[0] <= last[0] && last[6] === mm) return;
    if (last && last[6] === mm && list.length > 1 && p[0] - list[list.length - 2][0] < STEP_MS) list[list.length - 1] = p;
    else list.push(p);
    stats.matchedPositions++;
  };

  let result = { opened: false, error: 'No AISStream key has been added to the repository yet' };
  if (KEY) { log(`AIS: listening for ${LISTEN_S} s`); result = await listen(onMessage, LISTEN_S); }

  // Merge with the deployed history. Old pings survive only if their vessel is still assigned to the ship.
  const owner = (id) => anyFor(id)?.[0];
  const tracks = {}, from = {};
  for (const ship of ships) {
    const id = ship.id, mm = owner(id);
    const old = prev?.tracks?.[id] && prev.from?.[id] && prev.from[id] === mm ? prev.tracks[id] : [];
    const fresh = (pings.get(id) || []).filter((p) => p[6] === mm).map((p) => p.slice(0, 6));
    const all = new Map([...old, ...fresh].filter((p) => now - p[0] < KEEP_MS).map((p) => [p[0], p]));
    if (!all.size) continue;
    tracks[id] = [...all.values()].sort((a, b) => a[0] - b[0]); from[id] = mm;
  }
  const seenNow = [...pings.keys()].filter((id) => tracks[id]?.some((p) => now - p[0] < LISTEN_S * 1000 + MIN));
  const ok = !!KEY && result.opened && !(result.error && stats.messages === 0);
  const data = {
    ...base, status: !KEY ? 'no-key' : ok ? 'ok' : 'error', ...(ok ? {} : { error: result.error || 'AISStream sent no data' }),
    window: { seconds: KEY ? LISTEN_S : 0 }, stats: { ...stats, shipsSeen: seenNow.length },
    mmsi: Object.fromEntries(mmsi), blocked: [...blocked], from, tracks,
  };
  await save('ais.json', data);
  return { ok, at: now, error: data.error, note: `${stats.messages} messages, ${seenNow.length} of ${ships.length} ships seen: ${seenNow.map((id) => byId.get(id).name).join(', ') || 'none'}` };
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
