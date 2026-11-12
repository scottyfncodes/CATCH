// The body as a connected structure: for every catching position, the bones
// keep their lengths, the joints stay inside what a person's can do, the
// glove is where the game says it is, and its pocket faces the ball.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bodyToWorld, clampReach } from '../../src/shared/pose';
import { defaultStyle } from '../../src/shared/style';
import type { Vec3 } from '../../src/shared/vec';
import { Avatar } from '../../src/client/scene/avatar';

const UPPER = 0.29, FORE = 0.27;
const BALL: Vec3 = [0, 1.9, -14];
const dt = 1 / 60;

/** Catching positions in body space (right, up, forward) for a right-hander (glove on the left hand). */
export const POSITIONS: Record<string, Vec3> = {
  'centre chest': [-0.15, 1.25, 0.5],
  'above the head': [-0.1, 2.25, 0.3],
  'below the waist': [-0.15, 0.4, 0.6],
  'far glove side': [-0.95, 1.2, 0.3],
  'far across': [0.9, 1.2, 0.3],
  'across the body': [0.45, 1.1, 0.45],
  'fully extended': clampReach([-0.75, 1.95, 0.55], 0.98),
  'near the body': [-0.08, 1.1, 0.26],
};

function make(hand: 'R' | 'L') { return new Avatar([0, 0, 0], 0, hand, defaultStyle('bio'), 34); }
const mirror = (p: Vec3, hand: 'R' | 'L'): Vec3 => (hand === 'R' ? p : [-p[0], p[1], p[2]]);
function hold(av: Avatar, g: Vec3, frames: number, each?: () => void) {
  for (let i = 0; i < frames; i++) {
    av.update(dt, { pose: { x: 0, z: 0, yaw: 0, g: bodyToWorld(0, g) }, arm: 0, charge: 0, look: BALL, ready: true });
    each?.();
  }
}
function check(av: Avatar, where: string) {
  const j = av.joints;
  expect(j.shoulder.distanceTo(j.elbow), `${where}: upper arm length`).toBeCloseTo(UPPER, 3);
  expect(j.elbow.distanceTo(j.wrist), `${where}: forearm length`).toBeCloseTo(FORE, 3);
  // The elbow bends the way an elbow bends, and never past straight or folded flat.
  const a = new THREE.Vector3().subVectors(j.shoulder, j.elbow), b = new THREE.Vector3().subVectors(j.wrist, j.elbow);
  const elbow = a.angleTo(b);
  expect(elbow, `${where}: elbow angle`).toBeGreaterThan(0.45);
  expect(elbow, `${where}: elbow angle`).toBeLessThanOrEqual(Math.PI + 1e-6);
  const mid = new THREE.Vector3().addVectors(j.shoulder, j.wrist).multiplyScalar(0.5);
  if (elbow < 3.0) expect(new THREE.Vector3().subVectors(j.elbow, mid).dot(j.pole), `${where}: elbow on the right side of the arm`).toBeGreaterThan(-1e-3);
  // The hand stays within the wrist's range of the forearm.
  expect(j.forearm.angleTo(j.fingers), `${where}: wrist bend`).toBeLessThan(1.45 + 0.03);
  // The glove's axes are a clean frame.
  expect(Math.abs(j.pocket.dot(j.fingers)), `${where}: glove frame`).toBeLessThan(1e-3);
}

