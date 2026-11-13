// Deterministic baseball flight. Server and every client run exactly this code
// from the same (p0, v0, t0), so they all see the same ball.

import {
  BALL_DRAG,
  BALL_RADIUS,
  GRAVITY,
  GROUND_FRICTION_BOUNCE,
  GROUND_RESTITUTION,
  MAX_SIM_TIME,
  REST_SPEED,
  ROLL_DECEL,
  SIM_DT,
} from './constants.js';
import type { Vec3 } from './vec.js';

export interface Impact {
  /** Seconds after release. */
  t: number;
  /** Impact speed (m/s). */
  speed: number;
  pos: Vec3;
}

export interface Trajectory {
  p0: Vec3;
  v0: Vec3;
  /** Positions at k * SIM_DT, interleaved xyz. */
  samples: Float64Array;
  count: number;
  /** First ground contact, seconds after release (Infinity if it never lands). */
  groundT: number;
  /** Time the ball comes to rest. */
  restT: number;
  restPos: Vec3;
  impacts: Impact[];
}

export function simulateFlight(p0: Vec3, v0: Vec3): Trajectory {
  const maxSteps = Math.ceil(MAX_SIM_TIME / SIM_DT) + 1;
  const buf = new Float64Array(maxSteps * 3);
  let x = p0[0], y = p0[1], z = p0[2];
  let vx = v0[0], vy = v0[1], vz = v0[2];
  let rolling = false;
  let groundT = Infinity;
  let restT = MAX_SIM_TIME;
  const impacts: Impact[] = [];
  buf[0] = x; buf[1] = y; buf[2] = z;
  let i = 1;
  for (; i < maxSteps; i++) {
    const dt = SIM_DT;
    if (!rolling) {
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const k = BALL_DRAG * sp;
      // Semi-implicit Euler: velocity first, then position.
      vx += -k * vx * dt;
      vy += (-GRAVITY - k * vy) * dt;
      vz += -k * vz * dt;
      const py = y;
      x += vx * dt; y += vy * dt; z += vz * dt;
      if (y <= BALL_RADIUS) {
        const frac = py - y > 1e-9 ? (py - BALL_RADIUS) / (py - y) : 1;
        const tHit = (i - 1 + Math.min(1, Math.max(0, frac))) * dt;
        const impactSpeed = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (groundT === Infinity) groundT = tHit;
        impacts.push({ t: tHit, speed: impactSpeed, pos: [x, BALL_RADIUS, z] });
        y = BALL_RADIUS;
        vy = -vy * GROUND_RESTITUTION;
        vx *= GROUND_FRICTION_BOUNCE;
        vz *= GROUND_FRICTION_BOUNCE;
        if (vy < 0.7) { vy = 0; rolling = true; }
      }
    } else {
      const hs = Math.sqrt(vx * vx + vz * vz);
      if (hs <= REST_SPEED) {
        buf[i * 3] = x; buf[i * 3 + 1] = y; buf[i * 3 + 2] = z;
        restT = i * dt;
        i++;
        break;
      }
      const ns = Math.max(0, hs - ROLL_DECEL * dt);
      vx *= ns / hs; vz *= ns / hs;
      x += vx * dt; z += vz * dt;
    }
    buf[i * 3] = x; buf[i * 3 + 1] = y; buf[i * 3 + 2] = z;
  }
  const count = Math.min(i, maxSteps);
  if (restT === MAX_SIM_TIME) restT = (count - 1) * SIM_DT;
  const li = (count - 1) * 3;
  return {
    p0: [p0[0], p0[1], p0[2]],
    v0: [v0[0], v0[1], v0[2]],
    samples: buf,
    count,
    groundT,
    restT,
    restPos: [buf[li], buf[li + 1], buf[li + 2]],
    impacts,
  };
}

