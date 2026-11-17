// Spherical geometry helpers shared by the simulation, the renderer and the UI.
export const D2R = Math.PI / 180, R2D = 180 / Math.PI, NM_PER_RAD = 3440.065;

// lat/lon to a unit vector in the globe's frame (matches the texture mapping of a three.js sphere).
export function llToVec(lat, lon, r = 1, out = [0, 0, 0]) {
  const a = lat * D2R, b = lon * D2R, c = Math.cos(a) * r;
  out[0] = c * Math.cos(b); out[1] = Math.sin(a) * r; out[2] = -c * Math.sin(b);
  return out;
}
export function vecToLL(x, y, z) {
  const r = Math.hypot(x, y, z);
  return [Math.asin(Math.max(-1, Math.min(1, y / r))) * R2D, Math.atan2(-z, x) * R2D];
}
export function angle(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}
export const distNm = (lat1, lon1, lat2, lon2) => angle(lat1, lon1, lat2, lon2) * NM_PER_RAD;
export function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}
// Point f of the way along the great circle from a to b (both [lat, lon]).
export function gcPoint(a, b, f) {
  const w = angle(a[0], a[1], b[0], b[1]);
  if (w < 1e-9) return [a[0], a[1]];
  const s = Math.sin(w), k1 = Math.sin((1 - f) * w) / s, k2 = Math.sin(f * w) / s;
  const p = llToVec(a[0], a[1]), q = llToVec(b[0], b[1]);
  return vecToLL(p[0] * k1 + q[0] * k2, p[1] * k1 + q[1] * k2, p[2] * k1 + q[2] * k2);
}
// Destination from a start point, a bearing in degrees and a distance in nautical miles.
export function destination(lat, lon, brg, nm) {
  const d = nm / NM_PER_RAD, t = brg * D2R, p1 = lat * D2R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = lon * D2R + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 * R2D, ((l2 * R2D + 540) % 360) - 180];
}
// Densify a polyline so no step is longer than maxDeg along the great circle.
export function densify(pts, maxDeg = 1) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const n = Math.max(1, Math.ceil(angle(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) * R2D / maxDeg));
    for (let k = 1; k <= n; k++) out.push(k === n ? pts[i] : gcPoint(pts[i - 1], pts[i], k / n));
  }
  return out;
}
// Position of the sub-solar point for a UTC time in ms. Accurate to a fraction of a degree.
export function subSolar(ms) {
  const n = ms / 864e5 - 10957.5;
  const L = (280.46 + 0.9856474 * n) * D2R, g = (357.528 + 0.9856003 * n) * D2R;
  const lam = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R, eps = (23.439 - 4e-7 * n) * D2R;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)), dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  return [dec * R2D, ((ra * R2D - gmst) % 360 + 540) % 360 - 180];
}
export const fmtLat = (v) => `${Math.floor(Math.abs(v))}°${((Math.abs(v) % 1) * 60).toFixed(1).padStart(4, '0')}′${v >= 0 ? 'N' : 'S'}`;
export const fmtLon = (v) => `${Math.floor(Math.abs(v))}°${((Math.abs(v) % 1) * 60).toFixed(1).padStart(4, '0')}′${v >= 0 ? 'E' : 'W'}`;
export const compass = (deg) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(deg / 22.5) % 16];
