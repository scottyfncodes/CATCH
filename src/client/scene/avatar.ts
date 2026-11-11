// Other players: a simple low-poly person whose head, shoulders, torso and
// throwing arm show where they are looking and what they are about to do.

import * as THREE from 'three';
import { EYE_HEIGHT } from '../../shared/constants';
import { type Hand, type Pose, gloveWorld, viewBasis } from '../../shared/pose';
import { Arm } from '../../shared/protocol';
import { type Vec3, clamp, wrapAngle } from '../../shared/vec';
import { buildGlove, buildHand, setGloveClosure } from './gear';

export const LOOKS = [
  { shirt: '#c8553d', cap: '#26374f', pants: '#3d4f6b', skin: '#e0ac69' },
  { shirt: '#3f7cac', cap: '#d4a72c', pants: '#c2b59b', skin: '#8d5524' },
  { shirt: '#e3b448', cap: '#2f4f3a', pants: '#4a4e57', skin: '#f1c27d' },
  { shirt: '#5f8d4e', cap: '#7b2d26', pants: '#2f3542', skin: '#c68642' },
  { shirt: '#efe6d2', cap: '#1d3557', pants: '#5b6b7a', skin: '#ffdbac' },
  { shirt: '#8d99ae', cap: '#b23a48', pants: '#3a3a3a', skin: '#a0662f' },
];

const UP = new THREE.Vector3(0, 1, 0);
const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();

