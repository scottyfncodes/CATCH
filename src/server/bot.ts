// Coach: a friendly practice partner who keeps a lone player company until a
// friend joins. Runs on the server like any other player, so its throws and
// catches go through the same authoritative paths.

import { EYE_HEIGHT, GLOVE_REST_U, GLOVE_REST_V } from '../shared/constants.js';
import { type Trajectory, closestApproach, positionAt, solveThrowTo } from '../shared/physics.js';
import { eyePosition, lookAngles, releasePoint, viewBasis } from '../shared/pose.js';
import { Arm, type BallState, type CatchQuality } from '../shared/protocol.js';
import { type Vec3, dist, lerp, wrapAngle } from '../shared/vec.js';
import type { Member } from './room.js';

export type BotAction =
  | { kind: 'throw'; p: Vec3; v: Vec3 }
  | { kind: 'catch'; tid: number; tSec: number; q: CatchQuality; g: number };

const WINDUP_MS = 620;

export class BotBrain {
  private throwAt = 0;
  private releasedAt = 0;
  private throws = 0;
  private plannedTid = -1;
  private plan: { tSec: number; q: CatchQuality | null; g: number; point: Vec3 } | null = null;
  private rng = mulberry32(0x5eed);

  onGotBall(t: number) {
    this.throwAt = t + 1300 + this.rng() * 1100;
  }

  update(t: number, coach: Member, human: Member | null, ball: BallState, traj: Trajectory | null, streak: number): BotAction | null {
    const eye = eyePosition(coach.pos);
    const turn = (to: Vec3, rate = 0.25) => {
      const a = lookAngles(eye, to);
      coach.pose.yaw = coach.pose.yaw + wrapAngle(a.yaw - coach.pose.yaw) * rate;
      coach.pose.pitch = lerp(coach.pose.pitch, a.pitch, rate);
    };
    const relaxGlove = (rate = 0.2) => {
      coach.pose.gu = lerp(coach.pose.gu, GLOVE_REST_U, rate);
      coach.pose.gv = lerp(coach.pose.gv, GLOVE_REST_V, rate);
    };

    if (this.releasedAt && t - this.releasedAt > 380) { this.releasedAt = 0; coach.arm = Arm.Idle; }

    // Holding the ball: look at the friend, wait a beat, wind up, throw.
    if (ball.phase === 'held' && ball.holder === coach.id) {
      relaxGlove();
      if (!human || !human.connected) { coach.arm = Arm.Holding; coach.charge = 0; this.throwAt = Math.max(this.throwAt, t + 1200); return null; }
      const target = eyePosition(human.pos);
      turn([target[0], EYE_HEIGHT - 0.2, target[2]]);
      if (!this.throwAt) this.onGotBall(t);
      const left = this.throwAt - t;
      if (left > WINDUP_MS) { coach.arm = Arm.Holding; coach.charge = 0; return null; }
      if (left > 0) { coach.arm = Arm.Windup; coach.charge = Math.min(1, 1 - left / WINDUP_MS) * 0.8; return null; }
      this.throwAt = 0;
      this.releasedAt = t;
      coach.arm = Arm.Release;
      coach.charge = 0;
      return { kind: 'throw', ...this.aimAt(coach, human, streak) };
    }

    if (!this.releasedAt) { coach.arm = Arm.Idle; coach.charge = 0; }

    // Incoming live throw: read it, reach for it, catch it (usually).
    if (ball.phase === 'flight' && ball.live && traj && ball.thrower !== coach.id) {
      if (this.plannedTid !== ball.tid) {
        this.plannedTid = ball.tid;
        const chest: Vec3 = [coach.pos[0], EYE_HEIGHT - 0.32, coach.pos[2]];
        const ca = closestApproach(traj, chest);
        const point = positionAt(traj, ca.t);
        let q: CatchQuality | null = null;
        const reach = ca.dist;
        // Coach is good but human: easy balls are usually pocketed, reaches are scrappier.
        if (reach <= 0.55) q = reach < 0.3 ? (this.rng() < 0.45 ? 'perfect' : 'pocket') : 'web';
        else if (reach <= 0.95) q = this.rng() < 0.8 ? 'web' : null;
        else if (reach <= 1.25) q = this.rng() < 0.35 ? 'bobble' : null;
        const g = q === 'perfect' ? 0.82 + this.rng() * 0.15 : q === 'pocket' ? 0.55 + this.rng() * 0.2 : q === 'web' ? 0.3 + this.rng() * 0.2 : 0.1;
        this.plan = { tSec: ca.t, q, g: Math.round(g * 100) / 100, point };
      }
      const plan = this.plan!;
      const tSec = (t - ball.t0) / 1000;
      // Watch the ball, move the glove toward where it will arrive.
      const now = positionAt(traj, Math.max(0, tSec));
      turn(now, 0.35);
      const b = viewBasis(coach.pose.yaw, coach.pose.pitch);
      const off: Vec3 = [plan.point[0] - eye[0], plan.point[1] - eye[1], plan.point[2] - eye[2]];
      const fx = off[0] * b.f[0] + off[1] * b.f[1] + off[2] * b.f[2];
      const rx = off[0] * b.r[0] + off[1] * b.r[1] + off[2] * b.r[2];
      const uy = off[0] * b.u[0] + off[1] * b.u[1] + off[2] * b.u[2];
      const gu = Math.max(-1.1, Math.min(1.1, rx / Math.max(0.3, fx) / 0.42));
      const gv = Math.max(-1.1, Math.min(1.1, uy / Math.max(0.3, fx) / 0.62));
      coach.pose.gu = lerp(coach.pose.gu, gu, 0.35);
      coach.pose.gv = lerp(coach.pose.gv, gv, 0.35);
      if (plan.q && tSec >= plan.tSec) {
        const q = plan.q;
        this.plan = { ...plan, q: null };
        return { kind: 'catch', tid: ball.tid, tSec: plan.tSec, q, g: plan.g };
      }
      return null;
    }

    // Otherwise: watch the ball or whoever has it.
    relaxGlove(0.1);
    if (ball.phase === 'loose' && traj) {
      turn(positionAt(traj, (t - ball.t0) / 1000), 0.15);
    } else if (human) {
      const e = eyePosition(human.pos);
      turn([e[0], EYE_HEIGHT - 0.1, e[2]], 0.12);
    }
    return null;
  }

  private aimAt(coach: Member, human: Member, streak: number): { p: Vec3; v: Vec3 } {
    this.throws++;
    const yaw = lookAngles(eyePosition(coach.pos), eyePosition(human.pos)).yaw;
    const p = releasePoint(coach.pos, yaw, 'R');
    const facing = viewBasis(human.facing, 0);
    // Early throws are gentle and chest-high; variety grows with the streak.
    const warm = this.throws <= 3;
    const spread = warm ? 0.12 : Math.min(0.5, 0.2 + streak * 0.015);
    const ox = (this.rng() * 2 - 1) * spread;
    const oy = warm ? (this.rng() - 0.5) * 0.15 : -0.3 + this.rng() * 0.55;
    const he = eyePosition(human.pos);
    const target: Vec3 = [
      he[0] + facing.r[0] * ox,
      EYE_HEIGHT - 0.32 + oy,
      he[2] + facing.r[2] * ox,
    ];
    const d = dist(p, target);
    const pace = warm ? 10.5 : 12 + this.rng() * Math.min(9, 3 + streak * 0.35);
    const T = Math.max(0.55, d / pace);
    return { p, v: solveThrowTo(p, target, T) };
  }
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
