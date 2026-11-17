// Where ships are, and where they say they are going. Everything here comes from AIS:
//   data/live/ais.json   collected every 20 minutes by GitHub Actions from AISStream.io (tools/collect.mjs):
//                        position pings, the destination and ETA each ship broadcasts, detected port calls
//   CONFIG.AIS_PROXY_URL optional real-time relay, merged in when set
//   IndexedDB            every ping this browser has seen, so the timeline can replay further back
// A ship AIS has not heard is not drawn. Nothing is simulated.
import { CONFIG } from '../config.js';
import { destination, gcPoint, distNm } from '../geo.js';
import { getJSON, setSource } from './sources.js';
import { REC, TRAIL, PORT, SEA } from '../fleet.js';

export const SRC = { NONE: 0, LIVE: 1, ESTIMATED: 2, RECENT: 3, RECORDED: 4, LAST: 5 };
export const SRC_LABEL = ['', 'Live', 'Estimated', 'Recent', 'Recorded', 'Last known'];
export const NAV = { 0: 'Under way', 1: 'At anchor', 2: 'Not under command', 3: 'Restricted manoeuvrability', 5: 'Moored', 8: 'Under way, sailing' };
const MIN = 6e4, HOUR = 36e5, DAY = 864e5;
const norm = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const stopped = (p) => p.nav === 5 || p.nav === 1 || p.sog < 0.6;

export class AIS {
  constructor(fleet) {
    this.fleet = fleet; this.tracks = new Map(); this.voyages = new Map(); this.calls = new Map(); this.info = new Map();
    this.byMmsi = new Map(); this.byName = new Map(); this.byImo = new Map(); this.portCache = new Map();
    this.generatedAt = 0; this.ws = null; this.db = null; this.retry = 2000;
    for (const s of fleet.ships) { this.byName.set(norm(s.name), s); if (s.imo) this.byImo.set(s.imo, s); }
  }
  async start() {
    await this.openDb().catch(() => {});
    await this.loadRecorded().catch(() => {});
    const ok = await this.loadSnapshot();
    setInterval(() => this.loadSnapshot(), 5 * MIN);
    if (CONFIG.AIS_PROXY_URL) this.connect();
    else if (!ok) setSource('ais', 'waiting', 'No positions collected yet. The collector runs every 20 minutes.');
  }

  // ---- the collected snapshot ----
  async loadSnapshot() {
    let j;
    try { j = await getJSON(`${CONFIG.LIVE_BASE}ais.json?v=${Math.floor(Date.now() / MIN)}`, 15000); } catch { return false; }
    if (!j || j.schema !== 2 || !j.ships) return false;
    const at = Date.parse(j.generatedAt) || Date.now(); this.generatedAt = at; this.status = j.status;
    for (const [mmsi, m] of Object.entries(j.mmsi || {})) { const s = this.fleet.byId.get(m.id); if (s) this.byMmsi.set(String(mmsi), s); }
    for (const [id, d] of Object.entries(j.ships)) {
      if (!this.fleet.byId.has(id)) continue;
      this.info.set(id, { mmsi: d.mmsi, by: d.by });
      if (d.voyage) this.voyages.set(id, d.voyage);
      if (d.calls) this.calls.set(id, d.calls);
      this.addPings(id, (d.track || []).map(([t, lat, lon, sog, cog, hdg, nav]) => ({ t, lat, lon, sog, cog, hdg, nav })), true);
    }
    const { live, week, total } = this.counts();
    if (j.status !== 'ok' && !week) { setSource('ais', j.status === 'no-key' ? 'waiting' : 'error', j.error || 'The last collection failed.', at); return false; }
    setSource('ais', j.status === 'ok' ? 'live' : 'error',
      `${j.status === 'ok' ? '' : `${j.error || 'The last collection failed'}. `}${live} of ${total} ships heard in the last hour, ${week} in the last week. AIS is picked up by coastal receivers, so ships far offshore are shown at their last known position until they are heard again.`, at);
    setSource('voyages', this.voyages.size ? 'live' : 'waiting', this.voyages.size
      ? `${this.voyages.size} ships have broadcast a destination. The crew types it into the ship's AIS, so it is the ship's own word on where it is going.`
      : 'No ship has broadcast its destination yet. Ships send it every 6 minutes.', at);
    return true;
  }
  addPings(id, pings, persist) {
    let tr = this.tracks.get(id); if (!tr) this.tracks.set(id, tr = []);
    const have = new Set(tr.map((p) => p.t)); let added = false;
    for (const p of pings) {
      if (have.has(p.t) || !(Math.abs(p.lat) <= 90) || !(Math.abs(p.lon) <= 180)) continue;
      tr.push(p); have.add(p.t); added = true; if (persist) this.record(id, p);
    }
    if (added) { tr.sort((a, b) => a.t - b.t); this.portCache.delete(id); }
  }
  counts(now = Date.now()) {
    let live = 0, week = 0;
    for (const tr of this.tracks.values()) { const t = tr[tr.length - 1]?.t; if (!t) continue; if (now - t < HOUR) live++; if (now - t < 7 * DAY) week++; }
    return { live, week, total: this.fleet.ships.length };
  }

