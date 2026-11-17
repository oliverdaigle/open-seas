// Ships, wakes, ports and the selected ship's track. One instanced draw call for the whole fleet.
import { llToVec, densify, D2R } from '../geo.js';
import { REC, TRAIL, PORT } from '../fleet.js';
import { SRC } from '../data/ais.js';

const THREE = window.THREE;
const R_SHIP = 1.0012;

// Low-poly hull: pointed bow at -Z, superstructure block and funnel. aShade bakes the lighting,
// aTint says how much of the cruise line's colour a face takes (hull yes, upperworks stay white).
function hullGeometry() {
  const pos = [], shade = [], tint = [];
  const quad = (a, b, c, d, s, t) => { for (const p of [a, b, c, a, c, d]) { pos.push(...p); shade.push(s); tint.push(t); } };
  const prism = (outline, y0, y1, sTop, sSide, t) => {
    const n = outline.length;
    for (let i = 0; i < n; i++) { const [x1, z1] = outline[i], [x2, z2] = outline[(i + 1) % n]; quad([x1, y0, z1], [x2, y0, z2], [x2, y1, z2], [x1, y1, z1], sSide * (0.8 + 0.2 * Math.abs(Math.sin(i * 1.7))), t); }
    for (let i = 1; i < n - 1; i++) for (const p of [outline[0], outline[i], outline[i + 1]]) { pos.push(p[0], y1, p[1]); shade.push(sTop); tint.push(t); }
  };
  prism([[0, -0.5], [0.075, -0.36], [0.115, -0.18], [0.12, 0.4], [0.085, 0.5], [-0.085, 0.5], [-0.12, 0.4], [-0.115, -0.18], [-0.075, -0.36]], 0, 0.07, 0.95, 0.62, 1);
  prism([[0, -0.3], [0.085, -0.2], [0.09, 0.36], [-0.09, 0.36], [-0.085, -0.2]], 0.07, 0.15, 1.0, 0.78, 0.12);
  prism([[0.05, 0.12], [0.05, 0.26], [-0.05, 0.26], [-0.05, 0.12]], 0.15, 0.23, 0.9, 0.7, 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aShade', new THREE.Float32BufferAttribute(shade, 1));
  g.setAttribute('aTint', new THREE.Float32BufferAttribute(tint, 1));
  return g;
}

export class ShipLayer {
  constructor(globe, fleet, lines, labelsEl) {
    this.globe = globe; this.fleet = fleet; this.n = fleet.ships.length; this.labelsEl = labelsEl; this.labels = new Map();
    this.colors = fleet.ships.map((s) => new THREE.Color(lines[s.line].color));
    this.screen = new Float32Array(this.n * 3);       // x, y, visible
    this.highlight = null; this.alerts = new Set(); this.selected = -1; this.hover = -1;

    this.mesh = new THREE.InstancedMesh(hullGeometry(), new THREE.ShaderMaterial({
      vertexShader: `attribute float aShade; attribute float aTint; varying vec3 vC;
        void main() { vC = mix(vec3(0.97), instanceColor, aTint) * aShade; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec3 vC; void main() { gl_FragColor = vec4(vC, 1.0); }`, side: THREE.DoubleSide, transparent: true,   // drawn after the clouds so ships are never hidden
    }), this.n);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.n * 3), 3);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 12; globe.scene.add(this.mesh);

    // wakes: fading line behind every ship
    const segs = TRAIL, tp = new Float32Array(this.n * segs * 6), tc = new Float32Array(this.n * segs * 6);
    this.trailGeo = new THREE.BufferGeometry();
    this.trailGeo.setAttribute('position', new THREE.BufferAttribute(tp, 3)); this.trailGeo.setAttribute('color', new THREE.BufferAttribute(tc, 3));
    this.trails = new THREE.LineSegments(this.trailGeo, new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    this.trails.frustumCulled = false; this.trails.renderOrder = 11; globe.scene.add(this.trails);

    // ports: a dot each, with a glow that grows with the number of ships alongside
    this.portCodes = Object.keys(fleet.ports); this.portIndex = new Map(this.portCodes.map((c, i) => [c, i]));
    const pp = new Float32Array(this.portCodes.length * 3); this.portCount = new Float32Array(this.portCodes.length);
    this.portCodes.forEach((c, i) => { const p = fleet.ports[c]; llToVec(p.lat, p.lon, 1.0006, this._v = [0, 0, 0]); pp.set(this._v, i * 3); });
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pp, 3)); pg.setAttribute('aCount', new THREE.BufferAttribute(this.portCount, 1));
    this.portU = { uScale: { value: 1 }, uHeat: { value: 0 } };
    this.ports = new THREE.Points(pg, new THREE.ShaderMaterial({
      uniforms: this.portU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute float aCount; uniform float uScale, uHeat; varying float vCnt;
        void main() { vCnt = aCount; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = (5.0 + uHeat * aCount * 9.0) * uScale; }`,
      fragmentShader: `uniform float uHeat; varying float vCnt;
        void main() { float d = length(gl_PointCoord - 0.5) * 2.0; if (d > 1.0) discard;
          float core = smoothstep(1.0, 0.0, d * (1.0 + uHeat * vCnt * 1.8));
          vec3 c = mix(vec3(0.45, 0.8, 0.95), vec3(1.0, 0.62, 0.2), clamp(uHeat * vCnt / 4.0, 0.0, 1.0));
          gl_FragColor = vec4(c * (core * 0.9 + (1.0 - d) * (1.0 - d) * uHeat * min(vCnt, 5.0) * 0.22), 1.0); }`,
    }));
    this.ports.frustumCulled = false; this.ports.renderOrder = 8; globe.scene.add(this.ports);

    this.route = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffb547, transparent: true, opacity: 0.95, depthWrite: false }));
    this.route.frustumCulled = false; this.route.visible = false; this.route.renderOrder = 10; globe.scene.add(this.route);
    this.extraRoutes = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x5fd4e6, transparent: true, opacity: 0.8, depthWrite: false }));
    this.extraRoutes.frustumCulled = false; this.extraRoutes.visible = false; this.extraRoutes.renderOrder = 9; globe.scene.add(this.extraRoutes);
    this.m = new THREE.Matrix4();
  }

  // The selected ship: the track it has sailed (amber) and, dashed, the way still to go to the destination it
  // broadcasts (cyan): its lane route when there is one, else a straight line. Pass null to clear.
  showTrack(track, ahead) {
    const pts = [];
    if (track && track.length > 1) for (const p of densify(track, 1)) pts.push(...llToVec(p[0], p[1], 1.0009));
    this.route.geometry.dispose(); this.route.geometry = new THREE.BufferGeometry();
    this.route.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)); this.route.visible = pts.length > 0;
    const seg = [];
    if (ahead && ahead.length > 1) {
      const d = densify(ahead, 0.35);
      for (let i = 1; i < d.length; i += 2) seg.push(...llToVec(d[i - 1][0], d[i - 1][1], 1.0009), ...llToVec(d[i][0], d[i][1], 1.0009));
    }
    this.extraRoutes.geometry.dispose(); this.extraRoutes.geometry = new THREE.BufferGeometry();
    this.extraRoutes.geometry.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3)); this.extraRoutes.visible = seg.length > 0;
  }

  update(buf, modes, opts) {
    const { globe, n, m } = this, dist = globe.c.dist, cam = globe.camera.position;
    const size = Math.max(0.00042, Math.min(0.05, dist * 0.0165)), berth = size * 0.42, farPorts = dist > 0.75;
    const tp = this.trailGeo.attributes.position.array, tc = this.trailGeo.attributes.color.array, ic = this.mesh.instanceColor.array;
    const inPort = new Map(); this.portCount.fill(0);
    for (let k = 0; k < n; k++) if (buf[k * REC + 4] === PORT && buf[k * REC + 7] >= 0) {
      const code = this.portCodes[buf[k * REC + 7]]; if (!code) continue;
      let l = inPort.get(code); if (!l) inPort.set(code, l = []); l.push(k); this.portCount[this.portIndex.get(code)]++;
    }
    this.inPort = inPort;
    const slot = new Int16Array(n).fill(-1), slots = new Int16Array(n);
    for (const l of inPort.values()) l.forEach((k, i) => { slot[k] = i; slots[k] = l.length; });

    const up = new THREE.Vector3(), N = new THREE.Vector3(), E = new THREE.Vector3(), F = new THREE.Vector3(), Rt = new THREE.Vector3(), P = new THREE.Vector3(), Z = new THREE.Vector3(), v = [0, 0, 0];
    const proj = new THREE.Vector3(), w = globe.w, h = globe.h, hl = this.highlight;
    for (let k = 0; k < n; k++) {
      const b = k * REC, status = buf[b + 4], sc = this.screen;
      const dim = status === 0 || (hl && !hl.has(k));
      let s = status === 0 ? 0 : size * (k === this.selected ? 1.5 : k === this.hover ? 1.25 : 1) * (hl && hl.has(k) ? 1.25 : 1);
      if (status === PORT && slots[k] > 1 && farPorts && k !== this.selected) s = slot[k] === 0 ? s : 0;   // one hull per port from far away; the badge carries the count
      llToVec(buf[b], buf[b + 1], 1, v); up.set(v[0], v[1], v[2]);
      N.set(0, 1, 0).addScaledVector(up, -up.y).normalize(); E.crossVectors(N, up);
      const hd = buf[b + 2] * D2R; F.copy(N).multiplyScalar(Math.cos(hd)).addScaledVector(E, Math.sin(hd)); Rt.crossVectors(F, up);
      P.copy(up).multiplyScalar(R_SHIP);
      if (slot[k] >= 0 && slots[k] > 1 && !farPorts) P.addScaledVector(Rt, (slot[k] - (slots[k] - 1) / 2) * berth);
      Z.copy(F).negate();
      m.makeBasis(Rt, up, Z).scale(new THREE.Vector3(s, s, s)).setPosition(P);
      this.mesh.setMatrixAt(k, m);
      const c = this.colors[k], f = dim ? 0.22 : modes[k] === SRC.LAST ? 0.38 : modes[k] === SRC.RECENT ? 0.65 : 1;
      ic[k * 3] = c.r * f; ic[k * 3 + 1] = c.g * f; ic[k * 3 + 2] = c.b * f;
      // screen position for picking and labels
      if (s > 0 && P.dot(cam) > 1.0) { proj.copy(P).project(globe.camera); sc[k * 3] = (proj.x * 0.5 + 0.5) * w; sc[k * 3 + 1] = (-proj.y * 0.5 + 0.5) * h; sc[k * 3 + 2] = proj.z < 1 ? 1 : 0; } else sc[k * 3 + 2] = 0;
      // wake
      const bright = status === 2 && !dim && modes[k] !== SRC.LAST && modes[k] !== SRC.RECENT ? (opts.trails ? 1 : 0) : 0;
      let px = P.x, py = P.y, pz = P.z;
      for (let j = 0; j < TRAIL; j++) {
        llToVec(buf[b + 8 + j * 2], buf[b + 9 + j * 2], R_SHIP - 0.0003, v);
        const o = (k * TRAIL + j) * 6, a0 = bright * (1 - j / TRAIL) ** 1.6 * 0.75, a1 = bright * (1 - (j + 1) / TRAIL) ** 1.6 * 0.75;
        tp[o] = px; tp[o + 1] = py; tp[o + 2] = pz; tp[o + 3] = v[0]; tp[o + 4] = v[1]; tp[o + 5] = v[2];
        tc[o] = 0.55 * a0; tc[o + 1] = 0.85 * a0; tc[o + 2] = a0; tc[o + 3] = 0.55 * a1; tc[o + 4] = 0.85 * a1; tc[o + 5] = a1;
        px = v[0]; py = v[1]; pz = v[2];
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor.needsUpdate = true;
    this.trailGeo.attributes.position.needsUpdate = true; this.trailGeo.attributes.color.needsUpdate = true;
    this.ports.geometry.attributes.aCount.needsUpdate = true;
    this.portU.uScale.value = (window.devicePixelRatio || 1) * Math.min(1.5, 0.55 + 0.5 / Math.max(0.3, dist));
    this.portU.uHeat.value = opts.heat ? 1 : 0;
    this.drawLabels(buf, opts);
  }

  // Nearest ship to a screen point, or -1.
  pickShip(x, y, radius = 18) {
    let best = -1, bd = radius * radius; const sc = this.screen;
    for (let k = 0; k < this.n; k++) { if (!sc[k * 3 + 2]) continue; const d = (sc[k * 3] - x) ** 2 + (sc[k * 3 + 1] - y) ** 2; if (d < bd) { bd = d; best = k; } }
    return best;
  }
  pickPort(x, y, radius = 14) {
    let best = null, bd = radius * radius; const o = {};
    for (const code of this.portCodes) { const p = this.fleet.ports[code], s = this.globe.project(p.lat, p.lon, 1.0006, o); if (!s) continue; const d = (s.x - x) ** 2 + (s.y - y) ** 2; if (d < bd) { bd = d; best = code; } }
    return best;
  }

  // ---- HTML labels: ship names, port names, in-port counts ----
  label(key, x, y, text, cls) {
    let el = this.labels.get(key);
    if (!el) { el = document.createElement('div'); this.labelsEl.appendChild(el); this.labels.set(key, el); }
    if (el._t !== text) { el.textContent = text; el._t = text; }
    if (el._c !== cls) { el.className = `lbl ${cls}`; el._c = cls; }
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`; el._used = true; el.hidden = false;
  }
  drawLabels(buf, opts) {
    const { globe, fleet } = this, sc = this.screen, dist = globe.c.dist, o = {};
    for (const el of this.labels.values()) el._used = false;
    const name = (k, cls) => { if (k >= 0 && sc[k * 3 + 2]) this.label(`s${k}`, sc[k * 3], sc[k * 3 + 1], fleet.ships[k].name, cls); };
    name(this.selected, 'ship sel'); if (this.hover !== this.selected) name(this.hover, 'ship');
    for (const k of this.alerts) if (k !== this.selected && k !== this.hover && sc[k * 3 + 2]) this.label(`a${k}`, sc[k * 3], sc[k * 3 + 1], '!', 'alert');
    // quiet labels only where they do not collide with one already placed
    const placed = [], free = (x, y, text) => {
      const w = text.length * 6.4 + 14, r = [x, y - 18, x + w, y + 2];
      for (const q of placed) if (r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1]) return false;
      placed.push(r); return true;
    };
    if (this.selected >= 0 && sc[this.selected * 3 + 2]) free(sc[this.selected * 3], sc[this.selected * 3 + 1] - 6, fleet.ships[this.selected].name + '    ');
    if (dist < 0.55) for (let k = 0; k < this.n; k++) if (k !== this.selected && k !== this.hover && sc[k * 3 + 2] && sc[k * 3] > 0 && sc[k * 3] < globe.w && sc[k * 3 + 1] > 0 && sc[k * 3 + 1] < globe.h && free(sc[k * 3], sc[k * 3 + 1], fleet.ships[k].name)) this.label(`s${k}`, sc[k * 3], sc[k * 3 + 1], fleet.ships[k].name, 'ship quiet');
    for (const [code, list] of this.inPort) {
      const p = fleet.ports[code], s = globe.project(p.lat, p.lon, 1.0006, o); if (!s || s.x < -40 || s.x > globe.w + 40 || s.y < -40 || s.y > globe.h + 40) continue;
      if (list.length > 1 && dist > 0.75) this.label(`c${code}`, s.x, s.y, String(list.length), 'count');
      const pn = p.name.split(/[,(]/)[0].trim();
      if ((dist < 0.9 || (opts.heat && list.length > 2)) && free(s.x - 6, s.y + 26, pn)) this.label(`p${code}`, s.x, s.y, pn, 'port');
    }
    if (opts.portLabel) { const p = fleet.ports[opts.portLabel], s = globe.project(p.lat, p.lon, 1.0006, o); if (s) this.label(`p${opts.portLabel}`, s.x, s.y, p.name.split(/[,(]/)[0].trim(), 'port sel'); }
    for (const st of opts.storms || []) { const s = globe.project(st.lat, st.lon, 1.01, o); if (s) this.label(`storm${st.id}`, s.x, s.y, `${st.name} · ${Math.round(st.kt)} kn${st.simulated ? ' · simulated' : ''}`, 'storm'); }
    for (const el of this.labels.values()) if (!el._used) el.hidden = true;
  }
}