function seg(mat: THREE.Material, r: number) {
  const g = new THREE.CylinderGeometry(r, r * 0.9, 1, 7);
  g.translate(0, 0.5, 0);
  const m = new THREE.Mesh(g, mat);
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

/** Two-bone IK: returns the elbow for a shoulder → wrist chain, bending toward `pole`. */
function solveElbow(s: THREE.Vector3, t: THREE.Vector3, a: number, b: number, pole: THREE.Vector3, outElbow: THREE.Vector3, outWrist: THREE.Vector3) {
  const dir = tmpA.subVectors(t, s);
  let d = dir.length();
  dir.divideScalar(d || 1);
  d = clamp(d, 0.08, a + b - 0.002);
  outWrist.copy(s).addScaledVector(dir, d);
  const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const perp = tmpB.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (perp.lengthSq() < 1e-6) perp.set(0, -1, 0);
  perp.normalize();
  outElbow.copy(s).addScaledVector(dir, a * cosA).addScaledVector(perp, a * sinA);
}

export class Avatar {
  root = new THREE.Group();
  arms = new THREE.Group();
  readonly glove: THREE.Group;
  readonly handMesh: THREE.Group;
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private shoulderL = new THREE.Object3D();
  private shoulderR = new THREE.Object3D();
  private segs: THREE.Mesh[];
  private mats: THREE.MeshStandardMaterial[] = [];
  private bodyYaw: number;
  private throwTarget = new THREE.Vector3();
  private throwInit = false;
  private releaseT = 0;
  private lastArm = 0;
  recoil = 0;
  private recoilDir = new THREE.Vector3();
  private closure = 0;
  /** World position of the throwing hand's ball grip. */
  readonly handBall = new THREE.Vector3();
  readonly gloveWorldPos = new THREE.Vector3();
  readonly headTop = new THREE.Vector3();

  constructor(public seatPos: Vec3, public facing: number, public hand: Hand, look: number) {
    const L = LOOKS[look % LOOKS.length];
    const m = (c: string, r = 0.8) => { const x = new THREE.MeshStandardMaterial({ color: c, roughness: r }); this.mats.push(x); return x; };
    const shirt = m(L.shirt), pants = m(L.pants), skin = m(L.skin, 0.6), cap = m(L.cap, 0.7), shoe = m('#efeae0');
    this.bodyYaw = facing;

    // Legs.
    for (const sx of [-0.1, 0.1]) {
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.088, 0.7, 3, 8), pants);
      leg.position.set(sx, 0.47, 0);
      leg.rotation.z = sx * 0.25;
      leg.castShadow = true;
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.07, 0.24), shoe);
      s.position.set(sx * 1.25, 0.035, -0.04);
      this.root.add(leg, s);
    }
    // Torso pivots at the hips so it can twist.
    this.torso.position.y = 0.95;
    this.root.add(this.torso);
    const chest = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.36, 4, 10), shirt);
    chest.scale.set(1.18, 1, 0.72);
    chest.position.y = 0.3;
    chest.castShadow = true;
    this.torso.add(chest);
    this.shoulderL.position.set(-0.215, 0.5, 0);
    this.shoulderR.position.set(0.215, 0.5, 0);
    this.torso.add(this.shoulderL, this.shoulderR);
    // Sleeves as shoulder caps.
    for (const sh of [this.shoulderL, this.shoulderR]) {
      const cap2 = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), shirt);
      sh.add(cap2);
    }
    // Neck + head.
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.1, 8), skin);
    neck.position.y = 0.6;
    this.torso.add(neck);
    this.head.position.y = EYE_HEIGHT - 0.95 - 0.02;
    this.head.rotation.order = 'YXZ';
    this.torso.add(this.head);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.112, 16, 12), skin);
    skull.scale.set(0.92, 1.05, 1);
    skull.position.y = 0.02;
    skull.castShadow = true;
    this.head.add(skull);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.04, 6), skin);
    nose.rotation.x = -Math.PI / 2;
    nose.position.set(0, 0.0, -0.11);
    this.head.add(nose);
    // Ball cap: crown + brim. The brim is the clearest "where are they looking" cue.
    const crown = new THREE.Mesh(new THREE.SphereGeometry(0.118, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), cap);
    crown.position.y = 0.045;
    crown.scale.set(0.95, 0.85, 1.02);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.012, 16, 1, false, -Math.PI / 2, Math.PI), cap);
    brim.scale.set(1.05, 1, 1.25);
    brim.position.set(0, 0.05, -0.08);
    brim.rotation.x = 0.12;
    this.head.add(crown, brim);
    for (const sx of [-0.035, 0.035]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.011, 6, 6), new THREE.MeshBasicMaterial({ color: '#2a211b' }));
      eye.position.set(sx, 0.018, -0.1);
      this.head.add(eye);
    }

    // Arms (world space, IK each frame).
    this.segs = [seg(skin, 0.042), seg(skin, 0.036), seg(skin, 0.042), seg(skin, 0.036)];
    // Upper arms wear the sleeve colour near the shoulder.
    this.segs[0].material = shirt; this.segs[2].material = shirt;
    this.arms.add(...this.segs);

    this.glove = buildGlove();
    if (hand === 'L') this.glove.scale.x = -1;
    this.handMesh = buildHand(L.skin);
    if (hand === 'L') this.handMesh.scale.x = -1;
    this.arms.add(this.glove, this.handMesh);

    this.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
    this.place(seatPos, facing);
  }

  place(pos: Vec3, facing: number) {
    this.seatPos = pos;
    this.facing = facing;
    this.root.position.set(pos[0], 0, pos[2]);
  }

  setConnected(on: boolean) {
    for (const m of this.mats) { m.transparent = !on; m.opacity = on ? 1 : 0.4; }
  }

  /** Called when this player catches the ball (for the glove recoil). */
  catchImpact(vel: Vec3, speed: number) {
    this.recoil = Math.min(1, 0.35 + speed / 30);
    this.recoilDir.set(vel[0], vel[1], vel[2]).normalize();
    this.closure = 1;
  }

  update(dt: number, pose: Pose, arm: number, charge: number) {
    // Feet turn when the head has turned far enough.
    const rel = wrapAngle(pose.yaw - this.bodyYaw);
    if (Math.abs(rel) > 1.0) this.bodyYaw += (rel - Math.sign(rel) * 1.0) * Math.min(1, dt * 6);
    // Let the body drift back toward the circle when looking ahead.
    this.bodyYaw += wrapAngle(this.facing - this.bodyYaw) * Math.min(1, dt * 0.3) * (Math.abs(rel) < 0.3 ? 1 : 0);
    this.root.rotation.y = this.bodyYaw;
    const headRel = wrapAngle(pose.yaw - this.bodyYaw);
    const side = this.hand === 'R' ? 1 : -1;
    // Shoulders and torso turn with the gaze; winding up twists the throwing shoulder back.
    const twist = arm === Arm.Windup ? charge * 0.45 * side : arm === Arm.Release ? -0.25 * side : 0;
    const torsoYaw = clamp(headRel * 0.55, -0.75, 0.75) + twist;
    this.torso.rotation.y += (torsoYaw - this.torso.rotation.y) * Math.min(1, dt * 12);
    this.head.rotation.y = clamp(headRel - this.torso.rotation.y, -1.2, 1.2);
    this.head.rotation.x = clamp(pose.pitch, -0.8, 0.7);
    this.torso.rotation.x = arm === Arm.Windup ? -0.08 * charge : 0;
    this.root.updateMatrixWorld(true);

    const gloveShoulder = this.hand === 'R' ? this.shoulderL : this.shoulderR;
    const throwShoulder = this.hand === 'R' ? this.shoulderR : this.shoulderL;
    const sG = gloveShoulder.getWorldPosition(new THREE.Vector3());
    const sT = throwShoulder.getWorldPosition(new THREE.Vector3());

    // Glove arm reaches for the streamed glove pose.
    const gw = gloveWorld(this.seatPos, pose);
    const gp = new THREE.Vector3(gw[0], gw[1], gw[2]);
    this.recoil = Math.max(0, this.recoil - dt * 4.5);
    if (this.recoil > 0) gp.addScaledVector(this.recoilDir, 0.07 * Math.sin(this.recoil * Math.PI) * this.recoil);
    this.closure = Math.max(0, this.closure - dt * 2.2);
    setGloveClosure(this.glove, Math.min(1, this.closure * 1.6));
    const vb = viewBasis(pose.yaw, pose.pitch);
    const fwd = new THREE.Vector3(vb.f[0], vb.f[1], vb.f[2]);
    const right = new THREE.Vector3(Math.cos(this.bodyYaw), 0, -Math.sin(this.bodyYaw));
    const bodyFwd = new THREE.Vector3(-Math.sin(this.bodyYaw), 0, -Math.cos(this.bodyYaw));
    // Wrist sits a little behind the pocket.
    const wristT = gp.clone().addScaledVector(fwd, -0.06).add(new THREE.Vector3(0, -0.08, 0));
    const elbow = new THREE.Vector3(), wrist = new THREE.Vector3();
    const poleG = new THREE.Vector3(0, -1, 0).addScaledVector(right, -side * 0.8);
    solveElbow(sG, wristT, 0.29, 0.27, poleG, elbow, wrist);
    placeSeg(this.segs[0], sG, elbow);
    placeSeg(this.segs[1], elbow, wrist);
    this.glove.position.copy(gp);
    this.glove.lookAt(tmpA.copy(gp).sub(fwd));
    this.gloveWorldPos.copy(gp);

    // Throwing arm by state.
    let target: THREE.Vector3;
    const up = new THREE.Vector3(0, 1, 0);
    if (arm !== this.lastArm && arm === Arm.Release) this.releaseT = 0;
    this.lastArm = arm;
    if (arm === Arm.Windup) {
      // Ball taken back and up behind the throwing shoulder.
      target = sT.clone().addScaledVector(bodyFwd, 0.05 - 0.33 * charge).addScaledVector(up, 0.08 + 0.2 * charge).addScaledVector(right, side * (0.2 + 0.08 * charge));
    } else if (arm === Arm.Release) {
      this.releaseT += dt;
      const k = Math.min(1, this.releaseT / 0.28);
      target = sT.clone().addScaledVector(bodyFwd, 0.5 * Math.sin(k * Math.PI * 0.6)).addScaledVector(up, 0.1 - 0.45 * k).addScaledVector(right, side * (0.15 - 0.35 * k));
    } else if (arm === Arm.Holding) {
      target = sT.clone().addScaledVector(bodyFwd, 0.26).addScaledVector(up, -0.3).addScaledVector(right, -side * 0.1);
    } else {
      target = sT.clone().addScaledVector(up, -0.5).addScaledVector(bodyFwd, 0.07).addScaledVector(right, side * 0.05);
    }
    if (!this.throwInit) { this.throwTarget.copy(target); this.throwInit = true; }
    this.throwTarget.lerp(target, Math.min(1, dt * (arm === Arm.Release ? 30 : 14)));
    const poleT = arm === Arm.Windup ? new THREE.Vector3().addScaledVector(right, side).addScaledVector(up, -0.2) : new THREE.Vector3(0, -1, 0).addScaledVector(right, side * 0.6);
    solveElbow(sT, this.throwTarget, 0.29, 0.27, poleT, elbow, wrist);
    placeSeg(this.segs[2], sT, elbow);
    placeSeg(this.segs[3], elbow, wrist);
    // Hand: ball grip just beyond the wrist.
    const forearm = tmpA.subVectors(wrist, elbow).normalize();
    this.handBall.copy(wrist).addScaledVector(forearm, 0.07);
    this.handMesh.position.copy(this.handBall);
    this.handMesh.lookAt(tmpB.copy(this.handBall).addScaledVector(forearm, -1));
    this.headTop.set(this.seatPos[0], 2.08, this.seatPos[2]);
  }

  dispose() {
    this.root.removeFromParent();
    this.arms.removeFromParent();
    this.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    this.arms.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    for (const m of this.mats) m.dispose();
  }
}
