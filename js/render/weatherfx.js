// Weather drawn on the globe: wind particles, clouds, rain, sea temperature, wave height, storm cones.
import { llToVec, destination, bearing, D2R, R2D, NM_PER_RAD } from '../geo.js';
import { Weather, FX, FY } from '../data/weather.js';
import { setSource } from '../data/sources.js';
import { WATER_GLSL } from './globe.js';

const THREE = window.THREE;
const lerp3 = (stops, x) => {
  x = Math.max(0, Math.min(1, x)) * (stops.length - 1); const i = Math.min(stops.length - 2, Math.floor(x)), f = x - i, a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
};
// colour ramps: [r, g, b, alpha] stops across each field's range
export const RAMPS = {
  sst: { min: -2, max: 31, unit: '°C', label: 'Sea-surface temperature', stops: [[40, 30, 140, 190], [30, 110, 220, 190], [40, 200, 210, 185], [120, 220, 110, 185], [250, 220, 70, 190], [245, 120, 40, 200], [200, 40, 50, 205]] },
  waves: { min: 0, max: 8, unit: 'm', label: 'Significant wave height', stops: [[20, 60, 120, 0], [30, 150, 190, 120], [90, 220, 200, 170], [250, 230, 120, 190], [250, 130, 90, 205], [220, 60, 160, 215]] },
  precip: { min: 0, max: 8, unit: 'mm/h', label: 'Precipitation', stops: [[60, 120, 255, 0], [70, 140, 255, 110], [80, 220, 255, 170], [130, 255, 160, 200], [255, 240, 90, 220], [255, 110, 60, 235]] },
};
export const rampCss = (name) => `linear-gradient(90deg, ${RAMPS[name].stops.map((s) => `rgba(${s[0]},${s[1]},${s[2]},${Math.max(0.25, s[3] / 255)})`).join(',')})`;

