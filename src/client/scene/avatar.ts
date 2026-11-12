// A person playing catch, seen from a few metres away. Low-poly, but built to
// move like someone: legs that step, a pelvis that carries weight and drops
// into a crouch, a torso that twists into a throw, a head that tracks the
// ball, a glove arm that reaches exactly where the shared pose says the glove
// is, and a throwing arm that winds up, whips through and follows through.

import * as THREE from 'three';
import { type Hand, type Pose, bodyToWorld, gloveWorld, worldToBody } from '../../shared/pose';
import { Arm } from '../../shared/protocol';
import { type Vec3, clamp, wrapAngle } from '../../shared/vec';
import { buildGlove, buildHand, setGloveClosure } from './gear';

export const LOOKS = [
  { shirt: '#857f5a', cap: '#2d2f63', pants: '#93b1cf', skin: '#e3ad7c' },
  { shirt: '#3f7cac', cap: '#d4a72c', pants: '#c2b59b', skin: '#8d5524' },
  { shirt: '#e3b448', cap: '#2f4f3a', pants: '#4a4e57', skin: '#f1c27d' },
  { shirt: '#5f8d4e', cap: '#7b2d26', pants: '#2f3542', skin: '#c68642' },
  { shirt: '#efe6d2', cap: '#1d3557', pants: '#5b6b7a', skin: '#ffdbac' },
  { shirt: '#8d99ae', cap: '#b23a48', pants: '#3a3a3a', skin: '#a0662f' },
];

const UP = new THREE.Vector3(0, 1, 0);
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();

const THIGH = 0.45, SHIN = 0.44, HIP_W = 0.1, HIP_Y = 0.92;
const UPPER = 0.29, FORE = 0.27;

function seg(mat: THREE.Material, r: number, r2 = r * 0.85) {
  const g = new THREE.CylinderGeometry(r2, r, 1, 8);
  g.translate(0, 0.5, 0);
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  return m;
}

