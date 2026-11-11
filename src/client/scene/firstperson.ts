// Your own hands: the glove (catching) and the bare throwing hand, attached
// to the camera. The glove sits exactly where the shared glove mapping puts
// it, so what you see is what the server validates.

import * as THREE from 'three';
import { GLOVE_REST_U, GLOVE_REST_V } from '../../shared/constants';
import { gloveViewOffset, type Hand } from '../../shared/pose';
import { buildGlove, buildHand, setGloveClosure } from './gear';

const UP = new THREE.Vector3(0, 1, 0);
const tmp = new THREE.Vector3();

function limb(color: string, r: number) {
  const g = new THREE.CylinderGeometry(r, r * 1.3, 1, 12);
  g.translate(0, 0.5, 0);
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, roughness: 0.7 }));
}

function placeLimb(m: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3) {
  tmp.subVectors(b, a);
  const l = tmp.length() || 1e-4;
  m.position.copy(a);
  m.quaternion.setFromUnitVectors(UP, tmp.divideScalar(l));
  m.scale.set(1, l, 1);
}

export class FirstPerson {
  readonly group = new THREE.Group();
  readonly glove: THREE.Group;
  private gloveArm: THREE.Mesh;
  private hand: THREE.Group;
  private handArm: THREE.Mesh;
  private hand_: Hand = 'R';
  private tanX = 0.35;
  private tanY = 0.75;
  /** Visual-only glove offsets. */
  private recoil = 0;
  private recoilDir = new THREE.Vector3(0, 0, 1);
  private closure = 0;
  /** Throw animation clocks (seconds). */
  private releaseT = -1;
  private transferT = -1;
  private pickupT = -1;
  private handPos = new THREE.Vector3();
  private handVel = new THREE.Vector3();
  readonly handBallLocal = new THREE.Vector3();
  readonly gloveLocal = new THREE.Vector3();
  /** 0..1 how far the glove has been brought in toward the throwing hand. */
  private gather = 0;