  // ---- optional real-time relay ----
  connect() {
    let ws;
    try { ws = new WebSocket(CONFIG.AIS_PROXY_URL); } catch (e) { setSource('ais', 'error', `Could not open ${CONFIG.AIS_PROXY_URL}: ${e.message}`); return; }
    this.ws = ws; ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.retry = 2000; ws.send(JSON.stringify({ type: 'hello', mmsi: [...this.byMmsi.keys()] })); };
    ws.onmessage = (e) => { try { this.ingest(JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data))); } catch {} };
    ws.onclose = () => { setTimeout(() => this.connect(), this.retry); this.retry = Math.min(this.retry * 2, 60000); };
    ws.onerror = () => {};
  }
  ingest(m) {
    const meta = m.MetaData || {}, mmsi = String(meta.MMSI ?? ''); let ship = this.byMmsi.get(mmsi);
    if (m.MessageType === 'ShipStaticData') { const sd = m.Message?.ShipStaticData || {}; ship = ship || this.byImo.get(sd.ImoNumber); if (ship) this.byMmsi.set(mmsi, ship); return; }
    if (m.MessageType !== 'PositionReport' || !ship) return;
    const pr = m.Message?.PositionReport || {}, t = Date.parse(String(meta.time_utc || '').slice(0, 19).replace(' ', 'T') + 'Z') || Date.now();
    this.addPings(ship.id, [{ t, lat: pr.Latitude, lon: pr.Longitude, sog: pr.Sog ?? 0, cog: pr.Cog ?? 0, hdg: pr.TrueHeading < 360 ? pr.TrueHeading : (pr.Cog ?? 0), nav: pr.NavigationalStatus ?? 15 }], true);
  }

  // ---- positions ----
  // Where the ship was at time t according to AIS, or null when AIS has nothing for it.
  positionAt(id, t) {
    const tr = this.tracks.get(id); if (!tr || !tr.length || t < tr[0].t) return null;
    let lo = 0, hi = tr.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (tr[m].t <= t) lo = m; else hi = m - 1; }
    const a = tr[lo], b = tr[lo + 1], now = Date.now();
    if (b && b.t - a.t <= 3 * HOUR) {                                  // between two reports: follow the great circle
      const f = (t - a.t) / (b.t - a.t), p = gcPoint([a.lat, a.lon], [b.lat, b.lon], f);
      return { lat: p[0], lon: p[1], hdg: a.hdg, sog: a.sog + (b.sog - a.sog) * f, cog: a.cog, nav: a.nav, src: now - t < 10 * MIN ? SRC.LIVE : SRC.RECORDED, seen: a.t };
    }
    const age = t - a.t; if (age > 30 * DAY) return null;
    if (!stopped(a) && age <= 45 * MIN) {                              // shortly after a report: dead reckoning
      const p = destination(a.lat, a.lon, a.cog, a.sog * age / HOUR);
      return { lat: p[0], lon: p[1], hdg: a.hdg, sog: a.sog, cog: a.cog, nav: a.nav, src: age <= 5 * MIN ? SRC.LIVE : SRC.ESTIMATED, seen: a.t };
    }
    return { lat: a.lat, lon: a.lon, hdg: a.hdg, sog: a.sog, cog: a.cog, nav: a.nav, src: age <= 5 * MIN ? SRC.LIVE : age <= 6 * HOUR ? SRC.RECENT : SRC.LAST, seen: a.t };
  }
  // The fleet port (index into fleet.portCodes) a stopped ship is lying at, or -1.
  portIndex(id, p) {
    if (!stopped(p)) return -1;
    const c = this.portCache.get(id); if (c && c.seen === p.seen) return c.k;
    let k = -1, bd = 6;
    this.fleet.portCodes.forEach((code, i) => { const q = this.fleet.ports[code], d = distNm(p.lat, p.lon, q.lat, q.lon); if (d < bd) { bd = d; k = i; } });
    this.portCache.set(id, { seen: p.seen, k }); return k;
  }
  // Fill a renderer state buffer for time t. modes[k] says how each ship's position is known.
  apply(buf, modes, seen, t, trailMs) {
    const step = trailMs / TRAIL;
    this.fleet.ships.forEach((ship, k) => {
      const b = k * REC, p = this.positionAt(ship.id, t);
      if (!p) { buf[b + 4] = 0; modes[k] = SRC.NONE; seen[k] = 0; return; }
      buf[b] = p.lat; buf[b + 1] = p.lon; buf[b + 2] = p.hdg; buf[b + 3] = p.sog; buf[b + 4] = stopped(p) ? PORT : SEA; buf[b + 5] = p.src; buf[b + 7] = this.portIndex(ship.id, p);
      for (let j = 0; j < TRAIL; j++) {
        const q = p.src === SRC.LAST || p.src === SRC.RECENT ? null : this.positionAt(ship.id, t - (j + 1) * step);
        buf[b + 8 + j * 2] = q ? q.lat : p.lat; buf[b + 9 + j * 2] = q ? q.lon : p.lon;
      }
      modes[k] = p.src; seen[k] = p.seen;
    });
  }
  // The track sailed up to time t, as [[lat, lon], ...], for drawing.
  trackUntil(id, t, since = t - 7 * DAY) { return (this.tracks.get(id) || []).filter((p) => p.t <= t && p.t >= since).map((p) => [p.lat, p.lon]); }
  sailedNm(id, t, since) { const pts = this.trackUntil(id, t, since); let nm = 0; for (let i = 1; i < pts.length; i++) nm += distNm(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]); return nm; }
  lastSeen(id) { const tr = this.tracks.get(id); return tr && tr.length ? tr[tr.length - 1].t : 0; }

  // ---- history in IndexedDB ----
  openDb() {
    return new Promise((res, rej) => {
      const rq = indexedDB.open('open-seas', 2);
      rq.onupgradeneeded = () => { const db = rq.result; if (db.objectStoreNames.contains('pings')) db.deleteObjectStore('pings'); db.createObjectStore('pings', { keyPath: ['ship', 't'] }); };
      rq.onsuccess = () => { this.db = rq.result; res(); }; rq.onerror = () => rej(rq.error);
    });
  }
  record(ship, p) { try { this.db?.transaction('pings', 'readwrite').objectStore('pings').put({ ship, ...p }); } catch {} }
  loadRecorded() {
    return new Promise((res) => {
      if (!this.db) return res();
      const cutoff = Date.now() - 30 * DAY, store = this.db.transaction('pings', 'readwrite').objectStore('pings'), got = new Map();
      store.openCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (!c) { for (const [id, list] of got) this.addPings(id, list, false); return res(); }
        const { ship, ...p } = c.value;
        if (p.t < cutoff || !this.fleet.byId.has(ship)) c.delete(); else { if (!got.has(ship)) got.set(ship, []); got.get(ship).push(p); }
        c.continue();
      };
    });
  }
}
