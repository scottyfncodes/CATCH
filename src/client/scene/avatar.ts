// A person playing catch, seen from a few metres away. Low-poly, but built to
// move like someone: legs that step, a pelvis that carries weight and drops
// into a crouch, a torso that twists into a throw, a head that tracks the
// ball, a glove arm that reaches exactly where the shared pose says the glove
// is, and a throwing arm that winds up, whips through and follows through.

import * as THREE from 'three';
import { type Hand, type Pose, bodyToWorld, gloveWorld, worldToBody } from '../../shared/pose';
import { Arm } from '../../shared/protocol';
import { type Vec3, clamp, wrapAngle } from '../../shared/vec';
import { DELIVERY_LENGTH, type DeliveryPose, RELEASE_TIME, type Windup, deliveryPose, exaggerate, getWindup, pelvisHeight, windupPose, windupScale } from '../../shared/windups';
import { BUILDS, GLOVES, HAIR_COLORS, HATS, type Hat, PANTS, S, SKINS, type Style, TOPS } from '../../shared/style';
import { buildGlove, buildHand, setGloveClosure } from './gear';
import { rim } from './look';
import { type Tick, type WearFrame, buildHat, decorateGlove, dress, hatCovers } from './wear';
import { ELBOW, KNEE, SHOULDER, collarGeo, eyesGeo, headGeo, jointGeo, limbs, neckGeo, shoeGeo, torsoGeo } from './body';


/** Hair, drawn so it sits under whatever is on the head. */
function buildHair(kind: number, mat: THREE.Material, hat: Hat['shape']): THREE.Group {
  const g = new THREE.Group();
  if (kind === 0) return g;
  const covered = hatCovers(hat);
  // A close crop over the top and back of the head (a hat hides the top of it).
  // (Round enough, and far enough off the skull, that the scalp never shows through its facets.)
  const crop = new THREE.Mesh(new THREE.SphereGeometry(0.119, 22, 12, 0, Math.PI * 2, 0, Math.PI * (covered ? 0.62 : 0.56)), mat);
  // (Tall enough over the crown that the top of the skull never shows through, tipped back or not.)
  crop.scale.set(0.94, 1.08, 1.02);
  crop.position.set(0, 0.018, 0.006);
  crop.rotation.x = 0.32;
  g.add(crop);
  const ball = (r: number, x: number, y: number, z: number) => { const b = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), mat); b.position.set(x, y, z); g.add(b); };
  if (kind === 2) {
    // Curls: a ring of them round the sides and back, and over the top when nothing is in the way.
    for (let i = 0; i < 9; i++) { const a = Math.PI * 0.25 + (i / 8) * Math.PI * 1.5; ball(0.046, Math.sin(a) * 0.092, -0.005, -Math.cos(a) * 0.092 + 0.012); }
    if (!covered) for (let i = 0; i < 7; i++) { const a = (i / 7) * Math.PI * 2; ball(0.05, Math.sin(a) * 0.06, 0.105, Math.cos(a) * 0.06 + 0.008); }
  } else if (kind === 3) {
    // Long: down the back to the shoulders.
    const fall = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.13, 4, 8), mat);
    fall.scale.set(1.15, 1, 0.55);
    fall.position.set(0, -0.085, 0.082);
    g.add(fall);
  } else if (kind === 4) {
    // Ponytail: out through the back.
    const tail = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.13, 4, 6), mat);
    tail.position.set(0, -0.03, 0.145);
    tail.rotation.x = -0.5;
    g.add(tail);
    ball(0.036, 0, 0.035, 0.115);
  } else if (kind === 5) {
    // Bun: high on the back of the head.
    ball(0.05, 0, covered ? 0.02 : 0.085, covered ? 0.125 : 0.095);
  }
  return g;
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpM = new THREE.Matrix4();
const SHOULDER_L = new THREE.Vector3(-0.215, 0.5, 0), SHOULDER_R = new THREE.Vector3(0.215, 0.5, 0);
/** How far a shoulder can travel on its own (shrug, reach forward) before the trunk has to go with it (m). */
const SHOULDER_TRAVEL = 0.065;
/** How far the hand can bend off the line of the forearm (rad): about 83 degrees (a glove held fingers-up in front of the chest is near it). */
const WRIST_MAX = 1.45;

const THIGH = 0.45, SHIN = 0.44, HIP_W = 0.1, HIP_Y = 0.92;
const UPPER = 0.29, FORE = 0.27;

function joint(mat: THREE.Material, r: number) {
  const m = new THREE.Mesh(jointGeo(r), mat);
  m.castShadow = true;
  return m;
}

function placeSeg(m: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3) {
  tmpC.subVectors(b, a);
  const l = tmpC.length() || 1e-4;
  m.position.copy(a);
  m.quaternion.setFromUnitVectors(UP, tmpC.divideScalar(l));
  m.scale.set(1, l, 1);
}

/** Two-bone IK: returns the middle joint for a root → end chain, bending toward `pole`. */
function solve2(s: THREE.Vector3, t: THREE.Vector3, a: number, b: number, pole: THREE.Vector3, outMid: THREE.Vector3, outEnd: THREE.Vector3) {
  const dir = tmpA.subVectors(t, s);
  let d = dir.length();
  dir.divideScalar(d || 1);
  d = clamp(d, 0.08, a + b - 0.002);
  outEnd.copy(s).addScaledVector(dir, d);
  const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const perp = tmpB.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (perp.lengthSq() < 1e-6) perp.set(0, -1, 0);
  perp.normalize();
  outMid.copy(s).addScaledVector(dir, a * cosA).addScaledVector(perp, a * sinA);
}

const smooth = (k: number) => k * k * (3 - 2 * k);

interface Foot { pos: THREE.Vector3; from: THREE.Vector3; to: THREE.Vector3; t: number; stepping: boolean }

export interface AvatarFrame {
  pose: Pose;
  arm: number;
  charge: number;
  /** World point the head should track (the ball, or the friend). */
  look: Vec3 | null;
  /** Ball sits in the glove (just caught). */
  gloved?: boolean;
  /** A throw is coming: knees bent, on the balls of the feet. */
  ready?: boolean;
  /** Height off the grass (a leap for a high one), metres. */
  lift?: number;
  /** A dive: -1..1, toward the body's left/right. */
  dive?: number;
  /** How far back the thumb is pulled (0..1): the windup is drawn that much bigger. Half is the windup as written. */
  pull?: number;
  /** How far behind real time this pose is (seconds): a remote player's delivery makes it up. */
  lag?: number;
}

/** When the delivery hands the feet back to the step planner (they walk back to the spot). */
const FEET_BACK = 0.8;

