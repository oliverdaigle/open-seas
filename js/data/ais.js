// Where ships are, and where they say they are going. Everything here comes from AIS:
//   data/live/ais.json   collected every 20 minutes by GitHub Actions from AISStream.io (tools/collect.mjs):
//                        position pings, the destination and ETA each ship broadcasts, detected port calls
//   CONFIG.AIS_PROXY_URL optional real-time relay, merged in when set
//   IndexedDB            every ping this browser has seen, so the timeline can replay further back
// A ship AIS has not heard is not drawn. Between reports a ship that broadcast a destination is placed along
// the shipping-lane route there (worked out by the collector), timed to its broadcast ETA.
import { CONFIG } from '../config.js';
import { destination, gcPoint, distNm, bearing } from '../geo.js';
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
    this.fleet = fleet; this.tracks = new Map(); this.voyages = new Map(); this.calls = new Map(); this.info = new Map(); this.est = new Map(); this.facts = new Map();
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
      if (d.ais) this.facts.set(id, d.ais);
      if (d.est?.path?.length > 1) { const cum = [0]; for (let i = 1; i < d.est.path.length; i++) cum.push(cum[i - 1] + distNm(...d.est.path[i - 1], ...d.est.path[i])); this.est.set(id, { ...d.est, cum, total: cum[cum.length - 1] }); }
      else this.est.delete(id);
      this.addPings(id, (d.track || []).map(([t, lat, lon, sog, cog, hdg, nav]) => ({ t, lat, lon, sog, cog, hdg, nav })), true);
    }
    if (j.status !== 'ok' && !this.tracks.size) { setSource('ais', j.status === 'no-key' ? 'waiting' : 'error', j.error || 'The last collection failed.', at); return false; }
    setSource('ais', j.status === 'ok' ? 'live' : 'error',
      `${j.status === 'ok' ? '' : `${j.error || 'The last collection failed'}. `}Coastal receivers hear ships near land. Between reports, a ship that broadcast a destination is placed along the shipping lane to it, timed to its ETA; others are held at their last reported position.`, at);
    setSource('voyages', this.voyages.size ? 'live' : 'waiting', this.voyages.size
      ? 'The crew types the destination and ETA into the ship’s AIS, so it is the ship’s own word on where it is going.'
      : 'No destinations received yet. Ships send them every 6 minutes.', at);
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
    const e = !b && this.est.get(id);
    if (e && e.from === a.t && !stopped(a) && age > 5 * MIN) {        // along the lane to its broadcast destination
      const arr = this.arrival(id, a, e);
      if (t < arr.t) {
        const q = this.along(e, (t - a.t) / (arr.t - a.t));
        return { lat: q.lat, lon: q.lon, hdg: q.hdg, cog: q.hdg, sog: e.total / ((arr.t - a.t) / HOUR), nav: 0, src: SRC.ESTIMATED, seen: a.t, est: 'route', arr };
      }
      const end = e.path[e.path.length - 1];
      return { lat: end[0], lon: end[1], hdg: a.hdg, cog: a.cog, sog: 0, nav: 5, src: t - arr.t < 12 * HOUR ? SRC.ESTIMATED : SRC.LAST, seen: a.t, est: 'arrived', arr };
    }
    if (!stopped(a) && age <= 45 * MIN) {                              // shortly after a report: dead reckoning
      const p = destination(a.lat, a.lon, a.cog, a.sog * age / HOUR);
      return { lat: p[0], lon: p[1], hdg: a.hdg, sog: a.sog, cog: a.cog, nav: a.nav, src: age <= 5 * MIN ? SRC.LIVE : SRC.ESTIMATED, seen: a.t };
    }
    return { lat: a.lat, lon: a.lon, hdg: a.hdg, sog: a.sog, cog: a.cog, nav: a.nav, src: age <= 5 * MIN ? SRC.LIVE : age <= 6 * HOUR ? SRC.RECENT : SRC.LAST, seen: a.t };
  }
  // When an underway ship should reach the end of its lane route: its broadcast ETA when that is recent and
  // plausible (4 to 30 knots over the route), otherwise at its last reported speed.
  arrival(id, a, e) {
    const v = this.voyages.get(id);
    if (v?.eta && v.at >= a.t - DAY && v.eta > a.t + 10 * MIN) { const kn = e.total / ((v.eta - a.t) / HOUR); if (kn >= 4 && kn <= 30) return { t: v.eta, how: 'eta' }; }
    return { t: a.t + (e.total / Math.max(a.sog, 8)) * HOUR, how: 'speed', kn: Math.max(a.sog, 8) };
  }
  // The point fraction f of the way along a lane route, with the heading there and the index of its leg.
  along(e, f) {
    const d = Math.max(0, Math.min(1, f)) * e.total, c = e.cum; let i = 1;
    while (i < c.length - 1 && c[i] < d) i++;
    const a = e.path[i - 1], b = e.path[i], seg = c[i] - c[i - 1], p = gcPoint(a, b, seg > 0 ? (d - c[i - 1]) / seg : 0);
    return { lat: p[0], lon: p[1], hdg: bearing(a[0], a[1], b[0], b[1]), leg: i, left: e.total - d };
  }
  // The way still to go for the ship at time t: the rest of its lane route, or null.
  ahead(id, t, p) {
    const e = this.est.get(id), last = this.lastSeen(id);
    if (!p || !e || e.from !== last || t < e.from || p.est === 'arrived' || stopped(p)) return null;
    const a = (this.tracks.get(id) || []).at(-1), arr = this.arrival(id, a, e), q = this.along(e, (t - a.t) / (arr.t - a.t));
    return { path: [[p.lat, p.lon], ...e.path.slice(q.leg)], left: q.left, arr };
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