/** Ball position `t` seconds after release (clamped to the trajectory). */
export function positionAt(tr: Trajectory, t: number, out: Vec3 = [0, 0, 0]): Vec3 {
  if (t <= 0) { out[0] = tr.p0[0]; out[1] = tr.p0[1]; out[2] = tr.p0[2]; return out; }
  const f = t / SIM_DT;
  const i = Math.floor(f);
  if (i >= tr.count - 1) {
    out[0] = tr.restPos[0]; out[1] = tr.restPos[1]; out[2] = tr.restPos[2];
    return out;
  }
  const a = f - i;
  const s = tr.samples;
  const j = i * 3;
  out[0] = s[j] + (s[j + 3] - s[j]) * a;
  out[1] = s[j + 1] + (s[j + 4] - s[j + 1]) * a;
  out[2] = s[j + 2] + (s[j + 5] - s[j + 2]) * a;
  return out;
}

export function velocityAt(tr: Trajectory, t: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const i = Math.max(0, Math.min(tr.count - 2, Math.floor(t / SIM_DT)));
  const s = tr.samples;
  const j = i * 3;
  out[0] = (s[j + 3] - s[j]) / SIM_DT;
  out[1] = (s[j + 4] - s[j + 1]) / SIM_DT;
  out[2] = (s[j + 5] - s[j + 2]) / SIM_DT;
  return out;
}

/**
 * Closest approach of the airborne part of the flight to point `q`.
 * Returns the time (seconds after release) and the distance.
 */
export function closestApproach(tr: Trajectory, q: Vec3, tMax = tr.groundT): { t: number; dist: number } {
  const end = Math.min(tr.count - 1, Math.floor(Math.min(tMax, MAX_SIM_TIME) / SIM_DT));
  const s = tr.samples;
  let best = Infinity;
  let bestI = 0;
  for (let i = 0; i <= end; i++) {
    const dx = s[i * 3] - q[0], dy = s[i * 3 + 1] - q[1], dz = s[i * 3 + 2] - q[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) { best = d; bestI = i; }
  }
  return { t: bestI * SIM_DT, dist: Math.sqrt(best) };
}

/**
 * Minimum distance between the ball and a (possibly moving) point over the
 * time interval [ta, tb], with the point linearly interpolated from qa to qb.
 * This is the swept test used for catching, identical on client and server.
 */
export function sweptMinDistance(
  tr: Trajectory, ta: number, tb: number, qa: Vec3, qb: Vec3,
): { t: number; dist: number } {
  const span = Math.max(0, tb - ta);
  const steps = Math.max(1, Math.ceil(span / (SIM_DT * 0.5)));
  const p: Vec3 = [0, 0, 0];
  let best = Infinity;
  let bestT = ta;
  for (let k = 0; k <= steps; k++) {
    const a = k / steps;
    const t = ta + span * a;
    positionAt(tr, t, p);
    const qx = qa[0] + (qb[0] - qa[0]) * a;
    const qy = qa[1] + (qb[1] - qa[1]) * a;
    const qz = qa[2] + (qb[2] - qa[2]) * a;
    const dx = p[0] - qx, dy = p[1] - qy, dz = p[2] - qz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) { best = d; bestT = t; }
  }
  return { t: bestT, dist: Math.sqrt(best) };
}

// ---------------------------------------------------------------------------
// Throw solving (used by the aim assist for elevation and by the practice bot).

/** Simulate a 2D (horizontal distance, height) flight with drag. Returns height when reaching `dist`, or null if it lands first. */
function heightAtDistance(speed: number, elev: number, dist: number, h0: number): number | null {
  let x = 0, y = h0;
  let vx = speed * Math.cos(elev), vy = speed * Math.sin(elev);
  for (let i = 0; i < MAX_SIM_TIME / SIM_DT; i++) {
    const sp = Math.sqrt(vx * vx + vy * vy);
    const k = BALL_DRAG * sp;
    vx += -k * vx * SIM_DT;
    vy += (-GRAVITY - k * vy) * SIM_DT;
    const px = x, py = y;
    x += vx * SIM_DT; y += vy * SIM_DT;
    if (x >= dist) {
      const a = (dist - px) / (x - px);
      return py + (y - py) * a;
    }
    if (y < BALL_RADIUS) return null;
  }
  return null;
}

