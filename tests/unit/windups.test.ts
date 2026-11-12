import { describe, expect, it } from 'vitest';
import { EYE_HEIGHT } from '../../src/shared/constants';
import { positionAt, simulateFlight, solveThrowTo } from '../../src/shared/physics';
import { Arm } from '../../src/shared/protocol';
import { type Vec3, dist } from '../../src/shared/vec';
import {
  DEFAULT_WINDUP, DELIVERY_LENGTH, HOUSE_WINDUP, RELEASE_REACH, RELEASE_TIME, RIG, WINDUPS, WINDUP_IDS,
  deliveryPose, getWindup, pelvisHeight, releasePointFor, sampleKeys, shoulderOf, windupId, windupPose,
} from '../../src/shared/windups';
import { defaultStyle } from '../../src/shared/style';
import { Avatar } from '../../src/client/scene/avatar';

describe('windup library', () => {
  it('has the house delivery and six numbered signatures, each with a plain description', () => {
    expect([...WINDUP_IDS].sort((a, b) => a - b)).toEqual([0, 16, 32, 34, 35, 51, 55]);
    expect(new Set(WINDUP_IDS).size).toBe(WINDUP_IDS.length);
    for (const w of WINDUPS) {
      expect(w.label).toMatch(/^#\d\d$/);
      expect(w.blurb.length).toBeGreaterThan(8);
    }
    expect(WINDUP_IDS).toContain(DEFAULT_WINDUP);
    expect(WINDUP_IDS).toContain(HOUSE_WINDUP);
  });

  it('falls back safely on ids it does not know', () => {
    expect(getWindup(999).id).toBe(HOUSE_WINDUP);
    expect(getWindup('34').id).toBe(HOUSE_WINDUP);
    expect(windupId(999)).toBe(DEFAULT_WINDUP);
    expect(windupId(51)).toBe(51);
    expect(windupId(undefined, 16)).toBe(16);
  });

  it('every delivery is one continuous motion: the windup hands over to the delivery at the top', () => {
    for (const w of WINDUPS) {
      const top = windupPose(w, 1), go = deliveryPose(w, 0);
      expect(dist(top.ball, go.ball)).toBeLessThan(1e-9);
      expect(dist(top.lead, go.lead)).toBeLessThan(1e-9);
      // A quick throw (let go halfway up) starts from where the windup was, not from the top.
      const early = deliveryPose(w, 0, 0.5), mid = windupPose(w, 0.5);
      expect(dist(early.lead, mid.lead)).toBeLessThan(1e-9);
      // ...and has joined the full delivery well before the release.
      expect(dist(deliveryPose(w, 0.2, 0.5).ball, deliveryPose(w, 0.2).ball)).toBeLessThan(1e-9);
    }
  });

  it('feet stay on or above the grass and a planted foot never comes off its leg', () => {
    for (const w of WINDUPS) {
      const check = (p: ReturnType<typeof windupPose>) => {
        expect(p.lead[1]).toBeGreaterThanOrEqual(0);
        expect(p.pivot[1]).toBeGreaterThanOrEqual(0);
        const y = pelvisHeight(p);
        expect(y).toBeGreaterThan(0.42 - 1e-9);
        expect(y).toBeLessThanOrEqual(RIG.hipY + 0.05);
        const rx = Math.cos(p.hip), rz = -Math.sin(p.hip);
        for (const [foot, sx] of [[p.lead, -1], [p.pivot, 1]] as const) {
          if (foot[1] > 0.05) continue;
          const d = Math.hypot(foot[0] - (p.pelvis[0] + rx * RIG.hipW * sx), y - RIG.hipDrop - RIG.ankle - foot[1], foot[2] - (p.pelvis[2] + rz * RIG.hipW * sx));
          expect(d, `#${w.id} leg length`).toBeLessThanOrEqual(RIG.leg + 0.04);
        }
      };
      for (let u = 0; u <= 1.0001; u += 0.05) check(windupPose(w, u));
      for (let t = 0; t <= DELIVERY_LENGTH; t += 0.02) check(deliveryPose(w, t));
    }
  });

  it('the arm slots are really different: over the top is high and close, sidearm is low and wide', () => {
    const r = (id: number) => getWindup(id).release;
    expect(r(32)[1]).toBeGreaterThan(r(34)[1]);
    expect(r(34)[1]).toBeGreaterThan(r(35)[1]);
    expect(r(35)[1]).toBeGreaterThan(r(51)[1]);
    expect(r(51)[0]).toBeGreaterThan(r(32)[0] + 0.25);
    // The longest stride lets go furthest down the line.
    expect(r(55)[2]).toBeGreaterThan(r(0)[2] + 0.2);
  });

  it('the release point is where the arm actually is: a straight arm from the throwing shoulder', () => {
    for (const w of WINDUPS) {
      const p = sampleKeys(w.delivery, RELEASE_TIME);
      const reach = dist(shoulderOf(p), w.release);
      expect(reach).toBeGreaterThan(0.5);
      expect(reach).toBeLessThan(RIG.wrist + RIG.grip + 0.02);
    }
  });
});

describe('windups are fair', () => {
  it('every delivery lets go at the same moment, from a spot the server accepts', () => {
    for (const w of WINDUPS) {
      expect(w.delivery.some((k) => Math.abs(k.t - RELEASE_TIME) < 1e-9)).toBe(true);
      for (const hand of ['R', 'L'] as const) {
        const p = releasePointFor(w.id, [3, 0, -2], 0.7, hand);
        // The server's rule: the ball leaves from within reach of the thrower's eyes.
        expect(dist(p, [3, EYE_HEIGHT, -2])).toBeLessThan(RELEASE_REACH - 0.1);
        expect(p[1]).toBeGreaterThan(0.9);
        expect(p[1]).toBeLessThan(2.3);
      }
    }
  });

  it('left-handers are a mirror image', () => {
    for (const w of WINDUPS) {
      const r = releasePointFor(w.id, [0, 0, 0], 0, 'R'), l = releasePointFor(w.id, [0, 0, 0], 0, 'L');
      expect(l[0]).toBeCloseTo(-r[0], 9);
      expect(l[1]).toBeCloseTo(r[1], 9);
      expect(l[2]).toBeCloseTo(r[2], 9);
    }
  });

  it('the same aim gives the same throw whichever windup it is: same spot, same moment', () => {
    const target: Vec3 = [0.3, 1.25, -14];
    const T = 0.9;
    for (const w of WINDUPS) {
      const p0 = releasePointFor(w.id, [0, 0, 0], 0, 'R');
      const tr = simulateFlight(p0, solveThrowTo(p0, target, T));
      expect(dist(positionAt(tr, T), target), `#${w.id}`).toBeLessThan(0.01);
    }
  });
});

describe('the avatar performs the delivery', () => {
  const dt = 1 / 120;
  /** Wind up for the full tempo, let go, and run the clip to `until` seconds. */
  function deliver(id: number, hand: 'R' | 'L', until: number) {
    const av = new Avatar([2, 0, 5], 0.4, hand, defaultStyle('test'), id);
    const base = { pose: { x: 2, z: 5, yaw: 0.4, g: [0, 1.18, -0.4] as Vec3 }, look: null };
    for (let i = 0; i < 60; i++) av.update(dt, { ...base, arm: Arm.Holding, charge: 0 });
    const n = Math.round(getWindup(id).params.tempo / dt);
    for (let i = 1; i <= n; i++) av.update(dt, { ...base, arm: Arm.Windup, charge: i / n });
    for (let i = 0; i < Math.round(until / dt); i++) av.update(dt, { ...base, arm: Arm.Release, charge: 0 });
    return av;
  }

  it('the hand is at the release point when the ball leaves it (every windup, both hands)', () => {
    for (const w of WINDUPS) {
      for (const hand of ['R', 'L'] as const) {
        const av = deliver(w.id, hand, RELEASE_TIME);
        expect(av.deliveryTime).toBeCloseTo(RELEASE_TIME, 2);
        const want = releasePointFor(w.id, [2, 0, 5], 0.4, hand);
        const gap = dist([av.handBall.x, av.handBall.y, av.handBall.z], want);
        expect(gap, `#${w.id} ${hand}: hand is ${gap.toFixed(3)} m from the release point`).toBeLessThan(0.05);
      }
    }
  });

  it('a delivery runs its course and hands the body back', () => {
    const av = deliver(34, 'R', DELIVERY_LENGTH + 0.05);
    expect(av.deliveryTime).toBe(-1);
    expect(av.timeToRelease).toBe(RELEASE_TIME);
  });

  it('a remote delivery that starts late catches up, so its release lines up with the real one', () => {
    const av = new Avatar([0, 0, 0], 0, 'R', defaultStyle('test'), 16);
    const base = { pose: { x: 0, z: 0, yaw: 0, g: [0, 1.18, -0.4] as Vec3 }, look: null, lag: 0.11 };
    av.update(dt, { ...base, arm: Arm.Holding, charge: 0 });
    let t = 0;
    while (av.timeToRelease > 0 && t < 1) { av.update(dt, { ...base, arm: Arm.Release, charge: 0 }); t += dt; }
    // 0.11 s behind: the release comes ~0.11 s sooner than a full-length clip would.
    expect(t).toBeLessThan(RELEASE_TIME - 0.08);
    expect(t).toBeGreaterThan(RELEASE_TIME - 0.14);
  });
});
