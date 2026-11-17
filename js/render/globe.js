// The globe itself: Earth with a real day/night terminator, city lights, ocean glint, atmosphere,
// stars, and a camera you can spin with inertia, zoom and tilt. Knows nothing about ships or weather.
import { CONFIG } from '../config.js';
import { llToVec, vecToLL, subSolar, D2R, R2D } from '../geo.js';

const THREE = window.THREE;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const WATER_GLSL = `
  uniform sampler2D tWaterW, tWaterE;
  float waterAt(vec2 uv) {
    float w = texture2D(tWaterW, vec2(uv.x * 2.0, uv.y)).r, e = texture2D(tWaterE, vec2(uv.x * 2.0 - 1.0, uv.y)).r;
    return mix(w, e, step(0.5, uv.x));
  }`;

const EARTH_VS = `
  varying vec2 vUv; varying vec3 vN; varying vec3 vW;
  void main() { vUv = uv; vN = normalize(position); vW = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const EARTH_FS = `
  uniform sampler2D tDay, tNight; uniform vec3 uSun; uniform float uDetail;
  varying vec2 vUv; varying vec3 vN; varying vec3 vW;
  ${WATER_GLSL}
  void main() {
    vec3 n = normalize(vN), view = normalize(cameraPosition - vW);
    float water = waterAt(vUv);
    vec3 day = texture2D(tDay, vUv).rgb;
    // close to the surface the 10 km/pixel satellite texture runs out, so blend in the vector coastline
    float edge = smoothstep(0.35, 0.65, water);
    vec3 sea = mix(vec3(0.012, 0.055, 0.13), vec3(0.02, 0.12, 0.2), smoothstep(0.5, 1.0, water) * 0.5);
    vec3 land = max(day, vec3(0.1, 0.13, 0.09)) * 1.06;
    day = mix(day, mix(land, mix(day, sea, 0.8), edge), uDetail);
    float fw = fwidth(water) * 2.0 + 0.02;
    day += vec3(0.5, 0.75, 0.85) * (1.0 - smoothstep(0.0, fw, abs(water - 0.5))) * uDetail * 0.35;

    float cosSun = dot(n, uSun), light = smoothstep(-0.12, 0.28, cosSun);
    vec3 col = day * (0.035 + 1.08 * light);
    vec3 lights = texture2D(tNight, vUv).rgb;
    col += pow(lights, vec3(1.25)) * vec3(1.35, 1.05, 0.7) * (1.0 - smoothstep(-0.2, 0.08, cosSun)) * 1.7;
    col += vec3(0.95, 0.38, 0.12) * smoothstep(-0.2, 0.0, cosSun) * (1.0 - smoothstep(0.0, 0.3, cosSun)) * 0.16;      // dusk and dawn
    float spec = pow(max(dot(reflect(-uSun, n), view), 0.0), 55.0);
    col += vec3(1.0, 0.93, 0.8) * spec * edge * 0.75 * light;
    float rim = pow(1.0 - max(dot(n, view), 0.0), 3.2);
    col += vec3(0.25, 0.55, 1.0) * rim * (0.12 + 0.9 * light);
    gl_FragColor = vec4(col, 1.0);
  }`;
const ATMO_VS = `
  varying vec3 vNv; varying vec3 vPv; varying vec3 vNw;
  void main() { vNw = normalize(position); vNv = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vPv = mv.xyz; gl_Position = projectionMatrix * mv; }`;
const ATMO_FS = `
  uniform vec3 uSun; varying vec3 vNv; varying vec3 vPv; varying vec3 vNw;
  void main() {
    float f = clamp(-dot(normalize(vNv), normalize(-vPv)) / 0.36, 0.0, 1.0);
    float lit = mix(0.1, 1.0, smoothstep(-0.45, 0.35, dot(vNw, uSun)));
    vec3 c = mix(vec3(0.2, 0.5, 1.0), vec3(0.55, 0.8, 1.0), f);
    gl_FragColor = vec4(c * pow(f, 2.4) * lit * 1.25, 1.0);
  }`;

export class Globe {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x02040a, 1);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.01, 200);
    this.sun = new THREE.Vector3(1, 0, 0);
    // camera state: the surface point being looked at, distance from it, and tilt away from straight down
    this.c = { lat: 12, lon: -40, dist: 7, tilt: 0 };
    this.t = { lat: 22, lon: -66, dist: 2.35, tilt: 0 };
    this.vel = { lat: 0, lon: 0 }; this.autoTilt = true; this.fly = null; this.follow = null; this.lastInput = performance.now(); this.idleSpin = true;
    this.listeners = { click: [], hover: [], input: [] };
    this.loader = new THREE.TextureLoader();
    this.build(); this.bind(); this.resize();
    window.addEventListener('resize', () => this.resize());
  }
  texture(file, opts = {}) {
    return new Promise((res, rej) => this.loader.load(CONFIG.TEXTURE_BASE + file, (tx) => {
      tx.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      tx.wrapS = opts.repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping; res(tx);
    }, undefined, () => rej(new Error(`Could not load ${file}`))));
  }
  build() {
    const blank = new THREE.DataTexture(new Uint8Array([8, 20, 40, 255]), 1, 1); blank.needsUpdate = true;
    this.water = { tWaterW: { value: blank }, tWaterE: { value: blank } };
    this.earthU = { tDay: { value: blank }, tNight: { value: blank }, uSun: { value: this.sun }, uDetail: { value: 0 }, ...this.water };
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 160), new THREE.ShaderMaterial({ uniforms: this.earthU, vertexShader: EARTH_VS, fragmentShader: EARTH_FS, extensions: { derivatives: true } }));
    this.scene.add(this.earth);
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(1.062, 96, 64), new THREE.ShaderMaterial({
      uniforms: { uSun: { value: this.sun } }, vertexShader: ATMO_VS, fragmentShader: ATMO_FS, side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    this.scene.add(atmo);
    // stars: deterministic so the sky is the same on every visit
    const n = 5200, pos = new Float32Array(n * 3), col = new Float32Array(n * 3); let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u), b = 0.25 + 0.75 * rnd() ** 3, w = rnd();
      pos.set([r * Math.cos(a) * 90, u * 90, r * Math.sin(a) * 90], i * 3);
      col.set([b * (0.8 + 0.2 * w), b * 0.88, b * (1 - 0.25 * w)], i * 3);
    }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); sg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false, depthTest: false, transparent: true }));
    this.stars.renderOrder = -10; this.scene.add(this.stars);
  }
  async loadTextures(onProgress) {
    const set = async (file, apply) => { const tx = await this.texture(file); apply(tx); onProgress && onProgress(); };
    await Promise.all([
      set('earth-day.jpg', (tx) => (this.earthU.tDay.value = tx)),
      set('earth-night.jpg', (tx) => (this.earthU.tNight.value = tx)),
      set('water-w.png', (tx) => (this.water.tWaterW.value = tx)),
      set('water-e.png', (tx) => (this.water.tWaterE.value = tx)),
    ]);
  }
  setTime(ms) { const [lat, lon] = subSolar(ms), v = llToVec(lat, lon); this.sun.set(v[0], v[1], v[2]); }
  on(type, fn) { this.listeners[type].push(fn); }
  emit(type, ...a) { this.listeners[type].forEach((f) => f(...a)); }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.w = w; this.h = h; this.renderer.setSize(w, h, false); this.camera.aspect = w / h;
    this.camera.fov = w < h ? 44 : 32; this.camera.updateProjectionMatrix();
  }
  // ---- input ----
  bind() {
    const el = this.canvas, ptrs = new Map(); let moved = 0, pinch = null, mode = 'spin';
    const touch = () => { this.lastInput = performance.now(); this.idleSpin = false; this.fly = null; this.emit('input'); };
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = 0; touch();
      mode = e.button === 2 || e.shiftKey || e.ctrlKey ? 'tilt' : 'spin'; this.vel.lat = this.vel.lon = 0; this.dragging = true;
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), y: (a.y + b.y) / 2, dist: this.t.dist }; }
    });
    el.addEventListener('pointermove', (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p) { this.emit('hover', e.clientX, e.clientY); return; }
      const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY; moved += Math.abs(dx) + Math.abs(dy); touch();
      if (ptrs.size === 2 && pinch) {
        const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y), y = (a.y + b.y) / 2;
        this.t.dist = clamp(pinch.dist * pinch.d / Math.max(20, d), 0.03, 6);
        if (Math.abs(y - pinch.y) > 2) { this.autoTilt = false; this.t.tilt = clamp(this.t.tilt - (y - pinch.y) * 0.004, 0, 1.15); pinch.y = y; }
        return;
      }
      if (mode === 'tilt') { this.autoTilt = false; this.t.tilt = clamp(this.t.tilt - dy * 0.005, 0, 1.15); return; }
      if (this.follow) return;
      const k = Math.min(0.006, 2 * this.c.dist * Math.tan(this.camera.fov * D2R / 2) / this.h) * R2D;
      const dLon = -dx * k / Math.max(0.25, Math.cos(this.c.lat * D2R)), dLat = dy * k;
      this.t.lon += dLon; this.t.lat = clamp(this.t.lat + dLat, -84, 84);
      this.vel.lon = dLon * 60; this.vel.lat = dLat * 60;
    });
    const up = (e) => {
      const had = ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (!ptrs.size) this.dragging = false;
      if (had && moved < 6 && e.type === 'pointerup') this.emit('click', e.clientX, e.clientY, e.pointerType);
    };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', (e) => { e.preventDefault(); touch(); this.t.dist = clamp(this.t.dist * Math.exp(clamp(e.deltaY, -120, 120) * 0.0016), 0.03, 6); }, { passive: false });
    el.addEventListener('dblclick', (e) => { const ll = this.pick(e.clientX, e.clientY); if (ll) this.flyTo({ lat: ll[0], lon: ll[1], dist: Math.max(0.05, this.t.dist * 0.45) }, 900); });
  }
  zoomBy(f) { this.lastInput = performance.now(); this.idleSpin = false; this.t.dist = clamp(this.t.dist * f, 0.03, 6); }
  flyTo(to, ms = 1800) {
    const from = { ...this.c }; to = { ...this.t, ...to };
    to.lon = from.lon + ((((to.lon - from.lon) % 360) + 540) % 360 - 180);
    this.fly = { from, to, t0: performance.now(), ms }; this.vel.lat = this.vel.lon = 0; this.idleSpin = false; this.lastInput = performance.now();
    return new Promise((r) => setTimeout(r, ms));
  }
  update(dt) {
    const c = this.c, t = this.t, now = performance.now();
    if (this.follow) { const p = this.follow(); if (p) { t.lat = p[0]; t.lon = c.lon + ((((p[1] - c.lon) % 360) + 540) % 360 - 180); } }
    if (this.fly) {
      const f = this.fly, x = clamp((now - f.t0) / f.ms, 0, 1), e = x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
      // rise up in the middle of a long hop so the flight reads as a flight
      const hop = Math.min(1.2, Math.hypot(f.to.lat - f.from.lat, f.to.lon - f.from.lon) / 90) * Math.sin(Math.PI * x);
      t.lat = f.from.lat + (f.to.lat - f.from.lat) * e; t.lon = f.from.lon + (f.to.lon - f.from.lon) * e;
      t.dist = Math.exp(Math.log(f.from.dist) + (Math.log(f.to.dist) - Math.log(f.from.dist)) * e) + hop * 0.5 * Math.max(0, 1.6 - Math.max(f.from.dist, f.to.dist));
      if (f.to.tilt !== undefined && !this.autoTilt) t.tilt = f.from.tilt + (f.to.tilt - f.from.tilt) * e;
      if (x >= 1) { this.fly = null; t.dist = f.to.dist; }
    } else if (!this.dragging && !this.follow) {
      if (Math.abs(this.vel.lon) + Math.abs(this.vel.lat) > 0.01) {
        t.lon += this.vel.lon * dt; t.lat = clamp(t.lat + this.vel.lat * dt, -84, 84);
        const d = Math.exp(-dt * 2.6); this.vel.lon *= d; this.vel.lat *= d;
      } else if (this.idleSpin || now - this.lastInput > 45000) { this.idleSpin = true; t.lon += dt * 1.1 * smooth(0.6, 2, c.dist); }
    }
    if (this.autoTilt) t.tilt = 0.95 * (1 - smooth(0.12, 1.5, t.dist));
    const k = 1 - Math.exp(-dt * (this.fly ? 30 : 7));
    c.lat += (t.lat - c.lat) * k; c.lon += (t.lon - c.lon) * k; c.tilt += (t.tilt - c.tilt) * k;
    c.dist = Math.exp(Math.log(c.dist) + (Math.log(t.dist) - Math.log(c.dist)) * k);

    const T = llToVec(c.lat, c.lon), n = new THREE.Vector3(T[0], T[1], T[2]);
    const N = new THREE.Vector3(0, 1, 0).addScaledVector(n, -n.y).normalize();
    const ct = Math.cos(c.tilt), st = Math.sin(c.tilt);
    this.camera.position.copy(n).addScaledVector(n, c.dist * ct).addScaledVector(N, -c.dist * st);
    this.camera.up.copy(n).multiplyScalar(st).addScaledVector(N, ct);
    this.camera.lookAt(n);
    this.camera.near = Math.max(0.0006, c.dist * 0.06); this.camera.far = c.dist + 190; this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.earthU.uDetail.value = 1 - smooth(0.25, 0.9, c.dist);
    this.stars.position.copy(this.camera.position);
  }
  render() { this.renderer.render(this.scene, this.camera); }

  // ---- helpers for layers and UI ----
  // Screen position of a point on the globe; null when it is on the far side.
  project(lat, lon, r = 1, out = {}) {
    const v = llToVec(lat, lon, r), cp = this.camera.position;
    if (v[0] * cp.x + v[1] * cp.y + v[2] * cp.z < 1.0) return null;
    const p = new THREE.Vector3(v[0], v[1], v[2]).project(this.camera);
    if (p.z > 1) return null;
    out.x = (p.x * 0.5 + 0.5) * this.w; out.y = (-p.y * 0.5 + 0.5) * this.h; return out;
  }
  // lat/lon under a screen point, or null if it misses the globe.
  pick(x, y) {
    const r = this.canvas.getBoundingClientRect(), ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), this.camera);
    const hit = ray.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), 1), new THREE.Vector3());
    return hit ? vecToLL(hit.x, hit.y, hit.z) : null;
  }
}