/**
 * Launch elevation (radians) that carries a ball thrown at `speed` from height
 * `h0` to height `h1` at horizontal distance `dist`, with drag. Picks the
 * flatter solution. Returns null when the throw cannot get there.
 */
export function solveElevation(speed: number, dist: number, h0: number, h1: number): number | null {
  if (dist < 0.5) return Math.atan2(h1 - h0, Math.max(dist, 0.01));
  // Search the low-angle branch: height-at-distance increases with angle up to ~40°.
  let lo = -0.6, hi = 0.7;
  const hHi = heightAtDistance(speed, hi, dist, h0);
  if (hHi === null || hHi < h1) return null;
  for (let it = 0; it < 26; it++) {
    const mid = (lo + hi) / 2;
    const h = heightAtDistance(speed, mid, dist, h0);
    if (h === null || h < h1) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Fly a 2D throw (with drag) out to `dist`: its height there and how long it took, or null if it lands first. */
function arcAt(speed: number, elev: number, dist: number, h0: number): { h: number; t: number } | null {
  let x = 0, y = h0;
  let vx = speed * Math.cos(elev), vy = speed * Math.sin(elev);
  for (let i = 0; i < MAX_SIM_TIME / SIM_DT; i++) {
    const sp = Math.sqrt(vx * vx + vy * vy);
    const k = BALL_DRAG * sp;
    vx += -k * vx * SIM_DT;
    vy += (-GRAVITY - k * vy) * SIM_DT;
    const px = x, py = y;
    x += vx * SIM_DT; y += vy * SIM_DT;
    if (x >= dist) {
      const a = (dist - px) / (x - px);
      return { h: py + (y - py) * a, t: (i + a) * SIM_DT };
    }
    if (y < BALL_RADIUS) return null;
  }
  return null;
}

/**
 * How steeply a throw of `dist` metres leaves the hand (radians): a rope
 * across the road, an arc only when the distance needs one. This is what makes
 * distance cost arm: the further away your friend is, the harder the same throw is thrown.
 */
export function throwElevation(dist: number): number {
  const k = Math.max(0, Math.min(1, (dist - 14) / 100));
  return ((6.5 + 27.5 * k * k * (3 - 2 * k)) * Math.PI) / 180;
}

/**
 * The throw that leaves `p0` at elevation `elev` and passes through `target`:
 * its velocity, speed and time of flight (with drag). The speed is whatever
 * the distance takes; there is no "too far", only harder.
 */
export function solveArc(p0: Vec3, target: Vec3, elev: number): { v0: Vec3; speed: number; T: number } {
  const dx = target[0] - p0[0], dz = target[2] - p0[2];
  const d = Math.max(0.5, Math.hypot(dx, dz));
  // The arc has to be at least steep enough to get up to the target at all.
  const e = Math.max(elev, Math.atan2(target[1] - p0[1], d) + 0.06);
  let lo = 2, hi = 160;
  for (let i = 0; i < 34; i++) {
    const m = (lo + hi) / 2;
    const r = arcAt(m, e, d, p0[1]);
    if (!r || r.h < target[1]) lo = m; else hi = m;
  }
  const r = arcAt(hi, e, d, p0[1]);
  const ch = hi * Math.cos(e);
  return { v0: [(dx / d) * ch, hi * Math.sin(e), (dz / d) * ch], speed: hi, T: r ? r.t : d / ch };
}

/** Velocity that reaches `target` from `p0` in `flightTime` seconds (drag-corrected). */
export function solveThrowTo(p0: Vec3, target: Vec3, flightTime: number): Vec3 {
  const T = flightTime;
  let v: Vec3 = [
    (target[0] - p0[0]) / T,
    (target[1] - p0[1] + 0.5 * GRAVITY * T * T) / T,
    (target[2] - p0[2]) / T,
  ];
  for (let it = 0; it < 4; it++) {
    const tr = simulateFlight(p0, v);
    const p = positionAt(tr, T);
    v = [
      v[0] + (target[0] - p[0]) / T,
      v[1] + (target[1] - p[1]) / T,
      v[2] + (target[2] - p[2]) / T,
    ];
  }
  return v;
}