  constructor(skin: string) {
    this.glove = buildGlove();
    this.glove.scale.setScalar(0.78);
    this.gloveArm = limb(skin, 0.04);
    this.hand = buildHand(skin);
    this.handArm = limb(skin, 0.032);
    this.group.add(this.glove, this.gloveArm, this.hand, this.handArm);
    this.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.castShadow = false; m.frustumCulled = false; } });
    this.handPos.set(0.1, -0.25, -0.4);
  }

  setHand(h: Hand) {
    this.hand_ = h;
    const s = h === 'R' ? 1 : -1;
    this.glove.scale.x = 0.78 * (h === 'R' ? 1 : -1);
    this.hand.scale.x = s;
  }

  setFrustum(fovYDeg: number, aspect: number) {
    this.tanY = Math.tan((fovYDeg * Math.PI) / 360);
    this.tanX = this.tanY * aspect;
  }

  /** View-space point at normalised screen coords (ndc) and forward depth. */
  private ndc(x: number, y: number, depth: number, out: THREE.Vector3) {
    return out.set(x * this.tanX * depth, y * this.tanY * depth, -depth);
  }

  onCatch(dirCam: THREE.Vector3, speed: number) {
    this.recoil = Math.min(1, 0.35 + speed / 28);
    this.recoilDir.copy(dirCam).normalize();
    this.closure = 1;
  }
  onRelease() { this.releaseT = 0; }
  onTransfer() { this.transferT = 0; }
  onPickup() { this.pickupT = 0; }

  /**
   * gu/gv: smoothed glove pose. holding: ball in the throwing hand.
   * charge: windup 0..1 (null when not winding).
   */
  update(dt: number, gu: number, gv: number, holding: boolean, charge: number | null, glovedBall: boolean) {
    const side = this.hand_ === 'R' ? 1 : -1;
    const gside = -side;

    // ---- glove
    if (this.transferT >= 0) this.transferT += dt;
    if (this.transferT > 0.6) this.transferT = -1;
    // Bring the glove in to meet the throwing hand after a catch.
    const wantGather = glovedBall || (this.transferT >= 0 && this.transferT < 0.3) ? 1 : 0;
    this.gather += (wantGather - this.gather) * Math.min(1, dt * (wantGather ? 9 : 6));
    const o = gloveViewOffset(gu, gv);
    const pos = new THREE.Vector3(o[0], o[1], -o[2]);
    this.gloveLocal.copy(pos);
    const gatherPos = this.ndc(side * 0.12, -0.42, 0.5, new THREE.Vector3());
    pos.lerp(gatherPos, this.gather * 0.75);
    this.recoil = Math.max(0, this.recoil - dt * 4.2);
    if (this.recoil > 0) pos.addScaledVector(this.recoilDir, 0.075 * this.recoil * Math.sin(this.recoil * Math.PI * 0.9 + 0.3));
    this.closure = Math.max(0, this.closure - dt * 1.4);
    setGloveClosure(this.glove, Math.min(1, this.closure * 1.8 + this.gather * 0.5));
    this.glove.position.copy(pos);
    // Pocket faces the play, leaning out as it reaches; turns toward you when gathering.
    // Three-quarter view: thumb and web turned in toward the middle of the screen.
    this.glove.rotation.set(
      -0.18 + gv * 0.18 + this.gather * 0.5,
      gu * 0.3 + side * 0.42 + this.gather * side * 0.7,
      -gu * 0.22 + gside * 0.16,
      'YXZ',
    );
    // Forearm runs off the bottom of the screen.
    const wrist = new THREE.Vector3(0, -0.11, 0.05).applyEuler(this.glove.rotation).add(pos);
    const elbow = this.ndc(gside * 0.95, -1.35, 0.42, new THREE.Vector3());
    placeLimb(this.gloveArm, elbow, wrist);

    // ---- throwing hand
    const rest = this.ndc(side * 0.55, -0.6, 0.42, new THREE.Vector3());
    let target = rest.clone();
    const hidden = this.ndc(side * 0.8, -1.6, 0.42, new THREE.Vector3());
    if (this.releaseT >= 0) {
      this.releaseT += dt;
      const k = this.releaseT;
      // Whip through: forward and across, then drop out of view, then the empty hand returns.
      if (k < 0.12) target = this.ndc(side * 0.15, -0.05, 0.62, new THREE.Vector3());
      else if (k < 0.45) target = this.ndc(-side * 0.3, -1.4, 0.5, new THREE.Vector3());
      else { this.releaseT = -1; }
    } else if (charge !== null) {
      // Pull back: down, outward and toward you.
      target = this.ndc(side * (0.6 + 0.2 * charge), -0.62 - 0.38 * charge, 0.42 - 0.12 * charge, new THREE.Vector3());
    } else if (!holding) {
      target = this.ndc(side * 0.6, -0.95, 0.42, new THREE.Vector3());
    }
    if (this.pickupT >= 0) {
      this.pickupT += dt;
      if (this.pickupT < 0.25) target = hidden;
      else if (this.pickupT > 0.6) this.pickupT = -1;
    }
    if (this.transferT >= 0 && this.transferT < 0.3) {
      // Reach over to the glove to take the ball.
      target = gatherPos.clone().add(new THREE.Vector3(side * 0.05, 0.02, 0.03));
    }
    // Springy follow.
    const k = this.releaseT >= 0 ? 900 : 380, d = this.releaseT >= 0 ? 50 : 34;
    const acc = target.clone().sub(this.handPos).multiplyScalar(k).addScaledVector(this.handVel, -d);
    this.handVel.addScaledVector(acc, Math.min(dt, 1 / 30));
    this.handPos.addScaledVector(this.handVel, Math.min(dt, 1 / 30));
    this.hand.position.copy(this.handPos);
    const wind = charge ?? 0;
    this.hand.rotation.set(0.15 - wind * 0.45, -side * (0.25 + wind * 0.3), side * 0.1, 'YXZ');
    this.handBallLocal.copy(this.handPos);
    const hw = new THREE.Vector3(0, -0.09, 0.15).applyEuler(this.hand.rotation).add(this.handPos);
    const helb = this.ndc(side * 1.1, -1.5, 0.35, new THREE.Vector3());
    placeLimb(this.handArm, helb, hw);
  }

  /** Where the ball sits in the glove pocket (camera space), incl. visual offsets. */
  pocketLocal(out: THREE.Vector3) {
    return out.copy(this.glove.position).add(new THREE.Vector3(0, 0.005, -0.02).applyEuler(this.glove.rotation));
  }

  reset() {
    this.releaseT = this.transferT = this.pickupT = -1;
    this.gather = 0;
    this.gloveLocal.set(0, 0, 0);
  }

  static restPose() { return { gu: GLOVE_REST_U, gv: GLOVE_REST_V }; }
}
