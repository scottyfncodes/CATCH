// Heat effects: smoke off a glove after a run of perfect catches, and embers
// trailing the ball once the run is long. Each is one set of points drawn in a
// single call (a puff or an ember is a point with its own size and fade), so a
// hot streak costs two draw calls at most.

import * as THREE from 'three';

const VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;
  uniform float uScale;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // Size in metres, on screen as far away as it is; but never smaller than it would be
    // 3.5 m away (so a glove across the road still smokes), never more than a sixth of the
    // screen, and fading out right in front of the camera (your own glove, in your own eyes).
    float d = max(0.1, -mv.z);
    gl_PointSize = min(aSize * uScale / min(d, 3.5), uScale * 0.16);
    vAlpha = aAlpha * smoothstep(0.3, 1.2, d);
    vColor = aColor;
  }`;
const FRAG = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d) * 2.0;
    // A soft disc with some body to it (not a pinpoint that is mostly edge).
    float a = 1.0 - smoothstep(0.15, 1.0, r);
    a *= a;
    if (a * vAlpha < 0.003) discard;
    gl_FragColor = vec4(vColor, a * vAlpha);
  }`;

interface P { x: number; y: number; z: number; vx: number; vy: number; vz: number; age: number; life: number; size0: number; size1: number; a0: number; r: number; g: number; b: number }

/** A small pool of soft round points: puffs that rise and spread, or embers that glow and fade. */
class Points {
  readonly mesh: THREE.Points;
  private ps: P[] = [];
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  /** `fade`: how opaque a point is through its life (0..1 → 0..1). */
  constructor(private max: number, additive: boolean, private fade: (k: number) => number) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(max), 1));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(max), 1));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    this.geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uScale: { value: 600 } },
    });
    this.mesh = new THREE.Points(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }
  /** Pixels per metre at 1 m away: follows the screen, so a puff is the same size on every phone. */
  setScale(px: number) { this.mat.uniforms.uScale.value = px; }
  add(p: Omit<P, 'age'>) {
    if (this.ps.length >= this.max) this.ps.shift();
    this.ps.push({ ...p, age: 0 });
  }
  get count() { return this.ps.length; }
  update(dt: number, drag = 0) {
    this.ps = this.ps.filter((p) => (p.age += dt) < p.life);
    const pos = this.geo.attributes.position as THREE.BufferAttribute, size = this.geo.attributes.aSize as THREE.BufferAttribute;
    const alpha = this.geo.attributes.aAlpha as THREE.BufferAttribute, col = this.geo.attributes.aColor as THREE.BufferAttribute;
    this.ps.forEach((p, i) => {
      const k = p.age / p.life;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (drag) { const f = Math.exp(-drag * dt); p.vx *= f; p.vy *= f; p.vz *= f; }
      pos.setXYZ(i, p.x, p.y, p.z);
      size.setX(i, p.size0 + (p.size1 - p.size0) * Math.sqrt(k));
      alpha.setX(i, p.a0 * this.fade(k));
      col.setXYZ(i, p.r, p.g, p.b);
    });
    this.geo.setDrawRange(0, this.ps.length);
    for (const a of [pos, size, alpha, col]) a.needsUpdate = true;
    this.mesh.visible = this.ps.length > 0;
  }
  dispose() { this.geo.dispose(); this.mat.dispose(); }
}

export class HeatFx {
  readonly group = new THREE.Group();
  // Dust: there at once, thinning as it spreads.
  private smoke = new Points(48, false, (k) => Math.min(1, k / 0.06) * (1 - k));
  // (Three a frame for up to half a second: enough for the whole tail at 60 frames a second.)
  // Embers: glow, then go out.
  private embers = new Points(96, true, (k) => Math.min(1, k / 0.04) * (1 - k * k * k));
  private last: THREE.Vector3 | null = null;
  private rnd = 1;
  constructor() { this.group.add(this.smoke.mesh, this.embers.mesh); }

  private r() { this.rnd = (this.rnd * 16807) % 2147483647; return this.rnd / 2147483647; }

  /** The camera's vertical field of view and the screen's height in pixels: puffs keep their size in metres. */
  resize(fovDeg: number, heightPx: number) {
    const s = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.smoke.setScale(s); this.embers.setScale(s);
  }

  /**
   * A glove that just made the `heat`-th perfect catch in a row: a puff of dust off the
   * leather, as off a mitt that has taken a fastball (more of it, and warmer, the hotter it is).
   */
  puff(at: THREE.Vector3, heat: number) {
    const n = Math.min(10, 2 + heat);
    const warm = Math.min(1, (heat - 3) / 7);
    for (let i = 0; i < n; i++) {
      const a = this.r() * Math.PI * 2, s = 0.25 + this.r() * 0.45;
      this.smoke.add({
        x: at.x + Math.cos(a) * 0.04, y: at.y + this.r() * 0.04, z: at.z + Math.sin(a) * 0.04,
        vx: Math.cos(a) * s, vy: 0.25 + this.r() * 0.4, vz: Math.sin(a) * s,
        life: 0.7 + this.r() * 0.45, size0: 0.08, size1: 0.3 + this.r() * 0.18, a0: 0.7,
        r: 0.93, g: 0.86 - 0.1 * warm, b: 0.74 - 0.2 * warm,
      });
    }
  }

  /** The ball in the air on a long hot run: embers off it. `null` when it isn't flying. */
  ball(at: THREE.Vector3 | null, hot: boolean) {
    if (at && hot) {
      const from = this.last ?? at;
      // A few along the way it went this frame, so a fast ball leaves a line, not dots.
      for (let i = 0; i < 3; i++) {
        const k = i / 3;
        this.embers.add({
          x: from.x + (at.x - from.x) * k, y: from.y + (at.y - from.y) * k, z: from.z + (at.z - from.z) * k,
          vx: (this.r() - 0.5) * 0.2, vy: 0.1 + this.r() * 0.2, vz: (this.r() - 0.5) * 0.2,
          life: 0.3 + this.r() * 0.2, size0: 0.11, size1: 0.03, a0: 0.9,
          r: 1, g: 0.55 + this.r() * 0.25, b: 0.15,
        });
      }
    }
    this.last = at ? (this.last ?? new THREE.Vector3()).copy(at) : null;
  }

  update(dt: number) { this.smoke.update(dt, 3.2); this.embers.update(dt, 2.5); }
  dispose() { this.smoke.dispose(); this.embers.dispose(); }
}