export class Avatar {
  root = new THREE.Group();
  readonly glove: THREE.Group;
  readonly handMesh: THREE.Group;
  private pelvis = new THREE.Group();
  private torso = new THREE.Group();
  private chest: THREE.Mesh;
  private head = new THREE.Group();
  private shoulderL = new THREE.Object3D();
  private shoulderR = new THREE.Object3D();
  private armSegs: THREE.Object3D[];
  private legSegs: THREE.Mesh[];
  private knees: THREE.Mesh[];
  private elbows: THREE.Mesh[];
  private shoes: THREE.Mesh[];
  private mats: THREE.MeshStandardMaterial[] = [];
  private feet: Foot[];
  /** Smoothed body state. */
  private pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private bodyYaw: number;
  private crouch = 0;
  private tiptoe = 0;
  private leanF = 0;
  private leanS = 0;
  private throwTarget = new THREE.Vector3();
  private throwInit = false;
  private lastArm = 0;
  /** The delivery this player throws with. */
  private windup: Windup;
  /** How far through the windup (0..1). */
  private wu = 0;
  /** Seconds into the delivery clip, or -1. */
  private deliveryT = -1;
  private deliveryFrom = 1;
  /** How much the delivery owns the body right now (0..1). */
  private dw = 0;
  private dpose: DeliveryPose | null = null;
  private feetOwned = false;
  private coreMats: THREE.MeshStandardMaterial[] = [];
  private coreAlpha = 1;
  private sleeve!: THREE.MeshStandardMaterial;
  /** The glove arm's skin above the elbow: it thins out with the sleeve. */
  private sleeveSkin!: THREE.MeshStandardMaterial;
  private sleeveA = new THREE.Vector3();
  private sleeveB = new THREE.Vector3();
  private diveK = 0;
  private gloveK = 0;
  private gloveV = 0;
  private gloveSet = false;
  /** The glove arm's joints as last solved (root space), for validation: nothing in play reads these. */
  readonly joints = {
    shoulder: new THREE.Vector3(), elbow: new THREE.Vector3(), wrist: new THREE.Vector3(), glove: new THREE.Vector3(),
    pocket: new THREE.Vector3(), fingers: new THREE.Vector3(), forearm: new THREE.Vector3(), pole: new THREE.Vector3(), gap: 0,
  };
  private debt = 0;
  private showK = 0;
  /** World position of the eyes (first-person camera). */
  readonly eye = new THREE.Vector3();
  private recoil = 0;
  /** Things worn that move (a propeller, googly pupils, flames, a cape): run once a frame, after the body is posed. */
  private ticks: Tick[] = [];
  private wearFrame: WearFrame | null = null;
  /** How big the windup is being drawn right now (1 = as written). */
  private big = 1;
  private recoilDir = new THREE.Vector3();
  /** Where on the glove the ball struck (about the glove's own x and y axes): a ball off the centre of the pocket turns it. */
  private hinge = new THREE.Vector2();
  private gloveBase = new THREE.Quaternion();
  private closure = 0;
  private transferT = -1;
  private tapT = -1;
  private idleT = 0;
  private time = Math.random() * 10;
  private placed = false;
  /** World position of the throwing hand's ball grip. */
  readonly handBall = new THREE.Vector3();
  readonly gloveWorldPos = new THREE.Vector3();
  readonly headTop = new THREE.Vector3();
  readonly chestPos = new THREE.Vector3();

