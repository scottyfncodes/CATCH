// Coach: a friendly practice partner who keeps a lone player company until a
// friend joins. Runs on the server like any other player, so its throws and
// catches go through the same authoritative paths. Coach has a body like
// everyone else. When you have the ball it holds its glove up as your target
// and keeps it still, so how well your throw finds that glove is what its POP
// says. When it throws, it aims at your glove: good, not perfect.

import { MOVE_RADIUS, RUN_ACCEL, RUN_SPEED, WALK_SPEED } from '../shared/constants.js';
import { type Trajectory, closestApproach, positionAt, solveArc, throwElevation, velocityAt } from '../shared/physics.js';
import { bodyToWorld, clampReach, gloveReady, interceptPlan, lookAngles } from '../shared/pose.js';
import { Arm, type BallState, type CatchQuality, catchGrade, classifyCatch } from '../shared/protocol.js';
import { type Vec3, dist, len, lerp, wrapAngle } from '../shared/vec.js';
import { RELEASE_TIME, getWindup, releasePointFor } from '../shared/windups.js';
import type { Member } from './room.js';

export type BotAction =
  | { kind: 'throw'; p: Vec3; v: Vec3 }
  | { kind: 'catch'; tid: number; tSec: number; q: CatchQuality | 'deflect'; g: number };

/** Coach holds the top of the windup for a beat before going. */
const TOP_HOLD_MS = 160;
const RELEASE_MS = RELEASE_TIME * 1000;

