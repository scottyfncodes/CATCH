// Two views of the same game of catch, and one camera that moves between them.
//
// Throwing is third person: a friend filming on their phone from a couple of
// steps behind your shoulder, on your glove side. You big in the foreground
// and your partner small and far down the road. When you start your windup it
// cranes up and back to the shot a ballgame is filmed from: over the pitcher,
// looking down the line of the throw, with all of your delivery below and your
// partner and the aim ring above. It drifts, pans and breathes its framing so
// both of you and the ball stay in view.
//
// Catching is first person: your own eyes. The ball comes at you, your glove
// is in front of you, and the view follows the ball in the way a head does.
//
// The camera never cuts. When your role changes it travels from one view to
// the other in a single eased move.

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
  /** Where you're aiming (the ring on your partner's glove plane): kept in the frame. */
  aim?: Vec3 | null;
  /** You're winding up or delivering (0..1): crane up and keep all of you in the frame. */
  windup?: number;
  /**
   * Your long throw is in the air (0..1): let go of yourself and follow it.
   * The frame becomes the ball and your friend, so it starts wide on the arc
   * and closes in, like a long lens, as the ball comes down to their glove.
   */
  flight?: number;
}

/** What your own eyes are doing while you wait for (or go after) a throw. */
export interface EyeShot {
  /** Your eyes (the avatar's head). */
  eye: Vec3;
  /** Which way your body faces. */
  yaw: number;
  /** What you're watching: the ball in flight, or the person about to throw it. */
  far: Vec3;
  /** What your hands are doing: your glove, or the spot the throw is coming to. */
  near: Vec3;
  /** How far the view tips down from `far` toward `near` (0..1), and how far it turns. */
  pitchK: number;
  yawK: number;
  /** A throw is on its way (0..1, more for one dropping out of the sky): the view opens up to take in the ball and the catch. */
  wide: number;
  /** The ball is about to arrive (0..1): where it lands matters more than where it is. */
  landing?: number;
  /** Sideways lean of the body (rad): the horizon tips a little with it. */
  lean: number;
}

/** How long the move between the two views takes (seconds). */
const TO_FIRST = 0.75;
const TO_THIRD = 0.65;
const EYE_BACK = 0.24;
/** The furthest the first-person view turns from straight ahead (rad). */
const EYE_TURN = 0.42;

const damp = (cur: number, want: number, tau: number, dt: number) => cur + (want - cur) * (1 - Math.exp(-dt / tau));