  constructor(home: Vec3, facing: number, public hand: Hand, readonly style: Style, windup = 0) {
    const m = (c: string, r = 0.8) => { const x = rim(new THREE.MeshStandardMaterial({ color: c, roughness: r })); this.mats.push(x); return x; };
    const skinHex = SKINS[style[S.skin]], top = TOPS[style[S.top]], hat = HATS[style[S.hat]];
    const w = BUILDS[style[S.build]].w;
    const pants = m(PANTS[style[S.pants]], 0.86), skin = m(skinHex, 0.58), shoe = m('#ffffff', 0.72);
    // The head and chest get their own materials: in first person they fade
    // out of the way (and keep casting your shadow on the grass).
    const core = (c: string, r = 0.8) => { const x = m(c, r); this.coreMats.push(x); return x; };
    const shirtC = core(top.color), skinC = core(skinHex, 0.6);
    const sleeveHex = top.color;
    this.bodyYaw = facing;
    this.windup = getWindup(windup);

    // Legs: thigh + shin per side, knees solved each frame. (A build is how
    // thick you are, never how far you reach: joints stay where they are.)
    const L = limbs(w);
    const part = (g: THREE.BufferGeometry, mat: THREE.Material) => { const x = new THREE.Mesh(g, mat); x.castShadow = true; return x; };
    this.legSegs = [part(L.thigh, pants), part(L.shin, pants), part(L.thigh, pants), part(L.shin, pants)];
    this.knees = [joint(pants, KNEE * w), joint(pants, KNEE * w)];
    // Sneakers: one mesh each, its parts told apart by vertex colour.
    shoe.vertexColors = true;
    this.shoes = [0, 1].map(() => part(shoeGeo(), shoe));
    this.root.add(...this.legSegs, ...this.knees, ...this.shoes);

    // Pelvis carries the torso; it drops and shifts with weight.
    // (The hips fade with the head and chest in first person: from above they are just a blob.)
    const hips = new THREE.Mesh(new THREE.CapsuleGeometry(0.115, 0.1, 4, 10), core(PANTS[style[S.pants]], 0.86));
    hips.rotation.z = Math.PI / 2;
    hips.scale.set(w, 1, 0.8 * w);
    this.pelvis.add(hips);
    this.root.add(this.pelvis);
    this.torso.position.y = 0.04;
    this.torso.rotation.order = 'YXZ';
    this.pelvis.add(this.torso);
    // The trunk: shoulders, a chest, a waist, a shirt that hangs a little loose over the belt.
    this.chest = new THREE.Mesh(torsoGeo(), shirtC);
    this.chest.scale.set(1.18 * w, 1, 0.7 * w);
    this.chest.position.y = 0.3;
    this.torso.add(this.chest);
    // Anything that isn't a plain tee: the print, and whatever comes with it (a lei, tails, a cape, a robe).
    const outfit = dress(top, this.torso, shirtC, core, w);
    this.ticks.push(...outfit.ticks);
    this.shoulderL.position.copy(SHOULDER_L);
    this.shoulderR.position.copy(SHOULDER_R);
    this.torso.add(this.shoulderL, this.shoulderR);
    const shoulderMat = core(sleeveHex);
    const sleeveMats: THREE.MeshStandardMaterial[] = [shoulderMat];
    for (const sh of [this.shoulderL, this.shoulderR]) sh.add(joint(shoulderMat, SHOULDER * w));
    // A ribbed collar, a shade deeper than the shirt (or in its second colour).
    const collar = new THREE.Mesh(collarGeo(), core(outfit.collar));
    collar.position.y = 0.584;
    this.torso.add(collar);
    const neck = new THREE.Mesh(neckGeo(), skinC);
    neck.position.set(0, 0.61, 0.004);
    this.torso.add(neck);
    this.head.position.y = 0.7;
    // (A touch larger than life: a face and a cap read from across the road.)
    this.head.scale.setScalar(1.06);
    this.head.rotation.order = 'YXZ';
    this.torso.add(this.head);
    // A head with a jaw, a nose and ears (one mesh), and eyes.
    this.head.add(new THREE.Mesh(headGeo(), skinC), new THREE.Mesh(eyesGeo(), core('#2b1d17', 0.35)));
    this.head.add(buildHair(style[S.hair], core(HAIR_COLORS[style[S.hairColor]], 0.9), hat.shape));
    const worn = buildHat(hat, core);
    this.head.add(worn.group);
    if (worn.tick) this.ticks.push(worn.tick);

    // Arms live in world space (IK each frame).
    // In first person the throwing arm's sleeve fades with the head and chest (its
    // shoulder sits right under the camera). The glove arm keeps its sleeve, so the
    // arm you watch is a whole arm; it only thins out if it swings in close to the lens.
    this.sleeve = m(sleeveHex);
    this.sleeveSkin = m(skinHex, 0.58);
    // An upper arm is a short sleeve with the arm coming out of it.
    const upper = (cloth: THREE.Material, arm: THREE.Material) => { const g = new THREE.Group(); g.add(part(L.sleeve, cloth), part(L.upperArm, arm)); return g; };
    const throwSleeve = core(sleeveHex);
    sleeveMats.push(this.sleeve, throwSleeve);
    // (A printed shirt's sleeves are printed too.)
    if (outfit.sleeve) for (const sm of sleeveMats) { sm.map = outfit.sleeve; sm.color.set('#ffffff'); }
    this.armSegs = [upper(this.sleeve, this.sleeveSkin), part(L.forearm, skin), upper(throwSleeve, skinC), part(L.forearm, skin)];
    this.elbows = [joint(skin, ELBOW * w), joint(skin, ELBOW * w)];
    // A regular glove, at its real size.
    this.glove = buildGlove(GLOVES[style[S.glove]]);
    const decor = decorateGlove(this.glove, GLOVES[style[S.glove]]);
    if (decor) this.ticks.push(decor);
    if (hand === 'L') this.glove.scale.x = -1;
    this.handMesh = buildHand(skinHex);
    this.handMesh.scale.setScalar(1.2);
    if (hand === 'L') this.handMesh.scale.x = -1.2;
    this.root.add(...this.armSegs, ...this.elbows, this.glove, this.handMesh);
    // Arms are positioned in world space: keep them out of the root transform.
    for (const o of [...this.armSegs, ...this.elbows, this.glove, this.handMesh, ...this.legSegs, ...this.knees, ...this.shoes]) o.matrixAutoUpdate = true;

    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
    if (worn.group.userData.noShadow) worn.group.traverse((o) => { o.castShadow = false; });
    this.feet = [0, 1].map(() => ({ pos: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(), t: 1, stepping: false }));
    this.teleport(home, facing);
  }

