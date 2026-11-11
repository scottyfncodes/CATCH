// Coach: a friendly practice partner who keeps a lone player company until a
// friend joins. Runs on the server like any other player, so its throws and
// catches go through the same authoritative paths. Coach has a body like
// everyone else: it reads the throw, shuffles over to get under it, reaches,
// and usually (not always) squeezes it.

import { CHEST_HEIGHT, MOVE_RADIUS, RUN_ACCEL, RUN_SPEED, WALK_SPEED } from '../shared/constants.js';
import { type Trajectory, positionAt, solveThrowTo } from '../shared/physics.js';
import { clampReach, gloveReady, interceptPlan, lookAngles, releasePoint } from '../shared/pose.js';
import { Arm, type BallState, type CatchQuality } from '../shared/protocol.js';
import { type Vec3, dist, lerp, wrapAngle } from '../shared/vec.js';
import type { Member } from './room.js';

export type BotAction =
  | { kind: 'throw'; p: Vec3; v: Vec3 }
  | { kind: 'catch'; tid: number; tSec: number; q: CatchQuality; g: number };

const WINDUP_MS = 700;

export class BotBrain {
  private throwAt = 0;
  private releasedAt = 0;
  private throws = 0;
  private plannedTid = -1;
  private decided = false;
  private reactAt = 0;
  private runTo: Vec3 | null = null;
  private vx = 0;
  private vz = 0;
  private lastT = 0;
  private rng = mulberry32(0x5eed);

  onGotBall(t: number) {
    this.throwAt = t + 1500 + this.rng() * 1200;
  }

  update(t: number, coach: Member, human: Member | null, ball: BallState, traj: Trajectory | null, streak: number): BotAction | null {
    const dt = this.lastT ? Math.min(0.1, (t - this.lastT) / 1000) : 1 / 30;
    this.lastT = t;
    const pose = coach.pose;
    const here: Vec3 = [pose.x, 0, pose.z];
    const face = (to: Vec3, rate = 0.25) => {
      const a = lookAngles(here, to).yaw;
      pose.yaw = wrapAngle(pose.yaw + wrapAngle(a - pose.yaw) * rate);
    };
    const settleGlove = (rate = 0.2) => {
      const r = gloveReady(pose.yaw, coach.hand);
      pose.g = [lerp(pose.g[0], r[0], rate), lerp(pose.g[1], r[1], rate), lerp(pose.g[2], r[2], rate)];
    };
    /** Move toward a point: run when it matters, walk otherwise. */
    const moveTo = (to: Vec3, top: number) => {
      const dx = to[0] - pose.x, dz = to[2] - pose.z;
      const d = Math.hypot(dx, dz);
      // Arrive gently: speed tapers off over the last stride.
      const want = d < 0.03 ? 0 : Math.min(top, d * 3.2);
      const tx = d > 1e-4 ? (dx / d) * want : 0, tz = d > 1e-4 ? (dz / d) * want : 0;
      const ax = tx - this.vx, az = tz - this.vz;
      const al = Math.hypot(ax, az), amax = RUN_ACCEL * dt;
      const k = al > amax ? amax / al : 1;
      this.vx += ax * k; this.vz += az * k;
      pose.x += this.vx * dt; pose.z += this.vz * dt;
      // Stay near home.
      const hx = pose.x - coach.pos[0], hz = pose.z - coach.pos[2];
      const hd = Math.hypot(hx, hz);
      if (hd > MOVE_RADIUS) { pose.x = coach.pos[0] + (hx / hd) * MOVE_RADIUS; pose.z = coach.pos[2] + (hz / hd) * MOVE_RADIUS; }
    };

    if (this.releasedAt && t - this.releasedAt > 420) { this.releasedAt = 0; coach.arm = Arm.Idle; }

    // Holding the ball: wander back to the spot, look at the friend, wait a beat, wind up, throw.
    if (ball.phase === 'held' && ball.holder === coach.id) {
      settleGlove();
      moveTo(coach.pos, WALK_SPEED);
      if (!human || !human.connected) { coach.arm = Arm.Holding; coach.charge = 0; this.throwAt = Math.max(this.throwAt, t + 1200); return null; }
      face([human.pose.x, 0, human.pose.z]);
      if (!this.throwAt) this.onGotBall(t);
      const home = Math.hypot(pose.x - coach.pos[0], pose.z - coach.pos[2]);
      if (home > 0.8) this.throwAt = Math.max(this.throwAt, t + WINDUP_MS + 250);
      const left = this.throwAt - t;
      if (left > WINDUP_MS) { coach.arm = Arm.Holding; coach.charge = 0; return null; }
      if (left > 0) { coach.arm = Arm.Windup; coach.charge = Math.min(1, 1 - left / WINDUP_MS) * 0.75; return null; }
      this.throwAt = 0;
      this.releasedAt = t;
      coach.arm = Arm.Release;
      coach.charge = 0;
      return { kind: 'throw', ...this.aimAt(coach, human, streak) };
    }

    if (!this.releasedAt) { coach.arm = Arm.Idle; coach.charge = 0; }

    // Incoming live throw: read it, get under it, reach, and (usually) squeeze it.
    if (ball.phase === 'flight' && ball.live && traj && ball.thrower !== coach.id) {
      const tSec = (t - ball.t0) / 1000;
      if (this.plannedTid !== ball.tid) {
        this.plannedTid = ball.tid;
        this.decided = false;
        // A human beat to read the ball off the hand.
        this.reactAt = t + 180 + this.rng() * 140;
        // Where to stand: under the ball as it comes through chest height near the spot.
        const home = interceptPlan(traj, 0, coach.pos[0], coach.pos[2]);
        const p = home.point;
        const run: Vec3 = [p[0], 0, p[2]];
        // Pull back so the catch is out in front, glove side.
        const toward = lookAngles([p[0], 0, p[2]], [traj.p0[0], 0, traj.p0[2]]).yaw;
        run[0] += -Math.sin(toward) * -0.25; run[2] += -Math.cos(toward) * -0.25;
        this.runTo = Math.hypot(run[0] - pose.x, run[2] - pose.z) > 0.45 ? run : null;
      }
      const now = positionAt(traj, Math.max(0, tSec));
      face(now, 0.3);
      if (t >= this.reactAt && this.runTo) moveTo(this.runTo, RUN_SPEED * 0.92);
      else moveTo([pose.x, 0, pose.z], RUN_SPEED);
      const plan = interceptPlan(traj, Math.max(0, tSec - 0.05), pose.x, pose.z);
      const want = clampReach([plan.point[0] - pose.x, plan.point[1], plan.point[2] - pose.z]);
      // The glove comes up as the ball arrives.
      const rate = plan.t - tSec < 0.6 ? 0.45 : 0.12;
      pose.g = [lerp(pose.g[0], want[0], rate), lerp(pose.g[1], want[1], rate), lerp(pose.g[2], want[2], rate)];
      if (!this.decided && plan.t <= tSec + 0.02 && tSec > 0.25) {
        this.decided = true;
        const q = this.outcome(plan.norm, Math.hypot(this.vx, this.vz));
        if (q) {
          // The grade the POP plays: easy balls are often dead centre, reaches are scrappier.
          const r = this.rng();
          const g = q === 'perfect' ? 0.82 + r * 0.15 : q === 'pocket' ? 0.55 + r * 0.2 : q === 'web' ? 0.3 + r * 0.2 : 0.1;
          return { kind: 'catch', tid: ball.tid, tSec: Math.max(tSec - 0.01, plan.t), q, g: Math.round(g * 100) / 100 };
        }
      }
      return null;
    }

    // Otherwise: amble back to the spot and watch the ball, or the friend.
    settleGlove(0.1);
    moveTo(coach.pos, WALK_SPEED);
    if (ball.phase === 'loose' && traj) face(positionAt(traj, (t - ball.t0) / 1000), 0.15);
    else if (human) face([human.pose.x, 0, human.pose.z], 0.12);
    return null;
  }

