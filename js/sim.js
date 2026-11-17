// Pure voyage simulation: turns itineraries + sea routes into a position for any ship at any time.
// Runs unchanged in the page, in the web worker and in Node (tools and tests).
import { llToVec, vecToLL, angle, bearing, NM_PER_RAD } from './geo.js';

export const TRAIL = 10;            // wake samples per ship
export const REC = 8 + TRAIL * 2;   // floats per ship in a state buffer
export const PORT = 1, SEA = 2;

const HOUR = 36e5;
const localToUtc = (date, day, hhmm, tz) => {
  const [y, m, d] = date.split('-').map(Number), [h, mi] = hhmm.split(':').map(Number);
  return Date.UTC(y, m - 1, d + day - 1, h, mi) - tz * HOUR;
};

export function buildFleet({ ships, ports, templates, sailings, routes }) {
  const geoms = new Map();
  const geom = (A, B) => {
    const k = `${A}>${B}`; let g = geoms.get(k);
    if (!g) {
      const r = routes[A < B ? k : `${B}>${A}`];
      let pts = r ? (A < B ? r.pts : r.pts.slice().reverse()) : [[ports[A].lat, ports[A].lon], [ports[B].lat, ports[B].lon]];
      const cum = [0], vec = pts.map((p) => llToVec(p[0], p[1]));
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + angle(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) * NM_PER_RAD);
      g = { pts, cum, vec, nm: cum[cum.length - 1], routed: !!r };
      geoms.set(k, g);
    }
    return g;
  };
  const fleet = ships.map((ship, index) => {
    const stops = [], voyages = [];
    for (const [date, tid] of sailings[ship.id] || []) {
      const t = templates[tid]; if (!t) continue;
      const v = { id: `${ship.id}_${date}`, shipId: ship.id, tid, date, name: t.name, region: t.region, nights: t.nights, i0: 0, i1: 0, dep: 0, arr: 0 };
      const vi = voyages.length;
      t.calls.forEach((c, ci) => {
        const tz = ports[c.port].tz;
        const arr = c.arr ? localToUtc(date, c.day, c.arr, tz) : null, dep = c.dep ? localToUtc(date, c.depDay || c.day, c.dep, tz) : null;
        const last = stops[stops.length - 1];
        if (ci === 0 && last && last.port === c.port && last.dep === null) { last.dep = dep; last.voyDep = vi; v.i0 = stops.length - 1; }
        else { if (ci === 0) v.i0 = stops.length; stops.push({ port: c.port, arr: arr ?? dep - 8 * HOUR, dep, voyArr: ci === 0 ? -1 : vi, voyDep: dep === null ? -1 : vi }); }
      });
      v.i1 = stops.length - 1; v.dep = stops[v.i0].dep; v.arr = stops[v.i1].arr;
      voyages.push(v);
    }
    for (let i = 0; i < stops.length - 1; i++) if (stops[i].dep !== null) stops[i].geom = geom(stops[i].port, stops[i + 1].port);
    return { ...ship, index, stops, voyages };
  });
  return { ships: fleet, byId: new Map(fleet.map((s) => [s.id, s])), ports, templates, geom };
}

// Where along a leg (0..1 of its distance) a ship is after fraction x of the leg's time.
// Ships ease out of and into port instead of teleporting to cruising speed.
function progress(x, dur) {
  const e = Math.min(0.12, (1.2 * HOUR) / dur), v0 = 1 / (1 - e);
  if (x < e) return [v0 * x * x / (2 * e), v0 * x / e];
  if (x > 1 - e) return [1 - v0 * (1 - x) * (1 - x) / (2 * e), v0 * (1 - x) / e];
  return [v0 * (x - e / 2), v0];
}
export function pointOnGeom(g, s, out) {
  const d = Math.max(0, Math.min(1, s)) * g.nm, cum = g.cum;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
  const seg = cum[hi] - cum[lo], f = seg > 0 ? (d - cum[lo]) / seg : 0, a = g.vec[lo], b = g.vec[hi];
  const w = seg / NM_PER_RAD;
  let k1 = 1 - f, k2 = f;
  if (w > 1e-6) { const sn = Math.sin(w); k1 = Math.sin((1 - f) * w) / sn; k2 = Math.sin(f * w) / sn; }
  const ll = vecToLL(a[0] * k1 + b[0] * k2, a[1] * k1 + b[1] * k2, a[2] * k1 + b[2] * k2);
  out.lat = ll[0]; out.lon = ll[1];
  out.hdg = f < 0.999 ? bearing(ll[0], ll[1], g.pts[hi][0], g.pts[hi][1]) : bearing(g.pts[lo][0], g.pts[lo][1], g.pts[hi][0], g.pts[hi][1]);
  return out;
}
export function stopIndexAt(ship, t) {
  const s = ship.stops; let lo = 0, hi = s.length - 1;
  if (!s.length || t < s[0].arr) return -1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (s[m].arr <= t) lo = m; else hi = m - 1; }
  return lo;
}
// Fills `out` with the ship's state at time t. status 0 means the ship has no schedule at that time.
export function stateAt(fleet, ship, t, out = {}) {
  out.status = 0; out.sog = 0; out.voy = -1; out.stop = -1; out.frac = 0;
  const i = stopIndexAt(ship, t); if (i < 0) return out;
  const st = ship.stops[i], port = fleet.ports[st.port];
  out.stop = i;
  if (st.dep === null || t <= st.dep) {
    if (st.dep === null && t > st.arr + 12 * HOUR) return out;
    out.status = PORT; out.lat = port.lat; out.lon = port.lon; out.voy = st.voyDep >= 0 ? st.voyDep : st.voyArr;
    out.hdg = st.geom ? bearing(port.lat, port.lon, st.geom.pts[1][0], st.geom.pts[1][1]) : 0;
    return out;
  }
  const nx = ship.stops[i + 1]; if (!nx || !st.geom) return out;
  const dur = nx.arr - st.dep, [s, vf] = progress((t - st.dep) / dur, dur);
  pointOnGeom(st.geom, s, out);
  out.status = SEA; out.voy = st.voyDep; out.frac = s; out.sog = st.geom.nm / (dur / HOUR) * vf;
  return out;
}
// State of every ship at time t, packed for the renderer: lat, lon, hdg, sog, status, voy, frac, stop, then the wake.
export function packStates(fleet, t, trailMs, buf = new Float32Array(fleet.ships.length * REC)) {
  const o = {}, step = trailMs / TRAIL;
  fleet.ships.forEach((ship, k) => {
    const b = k * REC; stateAt(fleet, ship, t, o);
    buf[b] = o.lat || 0; buf[b + 1] = o.lon || 0; buf[b + 2] = o.hdg || 0; buf[b + 3] = o.sog; buf[b + 4] = o.status; buf[b + 5] = o.voy; buf[b + 6] = o.frac; buf[b + 7] = o.stop;
    const lat = buf[b], lon = buf[b + 1], live = o.status;
    for (let j = 0; j < TRAIL; j++) {
      if (live) stateAt(fleet, ship, t - (j + 1) * step, o);
      buf[b + 8 + j * 2] = live && o.status ? o.lat : lat; buf[b + 9 + j * 2] = live && o.status ? o.lon : lon;
    }
  });
  return buf;
}
