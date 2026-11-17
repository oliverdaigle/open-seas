// WeatherAdapter: wind, cloud, rain, waves, sea temperature and tropical storms.
//   Live  Open-Meteo (forecast + marine), NASA GIBS, RainViewer, NOAA NHC. All keyless.
//         The GitHub Action also saves the Open-Meteo grids and NHC storms to data/live/, so every
//         visitor shares one fresh copy and the page still works where the APIs can't be reached.
//   Demo  a modelled climatology and one simulated storm, used per source whenever a request fails,
//         you are offline, or the selected time is outside what the live source covers.
import { CONFIG } from '../config.js';
import { getJSON, setSource } from './sources.js';
import { angle, bearing, destination, D2R, R2D, NM_PER_RAD } from '../geo.js';
import { ago } from '../ui/util.js';

const HOUR = 36e5, DAY = 864e5, KN = 1.94384;
const GX = 18, GY = 11;                       // live grid: every 20 degrees of longitude, 15 of latitude
export const FX = 72, FY = 36;                // render grid for overlays and wind particles (5 degrees)
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const bell = (x, c, w) => Math.exp(-(((x - c) / w) ** 2));

// ---- Demo: modelled climatology. Smooth, seasonal, plausible. Not observations. ----
export function climate(lat, lon, t, o = {}) {
  const season = Math.cos(2 * Math.PI * ((t / DAY - 15) % 365.25) / 365.25);   // +1 in northern winter
  const itcz = 5 - 6 * season, phi = lat - itcz, al = Math.abs(lat), winter = lat >= 0 ? season : -season;
  let u = -7 * bell(Math.abs(phi), 14, 11) + (8 + 3 * winter) * bell(al, 47, 13) - 2 * bell(al, 76, 8);
  let v = -Math.sign(phi) * 3 * bell(Math.abs(phi), 10, 9);
  const ph = 5 * lon * D2R - (2 * Math.PI * t) / (5 * DAY) + lat * 0.12, eddy = 6 * bell(al, 46, 15);
  u += eddy * Math.sin(ph); v += eddy * Math.cos(ph) * (lat >= 0 ? 1 : -1);
  const ph2 = 3 * lon * D2R + (2 * Math.PI * t) / (9 * DAY);
  u += 1.5 * Math.sin(ph2 + lat * 0.2); v += 1.5 * Math.cos(ph2);
  o.u = u; o.v = v;
  o.sst = clamp(30.5 * Math.cos(clamp((lat + 3 * season) * 1.04, -90, 90) * D2R) ** 2.3 - 1.8 + 1.2 * Math.sin(lon * D2R * 2 + 1), -1.8, 30.5);
  o.temp = o.sst - 1 + 3 * Math.sin(ph) * bell(al, 46, 20);
  o.cloud = clamp(0.22 + 0.5 * bell(phi, 0, 7) + 0.45 * bell(al, 53, 14) * (0.6 + 0.4 * Math.sin(ph)) + 0.12 * Math.sin(ph2 * 2), 0, 1);
  o.precip = Math.max(0, o.cloud - 0.62) * 5;
  o.wave = 0.4 + 0.19 * Math.hypot(u, v) + 0.8 * bell(al, 52, 12);
  return o;
}

export class Weather {
  constructor() {
    this.forecast = null; this.marine = null; this.liveStorms = null; this.demoStorms = []; this.radar = null;
    this._o = {}; this.listeners = new Set();
  }
  onChange(fn) { this.listeners.add(fn); }
  emit() { this.listeners.forEach((f) => f()); }

  async start() {
    try { const d = await getJSON(`${CONFIG.DATA_BASE}weather.demo.json`); this.demoStorms = d.storms.map((s) => ({ ...s, track: s.track.map((p) => ({ ...p, t: Date.parse(p.t) })) })); } catch {}
    const demo = (id, why) => setSource(id, 'demo', why);
    if (!CONFIG.LIVE_WEATHER) { ['wind', 'marine', 'clouds', 'radar', 'storms'].forEach((id) => demo(id, 'Live weather is switched off in js/config.js. Using modelled climatology.')); return; }
    ['wind', 'marine', 'clouds', 'radar', 'storms'].forEach((id) => demo(id, 'Loading…'));
    this.loadGrid('forecast', 'wind', 'https://api.open-meteo.com/v1/forecast', 'wind_speed_10m,wind_direction_10m,cloud_cover,precipitation', '&wind_speed_unit=ms');
    this.loadGrid('marine', 'marine', 'https://marine-api.open-meteo.com/v1/marine', 'wave_height,sea_surface_temperature', '');
    this.loadStorms(); this.loadRadar();
  }