export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.1, 600);
  private axis = 0;
  private me = new THREE.Vector3();
  private yawC = 0;
  private pitchC = -0.1;
  private half = 0.45;
  private init = false;
  private t = Math.random() * 100;
  private wind = 0;
  private fl = 0;
  /** 0 = third person, 1 = first person; `blend` is the eased version the camera uses. */
  private k = 0;
  blend = 0;
  private eInit = false;
  private ePos = new THREE.Vector3();
  private eYaw = 0;
  private ePitch = 0;
  private eFov = 60;
  private eRoll = 0;
  private kickV = 0;
  private kickX = 0;
  /** Skip the travel between views (prefers-reduced-motion): the game dips the screen instead. */
  instant = false;
  aspect = 0.5;

  constructor() {
    this.camera.rotation.order = 'YXZ';
  }

  /** Jump straight to the framing (no easing): spawning, first frame. */
  reset() { this.init = false; this.eInit = false; }

  /** A catch lands: a small knock through the view. */
  kick(amount: number) { this.kickV -= 0.9 * amount; }

  /**
   * Frame the shot. `eyes` is your first-person view when you have one, and
   * `first` says which of the two views you should be in right now.
   */
  update(dt: number, s: Shot, eyes: EyeShot | null = null, first = false) {
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
    // Winding up: crane up and back, over the pitcher. From up there the whole
    // delivery sits in the lower part of the frame and your partner (and the
    // aim ring) in the clear above it, even on a tall, narrow phone.
    this.wind = this.init ? damp(this.wind, s.windup ?? 0, s.windup ? 0.32 : 0.5, dt) : (s.windup ?? 0);
    const w = this.wind * this.wind * (3 - 2 * this.wind);
    const back = (portrait ? 2.5 : 3.1) + w * (portrait ? 3.4 : 2.4);
    const sideOff = ((portrait ? 0.95 : 1.5) - w * (portrait ? 0.4 : 0.3)) * s.side;
    const height = (portrait ? 1.74 : 1.72) + w * (portrait ? 2.1 : 1.3);
    // A hand-held camera: tiny, slow drift (no shake).
    const hx = Math.sin(this.t * 0.31) * 0.05 + Math.sin(this.t * 0.73) * 0.02;
    const hy = Math.sin(this.t * 0.47 + 1.3) * 0.03;
    const pos = new THREE.Vector3(this.me.x, height + hy, this.me.z)
      .addScaledVector(f, -back)
      .addScaledVector(r, sideOff + hx);

    // Frame what matters: you from the hips up, your partner head to toe with
    // a little road under them, and the ball in flight.
    this.fl = this.init ? damp(this.fl, s.flight ?? 0, s.flight ? 0.35 : 0.5, dt) : 0;
    const fl = this.fl * this.fl * (3 - 2 * this.fl);
    // Following a long throw, the points that keep you in the frame slide over to your friend (and so drop out).
    const mine = (x: number, y: number, z: number): Vec3 => [x + (s.partner[0] - x) * fl, y + (1.2 - y) * fl, z + (s.partner[2] - z) * fl];
    const pts: Vec3[] = [
      mine(s.me[0], 0.75, s.me[2]), mine(s.me[0], 2.0, s.me[2]),
      [s.partner[0], -0.6 + 0.4 * fl, s.partner[2]], [s.partner[0], 2.3, s.partner[2]],
    ];
    // Room for your glove and throwing arm either side of you.
    pts.push(mine(s.me[0] + r.x * 0.5, 1.25, s.me[2] + r.z * 0.5), mine(s.me[0] - r.x * 0.5, 1.25, s.me[2] - r.z * 0.5));
    if (s.ball) pts.push([s.ball[0], Math.min(s.ball[1], 7 + 60 * fl) + 0.6 * fl, s.ball[2]]);
    if (w > 0.01) {
      // Head to toe, the hands over the head, and the stride.
      pts.push(mine(s.me[0], 0.75 - 0.85 * w, s.me[2]), mine(s.me[0], 2.0 + 0.3 * w, s.me[2]), mine(s.me[0] + f.x * 1.3 * w, 0.75 - 0.8 * w, s.me[2] + f.z * 1.3 * w));
    }
    if (s.aim) pts.push([s.aim[0], s.aim[1] + 0.2, s.aim[2]], [s.aim[0], s.aim[1] - 0.2, s.aim[2]]);
    const yawOf = (p: Vec3) => wrapAngle(Math.atan2(-(p[0] - pos.x), -(p[2] - pos.z)) - this.axis);
    const pitchOf = (p: Vec3) => Math.atan2(p[1] - pos.y, Math.hypot(p[0] - pos.x, p[2] - pos.z));
    // Your partner sits near the middle of the frame, you off to one side.
    const cm = 0.42 * (1 - fl);
    const centreYaw = yawOf([s.me[0], 0, s.me[2]]) * cm + yawOf([s.partner[0], 0, s.partner[2]]) * (1 - cm);
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
    const minHalf = (portrait ? 0.34 - 0.06 * w : 0.28 - 0.06 * w) * (1 - fl) + 0.055 * fl;
    let half = clamp(Math.max(hV * 1.02, hH), minHalf, portrait ? 0.7 : 0.6);
    const midP = (pHi + pLo) / 2;
    const wantPitch = midP - ((top + bottom) / 2) * half;
    const wantYaw = this.axis + centreYaw;
    if (!this.init) { this.half = half; this.pitchC = wantPitch; this.yawC = wantYaw; this.init = true; }
    // Breathe slowly; pan a little quicker so the ball never escapes.
    const quick = w > 0.02 && w < 0.98 ? 0.45 : 1;
    this.half = damp(this.half, half, (s.ball ? 0.55 : 0.9) * quick, dt);
    this.pitchC = damp(this.pitchC, wantPitch, 0.45 * quick, dt);
    this.yawC += wrapAngle(wantYaw - this.yawC) * (1 - Math.exp(-dt / (0.5 * quick)));
    half = this.half;
    let roll = Math.sin(this.t * 0.23) * 0.004;
    let pitch = this.pitchC + Math.sin(this.t * 0.6) * 0.002;
    let yaw = this.yawC;
    let fov = (half * 2 * 180) / Math.PI;

    // ---- your own eyes, and the move between the two views
    const want = first && eyes ? 1 : 0;
    if (this.instant) this.k = want;
    else this.k = clamp(this.k + (want ? dt / TO_FIRST : -dt / TO_THIRD), 0, 1);
    const e = this.k * this.k * this.k * (this.k * (this.k * 6 - 15) + 10);
    this.blend = e;
    if (eyes && this.k > 0) {
      const v = this.eyeView(dt, eyes, portrait);
      // Travel in an easy arc: up and over the shoulder, not through the back of the head.
      pos.lerp(v.pos, e);
      pos.y += Math.sin(Math.PI * e) * 0.22;
      yaw += wrapAngle(v.yaw - yaw) * e;
      pitch += (v.pitch - pitch) * e;
      roll += (v.roll - roll) * e;
      fov += (v.fov - fov) * e;
    } else this.eInit = false;
    // The knock of a catch: a damped spring on the pitch.
    this.kickV += (-this.kickX * 260 - this.kickV * 22) * dt;
    this.kickX += this.kickV * dt;
    this.camera.position.copy(pos);
    this.camera.rotation.set(pitch + this.kickX * 0.05, yaw, roll, 'YXZ');
    this.camera.fov = fov + this.kickX * 3;
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  /**
   * First person. The eyes sit where the head is and look mostly at the ball
   * (or the thrower), partly at the glove, so both stay in view; as the ball
   * arrives the two become the same place. Turning is quick enough to keep up
   * and soft enough not to lurch.
   */
  private eyeView(dt: number, s: EyeShot, portrait: boolean) {
    const eye = new THREE.Vector3(s.eye[0], s.eye[1], s.eye[2]);
    const ang = (p: Vec3) => {
      const dx = p[0] - eye.x, dy = p[1] - eye.y, dz = p[2] - eye.z;
      return { yaw: wrapAngle(Math.atan2(-dx, -dz) - s.yaw), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
    };
    const far = ang(s.far), near = ang(s.near);
    // Watching the thrower: a longer lens. A throw on its way: the view opens up.
    const wantFov = portrait ? 60 + 20 * s.wide : 46 + 28 * s.wide;
    // Look between the two, but never so far toward your hands that what you're
    // watching leaves the frame: the ball always stays in view.
    const vHalf = ((this.eInit ? this.eFov : wantFov) * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * this.aspect);
    // The head turns a little; it does not swing. A throw that is going wide is
    // followed by moving your feet (the whole view slides over), with the road
    // and the thrower still in the picture to stand on.
    const dy = wrapAngle(near.yaw - far.yaw) * s.yawK;
    const wantYaw = s.yaw + clamp(clamp(far.yaw, -EYE_TURN, EYE_TURN) + clamp(dy, -0.5 * hHalf, 0.5 * hHalf), -EYE_TURN, EYE_TURN);
    const dp = (near.pitch - far.pitch) * s.pitchK;
    const wantPitch = clamp(far.pitch + clamp(dp, -(0.62 + 0.64 * (s.landing ?? 0)) * vHalf, 0.5 * vHalf), -1.2, 0.9);
    const wantRoll = clamp(-s.lean * 0.3, -0.13, 0.13);
    if (!this.eInit) {
      this.eInit = true;
      this.ePos.copy(eye); this.eYaw = wantYaw; this.ePitch = wantPitch; this.eFov = wantFov; this.eRoll = wantRoll;
    }
    const kp = 1 - Math.exp(-dt / 0.05), ky = 1 - Math.exp(-dt / 0.16);
    this.ePos.x += (eye.x - this.ePos.x) * kp;
    this.ePos.z += (eye.z - this.ePos.z) * kp;
    this.ePos.y = damp(this.ePos.y, eye.y, 0.09, dt);
    this.eYaw += wrapAngle(wantYaw - this.eYaw) * ky;
    this.ePitch = damp(this.ePitch, wantPitch, 0.11, dt);
    this.eFov = damp(this.eFov, wantFov, 0.22, dt);
    this.eRoll = damp(this.eRoll, wantRoll, 0.14, dt);
    // A little behind the eyes (where a cap-cam would sit), so your glove and
    // arm are in the picture and the catch isn't jammed against the lens.
    const pos = this.ePos.clone();
    pos.x += Math.sin(this.eYaw) * EYE_BACK;
    pos.z += Math.cos(this.eYaw) * EYE_BACK;
    pos.y += 0.03;
    return { pos, yaw: this.eYaw, pitch: this.ePitch, roll: this.eRoll, fov: this.eFov };
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
