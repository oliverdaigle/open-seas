export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// All formatting is done on a Date shifted by an offset and read with UTC getters, so port-local
// times never depend on the viewer's own time zone.
const at = (ms, tz = 0) => new Date(ms + tz * 36e5);
export const fmtDate = (ms, tz = 0) => { const d = at(ms, tz); return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
export const fmtDateY = (ms, tz = 0) => `${fmtDate(ms, tz)} ${at(ms, tz).getUTCFullYear()}`;
export const fmtTime = (ms, tz = 0) => { const d = at(ms, tz); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
export const fmtShort = (ms, tz = 0) => { const d = at(ms, tz); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
export const monthName = (m) => MON[m];
export const num = (n) => Math.round(n).toLocaleString('en-US');
export const shortPort = (name) => name.split(/[,(]/)[0].trim();
export function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  return s < 90 ? `${Math.round(s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
}
export function relative(t, now = Date.now()) {
  const d = (t - now) / 864e5, a = Math.abs(d);
  const txt = a < 1 / 24 ? `${Math.round(a * 1440)} min` : a < 2 ? `${Math.round(a * 24)} h` : a < 60 ? `${Math.round(a)} days` : `${Math.round(a / 30.4)} months`;
  return d < 0 ? `${txt} ago` : `in ${txt}`;
}