const OVERLAY_VS = `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const OVERLAY_FS = `uniform sampler2D tField; uniform float uOpacity, uMask, uMerc; varying vec2 vUv; ${WATER_GLSL}
  void main() {
    vec2 uv = vUv;
    if (uMerc > 0.5) { float lat = (vUv.y - 0.5) * 3.14159265; if (abs(lat) > 1.47) discard; uv.y = 0.5 + log(tan(0.78539816 + lat * 0.5)) / 6.2831853; }
    vec4 c = texture2D(tField, uv);
    float a = c.a * uOpacity * mix(1.0, smoothstep(0.4, 0.6, waterAt(vUv)), uMask);
    if (a < 0.004) discard; gl_FragColor = vec4(c.rgb, a);
  }`;
const CLOUD_FS = `uniform float uTime, uSpin, uSpin2, uOpacity, uSat; uniform vec3 uSun; uniform vec4 uStorm; uniform sampler2D tSat; varying vec2 vUv; varying vec3 vP;
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
  float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + vec3(1.7); a *= 0.5; } return s; }
  void main() {
    vec3 p = normalize(vP); float lat = asin(clamp(p.y, -1.0, 1.0)), d;
    if (uSat > 0.5) { vec3 c = texture2D(tSat, vUv).rgb; d = smoothstep(0.45, 0.88, min(c.r, min(c.g, c.b))); }
    else {
      // two cloud decks: the tropics drift west with the trades, the mid-latitudes east with the westerlies
      float ca = cos(uTime), sa = sin(uTime), cb = cos(-uSpin2), sb = sin(-uSpin2);
      vec3 q1 = vec3(p.x * ca - p.z * sa, p.y, p.x * sa + p.z * ca) * 4.2, q2 = vec3(p.x * cb - p.z * sb, p.y + 3.0, p.x * sb + p.z * cb) * 4.6;
      q1 += 0.32 * vec3(noise(q1 * 2.0 + 3.0), 0.0, noise(q1 * 2.0 + 11.0));
      float band = 0.2 * exp(-pow(lat / 0.14, 2.0)) + 0.2 * exp(-pow((abs(lat) - 0.92) / 0.3, 2.0)) - 0.15 * exp(-pow((abs(lat) - 0.43) / 0.16, 2.0));
      d = smoothstep(0.5, 0.8, mix(fbm(q1), fbm(q2), smoothstep(0.35, 0.6, abs(lat))) + band) * (0.72 + 0.28 * noise(q1 * 9.0));
    }
    if (uStorm.w > 0.0) {
      vec3 s = uStorm.xyz, e1 = normalize(cross(vec3(0.0, 1.0, 0.0), s)), e2 = cross(s, e1);
      float r = acos(clamp(dot(p, s), -1.0, 1.0)) / 0.085, th = atan(dot(p, e2), dot(p, e1)) * sign(s.y + 0.0001);
      float arms = 0.5 + 0.5 * sin(th * 2.0 + log(r + 0.06) * 5.5 - uSpin);
      float body = exp(-r * r * 1.3) * (0.5 + 0.5 * arms) + exp(-r * r * 9.0);
      d = max(d, min(1.0, body * 1.5) * uStorm.w) * mix(1.0, smoothstep(0.03, 0.09, r), uStorm.w);
    }
    float light = smoothstep(-0.15, 0.3, dot(p, uSun));
    vec3 col = mix(vec3(0.05, 0.07, 0.12), vec3(1.0), light) * (0.82 + 0.18 * d);
    gl_FragColor = vec4(col, d * uOpacity * mix(0.4, 1.0, light));
  }`;

export class WeatherFX {
  constructor(globe, weather) {
    this.globe = globe; this.weather = weather;
    this.layers = { wind: true, clouds: true, precip: false, sst: false, waves: false, storms: true };
    this.u = new Float32Array(FX * FY); this.v = new Float32Array(FX * FY); this.tmp = new Float32Array(FX * FY);
    this.fieldT = -1e18; this.dirty = true; this.stormKey = ''; this.storms = [];
    weather.onChange(() => (this.dirty = true));
    // overlays reuse the Earth's own mesh, scaled up, so they follow its facets exactly and never dip through it
    const sphere = (r) => { const m = new THREE.Mesh(globe.earth.geometry); m.scale.setScalar(r); return m; };
    const overlay = (r, order) => {
      const tex = new THREE.DataTexture(new Uint8Array(FX * FY * 4), FX, FY); tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.wrapS = THREE.RepeatWrapping; tex.needsUpdate = true;
      const mesh = sphere(r); mesh.material = (new THREE.ShaderMaterial({ uniforms: { tField: { value: tex }, uOpacity: { value: 0.8 }, uMask: { value: 1 }, uMerc: { value: 0 }, ...globe.water }, vertexShader: OVERLAY_VS, fragmentShader: OVERLAY_FS, transparent: true, depthWrite: false }));
      mesh.renderOrder = order; mesh.visible = false; globe.scene.add(mesh); return { mesh, tex };
    };
    this.ov = { sst: overlay(1.0004, 1), waves: overlay(1.0005, 2), precip: overlay(1.0045, 4) };
    this.ov.precip.mesh.material.uniforms.uMask.value = 0; this.gridPrecipTex = this.ov.precip.tex;
    // clouds
    this.cloudU = { uTime: { value: 0 }, uSpin: { value: 0 }, uSpin2: { value: 0 }, uOpacity: { value: 0.9 }, uSat: { value: 0 }, uSun: { value: globe.sun }, uStorm: { value: new THREE.Vector4(0, 1, 0, 0) }, tSat: { value: this.ov.sst.tex } };
    this.clouds = sphere(1.006); this.clouds.material = (new THREE.ShaderMaterial({ uniforms: this.cloudU, vertexShader: `varying vec2 vUv; varying vec3 vP; void main() { vUv = uv; vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`, fragmentShader: CLOUD_FS, transparent: true, depthWrite: false }));
    this.clouds.renderOrder = 5; globe.scene.add(this.clouds);
    this.satDay = null; this.satWant = null; this.satTimer = 0;
    // wind particles
    const small = Math.min(window.innerWidth, window.innerHeight) < 600;
    this.N = small ? 1600 : 4200; this.H = 10;
    this.pl = new Float32Array(this.N * 2); this.age = new Float32Array(this.N); this.life = new Float32Array(this.N); this.spd = new Float32Array(this.N);
    this.hist = new Float32Array(this.N * this.H * 3);
    const segs = this.N * (this.H - 1);
    this.windGeo = new THREE.BufferGeometry();
    this.windGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs * 6), 3)); this.windGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(segs * 6), 3));
    this.wind = new THREE.LineSegments(this.windGeo, new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    this.wind.frustumCulled = false; this.wind.renderOrder = 3; globe.scene.add(this.wind);
    for (let i = 0; i < this.N; i++) this.spawn(i, true);
    // storms
    this.stormGroup = new THREE.Group(); this.stormGroup.renderOrder = 6; globe.scene.add(this.stormGroup);
  }
  spawn(i, randomAge) {
    const lat = Math.asin(Math.random() * 1.9 - 0.95) * R2D, lon = Math.random() * 360 - 180, v = llToVec(lat, lon, 1.003);
    this.pl[i * 2] = lat; this.pl[i * 2 + 1] = lon; this.life[i] = 2.5 + Math.random() * 4; this.age[i] = randomAge ? Math.random() * this.life[i] : 0;
    for (let h = 0; h < this.H; h++) this.hist.set(v, (i * this.H + h) * 3);
  }
  grid(arr, lat, lon) {
    const fx = ((lon + 177.5) / 5 + FX) % FX, fy = Math.max(0, Math.min(FY - 1.001, (lat + 87.5) / 5)), x0 = Math.floor(fx) % FX, x1 = (x0 + 1) % FX, y0 = Math.floor(fy), ax = fx - Math.floor(fx), ay = fy - y0;
    return (arr[y0 * FX + x0] * (1 - ax) + arr[y0 * FX + x1] * ax) * (1 - ay) + (arr[(y0 + 1) * FX + x0] * (1 - ax) + arr[(y0 + 1) * FX + x1] * ax) * ay;
  }
  paint(name, field) {
    const r = RAMPS[name], { tex } = name === 'precip' ? { tex: this.gridPrecipTex } : this.ov[name], d = tex.image.data;
    this.weather.field(field, this.fieldT, this.tmp);
    for (let k = 0; k < FX * FY; k++) { const c = lerp3(r.stops, (this.tmp[k] - r.min) / (r.max - r.min)); d[k * 4] = c[0]; d[k * 4 + 1] = c[1]; d[k * 4 + 2] = c[2]; d[k * 4 + 3] = c[3]; }
    tex.needsUpdate = true;
  }
  refresh(t) {
    this.fieldT = t; this.dirty = false;
    this.weather.field('u', t, this.u); this.weather.field('v', t, this.v);
    if (this.layers.sst) this.paint('sst', 'sst');
    if (this.layers.waves) this.paint('waves', 'wave');
    if (this.layers.precip) {
      this.paint('precip', 'precip');
      const rad = this.weather.radar, u = this.ov.precip.mesh.material.uniforms, useRadar = rad && Math.abs(t - Date.now()) < 2 * 36e5;
      if (useRadar && !this.radarTex && !this.radarTried) this.loadRadar(rad);
      const on = useRadar && this.radarTex; u.tField.value = on ? this.radarTex : this.gridPrecipTex; u.uMerc.value = on ? 1 : 0;
    }
  }
  loadRadar(rad) {
    this.radarTried = true;
    const cv = document.createElement('canvas'); cv.width = cv.height = 1024; const ctx = cv.getContext('2d'); let left = 16, failed = false;
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) {
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => { ctx.drawImage(img, x * 256, y * 256); if (--left === 0 && !failed) { try { this.radarTex = new THREE.CanvasTexture(cv); this.radarTex.wrapS = THREE.RepeatWrapping; this.dirty = true; } catch { setSource('radar', 'demo', 'Radar tiles could not be used. Rain layer uses the forecast grid.'); } } };
      img.onerror = () => { if (!failed) { failed = true; setSource('radar', 'demo', 'Radar tiles failed to load. Rain layer uses the forecast grid.'); } };
      img.src = rad.tile(2, x, y);
    }
  }
  loadSat(t) {
    const url = this.weather.cloudImageUrl(t), day = Math.floor(t / 864e5);
    if (!url) { this.cloudU.uSat.value = 0; this.satDay = null; if (this.weather.cloudImageUrl(Date.now() - 2 * 864e5)) setSource('clouds', 'demo', 'Satellite imagery exists for past dates only. Today and the future use modelled clouds.'); return; }
    if (day === this.satDay || day === this.satWant) return;
    this.satWant = day;
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (this.satWant !== day) return;
      try { const tx = new THREE.Texture(img); tx.needsUpdate = true; this.satTex?.dispose(); this.satTex = tx; this.cloudU.tSat.value = tx; this.cloudU.uSat.value = 1; this.satDay = day; setSource('clouds', 'live', `VIIRS true-colour mosaic for ${new Date(day * 864e5).toISOString().slice(0, 10)}.`); } catch { this.cloudU.uSat.value = 0; }
    };
    img.onerror = () => { this.satWant = null; this.satDay = day; this.cloudU.uSat.value = 0; setSource('clouds', 'demo', 'NASA GIBS unreachable. Using modelled clouds.'); };
    img.src = url;
  }
  buildStorms(storms) {
    const g = this.stormGroup; while (g.children.length) { const c = g.children.pop(); c.geometry.dispose(); }
    for (const s of storms) {
      const pts = [{ h: 0, lat: s.lat, lon: s.lon }, ...s.forecast]; if (pts.length < 2) continue;
      const left = [], right = [], centre = [];
      pts.forEach((p, i) => {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], brg = bearing(a.lat, a.lon, b.lat, b.lon), r = Weather.coneRadiusNm(p.h);
        left.push(destination(p.lat, p.lon, brg - 90, r)); right.push(destination(p.lat, p.lon, brg + 90, r)); centre.push(p);
        if (i === pts.length - 1) for (let k = 1; k < 8; k++) { left.push(destination(p.lat, p.lon, brg - 90 + k * 22.5, r)); }
      });
      const V = (p, r = 1.0035) => llToVec(p[0] ?? p.lat, p[1] ?? p.lon, r), tri = [];
      const cap = left.splice(pts.length);          // the rounded end
      for (let i = 0; i < pts.length - 1; i++) tri.push(...V(left[i]), ...V(right[i]), ...V(left[i + 1]), ...V(right[i]), ...V(right[i + 1]), ...V(left[i + 1]));
      const end = pts[pts.length - 1], ring = [left[left.length - 1], ...cap, right[right.length - 1]];
      for (let i = 0; i < ring.length - 1; i++) tri.push(...V(end), ...V(ring[i]), ...V(ring[i + 1]));
      const cone = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xff5a4f, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide }));
      cone.geometry.setAttribute('position', new THREE.Float32BufferAttribute(tri, 3)); cone.frustumCulled = false; g.add(cone);
      const outline = [...left, ...cap, ...right.slice().reverse(), left[0]].flatMap((p) => V(p, 1.0037));
      const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff8a7a, transparent: true, opacity: 0.85, depthWrite: false }));
      line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(outline, 3)); line.frustumCulled = false; g.add(line);
      const track = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false }));
      track.geometry.setAttribute('position', new THREE.Float32BufferAttribute(centre.flatMap((p) => V(p, 1.0039)), 3)); track.frustumCulled = false; g.add(track);
      const dots = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffffff, size: 5, sizeAttenuation: false, depthWrite: false }));
      dots.geometry.setAttribute('position', new THREE.Float32BufferAttribute(centre.filter((p) => p.h % 24 === 0).flatMap((p) => V(p, 1.004)), 3)); dots.frustumCulled = false; g.add(dots);
    }
  }

  update(t, dt, playing) {
    const L = this.layers, dist = this.globe.c.dist;
    if (this.dirty || Math.abs(t - this.fieldT) > 30 * 6e4) this.refresh(t);
    this.ov.sst.mesh.visible = L.sst; this.ov.waves.mesh.visible = L.waves; this.ov.precip.mesh.visible = L.precip;
    // storms
    this.storms = L.storms ? this.weather.stormsAt(t) : [];
    const key = this.storms.map((s) => `${s.id}:${s.lat.toFixed(1)}:${s.lon.toFixed(1)}`).join('|');
    if (key !== this.stormKey) { this.stormKey = key; this.buildStorms(this.storms); }
    // clouds
    this.clouds.visible = L.clouds;
    if (L.clouds) {
      // angles wrap at a full turn, so they stay small however far the timeline is scrubbed
      const days = t / 864e5, real = performance.now() / 1000, TAU = Math.PI * 2;
      this.cloudU.uTime.value = ((days / 30 + real / 2400) % 1) * TAU; this.cloudU.uSpin2.value = ((days / 18 + real / 1800) % 1) * TAU; this.cloudU.uSpin.value = (real * 0.6) % TAU;
      this.cloudU.uOpacity.value = 0.8 * (0.1 + 0.9 * Math.min(1, dist / 1.3) ** 1.3);     // thin out when close, so coasts and ports stay readable
      const s = this.weather.stormsAt(t)[0];
      if (s) { const v = llToVec(s.lat, s.lon); this.cloudU.uStorm.value.set(v[0], v[1], v[2], Math.min(1, s.kt / 70)); } else this.cloudU.uStorm.value.w = 0;
      this.satTimer += dt; if (this.satTimer > 1.2 && !playing) { this.satTimer = 0; this.loadSat(t); } else if (playing && this.cloudU.uSat.value && Math.floor(t / 864e5) !== this.satDay) this.cloudU.uSat.value = 0;
    }
    // wind
    this.wind.visible = L.wind;
    if (!L.wind) return;
    const { N, H, hist, pl, age, life } = this, pos = this.windGeo.attributes.position.array, col = this.windGeo.attributes.color.array, v = [0, 0, 0];
    // degrees moved per second for each m/s of wind. Scaled with zoom so streaks cover a similar share of the screen.
    const step = Math.min(dt, 0.05) * Math.max(0.03, Math.min(0.85, dist * 0.27)), fade = 0.5 + 0.5 * Math.min(1, dist);
    const push = (this.frame = (this.frame || 0) + 1) % 3 === 0;
    for (let i = 0; i < N; i++) {
      age[i] += dt;
      let lat = pl[i * 2], lon = pl[i * 2 + 1];
      if (age[i] > life[i] || Math.abs(lat) > 86) { this.spawn(i, false); continue; }
      const u = this.grid(this.u, lat, lon), w = this.grid(this.v, lat, lon), sp = Math.hypot(u, w);
      lat += w * step; lon += u * step / Math.max(0.2, Math.cos(lat * D2R)); if (lon > 180) lon -= 360; else if (lon < -180) lon += 360;
      pl[i * 2] = lat; pl[i * 2 + 1] = lon; this.spd[i] = sp;
      const b = i * H * 3; if (push) hist.copyWithin(b + 3, b, b + (H - 1) * 3); llToVec(lat, lon, 1.003, v); hist[b] = v[0]; hist[b + 1] = v[1]; hist[b + 2] = v[2];
      const env = Math.min(1, age[i] * 1.5, (life[i] - age[i]) * 1.5) * fade, hot = Math.min(1, sp / 22);
      const r = (0.35 + 0.65 * hot), gg = (0.75 + 0.2 * hot), bb = (1 - 0.45 * hot), base = env * (0.25 + 0.75 * Math.min(1, sp / 9));
      for (let h = 0; h < H - 1; h++) {
        const o = (i * (H - 1) + h) * 6, a0 = base * (1 - h / (H - 1)), a1 = base * (1 - (h + 1) / (H - 1));
        pos[o] = hist[b + h * 3]; pos[o + 1] = hist[b + h * 3 + 1]; pos[o + 2] = hist[b + h * 3 + 2]; pos[o + 3] = hist[b + h * 3 + 3]; pos[o + 4] = hist[b + h * 3 + 4]; pos[o + 5] = hist[b + h * 3 + 5];
        col[o] = r * a0; col[o + 1] = gg * a0; col[o + 2] = bb * a0; col[o + 3] = r * a1; col[o + 4] = gg * a1; col[o + 5] = bb * a1;
      }
    }
    this.windGeo.attributes.position.needsUpdate = true; this.windGeo.attributes.color.needsUpdate = true;
  }
}
