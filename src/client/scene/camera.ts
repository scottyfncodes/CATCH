// The camera is a friend filming on their phone from a couple of steps behind
// your shoulder, on your glove side: you big in the foreground, your partner
// small and far down the road. One continuous shot: it never cuts, it only
// drifts, pans and breathes its framing so both of you and the ball stay in
// view, and eases in on your partner while you aim.

import * as THREE from 'three';
import { type Vec3, clamp, wrapAngle } from '../../shared/vec';

export interface Shot {
  /** Your feet. */
  me: Vec3;
  /** The person you're playing with (feet). */
  partner: Vec3;
  /** Ball position when it matters for the framing (in flight), else null. */
  ball: Vec3 | null;
  /** Which side the camera stands on (+1 = your right). */
  side: number;
  /** Push in on a point near your partner (aiming at their glove). */
  focus?: { point: Vec3; amount: number } | null;
}

const damp = (cur: number, want: number, tau: number, dt: number) => cur + (want - cur) * (1 - Math.exp(-dt / tau));

export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.1, 600);
  private axis = 0;
  private me = new THREE.Vector3();
  private yawC = 0;
  private pitchC = -0.1;
  private half = 0.45;
  private init = false;
  private focusK = 0;
  private t = Math.random() * 100;
  aspect = 0.5;

  constructor() {
    this.camera.rotation.order = 'YXZ';
  }

  /** Jump straight to the framing (no easing): spawning, first frame. */
  reset() { this.init = false; }

  update(dt: number, s: Shot) {
    this.t += dt;
    const portrait = this.aspect < 1;
    const ax = s.partner[0] - s.me[0], az = s.partner[2] - s.me[2];
    const wantAxis = Math.atan2(-ax, -az);
    if (!this.init) { this.axis = wantAxis; this.me.set(s.me[0], 0, s.me[2]); }
    this.axis += wrapAngle(wantAxis - this.axis) * (this.init ? 1 - Math.exp(-dt / 1.4) : 1);
    // Follow you, but loosely: a person turning their head, not a dolly on rails.
    const k = this.init ? 1 - Math.exp(-dt / 0.55) : 1;
    this.me.x += (s.me[0] - this.me.x) * k;
    this.me.z += (s.me[2] - this.me.z) * k;

    const f = new THREE.Vector3(-Math.sin(this.axis), 0, -Math.cos(this.axis));
    const r = new THREE.Vector3(Math.cos(this.axis), 0, -Math.sin(this.axis));
    // A couple of steps behind your shoulder, at head height: like a friend
    // filming on their phone. You're big in the frame; your partner is small
    // and far, framed by the road.
    const back = portrait ? 2.5 : 3.1;
    const sideOff = (portrait ? 0.95 : 1.5) * s.side;
    const height = portrait ? 1.74 : 1.72;
    // A hand-held camera: tiny, slow drift (no shake).
    const hx = Math.sin(this.t * 0.31) * 0.05 + Math.sin(this.t * 0.73) * 0.02;
    const hy = Math.sin(this.t * 0.47 + 1.3) * 0.03;
    const pos = new THREE.Vector3(this.me.x, height + hy, this.me.z)
      .addScaledVector(f, -back)
      .addScaledVector(r, sideOff + hx);
    this.camera.position.copy(pos);

    // Frame what matters: you from the hips up, your partner head to toe with
    // a little road under them, and the ball in flight.
    const pts: Vec3[] = [
      [s.me[0], 0.75, s.me[2]], [s.me[0], 2.0, s.me[2]],
      [s.partner[0], -0.6, s.partner[2]], [s.partner[0], 2.3, s.partner[2]],
    ];
    // Room for your glove and throwing arm either side of you.
    pts.push([s.me[0] + r.x * 0.5, 1.25, s.me[2] + r.z * 0.5], [s.me[0] - r.x * 0.5, 1.25, s.me[2] - r.z * 0.5]);
    if (s.ball) pts.push([s.ball[0], Math.min(s.ball[1], 7), s.ball[2]]);
    const yawOf = (p: Vec3) => wrapAngle(Math.atan2(-(p[0] - pos.x), -(p[2] - pos.z)) - this.axis);
    const pitchOf = (p: Vec3) => Math.atan2(p[1] - pos.y, Math.hypot(p[0] - pos.x, p[2] - pos.z));
    // Your partner sits near the middle of the frame, you off to one side.
    const centreYaw = yawOf([s.me[0], 0, s.me[2]]) * 0.42 + yawOf([s.partner[0], 0, s.partner[2]]) * 0.58;
    let ySpan = 0, pLo = Infinity, pHi = -Infinity;
    for (const p of pts) {
      ySpan = Math.max(ySpan, Math.abs(yawOf(p) - centreYaw));
      const pt = pitchOf(p);
      pLo = Math.min(pLo, pt); pHi = Math.max(pHi, pt);
    }
    // Screen budget (NDC): portrait keeps the top clear for the streak and the sky.
    const top = portrait ? 0.42 : 0.6, bottom = portrait ? -0.98 : -0.98, sideB = portrait ? 0.84 : 0.8;
    const hV = (pHi - pLo) / (top - bottom);
    const hH = Math.atan(Math.tan(ySpan / sideB) / this.aspect);
    let half = clamp(Math.max(hV * 1.02, hH), portrait ? 0.34 : 0.28, portrait ? 0.7 : 0.6);
    const midP = (pHi + pLo) / 2;
    let wantPitch = midP - ((top + bottom) / 2) * half;
    let wantYaw = this.axis + centreYaw;
    // Aiming: ease in on your friend (head to toe, plus the aim ring) so their glove reads.
    this.focusK = damp(this.focusK, s.focus ? s.focus.amount : 0, s.focus ? 0.32 : 0.5, dt);
    if (this.focusK > 0.001) {
      // Centred on your friend; the frame only widens if the ring wanders off them.
      const feet: Vec3 = [s.partner[0], 0, s.partner[2]], head: Vec3 = [s.partner[0], 2.05, s.partner[2]];
      const fyc = yawOf(feet);
      const flo0 = pitchOf(feet) - 0.015, fhi0 = pitchOf(head) + 0.015;
      const fpc = (flo0 + fhi0) / 2;
      let vNeed = (fhi0 - flo0) / 2, hNeed = 0.04;
      if (s.focus) {
        vNeed = Math.max(vNeed, Math.abs(pitchOf(s.focus.point) - fpc) + 0.03);
        hNeed = Math.max(hNeed, Math.abs(wrapAngle(yawOf(s.focus.point) - fyc)) + 0.03);
      }
      const fHalf = clamp(Math.max(vNeed / 0.55, Math.atan(Math.tan(hNeed / 0.7) / this.aspect)), 0.07, half);
      // Your friend sits a little below centre, under the streak.
      const fPitch = fpc + 0.08 * fHalf;
      const k = this.focusK * this.focusK * (3 - 2 * this.focusK);
      half = half + (fHalf - half) * k;
      wantPitch = wantPitch + (fPitch - wantPitch) * k;
      wantYaw = wantYaw + wrapAngle(this.axis + fyc - wantYaw) * k;
    }
    if (!this.init) { this.half = half; this.pitchC = wantPitch; this.yawC = wantYaw; this.init = true; }
    // Breathe slowly; pan a little quicker so the ball never escapes.
    const quick = this.focusK > 0.02 ? 0.4 : 1;
    this.half = damp(this.half, half, (s.ball ? 0.55 : 0.9) * quick, dt);
    this.pitchC = damp(this.pitchC, wantPitch, 0.45 * quick, dt);
    this.yawC += wrapAngle(wantYaw - this.yawC) * (1 - Math.exp(-dt / (0.5 * quick)));
    half = this.half;
    const roll = Math.sin(this.t * 0.23) * 0.004;
    this.camera.rotation.set(this.pitchC + Math.sin(this.t * 0.6) * 0.002, this.yawC, roll, 'YXZ');
    this.camera.fov = (half * 2 * 180) / Math.PI;
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  /** Listener for spatial audio: between you and the camera, oriented as the camera. */
  listener(me: Vec3): { pos: Vec3; fwd: Vec3; up: Vec3 } {
    const c = this.camera.position;
    const pos: Vec3 = [c.x + (me[0] - c.x) * 0.6, 1.55, c.z + (me[2] - c.z) * 0.6];
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    return { pos, fwd: [fwd.x, fwd.y, fwd.z], up: [up.x, up.y, up.z] };
  }
}