  /** Put the body somewhere instantly (spawn, new layout). */
  teleport(p: Vec3, yaw: number) {
    this.pos.set(p[0], 0, p[2]);
    this.vel.set(0, 0, 0);
    this.bodyYaw = yaw;
    this.placed = true;
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      f.pos.copy(this.stance(i, yaw));
      f.from.copy(f.pos); f.to.copy(f.pos); f.t = 1; f.stepping = false;
    }
  }

  get position(): THREE.Vector3 { return this.pos; }

  /** Where a foot wants to be when standing (side 0 = left). */
  private stance(i: number, yaw: number, out = new THREE.Vector3()) {
    const sx = i === 0 ? -1 : 1;
    // A relaxed stance: feet a bit wider than the hips, glove-side foot slightly ahead.
    const gloveSide = this.hand === 'R' ? -1 : 1;
    const fwd = sx === gloveSide ? 0.07 : -0.05;
    const o = bodyToWorld(yaw, [sx * 0.15, 0, fwd]);
    return out.set(this.pos.x + o[0], 0, this.pos.z + o[2]);
  }

  setConnected(on: boolean) {
    // (Three bakes "opaque" into the shader: flipping `transparent` needs a rebuild to show.)
    for (const m of this.mats) { if (m.transparent === on) m.needsUpdate = true; m.transparent = !on; m.opacity = on ? 1 : 0.4; }
  }

  setWindup(id: number) { this.windup = getWindup(id); }
  get windupId() { return this.windup.id; }

  /** First person: fade the head and chest out of the camera's way (1 = solid). */
  setCoreOpacity(a: number) {
    if (a === this.coreAlpha || (Math.abs(a - this.coreAlpha) < 0.004 && a > 0 && a < 1)) return;
    this.coreAlpha = a;
    for (const m of this.coreMats) {
      const t = a < 0.995;
      if (m.transparent !== t) { m.transparent = t; m.needsUpdate = true; }
      m.opacity = a;
      m.depthWrite = a > 0.6;
    }
  }

  /** First person: thin the glove arm's sleeve out when it comes in close to the camera (null = solid). */
  fadeSleeve(cam: THREE.Vector3 | null) {
    let a = 1;
    if (cam) {
      // Distance from the camera to the nearest point of the upper arm.
      const ab = tmpA.subVectors(this.sleeveB, this.sleeveA);
      const t = clamp(tmpB.subVectors(cam, this.sleeveA).dot(ab) / Math.max(1e-6, ab.lengthSq()), 0, 1);
      const d = tmpB.copy(this.sleeveA).addScaledVector(ab, t).distanceTo(cam);
      a = smooth(clamp((d - 0.24) / 0.16, 0, 1));
    }
    if (this.sleeve.opacity === a) return;
    const t = a < 0.995;
    for (const m of [this.sleeve, this.sleeveSkin]) {
      if (m.transparent !== t) { m.transparent = t; m.needsUpdate = true; }
      m.opacity = a;
      m.depthWrite = a > 0.6;
    }
  }

  /** Big mitt: the glove at `size` times a regular one. */
  setGloveSize(size: number) {
    if (this.glove.scale.y !== size) this.glove.scale.set(this.hand === 'L' ? -size : size, size, size);
  }

  /** Seconds into the delivery clip (-1 when not throwing). The ball leaves at RELEASE_TIME. */
  get deliveryTime() { return this.deliveryT; }

  /** Seconds until the ball leaves this player's hand (a delivery that hasn't started counts in full). */
  get timeToRelease() { return this.deliveryT < 0 ? RELEASE_TIME : Math.max(0, RELEASE_TIME - this.deliveryT - this.debt); }
  /** Sideways lean of the trunk (rad, + = to the body's right). */
  get sideLean() { return this.leanS; }

  /** Start the delivery. `behind` seconds of it have already happened for real: it plays quicker until it has caught up. */
  startDelivery(behind = 0) {
    if (this.deliveryT >= 0) return;
    this.deliveryT = 0; this.deliveryFrom = this.wu; this.feetOwned = true; this.debt = behind;
  }

  /** Called when this player catches the ball (glove recoil + snap shut). */
  catchImpact(vel: Vec3, speed: number, off?: Vec3) {
    this.recoil = Math.min(1, 0.35 + speed / 26);
    this.recoilDir.set(vel[0], vel[1], vel[2]).normalize();
    // Off the middle of the pocket (`off`: from the pocket to the ball, world), the glove is turned by it:
    // tipped back by one caught up in the fingers, twisted by one out on the web or the heel of the hand.
    this.hinge.set(0, 0);
    if (off) {
      const l = tmpA.set(off[0], off[1], off[2]).applyQuaternion(tmpQ.copy(this.gloveBase).invert());
      const size = Math.abs(this.glove.scale.y) || 1;
      this.hinge.set(clamp(l.y / (0.11 * size), -1, 1), clamp(-l.x / (0.11 * size), -1, 1)).multiplyScalar(clamp(speed / 24, 0.3, 1));
    }
    this.closure = 1;
    this.gloveV += 9;
  }
  /** Throwing hand reaches over and takes the ball out of the glove. */
  transfer() { this.transferT = 0; }

  update(dt: number, f: AvatarFrame) {
    this.time += dt;
    const { pose, arm } = f;
    const side = this.hand === 'R' ? 1 : -1;
    const lift = f.lift ?? 0;
    this.diveK += ((f.dive ?? 0) - this.diveK) * (1 - Math.exp(-dt / 0.07));
    const dive = this.diveK;

    // ---- body position and facing (smoothed toward the streamed pose)
    const target = tmpC.set(pose.x, 0, pose.z);
    if (!this.placed || target.distanceTo(this.pos) > 6) this.teleport([pose.x, 0, pose.z], pose.yaw);
    const prev = this.pos.clone();
    this.pos.lerp(target, 1 - Math.exp(-dt / 0.06));
    const v = prev.sub(this.pos).multiplyScalar(-1 / Math.max(dt, 1e-3));
    this.vel.lerp(v, 1 - Math.exp(-dt / 0.1));
    this.bodyYaw += wrapAngle(pose.yaw - this.bodyYaw) * (1 - Math.exp(-dt / 0.12));
    const yaw = this.bodyYaw;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    // Everything below is laid out in the root's own space; a leap lifts the root.
    this.root.position.set(0, 0, 0);
    this.root.rotation.set(0, 0, 0);

    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    /** Pitch-frame point (x toward the throwing side, y up, z toward the target) → root space. */
    const pitch = (p: Vec3, out = new THREE.Vector3()) => out.copy(this.pos).addScaledVector(right, side * p[0]).addScaledVector(fwd, p[2]).setY(p[1]);

    // ---- the delivery: a windup scrubbed by the streamed phase, then a timed clip
    // through the stride, the release and the follow-through.
    if (arm === Arm.Windup) this.wu = clamp(f.charge, 0, 1);
    if (arm !== this.lastArm && arm === Arm.Release) this.startDelivery(f.lag ?? 0);
    this.lastArm = arm;
    if (this.deliveryT >= 0) {
      const extra = Math.min(this.debt, dt);
      this.debt -= extra;
      this.deliveryT += dt + extra;
      if (this.deliveryT >= DELIVERY_LENGTH) { this.deliveryT = -1; this.wu = 0; this.dw = 0; }
    }
    const throwing = this.deliveryT >= 0;
    let fade = 1;
    if (throwing) {
      // (The size of the windup is gone by the time the arm comes through: every throw leaves from the same slot.)
      this.dpose = exaggerate(this.windup, deliveryPose(this.windup, this.deliveryT, this.deliveryFrom), 1 + (this.big - 1) * (1 - smooth(clamp(this.deliveryT / 0.2, 0, 1))));
      fade = 1 - smooth(clamp((this.deliveryT - 0.74) / (DELIVERY_LENGTH - 0.74), 0, 1));
      this.dw += (1 - this.dw) * (1 - Math.exp(-dt / 0.045));
    } else if (arm === Arm.Windup) {
      // The further back the thumb, the bigger the windup.
      this.big += (windupScale(f.pull ?? 0.5) - this.big) * (1 - Math.exp(-dt / 0.12));
      this.dpose = exaggerate(this.windup, windupPose(this.windup, this.wu), this.big);
      if (this.wu > 0.98) {
        // Balanced at the top: alive, not frozen.
        this.dpose.lead[1] += Math.sin(this.time * 2.3) * 0.012;
        this.dpose.tilt += Math.sin(this.time * 1.4) * 0.012;
      }
      this.dw += (1 - this.dw) * (1 - Math.exp(-dt / 0.07));
    } else {
      this.dw += (0 - this.dw) * (1 - Math.exp(-dt / 0.11));
      if (this.dw < 0.004) { this.dw = 0; this.wu = 0; }
    }
    const P = this.dpose;
    const dw = P ? this.dw * fade : 0;
    // The feet belong to the clip until the follow-through lands; then they walk back.
    if (throwing && this.feetOwned && this.deliveryT >= FEET_BACK && P) {
      this.feetOwned = false;
      const gf = this.hand === 'R' ? 0 : 1;
      pitch(P.lead, this.feet[gf].pos).setY(0);
      pitch(P.pivot, this.feet[1 - gf].pos).setY(0);
      for (const ft of this.feet) { ft.stepping = false; ft.from.copy(ft.pos); ft.to.copy(ft.pos); ft.t = 1; }
    }
    if (!throwing) this.feetOwned = false;
    const footW = throwing ? (this.feetOwned ? dw : 0) : dw;

    // ---- glove target in body space decides crouch and lean
    const gw = gloveWorld(pose);
    gw[1] -= lift;
    const gl = worldToBody(yaw, [gw[0] - this.pos.x, gw[1], gw[2] - this.pos.z]);
    const wantCrouch = (f.ready ? 0.1 : 0.025) + clamp((0.95 - gl[1]) / 0.75, 0, 1) * 0.3 + Math.min(0.06, speed * 0.012) + Math.abs(dive) * 0.3;
    this.crouch += (wantCrouch - this.crouch) * (1 - Math.exp(-dt / 0.09));
    // Posture (secondary motion, eased): bend at the waist toward a low glove,
    // lean into a run or a dive. Getting the glove *there* is not posture: the
    // reach is solved exactly, further down, through shoulder, trunk and hips.
    const wantLeanF = clamp((0.9 - gl[1]) * 0.3, 0, 0.3) + clamp(speed * 0.02, 0, 0.08);
    const wantLeanS = dive * 0.8;
    this.leanF += (wantLeanF - this.leanF) * (1 - Math.exp(-dt / 0.1));
    this.leanS += (wantLeanS - this.leanS) * (1 - Math.exp(-dt / 0.1));

    // ---- feet: a simple step planner. Feet stay planted until the body
    // leaves them behind, then a step arcs to the new stance.
    const gloveFoot = this.hand === 'R' ? 0 : 1;
    const stepDur = clamp(0.32 - speed * 0.03, 0.17, 0.32);
    for (let i = 0; i < 2 && footW < 0.02; i++) {
      const ft = this.feet[i];
      const want = this.stance(i, yaw);
      // Moving: plant ahead along the velocity.
      want.addScaledVector(this.vel, clamp(stepDur * 0.7, 0, 0.3));
      // A wide reach: the foot on that side steps out under it (weight goes with the glove).
      const out = clamp((Math.abs(gl[0]) - 0.5) * 0.7, 0, 0.3) * (1 - dw);
      if (out > 0 && (i === 0 ? -1 : 1) === Math.sign(gl[0])) want.addScaledVector(right, Math.sign(gl[0]) * out);
      const other = this.feet[1 - i];
      if (ft.stepping) {
        ft.t += dt / stepDur;
        ft.to.lerp(want, 0.25);
        const k = Math.min(1, ft.t);
        ft.pos.lerpVectors(ft.from, ft.to, smooth(k));
        ft.pos.y = Math.sin(Math.PI * k) * (0.05 + Math.min(0.08, speed * 0.02));
        if (k >= 1) { ft.stepping = false; ft.pos.y = 0; }
      } else if (!other.stepping && (ft.pos.distanceTo(want) > 0.2 || (speed > 0.4 && ft.pos.distanceTo(want) > 0.12))) {
        // Only one foot in the air at a time; the further-behind foot goes first.
        const otherErr = other.pos.distanceTo(this.stance(1 - i, yaw));
        if (ft.pos.distanceTo(want) >= otherErr - 0.02) {
          ft.stepping = true; ft.t = 0; ft.from.copy(ft.pos); ft.to.copy(want);
        }
      }
    }
    // Where the feet are drawn: the planner's, or the delivery's.
    const feet = [this.feet[0].pos.clone(), this.feet[1].pos.clone()];
    if (P && footW > 0) {
      feet[gloveFoot].lerp(pitch(P.lead), footW);
      feet[1 - gloveFoot].lerp(pitch(P.pivot), footW);
    }
    // Off the ground: knees tuck a little.
    if (lift > 0) for (const ft of feet) ft.y += Math.min(0.14, lift * 0.4);

    // ---- pelvis: between the feet, dropped by the crouch, bobbing with steps
    const mid = tmpA.addVectors(this.feet[0].pos, this.feet[1].pos).multiplyScalar(0.5);
    const centre = new THREE.Vector3(this.pos.x, 0, this.pos.z).lerp(mid.setY(0), 0.35);
    const bob = Math.max(this.feet[0].pos.y, this.feet[1].pos.y) * 0.25;
    // Idle: slow weight shifts and breathing.
    const idle = speed < 0.2 && dw < 0.01 ? 1 : 0;
    const sway = Math.sin(this.time * 0.55) * 0.012 * idle;
    centre.addScaledVector(right, sway + dive * 0.25);
    // High glove: up on the toes.
    this.tiptoe += (clamp((gl[1] - 1.75) * 0.32, 0, 0.13) - this.tiptoe) * (1 - Math.exp(-dt / 0.1));
    let hipY = HIP_Y - this.crouch * 0.42 + this.tiptoe + bob - 0.01 * idle * (0.5 + 0.5 * Math.sin(this.time * 1.7));
    let hipTurn = 0, coil = 0, lean = this.leanF, tilt = -this.leanS * 0.8;
    if (P && dw > 0) {
      const pc = pitch([P.pelvis[0], 0, P.pelvis[2]]);
      centre.lerp(pc, dw);
      hipY += (pelvisHeight(P) - hipY) * dw;
      hipTurn = -side * P.hip * dw;
      coil = -side * P.coil * dw;
      lean += (P.lean - lean) * dw;
      tilt += (side * P.tilt - tilt) * dw;
    }
    const pelvisYaw = yaw + hipTurn;
    this.pelvis.position.set(centre.x, hipY, centre.z);
    this.pelvis.rotation.set(0, pelvisYaw, 0, 'YXZ');
    this.torso.rotation.set(-lean, coil, tilt);
    this.chest.scale.y = 1 + Math.sin(this.time * 1.7) * 0.012;

    // ---- where the glove is going, and how it is turned to receive the ball
    const gs = -side;
    const gloveShoulder = this.hand === 'R' ? this.shoulderL : this.shoulderR;
    const throwShoulder = this.hand === 'R' ? this.shoulderR : this.shoulderL;
    const gp = new THREE.Vector3(gw[0], gw[1], gw[2]);
    // While throwing, the glove belongs to the delivery (it leads the stride, then tucks).
    if (P && dw > 0) gp.lerp(pitch(P.glove), dw);
    // The arm gives with the ball: the glove rides back along its path and returns.
    this.recoil = Math.max(0, this.recoil - dt * 4.2);
    const give = this.recoil > 0 ? Math.sin(this.recoil * Math.PI) * this.recoil : 0;
    if (give > 0) gp.addScaledVector(this.recoilDir, 0.1 * give);
    // The pocket faces the ball coming in (out in front when there isn't one),
    // cupped a little up and back toward your own eyes, the way a hand presents a glove.
    const pocket = f.look && dw < 0.5 ? tmpB.set(f.look[0] - gp.x, f.look[1] - lift - gp.y, f.look[2] - gp.z).normalize().clone() : fwd.clone();
    if (pocket.dot(fwd) < -0.2) pocket.copy(fwd);
    pocket.addScaledVector(UP, 0.14).addScaledVector(fwd, -0.1).normalize();
    // Just caught: the pocket turns up toward you, and there's the ball in it.
    this.showK += ((f.gloved && dw < 0.1 ? 1 : 0) - this.showK) * (1 - Math.exp(-dt / (f.gloved ? 0.12 : 0.08)));
    if (this.showK > 0.01) pocket.lerp(tmpA.copy(fwd).multiplyScalar(-0.55).addScaledVector(UP, 0.83), this.showK * 0.85).normalize();
    // Which way the fingers point follows where the glove is around the body,
    // as it does on a fielder: up for a ball above the belt, down for one
    // below it, out to the side for a wide one, across for a backhand. It
    // turns continuously through those; there is no height at which it flips.
    const belt = tmpA.set(this.pos.x, hipY - 0.02, this.pos.z).addScaledVector(right, gs * 0.06).addScaledVector(fwd, 0.12).clone();
    const fingers = new THREE.Vector3().subVectors(gp, belt);
    // (Height counts for a little less than width, and the glove side is "out":
    // so in front of the belt the hand turns over through fingers-sideways,
    // across a forearm's length of travel, not in a hand's width.)
    fingers.y *= 0.8;
    fingers.addScaledVector(right, gs * 0.06);
    fingers.addScaledVector(pocket, -fingers.dot(pocket));
    // (Close in to the belt there is no "away from the body": settle on fingers up.)
    fingers.addScaledVector(UP, Math.max(0, 0.22 - fingers.length()) * 2.2);
    if (fingers.lengthSq() < 1e-6) fingers.copy(UP);
    fingers.normalize();
    // Impact: the wrist gives too (the glove hinges back a little, then returns).
    if (give > 0) { pocket.addScaledVector(fingers, 0.22 * give).normalize(); fingers.addScaledVector(pocket, -fingers.dot(pocket)).normalize(); }
    /** From the pocket back to the wrist: down the palm, and in behind the leather. */
    const HEEL = 0.088, PALM = 0.032;
    const wristT = gp.clone().addScaledVector(fingers, -HEEL).addScaledVector(pocket, -PALM);

    // ---- the reach, through a connected body. The arm is a fixed length, so
    // a glove further than the arm goes is reached the way a person reaches:
    // the shoulder goes first (it has a few centimetres of its own), then the
    // trunk leans and turns that way, then the hips shift and sink or rise.
    // Nothing stretches.
    const reachW = 1 - dw;
    const baseL = SHOULDER_L, baseR = SHOULDER_R;
    this.shoulderL.position.copy(baseL);
    this.shoulderR.position.copy(baseR);
    let reachGap = 0;
    if (reachW > 0.01) {
      // Across the body: the trunk turns to bring that shoulder round.
      const across = Math.max(0, -gl[0] * gs - 0.02);
      const twist = gs * Math.min(0.95, across * 1.4) * reachW;
      this.torso.rotation.y = coil + twist * 0.7;
      this.pelvis.rotation.y = pelvisYaw + twist * 0.3;
      // (A foot has stepped out under a wide one, so the hips can go further that way.)
      const stride = 0.2 + clamp((Math.abs(gl[0]) - 0.5) * 0.7, 0, 0.3) * 0.75;
      const ARM = UPPER + FORE - 0.012;
      const girdle = new THREE.Vector3(), shift = new THREE.Vector3();
      let addF = 0, addT = 0;
      const sh = new THREE.Vector3(), u = new THREE.Vector3(), inv = new THREE.Quaternion();
      const base = gloveShoulder === this.shoulderL ? baseL : baseR;
      /** Pose the trunk with the current corrections and measure how far short the arm is. */
      const measure = () => {
        this.torso.rotation.x = -clamp(lean + addF, -0.3, 1.0);
        this.torso.rotation.z = clamp(tilt + addT, -0.9, 0.9);
        this.pelvis.position.set(centre.x + shift.x, hipY + shift.y, centre.z + shift.z);
        this.pelvis.updateMatrixWorld(true);
        // The shoulder's own travel is set in the trunk's frame.
        inv.copy(this.torso.getWorldQuaternion(tmpQ)).invert();
        gloveShoulder.position.copy(base).add(tmpC.copy(girdle).applyQuaternion(inv));
        gloveShoulder.updateMatrixWorld(true);
        gloveShoulder.getWorldPosition(sh);
        u.subVectors(wristT, sh);
        const D = u.length();
        u.divideScalar(D || 1);
        reachGap = Math.max(0, D - ARM);
        return (D - ARM) * reachW;
      };
      // First, comfort: nobody catches with a locked elbow if they can help it.
      // While the glove is out in front, the trunk comes forward over it (the
      // athletic stance) until the arm has a working bend in it.
      const EASY = (UPPER + FORE) * 0.8;
      for (let it = 0; it < 4; it++) {
        const e = measure() + (ARM - EASY) * reachW;
        if (e <= 0.002) break;
        const ur = u.dot(right), uf = u.dot(fwd);
        addT = clamp(addT - Math.asin(clamp((ur * e * 0.7) / 0.5, -0.4, 0.4)), -0.22, 0.22);
        addF = clamp(addF + Math.asin(clamp((uf * e * 0.8) / 0.5, -0.4, 0.4)), -0.06, 0.34);
        shift.y = clamp(shift.y + u.y * e * 0.5, -0.1, 0.03);
      }
      // Then, need: whatever it takes to get there.
      for (let it = 0; it < 8; it++) {
        let e = measure();
        if (e <= 0.0008) break;
        const room = SHOULDER_TRAVEL - girdle.length();
        if (room > 1e-4) { const take = Math.min(e, room); girdle.addScaledVector(u, take); e -= take; if (e <= 0.0008) continue; }
        const ur = u.dot(right), uf = u.dot(fwd);
        // Trunk first, hips after: a lean covers most of it, the weight follows.
        // (The trunk bends only so far before it is a fall: past that it is the hips' job.)
        addT = clamp(addT - Math.asin(clamp((ur * e * 0.5) / 0.5, -0.5, 0.5)), -0.42, 0.42);
        addF = clamp(addF + Math.asin(clamp((uf * e * 0.6) / 0.5, -0.5, 0.5)), -0.1, 0.62);
        shift.addScaledVector(right, clamp(ur * e * 0.45, -0.09, 0.09)).addScaledVector(fwd, clamp(uf * e * 0.25, -0.04, 0.05));
        shift.y = clamp(shift.y + u.y * e * 0.6, -0.34, 0.12);
        const hl = Math.hypot(shift.x, shift.z);
        if (hl > stride) { shift.x *= stride / hl; shift.z *= stride / hl; }
      }
      // Whatever is left, the hips take (a step's worth at most): the arm is never the thing that gives.
      for (let it = 0; it < 3; it++) {
        const e = measure();
        if (e <= 0.0008 || shift.length() > 0.55) break;
        shift.addScaledVector(u, Math.min(e, 0.25));
      }
      measure();
      centre.x += shift.x; centre.z += shift.z; hipY += shift.y;
    }

    // ---- head: track the ball (or the friend)
    this.root.updateMatrixWorld(true);
    if (f.look) {
      const hw = this.head.getWorldPosition(tmpB);
      const dx = f.look[0] - hw.x, dy = f.look[1] - lift - hw.y, dz = f.look[2] - hw.z;
      const lookYaw = Math.atan2(-dx, -dz);
      const torsoYaw = pelvisYaw + coil;
      const rel = clamp(wrapAngle(lookYaw - torsoYaw), -1.35, 1.35);
      const pitchA = clamp(Math.atan2(dy, Math.hypot(dx, dz)) + lean * 0.8, -0.8, 0.7);
      const k = 1 - Math.exp(-dt / 0.07);
      this.head.rotation.y += (rel - this.head.rotation.y) * k;
      this.head.rotation.x += (pitchA - this.head.rotation.x) * k;
      // Keep the eyes level when the trunk bends sideways.
      this.head.rotation.z += (-this.torso.rotation.z * 0.7 - this.head.rotation.z) * k;
    }
    this.root.updateMatrixWorld(true);

    // ---- legs (IK from hips to feet, knees ahead of the hips; a lifted foot brings the knee up)
    const pFwd = new THREE.Vector3(-Math.sin(pelvisYaw), 0, -Math.cos(pelvisYaw));
    const pRight = new THREE.Vector3(Math.cos(pelvisYaw), 0, -Math.sin(pelvisYaw));
    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? -1 : 1;
      const hip = tmpC.set(sx * HIP_W, -0.02, 0).applyMatrix4(this.pelvis.matrixWorld).clone();
      const fy = feet[i].y;
      const ankle = feet[i].clone().add(new THREE.Vector3(0, 0.07, 0));
      // A leg at full stretch goes up onto the toes (the heel comes off the grass).
      const toes = clamp(hip.distanceTo(ankle) - (THIGH + SHIN - 0.004), 0, 0.1);
      ankle.y += toes;
      const knee = new THREE.Vector3(), end = new THREE.Vector3();
      const pole = pFwd.clone().addScaledVector(pRight, sx * 0.12).addScaledVector(UP, clamp(fy / 0.3, 0, 2.5));
      solve2(hip, ankle, THIGH, SHIN, pole, knee, end);
      placeSeg(this.legSegs[i * 2], hip, knee);
      placeSeg(this.legSegs[i * 2 + 1], knee, end);
      this.knees[i].position.copy(knee);
      const shoe = this.shoes[i];
      shoe.position.copy(end).setY(end.y - 0.07 + toes * 0.15);
      // The pivot foot turns with the hips; the striding foot points where it's going once it's down.
      let shoeYaw = yaw + sx * 0.12;
      if (P && footW > 0) shoeYaw += -side * (i === gloveFoot ? P.hip * clamp(fy / 0.25, 0, 1) : clamp(P.hip, -0.3, 1.5)) * footW;
      shoe.rotation.set(-clamp(fy * 0.9, 0, 0.7) - Math.asin(clamp(toes / 0.17, 0, 0.6)), shoeYaw, 0, 'YXZ');
    }

    // ---- glove arm: shoulder, elbow, wrist, then the glove on the hand
    const sG = gloveShoulder.getWorldPosition(new THREE.Vector3());
    const sT = throwShoulder.getWorldPosition(new THREE.Vector3());
    // The glove is alive: it opens to take a throw, snaps shut on the ball (a
    // stiff spring, so it overshoots into a squeeze), holds, and eases back to its cup.
    this.closure = Math.max(0, this.closure - dt * 1.6);
    const shut = this.closure > 0.35 || !!f.gloved;
    const wantShape = shut ? 1 : f.ready ? -0.4 : 0;
    const stiff = shut ? 900 : 110, dampK = shut ? 34 : 16;
    this.gloveV += ((wantShape - this.gloveK) * stiff - this.gloveV * dampK) * Math.min(dt, 0.02);
    this.gloveK += this.gloveV * Math.min(dt, 0.02);
    setGloveClosure(this.glove, clamp(this.gloveK, -0.6, 1.25));
    // The elbow hangs down and out to the glove side; for a low ball (fingers
    // down) it comes up and back, as it does when you reach for the ground.
    const lowK = clamp(-fingers.y, 0, 1) * reachW;
    const elbow = new THREE.Vector3(), wrist = new THREE.Vector3();
    const poleG = new THREE.Vector3(0, -1 + 1.25 * lowK, 0).addScaledVector(right, gs * (0.55 + 0.5 * lowK)).addScaledVector(fwd, -0.3 - 0.25 * lowK);
    solve2(sG, wristT, UPPER, FORE, poleG, elbow, wrist);
    // The wrist has limits: the hand can only bend so far off the line of the
    // forearm. Past that the glove comes round toward the forearm (and the arm is solved again).
    const forearm = new THREE.Vector3().subVectors(wrist, elbow).normalize();
    const flat = new THREE.Vector3();
    for (let it = 0; it < 6 && reachW > 0.5; it++) {
      const bend = forearm.angleTo(fingers);
      if (bend <= WRIST_MAX) break;
      // The hand comes round toward the line of the forearm. The forearm rolls
      // freely, so where it lies across the pocket the hand turns in the
      // pocket's own plane (which keeps facing the ball); where it points
      // through the pocket, the pocket has to tip.
      const through = forearm.dot(pocket);
      const keep = clamp((Math.sqrt(Math.max(0, 1 - through * through)) - 0.35) / 0.4, 0, 1);
      flat.copy(forearm).addScaledVector(pocket, -through * keep).normalize();
      // (A little past the limit each pass: moving the wrist moves the forearm too.)
      fingers.lerp(flat, Math.min(1, ((bend - WRIST_MAX) / bend) * 1.25 + 0.02)).normalize();
      pocket.addScaledVector(fingers, -pocket.dot(fingers)).normalize();
      wristT.copy(gp).addScaledVector(fingers, -HEEL).addScaledVector(pocket, -PALM);
      solve2(sG, wristT, UPPER, FORE, poleG, elbow, wrist);
      forearm.subVectors(wrist, elbow).normalize();
    }
    if (dw > 0.01) {
      // In a delivery the glove is just the end of the arm: fingers along the
      // forearm, pocket turned in toward the chest.
      const inward = this.chest.getWorldPosition(new THREE.Vector3()).sub(gp);
      inward.addScaledVector(forearm, -inward.dot(forearm));
      if (inward.lengthSq() < 1e-4) inward.copy(fwd);
      fingers.lerp(forearm, dw).normalize();
      pocket.lerp(inward.normalize(), dw);
    }
    pocket.addScaledVector(fingers, -pocket.dot(fingers));
    if (pocket.lengthSq() < 1e-6) pocket.copy(fwd).addScaledVector(fingers, -fwd.dot(fingers));
    pocket.normalize();
    // Bones are placed at their true lengths, shoulder to elbow to wrist.
    placeSeg(this.armSegs[0], sG, elbow);
    placeSeg(this.armSegs[1], elbow, wrist);
    this.sleeveA.copy(sG).setY(sG.y + lift);
    this.sleeveB.copy(elbow).setY(elbow.y + lift);
    this.elbows[0].position.copy(elbow);
    // The glove is worn on that hand: it sits where the wrist puts it. (When the
    // arm reaches the pose, which is always unless the body truly can't, that
    // is exactly the pocket the server checks and your friend aims at.)
    const worn = wrist.clone().addScaledVector(fingers, HEEL).addScaledVector(pocket, PALM);
    if (dw > 0.5) gp.copy(worn);
    this.glove.position.copy(dw > 0.5 || reachGap < 0.004 ? gp : worn);
    // Orientation: fingers along +Y, pocket out of -Z, built as a rotation (no
    // look-at, no up vector to flip) and eased, so the wrist turns; it never snaps.
    const zAxis = tmpC.copy(pocket).multiplyScalar(-1);
    const xAxis = tmpA.crossVectors(fingers, zAxis).normalize();
    tmpQ.setFromRotationMatrix(tmpM.makeBasis(xAxis, fingers, zAxis));
    if (!this.gloveSet) { this.gloveBase.copy(tmpQ); this.gloveSet = true; }
    else this.gloveBase.slerp(tmpQ, 1 - Math.exp(-dt / 0.05));
    this.glove.quaternion.copy(this.gloveBase);
    // The knock of an off-centre ball: applied on top, at once, and gone as the arm recovers.
    if (give > 0 && this.hinge.lengthSq() > 1e-4) this.glove.quaternion.multiply(tmpQ.setFromEuler(tmpE.set(this.hinge.x * 0.42 * give, this.hinge.y * 0.36 * give, 0)));
    this.gloveWorldPos.copy(gp);
    this.gloveWorldPos.y += lift;
    // What the validation looks at.
    const d = this.joints;
    d.shoulder.copy(sG); d.elbow.copy(elbow); d.wrist.copy(wrist); d.pocket.copy(pocket); d.fingers.copy(fingers); d.forearm.copy(forearm);
    d.gap = reachGap; d.glove.copy(this.glove.position); d.pole.copy(poleG).normalize();

    // ---- throwing arm: idle, holding, taking the ball out of the glove; or the delivery
    let tgt: THREE.Vector3;
    const up = UP;
    if (this.transferT >= 0) { this.transferT += dt; if (this.transferT > 0.45) this.transferT = -1; }
    if (this.tapT >= 0) { this.tapT += dt; if (this.tapT > 0.5) this.tapT = -1; }
    const holdIdle = arm === Arm.Holding && speed < 0.2 && dw < 0.01;
    this.idleT = holdIdle ? this.idleT + dt : 0;
    if (holdIdle && this.idleT > 2.6 && this.tapT < 0 && Math.sin(this.time * 0.9) > 0.6) { this.tapT = 0; this.idleT = 0; }
    if (this.transferT >= 0 || (this.tapT >= 0 && this.tapT < 0.3)) {
      // Reach over to the glove: take the ball out (or a little pound of the mitt).
      tgt = gp.clone().addScaledVector(right, side * 0.06).addScaledVector(fwd, 0.04);
    } else if (arm === Arm.Holding || arm === Arm.Windup) {
      tgt = sT.clone().addScaledVector(fwd, 0.26).addScaledVector(up, -0.32).addScaledVector(right, -side * 0.06);
    } else {
      // Arm hangs relaxed, swinging a little when moving.
      const swing = Math.sin(this.time * 9) * Math.min(0.25, speed * 0.06);
      tgt = sT.clone().addScaledVector(up, -0.52).addScaledVector(fwd, 0.06 + swing).addScaledVector(right, side * 0.05);
    }
    if (!this.throwInit) { this.throwTarget.copy(tgt); this.throwInit = true; }
    if (dw < 0.98) this.throwTarget.lerp(tgt, Math.min(1, dt * 13));
    const handT = this.throwTarget.clone();
    const poleT = new THREE.Vector3(0, -1, 0).addScaledVector(right, side * 0.7);
    if (P && dw > 0) {
      handT.lerp(pitch(P.ball), dw);
      // Above the shoulder the elbow leads out to the side (the "L"), not down.
      const cy = pelvisYaw + coil;
      const hi = smooth(clamp((handT.y - (sT.y - 0.2)) / 0.3, 0, 1)) * dw;
      const out = new THREE.Vector3(Math.cos(cy) * side, -0.35, -Math.sin(cy) * side).addScaledVector(tmpA.set(-Math.sin(cy), 0, -Math.cos(cy)), -0.25);
      poleT.lerp(out, hi);
      if (dw >= 0.98) this.throwTarget.copy(handT);
    }
    solve2(sT, handT, UPPER, FORE, poleT, elbow, wrist);
    placeSeg(this.armSegs[2], sT, elbow);
    placeSeg(this.armSegs[3], elbow, wrist);
    this.elbows[1].position.copy(elbow);
    const tFore = tmpA.subVectors(wrist, elbow).normalize();
    this.handBall.copy(wrist).addScaledVector(tFore, 0.075);
    this.handMesh.position.copy(this.handBall);
    this.handMesh.lookAt(tmpB.copy(this.handBall).addScaledVector(tFore, -1));
    this.handBall.y += lift;

    this.root.position.y = lift;
    this.root.updateMatrixWorld(true);
    this.head.getWorldPosition(this.eye);
    this.eye.y += 0.03;
    this.headTop.copy(this.eye).add(new THREE.Vector3(0, 0.27, 0));
    this.chest.getWorldPosition(this.chestPos);
    if (this.ticks.length) {
      const wf = (this.wearFrame ??= { dt, t: 0, speed: 0, vel: new THREE.Vector3(), torso: this.torso, glove: this.glove });
      wf.dt = dt; wf.t = this.time; wf.vel.copy(this.vel); wf.speed = Math.hypot(this.vel.x, this.vel.z);
      for (const t of this.ticks) t(wf);
    }
  }

  dispose() {
    this.root.removeFromParent();
    this.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    for (const m of this.mats) m.dispose();
  }
}