export class BotBrain {
  /** When Coach starts the arm forward (the windup runs up to this). */
  private throwAt = 0;
  /** A delivery in progress: the ball leaves the hand at `at`. */
  private pending: { p: Vec3; v: Vec3; at: number } | null = null;
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
  /** Where Coach holds the glove as a target for you (body space: right, up, forward). */
  private target: Vec3 = [-0.2, 1.2, 0.42];
  private targetFor = -1;
  /** How far off Coach's set glove your throw is coming (null = not read yet). */
  private offBy: number | null = null;
  private gauss() { const u = Math.max(1e-9, this.rng()), v = this.rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  onGotBall(t: number) {
    this.throwAt = t + 1500 + this.rng() * 1200;
  }

  update(t: number, coach: Member, human: Member | null, ball: BallState, traj: Trajectory | null, streak: number, glove = 1): BotAction | null {
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

    if (this.releasedAt && t - this.releasedAt > 450) { this.releasedAt = 0; coach.arm = Arm.Idle; }
    if (this.pending && !(ball.phase === 'held' && ball.holder === coach.id)) this.pending = null;

    // Holding the ball: wander back to the spot, look at the friend, wait a beat,
    // go through the windup, then deliver: the ball leaves the hand a beat after
    // the arm starts forward, exactly as it does for a person.
    if (ball.phase === 'held' && ball.holder === coach.id) {
      if (this.pending) {
        coach.arm = Arm.Release;
        if (t < this.pending.at) return null;
        const a = this.pending;
        this.pending = null;
        this.throwAt = 0;
        this.releasedAt = t;
        return { kind: 'throw', p: a.p, v: a.v };
      }
      settleGlove();
      moveTo(coach.pos, WALK_SPEED);
      if (!human || !human.connected) { coach.arm = Arm.Holding; coach.charge = 0; this.throwAt = Math.max(this.throwAt, t + 1200); return null; }
      face([human.pose.x, 0, human.pose.z]);
      if (!this.throwAt) this.onGotBall(t);
      const tempo = getWindup(coach.windup).params.tempo * 1000;
      const windMs = tempo + TOP_HOLD_MS;
      const home = Math.hypot(pose.x - coach.pos[0], pose.z - coach.pos[2]);
      if (home > 0.8) this.throwAt = Math.max(this.throwAt, t + windMs + 250);
      const left = this.throwAt - t;
      if (left > windMs) { coach.arm = Arm.Holding; coach.charge = 0; return null; }
      // (Coach winds up bigger the further he has to throw.)
      if (left > 0) { coach.arm = Arm.Windup; coach.charge = Math.min(1, (windMs - left) / tempo); coach.pull = Math.min(0.9, 0.4 + Math.hypot(human.pose.x - coach.pos[0], human.pose.z - coach.pos[2]) * 0.008); return null; }
      coach.arm = Arm.Release;
      coach.charge = 0;
      this.pending = { ...this.aimAt(coach, human, streak), at: t + RELEASE_MS };
      return null;
    }

    if (!this.releasedAt) { coach.arm = Arm.Idle; coach.charge = 0; }

    // Your turn to throw: Coach sets a target with the glove and holds it still.
    if (ball.phase === 'held' && ball.holder && ball.holder !== coach.id) {
      if (this.targetFor !== ball.tid) {
        this.targetFor = ball.tid;
        const side = coach.hand === 'R' ? -1 : 1;
        // The first few are friendly chest-high targets; then mostly chest-high on
        // the glove side, sometimes up high, down low, or across the body.
        const r = this.throws < 3 ? 0 : this.rng();
        this.target = r < 0.55 ? [side * (0.12 + this.rng() * 0.18), 1.15 + this.rng() * 0.25, 0.42]
          : r < 0.72 ? [side * 0.1 * this.rng(), 1.75 + this.rng() * 0.3, 0.32]
          : r < 0.88 ? [side * (0.1 + this.rng() * 0.2), 0.6 + this.rng() * 0.25, 0.5]
          : [-side * (0.2 + this.rng() * 0.2), 1.2 + this.rng() * 0.2, 0.42];
      }
      moveTo(coach.pos, WALK_SPEED);
      if (human) face([human.pose.x, 0, human.pose.z], 0.25);
      const want = clampReach(bodyToWorld(pose.yaw, this.target));
      pose.g = [lerp(pose.g[0], want[0], 0.2), lerp(pose.g[1], want[1], 0.2), lerp(pose.g[2], want[2], 0.2)];
      return null;
    }

    // Incoming live throw: if it's on the glove, hold still and squeeze it; a little
    // off, a quick adjust (that costs the POP); way off, go and get it.
    if (ball.phase === 'flight' && ball.live && traj && ball.thrower !== coach.id) {
      const tSec = (t - ball.t0) / 1000;
      if (this.plannedTid !== ball.tid) {
        this.plannedTid = ball.tid;
        this.decided = false;
        this.reactAt = t + 180 + this.rng() * 140;
        const gw: Vec3 = [pose.x + pose.g[0], pose.g[1], pose.z + pose.g[2]];
        const ca = closestApproach(traj, gw);
        // (With a bigger glove, further off still finds leather.)
        this.offBy = ca.dist / glove;
        this.runTo = null;
        if (ca.dist > 0.45) {
          // Where to stand: under the ball as it comes through chest height near the spot.
          const home = interceptPlan(traj, 0, coach.pos[0], coach.pos[2]);
          const p = home.point;
          const run: Vec3 = [p[0], 0, p[2]];
          const toward = lookAngles([p[0], 0, p[2]], [traj.p0[0], 0, traj.p0[2]]).yaw;
          run[0] += Math.sin(toward) * 0.25; run[2] += Math.cos(toward) * 0.25;
          this.runTo = Math.hypot(run[0] - pose.x, run[2] - pose.z) > 0.45 ? run : null;
        }
      }
      const off = this.offBy ?? 1;
      if (off <= 0.45) {
        // Stay square and hold (or nudge) the glove.
        moveTo([pose.x, 0, pose.z], RUN_SPEED);
        const gw: Vec3 = [pose.x + pose.g[0], pose.g[1], pose.z + pose.g[2]];
        const ca = closestApproach(traj, gw);
        if (off > 0.11 && ca.t - tSec < 0.3) {
          const bp = positionAt(traj, ca.t);
          pose.g = clampReach([lerp(pose.g[0], bp[0] - pose.x, 0.35), lerp(pose.g[1], bp[1], 0.35), lerp(pose.g[2], bp[2] - pose.z, 0.35)]);
        }
        if (!this.decided && tSec >= ca.t - 0.01 && tSec > 0.25) {
          this.decided = true;
          // Held still: the grade is exactly how close your throw came. Adjusted: scrappier.
          const d = off <= 0.11 ? off : 0.1 + this.rng() * 0.095;
          const q = classifyCatch(d, len(velocityAt(traj, ca.t)));
          if (q) return { kind: 'catch', tid: ball.tid, tSec: Math.max(0.26, ca.t), q, g: catchGrade(d) };
        }
        return null;
      }
      const now = positionAt(traj, Math.max(0, tSec));
      face(now, 0.3);
      if (t >= this.reactAt && this.runTo) moveTo(this.runTo, RUN_SPEED * 0.92);
      else moveTo([pose.x, 0, pose.z], RUN_SPEED);
      const plan = interceptPlan(traj, Math.max(0, tSec - 0.05), pose.x, pose.z);
      const want = clampReach([plan.point[0] - pose.x, plan.point[1], plan.point[2] - pose.z]);
      const rate = plan.t - tSec < 0.6 ? 0.45 : 0.12;
      pose.g = [lerp(pose.g[0], want[0], rate), lerp(pose.g[1], want[1], rate), lerp(pose.g[2], want[2], rate)];
      if (!this.decided && plan.t <= tSec + 0.02 && tSec > 0.25) {
        this.decided = true;
        const q = this.outcome(plan.norm, Math.hypot(this.vx, this.vz));
        if (q) {
          // Running catches are never pretty.
          const g = q === 'pocket' ? 0.5 + this.rng() * 0.12 : q === 'web' ? 0.3 + this.rng() * 0.15 : 0.08;
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
    if (norm <= 0.62) return r < 0.985 - hustle * 0.2 ? (norm < 0.4 ? 'pocket' : 'web') : null;
    if (norm <= 0.86) return r < 0.9 - hustle ? (r < 0.5 ? 'web' : 'pocket') : r < 0.95 ? 'bobble' : null;
    if (norm <= 1.0) return r < 0.55 - hustle ? 'bobble' : r < 0.7 ? 'web' : null;
    if (norm <= 1.12) return r < 0.18 ? 'bobble' : null;
    return null;
  }

  /** Coach aims at your glove, like a friend would. Good, not perfect. */
  private aimAt(coach: Member, human: Member, streak: number): { p: Vec3; v: Vec3 } {
    this.throws++;
    const from: Vec3 = [coach.pose.x, 0, coach.pose.z];
    const glove: Vec3 = [human.pose.x + human.pose.g[0], human.pose.g[1], human.pose.z + human.pose.g[2]];
    const yaw = lookAngles(from, glove).yaw;
    const p = releasePointFor(coach.windup, from, yaw, coach.hand);
    // Sideways relative to the line between them.
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const warm = this.throws <= 3;
    const r = this.rng();
    // A long throw is harder to put on the glove: Coach's misses grow with the distance (gently).
    const far = Math.min(2.2, Math.sqrt(Math.max(1, dist(from, glove) / 14)));
    let ox: number, oy: number;
    let high = 0;
    if (warm || r < 0.64) {
      // On target, give or take a hand's width.
      const sd = warm ? 0.03 : Math.min(0.1, 0.045 + streak * 0.002);
      ox = this.gauss() * sd * far; oy = this.gauss() * sd * far;
    } else if (r < 0.84) {
      // A bit off: you'll have to adjust the glove.
      const a = this.rng() * Math.PI * 2, m = (0.22 + this.rng() * 0.3) * far;
      ox = Math.cos(a) * m; oy = Math.sin(a) * m * 0.7;
    } else if (r < 0.92) {
      // Wide: go get it.
      ox = (this.rng() < 0.5 ? -1 : 1) * (1.0 + this.rng() * Math.min(1.3, 0.5 + streak * 0.05)) * Math.min(1.5, far); oy = -0.2 + this.rng() * 0.4;
    } else if (r < 0.96) {
      // Sailed: over your head. Get up for it.
      ox = this.gauss() * 0.15; oy = 0; high = 2.25 + this.rng() * 0.4;
    } else {
      // In the dirt: a scoop.
      ox = this.gauss() * 0.2; oy = 0; high = 0.24 + this.rng() * 0.14;
    }
    const target: Vec3 = [glove[0] + rx * ox, high || Math.max(0.25, glove[1] + oy), glove[2] + rz * ox];
    // Thrown as hard as the distance takes; a little flatter and quicker once you're warm.
    const d = dist(p, target);
    const zip = warm ? 1.3 : 1.35 - this.rng() * Math.min(0.3, 0.1 + streak * 0.01);
    return { p, v: solveArc(p, target, throwElevation(d) * zip).v0 };
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