  // ---- Live: coarse global grid from Open-Meteo, 7 days back and 7 ahead ----
  // Order: the collected snapshot if under 4 hours old, this browser's 3-hour cache, a direct call,
  // an older snapshot, and finally modelled climatology.
  async loadGrid(slot, source, url, vars, extra) {
    const key = `os.wx2.${slot}`;
    const use = (g, how) => { this[slot] = this.prep(g); setSource(source, 'live', `${how} ${this.gridDetail(g)}`, g.at); this.emit(); };
    const snap = await getJSON(`${CONFIG.LIVE_BASE}${slot}.json?v=${Math.floor(Date.now() / 6e5)}`, 15000).catch(() => null);
    const okSnap = snap && Array.isArray(snap.times) && snap.times.length > 1 && snap.v;
    if (okSnap && Date.now() - snap.at < 4 * HOUR) return use(snap, `Collected ${ago(snap.at)}.`);
    try { const c = JSON.parse(localStorage.getItem(key)); if (c && Date.now() - c.at < 3 * HOUR) return use(c, 'Saved in this browser.'); } catch {}
    const lats = [], lons = [];
    for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) { lats.push(-75 + 15 * j); lons.push(-180 + 20 * i); }
    try {
      const names = vars.split(','), out = { at: Date.now(), times: null, v: Object.fromEntries(names.map((n) => [n, []])) };
      for (let c = 0; c < lats.length; c += 99) {
        const q = `${url}?latitude=${lats.slice(c, c + 99).join(',')}&longitude=${lons.slice(c, c + 99).join(',')}&hourly=${vars}${extra}&past_days=7&forecast_days=7&timeformat=unixtime&timezone=GMT`;
        let res; try { res = await getJSON(q + '&temporal_resolution=hourly_6', 20000); } catch { res = await getJSON(q, 25000); }
        for (const loc of Array.isArray(res) ? res : [res]) {
          const tt = loc.hourly.time, stride = tt.length > 1 && tt[1] - tt[0] < 6 * 3600 ? Math.round(6 * 3600 / (tt[1] - tt[0])) : 1;
          if (!out.times) out.times = tt.filter((_, k) => k % stride === 0).map((s) => s * 1000);
          for (const n of names) out.v[n].push(loc.hourly[n].filter((_, k) => k % stride === 0).map((x) => (x === null ? null : Math.round(x * 10) / 10)));
        }
      }
      try { localStorage.setItem(key, JSON.stringify(out)); } catch {}
      use(out, 'Fetched by this browser.');
    } catch (e) {
      if (okSnap) return use(snap, `Collected ${ago(snap.at)}; Open-Meteo did not answer just now.`);
      setSource(source, 'demo', `Open-Meteo unreachable (${e.name === 'AbortError' ? 'timed out' : e.message}). Using modelled climatology.`);
    }
  }
  // Wind arrives as speed and direction. Convert to components once, so interpolating between
  // 350 and 10 degrees gives north instead of south.
  prep(g) {
    const sp = g.v.wind_speed_10m, dir = g.v.wind_direction_10m; if (!sp || g.v.u) return g;
    g.v.u = sp.map((row, i) => row.map((s, k) => (s === null || dir[i][k] === null ? null : -s * Math.sin(dir[i][k] * D2R))));
    g.v.v = sp.map((row, i) => row.map((s, k) => (s === null || dir[i][k] === null ? null : -s * Math.cos(dir[i][k] * D2R))));
    return g;
  }
  gridDetail(g) { const f = (ms) => new Date(ms).toISOString().slice(5, 10); return `Covers ${f(g.times[0])} to ${f(g.times.at(-1))} UTC. Other dates use modelled climatology.`; }
  liveRange() { const g = this.forecast; return g ? [g.times[0], g.times.at(-1)] : null; }
  covers(t) { const r = this.liveRange(); return !!r && t >= r[0] && t <= r[1]; }

  gridValue(g, name, lat, lon, t) {
    const T = g.times; if (t < T[0] || t > T[T.length - 1]) return null;
    const ft = (t - T[0]) / (T[1] - T[0]), k0 = Math.min(T.length - 2, Math.floor(ft)), kt = ft - k0;
    const fx = ((lon + 180) / 20 + GX) % GX, fy = clamp((lat + 75) / 15, 0, GY - 1);
    const x0 = Math.floor(fx) % GX, x1 = (x0 + 1) % GX, y0 = Math.min(GY - 2, Math.floor(fy)), ax = fx - Math.floor(fx), ay = fy - y0, arr = g.v[name];
    let sum = 0, wsum = 0;
    for (const [x, y, w] of [[x0, y0, (1 - ax) * (1 - ay)], [x1, y0, ax * (1 - ay)], [x0, y0 + 1, (1 - ax) * ay], [x1, y0 + 1, ax * ay]]) {
      const s = arr[y * GX + x], a = s[k0], b = s[k0 + 1]; if (a === null || b === null) continue;
      sum += (a + (b - a) * kt) * w; wsum += w;
    }
    return wsum > 0.2 ? sum / wsum : null;
  }

  // Weather at a point and time. o.live tells you whether the wind came from the live grid.
  sample(lat, lon, t, o = {}) {
    climate(lat, lon, t, o); o.live = false; o.liveSea = false;
    const g = this.forecast;
    if (g && t >= g.times[0] && t <= g.times[g.times.length - 1]) {
      const u = this.gridValue(g, 'u', lat, lon, t), v = this.gridValue(g, 'v', lat, lon, t);
      if (u !== null && v !== null) {
        o.u = u; o.v = v; o.live = true;
        const c = this.gridValue(g, 'cloud_cover', lat, lon, t), p = this.gridValue(g, 'precipitation', lat, lon, t);
        if (c !== null) o.cloud = c / 100; if (p !== null) o.precip = p;
      }
    }
    const m = this.marine;
    if (m && t >= m.times[0] && t <= m.times[m.times.length - 1]) {
      const w = this.gridValue(m, 'wave_height', lat, lon, t), s = this.gridValue(m, 'sea_surface_temperature', lat, lon, t);
      if (w !== null) { o.wave = w; o.liveSea = true; } if (s !== null) o.sst = s;
    }
    for (const st of this.stormsAt(t)) {          // wrap the storm's own circulation around it
      const d = angle(lat, lon, st.lat, st.lon) * NM_PER_RAD; if (d > 420) continue;
      const vmax = st.kt / KN, rm = 22, sp = d < rm ? vmax * d / rm : vmax * (rm / d) ** 0.62, k = clamp(1.3 - d / 420, 0, 1);
      const b = (bearing(st.lat, st.lon, lat, lon) + (st.lat >= 0 ? -90 - 20 : 90 + 20)) * D2R;
      o.u = o.u * (1 - k) + sp * Math.sin(b); o.v = o.v * (1 - k) + sp * Math.cos(b);
      o.wave = Math.max(o.wave, 1 + 0.16 * sp * KN * 0.5); o.cloud = Math.max(o.cloud, k); o.precip = Math.max(o.precip, 14 * k * k);
    }
    return o;
  }
  // Fill a FX x FY grid (5 degree cells, row 0 at 87.5 S) with one field for the overlay textures.
  field(name, t, out) {
    const o = this._o;
    for (let j = 0; j < FY; j++) for (let i = 0; i < FX; i++) {
      this.sample(-87.5 + 5 * j, -177.5 + 5 * i, t, o);
      out[j * FX + i] = name === 'u' ? o.u : name === 'v' ? o.v : o[name];
    }
    return out;
  }

  // ---- Storms ----
  async loadStorms() {
    const parse = (list) => (list || []).map((st) => ({
      id: st.id, name: `${st.classification === 'HU' ? 'Hurricane' : st.classification === 'TS' ? 'Tropical Storm' : 'Tropical Depression'} ${st.name}`,
      lat: +st.latitudeNumeric, lon: +st.longitudeNumeric, kt: +st.intensity || 30, dir: +st.movementDir || 0, speedKt: (+st.movementSpeed || 0) * 0.869, at: Date.parse(st.lastUpdate) || Date.now(),
    })).filter((st) => isFinite(st.lat) && isFinite(st.lon));
    let list = null, how = '', at = Date.now();
    try { list = parse((await getJSON('https://www.nhc.noaa.gov/CurrentStorms.json', 9000)).activeStorms); how = 'Fetched by this browser.'; }
    catch {
      try {
        const j = await getJSON(`${CONFIG.LIVE_BASE}storms.json?v=${Math.floor(Date.now() / 6e5)}`, 9000);
        if (Array.isArray(j.activeStorms) && Date.now() - Date.parse(j.fetchedAt) < 24 * HOUR) { list = parse(j.activeStorms); at = Date.parse(j.fetchedAt); how = `Collected ${ago(at)}.`; }
      } catch {}
    }
    if (!list) { this.liveStorms = null; setSource('storms', 'demo', 'NHC feed unreachable. Showing one simulated storm, clearly labelled.'); return; }
    this.liveStorms = list;
    setSource('storms', 'live', `${how} ${list.length ? `${list.length} active: ${list.map((st) => st.name).join(', ')}. Cones are projected from current motion, not the official NHC cone.` : 'No active tropical cyclones in the Atlantic or eastern Pacific.'}`, at);
    this.emit();
  }
  // Storms that exist at time t, each with a forecast: [{h, lat, lon, kt}] every 12 h out to 120 h.
  stormsAt(t) {
    if (this._st && Math.abs(this._stT - t) < 5 * 6e4) return this._st;
    const out = [];
    if (this.liveStorms) {
      for (const s of this.liveStorms) {
        const dt = (t - s.at) / HOUR; if (dt < -6 || dt > 120) continue;
        const at = (h) => { const p = destination(s.lat, s.lon, s.dir, s.speedKt * h); return { h: h - Math.max(0, dt), lat: p[0], lon: p[1], kt: s.kt }; };
        const now = at(Math.max(0, dt)), fc = []; for (let h = 12; h <= 120; h += 12) fc.push({ ...at(Math.max(0, dt) + h), h });
        out.push({ id: s.id, name: s.name, simulated: false, lat: now.lat, lon: now.lon, kt: s.kt, forecast: fc });
      }
    } else {
      for (const s of this.demoStorms) {
        const tr = s.track; if (t < tr[0].t || t > tr[tr.length - 1].t) continue;
        const at = (tt) => { let i = 0; while (i < tr.length - 2 && tr[i + 1].t <= tt) i++; const a = tr[i], b = tr[i + 1], f = clamp((tt - a.t) / (b.t - a.t), 0, 1); return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, kt: a.kt + (b.kt - a.kt) * f }; };
        const fc = []; for (let h = 12; h <= 120; h += 12) if (t + h * HOUR <= tr[tr.length - 1].t) fc.push({ h, ...at(t + h * HOUR) });
        out.push({ id: s.id, name: s.name, simulated: true, ...at(t), forecast: fc });
      }
    }
    this._st = out; this._stT = t; return out;
  }
  static coneRadiusNm(h) { return 22 + 1.45 * h; }

  // ---- Imagery ----
  // True-colour satellite mosaic for a past UTC date, or null when the date is today or later.
  cloudImageUrl(t) {
    const day = Math.floor(t / DAY) * DAY; if (!CONFIG.LIVE_WEATHER || day >= Math.floor(Date.now() / DAY) * DAY) return null;
    return `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=VIIRS_SNPP_CorrectedReflectance_TrueColor&STYLES=&SRS=EPSG:4326&BBOX=-180,-90,180,90&WIDTH=2048&HEIGHT=1024&FORMAT=image/jpeg&TIME=${new Date(day).toISOString().slice(0, 10)}`;
  }
  async loadRadar() {
    try {
      const j = await getJSON('https://api.rainviewer.com/public/weather-maps.json', 9000), f = j.radar.past.at(-1);
      this.radar = { time: f.time * 1000, tile: (z, x, y) => `${j.host}${f.path}/256/${z}/${x}/${y}/2/1_1.png` };
      setSource('radar', 'live', 'Latest radar mosaic, shown when the timeline is within two hours of now.', this.radar.time); this.emit();
    } catch (e) { setSource('radar', 'demo', 'RainViewer unreachable. Rain layer uses the forecast grid or climatology.'); }
  }

  // ---- Conditions at one ship, for the detail panel ----
  async pointWeather(lat, lon, t) {
    const o = this.sample(lat, lon, t, {}), sp = Math.hypot(o.u, o.v);
    const base = { windKn: sp * KN, windDir: (Math.atan2(-o.u, -o.v) * R2D + 360) % 360, waveM: o.wave, sstC: o.sst, tempC: o.temp, cloud: o.cloud * 100, precip: o.precip, source: o.live ? 'Open-Meteo grid (interpolated)' : 'Modelled climatology', live: o.live };
    if (!CONFIG.LIVE_WEATHER || Math.abs(t - Date.now()) > 14 * DAY) return base;
    const hour = new Date(Math.round(t / HOUR) * HOUR).toISOString().slice(0, 13) + ':00', q = `latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&start_hour=${hour}&end_hour=${hour}&timezone=GMT`;
    try {
      const [a, m] = await Promise.all([
        getJSON(`https://api.open-meteo.com/v1/forecast?${q}&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,cloud_cover,precipitation&wind_speed_unit=kn`, 7000),
        getJSON(`https://marine-api.open-meteo.com/v1/marine?${q}&hourly=wave_height,sea_surface_temperature`, 7000).catch(() => null),
      ]);
      const h = a.hourly, hm = m?.hourly;
      return { windKn: h.wind_speed_10m[0], windDir: h.wind_direction_10m[0], tempC: h.temperature_2m[0], cloud: h.cloud_cover[0], precip: h.precipitation[0],
        waveM: hm?.wave_height?.[0] ?? base.waveM, sstC: hm?.sea_surface_temperature?.[0] ?? base.sstC, source: 'Open-Meteo', live: true };
    } catch { return base; }
  }
}