describe('a connected body', () => {
  for (const hand of ['R', 'L'] as const) {
    for (const [name, p] of Object.entries(POSITIONS)) {
      it(`${name} (${hand === 'R' ? 'right' : 'left'}-handed): bones keep their length, joints stay human, the glove is on the ball's line`, () => {
        const av = make(hand);
        const g = mirror(p, hand);
        hold(av, g, 90);
        check(av, name);
        const j = av.joints;
        // The arm actually gets the glove there (the pocket the server checks), without stretching.
        expect(j.gap, `${name}: reach shortfall`).toBeLessThan(0.004);
        const want = bodyToWorld(0, g);
        expect(j.glove.distanceTo(new THREE.Vector3(want[0], want[1], want[2])), `${name}: pocket is where the pose says`).toBeLessThan(0.006);
        // The pocket is presented to the incoming ball.
        const toBall = new THREE.Vector3(BALL[0] - j.glove.x, BALL[1] - j.glove.y, BALL[2] - j.glove.z).normalize();
        expect(j.pocket.angleTo(toBall), `${name}: pocket faces the ball`).toBeLessThan(0.6);
        // Feet stay on the grass and the head stays up.
        expect(av.eye.y).toBeGreaterThan(0.9);
      });
    }
  }

  it('fingers up above the belt, down below it, out to the side for a wide one: and it turns, it does not flip', () => {
    const av = make('R');
    hold(av, POSITIONS['above the head'], 60);
    expect(av.joints.fingers.y).toBeGreaterThan(0.8);
    hold(av, POSITIONS['below the waist'], 60);
    expect(av.joints.fingers.y).toBeLessThan(-0.6);
    hold(av, POSITIONS['far glove side'], 60);
    expect(av.joints.fingers.x).toBeLessThan(-0.6);
    hold(av, POSITIONS['far across'], 60);
    expect(av.joints.fingers.x).toBeGreaterThan(0.5);
    // Sweep the glove slowly from the grass to overhead: the glove's facing changes smoothly the whole way.
    const q = new THREE.Quaternion(); let worst = 0;
    hold(av, [-0.2, 0.3, 0.55], 60);
    q.copy(av.glove.quaternion);
    for (let k = 0; k <= 240; k++) {
      hold(av, [-0.2, 0.3 + (1.95 * k) / 240, 0.55 - 0.2 * (k / 240)], 1);
      worst = Math.max(worst, q.angleTo(av.glove.quaternion)); q.copy(av.glove.quaternion);
      check(av, `sweep ${k}`);
    }
    // (Passing the belt, the hand turns over from fingers-down to fingers-up: quick, but a turn.)
    expect(worst, 'largest turn of the glove in one frame of a slow sweep').toBeLessThan(0.14);
  });

  it('rapid movement between opposite positions: nothing stretches, inverts or snaps on the way', () => {
    for (const hand of ['R', 'L'] as const) {
      const av = make(hand);
      const pairs: [string, string][] = [['far glove side', 'far across'], ['above the head', 'below the waist'], ['fully extended', 'near the body'], ['far across', 'below the waist']];
      for (const [a, b] of pairs) {
        hold(av, mirror(POSITIONS[a], hand), 40);
        const q = av.glove.quaternion.clone(); let worst = 0;
        // The game eases the glove to a new target over a few hundredths of a second; here it is moved in six frames.
        const A = mirror(POSITIONS[a], hand), B = mirror(POSITIONS[b], hand);
        for (let k = 1; k <= 30; k++) {
          const t = Math.min(1, k / 6);
          hold(av, [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t], 1, () => {
            check(av, `${a} → ${b} frame ${k}`);
            expect(av.joints.gap, `${a} → ${b} frame ${k}: reach shortfall`).toBeLessThan(0.01);
            worst = Math.max(worst, q.angleTo(av.glove.quaternion)); q.copy(av.glove.quaternion);
          });
        }
        // A fast move turns the wrist fast, but never in one frame (that would be a snap).
        expect(worst, `${a} → ${b}: largest turn of the glove in one frame`).toBeLessThan(0.75);
      }
    }
  });

  it('a wide reach is the whole body going: the shoulder leads, the trunk leans, the hips shift', () => {
    const av = make('R');
    hold(av, POSITIONS['centre chest'], 60);
    const chest0 = av.chestPos.clone(), sh0 = av.joints.shoulder.clone();
    hold(av, POSITIONS['far glove side'], 60);
    // The glove shoulder has gone toward the ball further than the chest has: it leads.
    expect(sh0.x - av.joints.shoulder.x).toBeGreaterThan(0.14);
    expect(chest0.x - av.chestPos.x).toBeGreaterThan(0.08);
    expect(sh0.x - av.joints.shoulder.x).toBeGreaterThan(chest0.x - av.chestPos.x);
    // Across the body the trunk turns the glove shoulder round to the front.
    hold(av, POSITIONS['far across'], 60);
    expect(av.joints.shoulder.z).toBeLessThan(sh0.z - 0.05);
  });

  it('a caught ball makes the arm give, then come back', () => {
    const av = make('R');
    hold(av, POSITIONS['centre chest'], 60);
    const rest = av.joints.glove.clone();
    av.catchImpact([0, -2, 22], 22);
    let back = 0;
    hold(av, POSITIONS['centre chest'], 30, () => { back = Math.max(back, av.joints.glove.z - rest.z); check(av, 'impact'); });
    expect(back).toBeGreaterThan(0.03);
    expect(back).toBeLessThan(0.14);
    hold(av, POSITIONS['centre chest'], 60);
    expect(av.joints.glove.distanceTo(rest)).toBeLessThan(0.01);
  });
});
