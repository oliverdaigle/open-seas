// The timeline: scrub from 30 days back to 12 months ahead, play at four speeds, snap back to now.
import { $, $$, fmtDateY, fmtTime, monthName, relative } from './util.js';

const DAY = 864e5;
export class Timeline {
  constructor(app) {
    this.app = app; this.track = $('#tl-track'); this.cv = $('#tl-canvas'); this.head = $('#tl-head'); this.tip = $('#tl-tip');
    this.lastText = 0; this.lastDraw = 0;
    $('#tl-play').addEventListener('click', () => app.togglePlay());
    $('#tl-now').addEventListener('click', () => app.goNow());
    $$('.speeds button').forEach((b) => b.addEventListener('click', () => app.setRate(+b.dataset.rate)));
    const tAt = (e) => { const r = this.track.getBoundingClientRect(), f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); return app.time.min + f * (app.time.max - app.time.min); };
    let drag = false;
    this.track.addEventListener('pointerdown', (e) => { drag = true; this.track.setPointerCapture(e.pointerId); app.pause(); app.setTime(tAt(e)); });
    this.track.addEventListener('pointermove', (e) => {
      const t = tAt(e); if (drag) app.setTime(t);
      const r = this.track.getBoundingClientRect(); this.tip.hidden = false; this.tip.style.left = `${Math.max(60, Math.min(r.width - 60, e.clientX - r.left))}px`; this.tip.textContent = `${fmtDateY(t)} · ${relative(t)}`;
    });
    const end = () => { drag = false; }; this.track.addEventListener('pointerup', end); this.track.addEventListener('pointercancel', end);
    this.track.addEventListener('pointerleave', () => { this.tip.hidden = true; });
    this.track.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); app.pause(); app.setTime(app.time.t + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? DAY : 36e5)); } });
    window.addEventListener('keydown', (e) => {
      if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) return;
      if (e.key === ' ') { e.preventDefault(); app.togglePlay(); }
      else if (e.key === 'n' || e.key === 'N') app.goNow();
      else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && document.activeElement !== this.track) { app.pause(); app.setTime(app.time.t + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? DAY : 36e5)); }
    });
    window.addEventListener('resize', () => this.draw());
    this.draw();
  }
  draw() {
    const { min, max } = this.app.time, cv = this.cv, dpr = Math.min(2, window.devicePixelRatio || 1), w = this.track.clientWidth, h = this.track.clientHeight;
    if (!w) return;
    cv.width = w * dpr; cv.height = h * dpr; const c = cv.getContext('2d'); c.scale(dpr, dpr);
    const x = (t) => ((t - min) / (max - min)) * w, now = Date.now(), base = h - 14;
    c.fillStyle = 'rgba(255,181,71,0.10)'; c.fillRect(0, 0, x(now), base);
    c.fillStyle = 'rgba(95,212,230,0.07)'; c.fillRect(x(now), 0, w - x(now), base);
    const wx = this.app.weather.liveRange();
    if (wx) { c.fillStyle = 'rgba(95,212,230,0.9)'; c.fillRect(x(Math.max(min, wx[0])), base - 2, x(Math.min(max, wx[1])) - x(Math.max(min, wx[0])), 2); }
    c.font = '500 10px "Spline Sans Mono", ui-monospace, monospace'; c.textBaseline = 'alphabetic';
    const d = new Date(min); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
    for (; +d < max; d.setUTCMonth(d.getUTCMonth() + 1)) {
      const px = x(+d); if (px < 0) continue;
      c.fillStyle = 'rgba(150,190,230,0.35)'; c.fillRect(Math.round(px), 0, 1, base);
      c.fillStyle = d.getUTCMonth() === 0 ? '#e7eef7' : '#8ea2b8';
      if (w / ((max - min) / (30.4 * DAY)) > 34 || d.getUTCMonth() % 2 === 0) c.fillText(d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : monthName(d.getUTCMonth()).toUpperCase(), px + 4, h - 2);
    }
    // week ticks
    c.fillStyle = 'rgba(150,190,230,0.14)';
    for (let t = Math.ceil(min / (7 * DAY)) * 7 * DAY; t < max; t += 7 * DAY) c.fillRect(Math.round(x(t)), base - 6, 1, 6);
    c.fillStyle = '#ffb547'; c.fillRect(Math.round(x(now)) - 1, 0, 2, base);
    c.fillText('NOW', Math.min(w - 26, x(now) + 5), 10);
    this.lastDraw = now;
  }
  update() {
    const { t, min, max, live, playing, rate } = this.app.time, now = performance.now();
    this.head.style.left = `${((t - min) / (max - min)) * 100}%`;
    if (now - this.lastText < 120) return; this.lastText = now;
    $('#tl-date').textContent = fmtDateY(t); $('#tl-time').textContent = `${fmtTime(t)} UTC`;
    const m = $('#tl-mode'), real = Date.now(), near = Math.abs(t - real) < 3 * 6e4;
    m.textContent = near ? (live ? 'Live clock' : 'Now') : t < real ? `Past · ${relative(t, real)}` : `Future · ${relative(t, real)}`;
    m.className = `badge ${near ? 'now' : t < real ? '' : 'future'}`;
    const play = $('#tl-play'); play.textContent = playing ? 'Pause' : 'Play'; play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    $$('.speeds button').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.rate === rate)));
    $('#tl-wx').textContent = this.app.weather.covers(t) ? 'Weather: Open-Meteo, live' : 'Weather: modelled climatology';
    if (Date.now() - this.lastDraw > 60000) this.draw();
  }
}
