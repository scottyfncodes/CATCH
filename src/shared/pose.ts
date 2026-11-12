// Player geometry shared by client rendering and server validation.
//
// Third person: a player is a body standing at (x, z), facing `yaw`, with the
// glove somewhere inside the reach envelope around them. What the server
// validates is exactly what everyone sees: the ball has to pass through that
// glove.

import {
  EYE_HEIGHT,
  GLOVE_READY,
  REACH_CENTER_Y,
  REACH_H,
  REACH_V,
  SIM_DT,
} from './constants.js';
import { type Trajectory, positionAt } from './physics.js';
import { type Vec3 } from './vec.js';

export type Hand = 'R' | 'L';

/** Pose a player streams to the room. */
export interface Pose {
  /** Feet position on the grass. */
  x: number;
  z: number;
  /** Body facing (radians, 0 = facing -Z). */
  yaw: number;
  /** Glove pocket relative to the feet, world axes (metres). */
  g: Vec3;
}

export interface Basis { f: Vec3; r: Vec3; u: Vec3 }

/** View basis for yaw/pitch: forward, right, up (Three.js YXZ convention). */
export function viewBasis(yaw: number, pitch: number): Basis {
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const f: Vec3 = [-sy * cp, sp, -cy * cp];
  const r: Vec3 = [cy, 0, -sy];
  // u = r × f
  const u: Vec3 = [
    r[1] * f[2] - r[2] * f[1],
    r[2] * f[0] - r[0] * f[2],
    r[0] * f[1] - r[1] * f[0],
  ];
  return { f, r, u };
}

export function eyePosition(seat: Vec3): Vec3 {
  return [seat[0], EYE_HEIGHT, seat[2]];
}

/** Body-local offset (right, up, forward) → world-axes offset. */
export function bodyToWorld(yaw: number, l: Vec3): Vec3 {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  return [cy * l[0] - sy * l[2], l[1], -sy * l[0] - cy * l[2]];
}

/** World-axes offset → body-local (right, up, forward). */
export function worldToBody(yaw: number, w: Vec3): Vec3 {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  return [cy * w[0] - sy * w[2], w[1], -sy * w[0] - cy * w[2]];
}

/** Glove ready position for a body facing `yaw`, slightly to the glove side. */
export function gloveReady(yaw: number, hand: Hand): Vec3 {
  const side = hand === 'R' ? -1 : 1;
  return bodyToWorld(yaw, [GLOVE_READY[0] + side * 0.2, GLOVE_READY[1], GLOVE_READY[2]]);
}

/** How far into the reach envelope an offset (from the feet) is: ≤1 is reachable. */
export function reachNorm(g: Vec3): number {
  const h = (g[0] * g[0] + g[2] * g[2]) / (REACH_H * REACH_H);
  const v = (g[1] - REACH_CENTER_Y) / REACH_V;
  return Math.sqrt(h + v * v);
}

/** Pull an offset back inside the envelope (to `limit` of its size). */
export function clampReach(g: Vec3, limit = 1): Vec3 {
  const n = reachNorm(g);
  if (n <= limit) return [g[0], g[1], g[2]];
  const k = limit / n;
  return [g[0] * k, REACH_CENTER_Y + (g[1] - REACH_CENTER_Y) * k, g[2] * k];
}

/** World-space glove pocket centre. */
export function gloveWorld(pose: Pose): Vec3 {
  return [pose.x + pose.g[0], pose.g[1], pose.z + pose.g[2]];
}

/**
 * Where a body at (x, z) has its best chance at an incoming ball: the moment
 * (after `tFrom`) the airborne ball is deepest inside the reach envelope.
 */
export function interceptPlan(tr: Trajectory, tFrom: number, x: number, z: number): { t: number; point: Vec3; norm: number } {
  const end = Math.min(tr.count - 1, Math.floor(tr.groundT / SIM_DT));
  const s = tr.samples;
  let best = Infinity, bi = Math.max(0, Math.floor(tFrom / SIM_DT));
  for (let i = bi; i <= end; i += 2) {
    const g: Vec3 = [s[i * 3] - x, s[i * 3 + 1], s[i * 3 + 2] - z];
    const n = reachNorm(g);
    if (n < best) { best = n; bi = i; }
  }
  const t = bi * SIM_DT;
  return { t, point: positionAt(tr, t), norm: best };
}

/** Where the ball leaves the throwing hand (world space). */
export function releasePoint(seat: Vec3, yaw: number, hand: Hand): Vec3 {
  const e = eyePosition(seat);
  const { f, r } = viewBasis(yaw, 0);
  const side = hand === 'R' ? 1 : -1;
  return [
    e[0] + r[0] * 0.3 * side + f[0] * 0.38,
    e[1] + 0.12,
    e[2] + r[2] * 0.3 * side + f[2] * 0.38,
  ];
}

/** Ring radius used for a given number of players. */
export function ringRadius(n: number): number {
  return n <= 2 ? 7 : n === 3 ? 7.6 : n === 4 ? 8.1 : 8.6;
}

/** Positions for n players around a loose circle, each facing the centre. */
export function seatLayout(n: number): { pos: Vec3; yaw: number }[] {
  const r = ringRadius(n);
  const out: { pos: Vec3; yaw: number }[] = [];
  for (let i = 0; i < n; i++) {
    // Slight irregularity so it reads as friends standing around, not a clock face.
    const jitter = n > 2 ? Math.sin(i * 2.39 + n) * 0.12 : 0;
    const a = (i / n) * Math.PI * 2 + jitter;
    const rr = r + (n > 2 ? Math.cos(i * 1.7 + n) * 0.35 : 0);
    const pos: Vec3 = [Math.sin(a) * rr, 0, Math.cos(a) * rr];
    out.push({ pos, yaw: Math.atan2(pos[0], pos[2]) });
  }
  return out;
}

/** Yaw/pitch that looks from `from` at `to`. */
export function lookAngles(from: Vec3, to: Vec3): { yaw: number; pitch: number } {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const h = Math.sqrt(dx * dx + dz * dz);
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, h) };
}
