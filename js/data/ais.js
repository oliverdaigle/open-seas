// AISAdapter: where ships actually are.
//   Demo  positions computed from itineraries in a web worker (DemoAISAdapter)
//   Live  AISStream.io pings collected every 20 minutes by GitHub Actions into data/live/ais.json,
//         plus, optionally, a real-time relay set in CONFIG.AIS_PROXY_URL (LiveAISAdapter)
// Every live ping is also written to IndexedDB, so real history builds up for the timeline to replay.
import { CONFIG } from '../config.js';
import { buildFleet, packStates, REC, TRAIL, SEA, PORT } from '../sim.js';
import { destination, gcPoint } from '../geo.js';
import { getJSON, setSource } from './sources.js';

export const SRC = { DEMO: 0, LIVE: 1, ESTIMATED: 2, STALE: 3, RECORDED: 4 };
export const SRC_LABEL = ['Demo', 'Live', 'Estimated', 'Stale', 'Recorded'];
const MIN = 6e4;

export class DemoAISAdapter {
  constructor(data, fleet) {
    this.fleet = fleet; this.buf = packStates(fleet, Date.now(), 3 * 36e5); this.t = 0; this.busy = false; this.worker = null;
    try {
      this.worker = new Worker(new URL('../sim.worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => { if (e.data.type === 'state') { this.buf = e.data.buf; this.t = e.data.t; this.busy = false; } };
      this.worker.onerror = () => { this.worker = null; this.busy = false; };
      this.worker.postMessage({ type: 'init', data: { ships: data.ships, ports: data.ports, templates: data.templates, sailings: data.sailings, routes: data.routes } });
    } catch { this.worker = null; }
  }
  // Ask for the fleet at time t. The answer lands in this.buf, at most a frame later.
  request(t, trailMs) {
    if (!this.worker) { this.buf = packStates(this.fleet, t, trailMs, this.buf); this.t = t; return; }
    if (this.busy) return;
    this.busy = true; this.worker.postMessage({ type: 'tick', t, trailMs });
  }
}

const norm = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export class LiveAISAdapter {
  constructor(fleet) {
    this.fleet = fleet; this.tracks = new Map(); this.byMmsi = new Map(); this.byName = new Map(); this.byImo = new Map();
    this.lastMsg = 0; this.count = 0; this.ws = null; this.db = null; this.retry = 2000;
    for (const s of fleet.ships) { this.byName.set(norm(s.name), s); if (s.imo) this.byImo.set(s.imo, s); }
  }
  async start() {
    await this.openDb().catch(() => {});
    await this.loadRecorded().catch(() => {});
    try { const m = await getJSON(`${CONFIG.DATA_BASE}mmsi.json`, 8000); for (const [mmsi, id] of Object.entries(m)) { const s = this.fleet.byId.get(id); if (s) this.byMmsi.set(String(mmsi), s); } } catch {}
    const snap = await this.loadSnapshot();
    setInterval(() => this.loadSnapshot(), 5 * MIN);
    if (CONFIG.AIS_PROXY_URL) this.connect();
    else if (!snap) setSource('ais', 'demo', 'No live positions collected yet. Ships follow demo itineraries.');
  }
  // Positions gathered by the GitHub Action. Returns true when the file had any.
  async loadSnapshot() {
    let j;
    try { j = await getJSON(`${CONFIG.LIVE_BASE}ais.json?v=${Math.floor(Date.now() / MIN)}`, 15000); } catch { return false; }
    if (!j || !j.tracks) return false;
    for (const [mmsi, m] of Object.entries(j.mmsi || {})) { const s = this.fleet.byId.get(m.id ?? m); if (s) this.byMmsi.set(String(mmsi), s); }
    for (const [id, pings] of Object.entries(j.tracks)) {
      if (!this.fleet.byId.has(id) || !pings.length) continue;
      let tr = this.tracks.get(id); if (!tr) this.tracks.set(id, tr = []);
      const have = new Set(tr.map((p) => p.t)); let added = false;
      for (const [t, lat, lon, sog, cog, hdg] of pings) {
        if (have.has(t) || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) continue;
        const p = { t, lat, lon, sog, cog, hdg }; tr.push(p); this.record(id, p); added = true;
      }
      if (added) tr.sort((a, b) => a.t - b.t);
    }
    const at = Date.parse(j.generatedAt) || Date.now(), now = Date.now();
    const recent = [...this.tracks.values()].filter((tr) => tr.length && now - tr[tr.length - 1].t < 60 * MIN).length;
    const total = this.fleet.ships.length;
    if (j.status && j.status !== 'ok' && !recent) { setSource('ais', j.status === 'no-key' ? 'demo' : 'error', `${j.error || 'The last collection failed'}. Ships follow demo itineraries.`, at); return false; }
    setSource('ais', recent ? 'live' : 'demo', recent
      ? `${recent} of ${total} ships seen by AIS in the last hour. Positions between collections are estimated from course and speed. The rest follow demo itineraries.`
      : `None of the ${total} ships was in range of an AIS receiver in the last hour. They follow demo itineraries.`, at);
    return true;
  }
  connect() {
    let ws;
    try { ws = new WebSocket(CONFIG.AIS_PROXY_URL); } catch (e) { setSource('ais', 'error', `Could not open ${CONFIG.AIS_PROXY_URL}: ${e.message}. Showing demo ships.`); return; }
    this.ws = ws; ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.retry = 2000; ws.send(JSON.stringify({ type: 'hello', mmsi: [...this.byMmsi.keys()] })); setSource('ais', 'live', 'Connected. Waiting for the first position reports.'); };
    ws.onmessage = (e) => { try { this.ingest(JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data))); } catch {} };
    ws.onclose = () => {
      setSource('ais', 'error', 'AIS connection closed. Showing demo ships and retrying.');
      setTimeout(() => this.connect(), this.retry); this.retry = Math.min(this.retry * 2, 60000);
    };
    ws.onerror = () => {};
  }
  ingest(m) {
    if (m.error) { setSource('ais', 'error', `AIS proxy: ${m.error}. Showing demo ships.`); return; }
    const meta = m.MetaData || {}, mmsi = String(meta.MMSI ?? meta.MMSI_String ?? '');
    let ship = this.byMmsi.get(mmsi);
    if (m.MessageType === 'ShipStaticData') {
      const sd = m.Message?.ShipStaticData || {};
      ship = ship || this.byImo.get(sd.ImoNumber) || this.byName.get(norm(sd.Name || meta.ShipName));
      if (ship) this.byMmsi.set(mmsi, ship);
      return;
    }
    if (m.MessageType !== 'PositionReport') return;
    ship = ship || this.byName.get(norm(meta.ShipName)); if (!ship) return;
    this.byMmsi.set(mmsi, ship);
    const pr = m.Message?.PositionReport || {}, lat = pr.Latitude ?? meta.latitude ?? meta.Latitude, lon = pr.Longitude ?? meta.longitude ?? meta.Longitude;
    if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) return;
    const t = Date.parse(meta.time_utc || '') || Date.now();
    const ping = { t, lat, lon, sog: pr.Sog ?? 0, cog: pr.Cog ?? 0, hdg: pr.TrueHeading < 360 ? pr.TrueHeading : (pr.Cog ?? 0) };
    let tr = this.tracks.get(ship.id); if (!tr) this.tracks.set(ship.id, tr = []);
    const last = tr[tr.length - 1];
    if (last && t <= last.t) return;
    // keep one point every two minutes in history, but always the newest ping
    if (last && tr.length > 1 && last.t - tr[tr.length - 2].t < 2 * MIN) tr[tr.length - 1] = ping; else { tr.push(ping); this.record(ship.id, ping); }
    this.lastMsg = Date.now(); this.count++;
    if (this.count % 25 === 1) setSource('ais', 'live', `${this.tracks.size} ships reporting live. Other ships follow their itineraries.`);
  }
  // Live or recorded position for a ship at time t, or null when the itinerary should be used instead.
  positionAt(shipId, t) {
    const tr = this.tracks.get(shipId); if (!tr || !tr.length) return null;
    let lo = 0, hi = tr.length - 1;
    if (t < tr[0].t) return null;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tr[m].t <= t) lo = m; else hi = m - 1; }
    const a = tr[lo], b = tr[lo + 1], now = Date.now();
    if (b) {
      if (b.t - a.t > 2 * 60 * MIN) return null;          // a gap too long to bridge: use the itinerary
      const f = (t - a.t) / (b.t - a.t), p = gcPoint([a.lat, a.lon], [b.lat, b.lon], f);
      return { lat: p[0], lon: p[1], hdg: a.hdg, sog: a.sog + (b.sog - a.sog) * f, src: now - t < 10 * MIN ? SRC.LIVE : SRC.RECORDED, seen: a.t };
    }
    const age = t - a.t;
    if (age > 6 * 60 * MIN) return null;
    if (age > 45 * MIN) return { lat: a.lat, lon: a.lon, hdg: a.hdg, sog: a.sog, src: SRC.STALE, seen: a.t };
    const p = destination(a.lat, a.lon, a.cog, a.sog * age / 36e5);     // dead reckoning between pings
    return { lat: p[0], lon: p[1], hdg: a.hdg, sog: a.sog, src: age > 5 * MIN ? SRC.ESTIMATED : SRC.LIVE, seen: a.t };
  }
  // Overlay live positions on a demo state buffer. modes[k] says where each ship's position came from.
  apply(buf, modes, seen, t) {
    modes.fill(SRC.DEMO);
    if (!this.tracks.size) return;
    this.fleet.ships.forEach((ship, k) => {
      const p = this.positionAt(ship.id, t); if (!p) return;
      const b = k * REC; buf[b] = p.lat; buf[b + 1] = p.lon; buf[b + 2] = p.hdg; buf[b + 3] = p.sog; buf[b + 4] = p.sog > 0.5 ? SEA : PORT;
      for (let j = 0; j < TRAIL; j++) { const q = this.positionAt(ship.id, t - (j + 1) * 12 * MIN) || p; buf[b + 8 + j * 2] = q.lat; buf[b + 9 + j * 2] = q.lon; }
      modes[k] = p.src; seen[k] = p.seen;
    });
  }
  // ---- history in IndexedDB ----
  openDb() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open('open-seas', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('pings', { keyPath: ['ship', 't'] });
      rq.onsuccess = () => { this.db = rq.result; res(); }; rq.onerror = () => rej(rq.error);
    });
  }
  record(ship, p) { try { this.db?.transaction('pings', 'readwrite').objectStore('pings').put({ ship, ...p }); } catch {} }
  loadRecorded() {
    return new Promise((res) => {
      if (!this.db) return res();
      const cutoff = Date.now() - 40 * 864e5, store = this.db.transaction('pings', 'readwrite').objectStore('pings');
      store.openCursor().onsuccess = (e) => {
        const c = e.target.result; if (!c) return res();
        const v = c.value;
        if (v.t < cutoff) c.delete(); else { let tr = this.tracks.get(v.ship); if (!tr) this.tracks.set(v.ship, tr = []); tr.push(v); }
        c.continue();
      };
    });
  }
}
export { buildFleet };
