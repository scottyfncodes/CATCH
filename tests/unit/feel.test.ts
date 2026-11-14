// How a throw feels: a rope, not a rainbow; and a windup as big as the pull.
import { describe, expect, it } from 'vitest';
import { THROW_SPEED_LIMIT } from '../../src/shared/constants';
import { positionAt, simulateFlight, solveArc, throwElevation } from '../../src/shared/physics';
import { RELEASE_TIME, WINDUP_IDS, exaggerate, getWindup, windupPose, windupScale } from '../../src/shared/windups';
import { Arm } from '../../src/shared/protocol';
import { defaultStyle } from '../../src/shared/style';
import { Avatar } from '../../src/client/scene/avatar';

const IDS = WINDUP_IDS;

describe('a straighter, quicker throw', () => {
  const p0: [number, number, number] = [0, 1.8, 0];
  const thrown = (d: number, k: number) => {
    const r = solveArc(p0, [0, 1.25, -d], throwElevation(d) * k);
    const tr = simulateFlight(p0, r.v0);
    let apex = 0;
    for (let t = 0; t <= r.T; t += 0.01) apex = Math.max(apex, positionAt(tr, t)[1]);
    return { ...r, apex };
  };

  it('across the road at full pull it is on a line: barely above the hand, there in well under a second', () => {
    const t = thrown(14, 0.65);
    expect(t.speed).toBeGreaterThan(24);
    expect(t.T).toBeLessThan(0.62);
    expect(t.apex - p0[1]).toBeLessThan(0.2);
  });

  it('a soft pull is still a throw, not a lob', () => {
    const t = thrown(14, 1.2);
    expect(t.T).toBeLessThan(0.8);
    expect(t.apex - p0[1]).toBeLessThan(0.45);
  });

  it('a harder pull is always flatter and quicker, at every distance', () => {
    for (const d of [14, 25, 40, 70, 120]) {
      const soft = thrown(d, 1.2), hard = thrown(d, 0.65);
      expect(hard.T).toBeLessThan(soft.T);
      expect(hard.apex).toBeLessThanOrEqual(soft.apex);
      expect(hard.speed).toBeLessThan(THROW_SPEED_LIMIT);
    }
  });
});

describe('the windup is as big as the pull', () => {
  it('half a pull is the windup as written', () => {
    expect(windupScale(0.5)).toBe(1);
    const w = getWindup(34);
    expect(exaggerate(w, windupPose(w, 1), windupScale(0.5))).toEqual(windupPose(w, 1));
  });

  it('the further back the thumb, the higher the kick and the bigger the turn, for every windup', () => {
    for (const id of IDS) {
      const w = getWindup(id);
      const top = windupPose(w, 1);
      let prev = exaggerate(w, top, windupScale(0));
      for (let pull = 0.1; pull <= 1.001; pull += 0.1) {
        const p = exaggerate(w, top, windupScale(pull));
        expect(p.lead[1], `#${id} kick at pull ${pull.toFixed(1)}`).toBeGreaterThanOrEqual(prev.lead[1] - 1e-9);
        expect(p.hip, `#${id} turn at pull ${pull.toFixed(1)}`).toBeGreaterThanOrEqual(prev.hip - 1e-9);
        prev = p;
      }
      const small = exaggerate(w, top, windupScale(0)), big = exaggerate(w, top, windupScale(1));
      expect(big.lead[1]).toBeGreaterThan(small.lead[1] + 0.15);
      // Bigger, but still something a body does.
      expect(big.lead[1]).toBeLessThanOrEqual(Math.max(top.lead[1], 1.25) + 1e-9);
      expect(big.hip).toBeLessThanOrEqual(Math.max(top.hip, 2.7) + 1e-9);
      expect(big.ball[1]).toBeLessThanOrEqual(2.35);
    }
  });

  it('whatever the size of the windup, the ball leaves from the same place', () => {
    const at = (pull: number) => {
      const av = new Avatar([0, 0, 0], 0, 'R', defaultStyle('feel'), 34);
      const base = { pose: { x: 0, z: 0, yaw: 0, g: [-0.2, 1.18, -0.42] as [number, number, number] }, look: [0, 1.4, -14] as [number, number, number], pull };
      const dt = 1 / 120;
      for (let i = 0; i < 60; i++) av.update(dt, { ...base, arm: Arm.Holding, charge: 0 });
      for (let i = 1; i <= 120; i++) av.update(dt, { ...base, arm: Arm.Windup, charge: i / 120 });
      const top = av.handBall.clone();
      for (let i = 0; i < Math.round(RELEASE_TIME / dt); i++) av.update(dt, { ...base, arm: Arm.Release, charge: 0 });
      return { top, rel: av.handBall.clone() };
    };
    const small = at(0), big = at(1);
    expect(small.rel.distanceTo(big.rel)).toBeLessThan(0.02);
    // (And the two windups really were different at the top.)
    expect(small.top.distanceTo(big.top)).toBeGreaterThan(0.1);
  });
});

describe('more zip on every throw', () => {
  const p0: [number, number, number] = [0, 1.8, 0];
  it('the same throw, to the same place, 17% faster and sooner; and never over the cap', async () => {
    const { solveThrow, simulateFlight: sim, positionAt: at, solveArc: arc, throwElevation: elev } = await import('../../src/shared/physics');
    const { THROW_ZIP, THROW_SPEED_CAP, SPEED_MAX } = await import('../../src/shared/constants');
    for (const d of [14, 20, 35, 60, 90, 120]) for (const k of [0.65, 1.2]) {
      const target: [number, number, number] = [0.6, 1.3, -d];
      const base = arc(p0, target, elev(d) * k);
      for (const mul of [THROW_ZIP, THROW_ZIP * SPEED_MAX]) {
        const z = solveThrow(p0, target, elev(d) * k, mul);
        const hit = at(sim(p0, z.v0), z.T);
        expect(Math.hypot(hit[0] - target[0], hit[1] - target[1], hit[2] - target[2]), `${d} m ×${mul}`).toBeLessThan(0.06);
        expect(z.speed).toBeLessThanOrEqual(THROW_SPEED_CAP + 1e-9);
        expect(z.speed).toBeCloseTo(Math.min(THROW_SPEED_CAP, base.speed * mul), 3);
        expect(z.T).toBeLessThan(base.T);
      }
    }
    // Asking for no more zip changes nothing.
    const a = arc(p0, [0, 1.25, -14], elev(14)), b = solveThrow(p0, [0, 1.25, -14], elev(14), 1);
    expect(b.v0).toEqual(a.v0);
  });
});