function joint(mat: THREE.Material, r: number) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), mat);
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
}

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
  private armSegs: THREE.Mesh[];
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
  private kneeLift = 0;
  private leanF = 0;
  private leanS = 0;
  private twist = 0;
  private throwTarget = new THREE.Vector3();
  private throwInit = false;
  private releaseT = -1;
  private lastArm = 0;
  private recoil = 0;
  private recoilDir = new THREE.Vector3();
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

  constructor(home: Vec3, facing: number, public hand: Hand, look: number) {
    const L = LOOKS[look % LOOKS.length];
    const m = (c: string, r = 0.8) => { const x = new THREE.MeshStandardMaterial({ color: c, roughness: r }); this.mats.push(x); return x; };
    const shirt = m(L.shirt), pants = m(L.pants), skin = m(L.skin, 0.6), cap = m(L.cap, 0.7), shoe = m('#efeae0', 0.7);
    this.bodyYaw = facing;

    // Legs: thigh + shin per side, knees solved each frame.
    this.legSegs = [seg(pants, 0.085, 0.07), seg(pants, 0.068, 0.055), seg(pants, 0.085, 0.07), seg(pants, 0.068, 0.055)];
    this.knees = [joint(pants, 0.072), joint(pants, 0.072)];
    this.shoes = [0, 1].map(() => {
      const g = new THREE.BoxGeometry(0.11, 0.075, 0.27);
      g.translate(0, 0.0375, -0.05);
      const s = new THREE.Mesh(g, shoe);
      s.castShadow = true;
      return s;
    });
    this.root.add(...this.legSegs, ...this.knees, ...this.shoes);

    // Pelvis carries the torso; it drops and shifts with weight.
    const hips = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.1, 4, 10), pants);
    hips.rotation.z = Math.PI / 2;
    hips.scale.set(1, 1, 0.75);
    this.pelvis.add(hips);
    this.root.add(this.pelvis);
    this.torso.position.y = 0.04;
    this.torso.rotation.order = 'YXZ';
    this.pelvis.add(this.torso);
    this.chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.32, 4, 10), shirt);
    this.chest.scale.set(1.18, 1, 0.7);
    this.chest.position.y = 0.3;
    this.torso.add(this.chest);
    this.shoulderL.position.set(-0.215, 0.5, 0);
    this.shoulderR.position.set(0.215, 0.5, 0);
    this.torso.add(this.shoulderL, this.shoulderR);
    for (const sh of [this.shoulderL, this.shoulderR]) sh.add(joint(shirt, 0.062));
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.056, 0.1, 8), skin);
    neck.position.y = 0.6;
    this.torso.add(neck);
    this.head.position.y = 0.7;
    this.head.rotation.order = 'YXZ';
    this.torso.add(this.head);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.112, 16, 12), skin);
    skull.scale.set(0.92, 1.05, 1);
    skull.position.y = 0.02;
    this.head.add(skull);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.04, 6), skin);
    nose.rotation.x = -Math.PI / 2;
    nose.position.set(0, 0.0, -0.11);
    this.head.add(nose);
    for (const sx of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.022, 6, 6), skin);
      ear.position.set(sx * 0.1, 0.0, 0.0);
      this.head.add(ear);
    }
    // Ball cap: crown + brim. The brim is the clearest "where are they looking" cue.
    const crown = new THREE.Mesh(new THREE.SphereGeometry(0.118, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), cap);
    crown.position.y = 0.045;
    crown.scale.set(0.95, 0.85, 1.02);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.012, 16, 1, false, -Math.PI / 2, Math.PI), cap);
    brim.scale.set(1.05, 1, 1.25);
    brim.position.set(0, 0.05, -0.08);
    brim.rotation.x = 0.12;
    this.head.add(crown, brim);

    // Arms live in world space (IK each frame).
    this.armSegs = [seg(shirt, 0.046, 0.04), seg(skin, 0.038, 0.032), seg(shirt, 0.046, 0.04), seg(skin, 0.038, 0.032)];
    this.elbows = [joint(skin, 0.038), joint(skin, 0.038)];
    this.glove = buildGlove();
    this.glove.scale.setScalar(1.25);
    if (hand === 'L') this.glove.scale.x = -1.25;
    this.handMesh = buildHand(L.skin);
    this.handMesh.scale.setScalar(1.1);
    if (hand === 'L') this.handMesh.scale.x = -1.1;
    this.root.add(...this.armSegs, ...this.elbows, this.glove, this.handMesh);
    // Arms are positioned in world space: keep them out of the root transform.
    for (const o of [...this.armSegs, ...this.elbows, this.glove, this.handMesh, ...this.legSegs, ...this.knees, ...this.shoes]) o.matrixAutoUpdate = true;

    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
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
    for (const m of this.mats) { m.transparent = !on; m.opacity = on ? 1 : 0.4; }
  }

  /** Called when this player catches the ball (glove recoil + snap shut). */
  catchImpact(vel: Vec3, speed: number) {
    this.recoil = Math.min(1, 0.35 + speed / 26);
    this.recoilDir.set(vel[0], vel[1], vel[2]).normalize();
    this.closure = 1;
  }
  /** Throwing hand reaches over and takes the ball out of the glove. */
  transfer() { this.transferT = 0; }

  update(dt: number, f: AvatarFrame) {
    this.time += dt;
    const { pose, arm, charge } = f;
    const side = this.hand === 'R' ? 1 : -1;

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
    this.root.position.set(0, 0, 0);
    this.root.rotation.set(0, 0, 0);

    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));

    // ---- glove target in body space decides crouch and lean
    const gw = gloveWorld(pose);
    const gl = worldToBody(yaw, [gw[0] - this.pos.x, gw[1], gw[2] - this.pos.z]);
    const wantCrouch = (f.ready ? 0.1 : 0.025) + clamp((0.95 - gl[1]) / 0.75, 0, 1) * 0.3 + (arm === Arm.Windup ? 0.05 * charge : 0) + Math.min(0.06, speed * 0.012);
    this.crouch += (wantCrouch - this.crouch) * (1 - Math.exp(-dt / 0.09));
    const reachOut = Math.hypot(gl[0], gl[2]);
    let wantLeanF = clamp((gl[2] - 0.45) * 0.35, -0.1, 0.32) + clamp((0.9 - gl[1]) * 0.35, 0, 0.35) + clamp(speed * 0.02, 0, 0.08);
    let wantLeanS = clamp(gl[0] * 0.5 * clamp(reachOut - 0.45, 0, 1) * 2, -0.38, 0.38);
    // ---- throwing: weight back on the windup, stride and drive through the release
    let stride = 0, wantTwist = 0;
    if (arm !== this.lastArm && arm === Arm.Release) this.releaseT = 0;
    this.lastArm = arm;
    if (this.releaseT >= 0) {
      this.releaseT += dt;
      if (this.releaseT > 0.75) this.releaseT = -1;
    }
    const rk = this.releaseT >= 0 ? this.releaseT : -1;
    if (arm === Arm.Windup) {
      // Load the throwing shoulder back (a right-hander turns clockwise, i.e. negative yaw).
      wantTwist = -0.75 * charge * side;
      wantLeanF -= 0.1 * charge;
      stride = 0.12 * charge;
    } else if (rk >= 0) {
      const k = clamp(rk / 0.22, 0, 1);
      const settle = clamp((rk - 0.3) / 0.45, 0, 1);
      // ...then unwind hard through the release and finish facing past the target.
      wantTwist = (-0.6 + 1.15 * smooth(k)) * side * (1 - settle);
      wantLeanF += 0.42 * Math.sin(Math.PI * clamp(rk / 0.55, 0, 1));
      stride = 0.32 * (1 - settle);
    }
    this.twist += (wantTwist - this.twist) * (1 - Math.exp(-dt / (rk >= 0 ? 0.04 : 0.1)));
    this.leanF += (wantLeanF - this.leanF) * (1 - Math.exp(-dt / 0.1));
    this.leanS += (wantLeanS - this.leanS) * (1 - Math.exp(-dt / 0.1));

    // ---- feet: a simple step planner. Feet stay planted until the body
    // leaves them behind, then a step arcs to the new stance.
    const gloveFoot = this.hand === 'R' ? 0 : 1;
    const stepDur = clamp(0.32 - speed * 0.03, 0.17, 0.32);
    for (let i = 0; i < 2; i++) {
      const ft = this.feet[i];
      const want = this.stance(i, yaw);
      // Moving: plant ahead along the velocity.
      want.addScaledVector(this.vel, clamp(stepDur * 0.7, 0, 0.3));
      if (i === gloveFoot && stride) want.addScaledVector(fwd, stride);
      if (i !== gloveFoot && stride) want.addScaledVector(fwd, -stride * 0.25);
      const other = this.feet[1 - i];
      if (ft.stepping) {
        ft.t += dt / stepDur;
        ft.to.lerp(want, 0.25);
        const k = Math.min(1, ft.t);
        ft.pos.lerpVectors(ft.from, ft.to, smooth(k));
        ft.pos.y = Math.sin(Math.PI * k) * (0.05 + Math.min(0.08, speed * 0.02));
        if (k >= 1) { ft.stepping = false; ft.pos.y = 0; }
      } else if (!other.stepping && (ft.pos.distanceTo(want) > (stride ? 0.05 : 0.2) || (speed > 0.4 && ft.pos.distanceTo(want) > 0.12))) {
        // Only one foot in the air at a time; the further-behind foot goes first.
        const otherErr = other.pos.distanceTo(this.stance(1 - i, yaw));
        if (ft.pos.distanceTo(want) >= otherErr - 0.02 || stride) {
          ft.stepping = true; ft.t = 0; ft.from.copy(ft.pos); ft.to.copy(want);
        }
      }
    }

    // ---- the throw's footwork (as in a real long toss): lift the glove-side
    // knee as you load, stride long toward the target, and let the back leg
    // kick up behind you as you finish.
    const throwFoot = 1 - gloveFoot;
    const lift = arm === Arm.Windup ? smooth(clamp((charge - 0.2) / 0.6, 0, 1)) : 0;
    this.kneeLift += (lift - this.kneeLift) * (1 - Math.exp(-dt / 0.08));
    if (this.kneeLift > 0.01 && rk < 0) {
      const ft = this.feet[gloveFoot];
      const base = this.stance(gloveFoot, yaw);
      ft.stepping = false;
      ft.pos.lerp(base.clone().addScaledVector(fwd, 0.04).addScaledVector(right, side * 0.06), 0.3);
      ft.pos.y = 0.36 * this.kneeLift;
    }
    if (rk >= 0 && rk < 0.75) {
      const plant = this.stance(gloveFoot, yaw).addScaledVector(fwd, 0.55).addScaledVector(right, side * 0.08);
      const g = this.feet[gloveFoot];
      g.stepping = false;
      g.pos.lerp(plant, rk < 0.12 ? 0.55 : 0.2);
      g.pos.y = rk < 0.1 ? 0.12 * (1 - rk / 0.1) : 0;
      const kick = clamp((rk - 0.1) / 0.5, 0, 1);
      const b = this.feet[throwFoot];
      b.stepping = false;
      const behind = this.stance(throwFoot, yaw).addScaledVector(fwd, -0.12 + 0.35 * smooth(kick));
      b.pos.lerp(behind, 0.25);
      b.pos.y = 0.42 * Math.sin(Math.PI * kick);
    }

    // ---- pelvis: between the feet, dropped by the crouch, bobbing with steps
    const mid = tmpA.addVectors(this.feet[0].pos, this.feet[1].pos).multiplyScalar(0.5);
    const centre = new THREE.Vector3(this.pos.x, 0, this.pos.z).lerp(mid.setY(0), 0.35);
    const bob = Math.max(this.feet[0].pos.y, this.feet[1].pos.y) * 0.25;
    // Idle: slow weight shifts and breathing.
    const idle = speed < 0.2 && arm !== Arm.Windup && rk < 0 ? 1 : 0;
    const sway = Math.sin(this.time * 0.55) * 0.012 * idle;
    centre.addScaledVector(right, sway);
    // High glove: up on the toes.
    this.tiptoe += (clamp((gl[1] - 1.75) * 0.32, 0, 0.13) - this.tiptoe) * (1 - Math.exp(-dt / 0.1));
    const hipY = HIP_Y - this.crouch * 0.42 + this.tiptoe + bob - 0.01 * idle * (0.5 + 0.5 * Math.sin(this.time * 1.7));
    this.pelvis.position.set(centre.x, hipY, centre.z);
    this.pelvis.rotation.set(0, yaw, 0, 'YXZ');
    this.pelvis.rotateY(this.twist * 0.35);
    this.torso.rotation.set(-this.leanF, this.twist * 0.75, -this.leanS * 0.8);
    this.chest.scale.y = 1 + Math.sin(this.time * 1.7) * 0.012;

    // ---- head: track the ball (or the friend)
    this.root.updateMatrixWorld(true);
    if (f.look) {
      const hw = this.head.getWorldPosition(tmpB);
      const dx = f.look[0] - hw.x, dy = f.look[1] - hw.y, dz = f.look[2] - hw.z;
      const lookYaw = Math.atan2(-dx, -dz);
      const torsoYaw = yaw + this.twist * 1.1;
      const rel = clamp(wrapAngle(lookYaw - torsoYaw), -1.25, 1.25);
      const pitch = clamp(Math.atan2(dy, Math.hypot(dx, dz)) + this.leanF * 0.8, -0.8, 0.7);
      const k = 1 - Math.exp(-dt / 0.07);
      this.head.rotation.y += (rel - this.head.rotation.y) * k;
      this.head.rotation.x += (pitch - this.head.rotation.x) * k;
    }
    this.root.updateMatrixWorld(true);

    // ---- legs (IK from hips to feet, knees forward)
    for (let i = 0; i < 2; i++) {
      const sx = i === 0 ? -1 : 1;
      const hip = tmpC.set(sx * HIP_W, -0.02, 0).applyMatrix4(this.pelvis.matrixWorld).clone();
      const ankle = this.feet[i].pos.clone().add(new THREE.Vector3(0, 0.07, 0));
      const knee = new THREE.Vector3(), end = new THREE.Vector3();
      const pole = fwd.clone().addScaledVector(right, sx * 0.12);
      solve2(hip, ankle, THIGH, SHIN, pole, knee, end);
      placeSeg(this.legSegs[i * 2], hip, knee);
      placeSeg(this.legSegs[i * 2 + 1], knee, end);
      this.knees[i].position.copy(knee);
      const shoe = this.shoes[i];
      shoe.position.copy(this.feet[i].pos);
      shoe.rotation.set(0, yaw + sx * 0.12 + (this.feet[i].stepping ? 0 : 0), 0);
    }

    // ---- glove arm: reach for the streamed glove point
    const gloveShoulder = this.hand === 'R' ? this.shoulderL : this.shoulderR;
    const throwShoulder = this.hand === 'R' ? this.shoulderR : this.shoulderL;
    const sG = gloveShoulder.getWorldPosition(new THREE.Vector3());
    const sT = throwShoulder.getWorldPosition(new THREE.Vector3());
    const gp = new THREE.Vector3(gw[0], gw[1], gw[2]);
    // While throwing, the glove arm pulls in to the chest (it drives the turn).
    if (arm === Arm.Windup || rk >= 0) {
      const tuck = arm === Arm.Windup ? 0.6 + 0.4 * charge : Math.max(0, 1 - rk / 0.6);
      const tuckPos = sG.clone().addScaledVector(fwd, 0.36 - 0.12 * (rk >= 0 ? 1 : 0)).addScaledVector(UP, -0.12).addScaledVector(right, side * 0.12);
      gp.lerp(tuckPos, clamp(tuck, 0, 1) * 0.85);
    }
    this.recoil = Math.max(0, this.recoil - dt * 4.2);
    if (this.recoil > 0) gp.addScaledVector(this.recoilDir, 0.09 * Math.sin(this.recoil * Math.PI) * this.recoil);
    this.closure = Math.max(0, this.closure - dt * 1.6);
    setGloveClosure(this.glove, Math.min(1, this.closure * 1.6 + (f.gloved ? 0.35 : 0)));
    // Pocket faces where the ball comes from (or out in front).
    const faceDir = f.look ? tmpB.set(f.look[0] - gp.x, f.look[1] - gp.y, f.look[2] - gp.z).normalize() : fwd.clone();
    if (faceDir.dot(fwd) < -0.2) faceDir.copy(fwd);
    // Low catches: fingers down (backhand/scoop); high: fingers up.
    const low = clamp((0.85 - gp.y) / 0.5, 0, 1);
    const wristBack = faceDir.clone().multiplyScalar(-0.07).add(new THREE.Vector3(0, -0.085 * (1 - 2 * low), 0));
    const wristT = gp.clone().add(wristBack);
    const elbow = new THREE.Vector3(), wrist = new THREE.Vector3();
    const poleG = new THREE.Vector3(0, -1, 0).addScaledVector(right, -side * 0.9).addScaledVector(fwd, -0.3);
    solve2(sG, wristT, UPPER, FORE, poleG, elbow, wrist);
    placeSeg(this.armSegs[0], sG, elbow);
    // The glove is where the pose says it is (that's what the server checks and
    // what your friend aims at); if the arm is a touch short, the forearm stretches.
    placeSeg(this.armSegs[1], elbow, wristT);
    this.elbows[0].position.copy(elbow);
    // If the arm couldn't quite reach, the glove stays on the hand.
    this.glove.position.copy(gp);
    const upHint = low > 0.5 ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(0, 1, 0);
    const lookM = new THREE.Matrix4().lookAt(gp, tmpA.copy(gp).sub(faceDir), upHint);
    this.glove.quaternion.setFromRotationMatrix(lookM);
    this.gloveWorldPos.copy(gp);

    // ---- throwing arm by state
    let tgt: THREE.Vector3;
    const up = UP;
    if (this.transferT >= 0) { this.transferT += dt; if (this.transferT > 0.45) this.transferT = -1; }
    if (this.tapT >= 0) { this.tapT += dt; if (this.tapT > 0.5) this.tapT = -1; }
    const holdIdle = arm === Arm.Holding && speed < 0.2 && rk < 0;
    this.idleT = holdIdle ? this.idleT + dt : 0;
    if (holdIdle && this.idleT > 2.6 && this.tapT < 0 && Math.sin(this.time * 0.9) > 0.6) { this.tapT = 0; this.idleT = 0; }
    if (arm === Arm.Windup) {
      // Ball taken down, back and up behind the throwing shoulder.
      const c = charge;
      tgt = sT.clone().addScaledVector(fwd, 0.06 - 0.4 * c).addScaledVector(up, -0.14 + 0.42 * c).addScaledVector(right, side * (0.12 + 0.03 * c));
    } else if (rk >= 0) {
      // Whip over the top, through, and across the body; then relax.
      const k = clamp(rk / 0.3, 0, 1);
      const a = smooth(k);
      tgt = sT.clone()
        .addScaledVector(fwd, 0.55 * Math.sin(a * Math.PI * 0.85))
        .addScaledVector(up, 0.18 - 0.75 * a)
        .addScaledVector(right, side * (0.15 - 0.5 * a));
      if (rk > 0.4) tgt.lerp(sT.clone().addScaledVector(up, -0.5).addScaledVector(fwd, 0.1), clamp((rk - 0.4) / 0.35, 0, 1));
    } else if (this.transferT >= 0 || (this.tapT >= 0 && this.tapT < 0.3)) {
      // Reach over to the glove: take the ball out (or a little pound of the mitt).
      tgt = this.gloveWorldPos.clone().addScaledVector(right, side * 0.06).addScaledVector(fwd, 0.04);
    } else if (arm === Arm.Holding) {
      tgt = sT.clone().addScaledVector(fwd, 0.26).addScaledVector(up, -0.32).addScaledVector(right, -side * 0.06);
    } else {
      // Arm hangs relaxed, swinging a little when moving.
      const swing = Math.sin(this.time * 9) * Math.min(0.25, speed * 0.06);
      tgt = sT.clone().addScaledVector(up, -0.52).addScaledVector(fwd, 0.06 + swing).addScaledVector(right, side * 0.05);
    }
    if (!this.throwInit) { this.throwTarget.copy(tgt); this.throwInit = true; }
    this.throwTarget.lerp(tgt, Math.min(1, dt * (rk >= 0 && rk < 0.3 ? 34 : 13)));
    const poleT = arm === Arm.Windup || (rk >= 0 && rk < 0.15)
      ? new THREE.Vector3().addScaledVector(right, side).addScaledVector(up, -0.3).addScaledVector(fwd, -0.2)
      : new THREE.Vector3(0, -1, 0).addScaledVector(right, side * 0.7);
    solve2(sT, this.throwTarget, UPPER, FORE, poleT, elbow, wrist);
    placeSeg(this.armSegs[2], sT, elbow);
    placeSeg(this.armSegs[3], elbow, wrist);
    this.elbows[1].position.copy(elbow);
    const forearm = tmpA.subVectors(wrist, elbow).normalize();
    this.handBall.copy(wrist).addScaledVector(forearm, 0.075);
    this.handMesh.position.copy(this.handBall);
    this.handMesh.lookAt(tmpB.copy(this.handBall).addScaledVector(forearm, -1));
    this.head.getWorldPosition(this.headTop).add(new THREE.Vector3(0, 0.3, 0));
    this.chest.getWorldPosition(this.chestPos);
  }

  dispose() {
    this.root.removeFromParent();
    this.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    for (const m of this.mats) m.dispose();
  }
}