  /** Catch quality from how far Coach had to reach (and whether still moving). */
  private outcome(norm: number, speed: number): CatchQuality | null {
    const r = this.rng();
    const hustle = Math.min(0.25, speed * 0.04);
    if (norm <= 0.62) return r < 0.985 - hustle * 0.2 ? (norm < 0.4 ? (r < 0.45 ? 'perfect' : 'pocket') : 'web') : null;
    if (norm <= 0.86) return r < 0.9 - hustle ? (r < 0.5 ? 'web' : 'pocket') : r < 0.95 ? 'bobble' : null;
    if (norm <= 1.0) return r < 0.55 - hustle ? 'bobble' : r < 0.7 ? 'web' : null;
    if (norm <= 1.12) return r < 0.18 ? 'bobble' : null;
    return null;
  }

  private aimAt(coach: Member, human: Member, streak: number): { p: Vec3; v: Vec3 } {
    this.throws++;
    const from: Vec3 = [coach.pose.x, 0, coach.pose.z];
    const to: Vec3 = [human.pose.x, 0, human.pose.z];
    const yaw = lookAngles(from, to).yaw;
    const p = releasePoint(from, yaw, coach.hand);
    // Sideways relative to the line between them (receiver's left/right).
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    // Early throws are gentle and chest-high. Then the throws wander like a
    // real friend's do: mostly catchable where you stand, some make you move.
    const warm = this.throws <= 3;
    const r = this.rng();
    let ox: number, oy: number;
    if (warm) { ox = (this.rng() * 2 - 1) * 0.25; oy = (this.rng() - 0.5) * 0.2; }
    else if (r < 0.45) { ox = (this.rng() * 2 - 1) * 0.6; oy = -0.25 + this.rng() * 0.5; }
    else if (r < 0.85) { ox = (this.rng() < 0.5 ? -1 : 1) * (1.15 + this.rng() * Math.min(1.5, 0.7 + streak * 0.06)); oy = -0.2 + this.rng() * 0.5; }
    else { ox = (this.rng() * 2 - 1) * 0.5; oy = this.rng() < 0.5 ? -0.75 : 0.65; }
    const target: Vec3 = [to[0] + rx * ox, CHEST_HEIGHT - 0.05 + oy, to[2] + rz * ox];
    const d = dist(p, target);
    const pace = warm ? 10.5 : 11 + this.rng() * Math.min(7, 2 + streak * 0.3);
    const T = Math.max(0.6, d / pace);
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
