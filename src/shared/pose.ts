// Player geometry shared by client rendering and server validation.

import {
  EYE_HEIGHT,
  GLOVE_REACH_FAR,
  GLOVE_REACH_NEAR,
  GLOVE_TAN_X,
  GLOVE_TAN_Y,
} from './constants.js';
import { clamp, type Vec3 } from './vec.js';

export type Hand = 'R' | 'L';

/** Pose a player streams to the room. */
export interface Pose {
  /** View yaw (radians, 0 = looking toward -Z). */
  yaw: number;
  /** View pitch (radians, + up). */
  pitch: number;
  /** Glove pose in [-1.15, 1.15]. */
  gu: number;
  gv: number;
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

export const GLOVE_LIMIT = 1.15;

/** Glove offset in view space (x right, y up, z forward) for a glove pose. */
export function gloveViewOffset(gu: number, gv: number): Vec3 {
  gu = clamp(gu, -GLOVE_LIMIT, GLOVE_LIMIT);
  gv = clamp(gv, -GLOVE_LIMIT, GLOVE_LIMIT);
  const x = gu * GLOVE_TAN_X, y = gv * GLOVE_TAN_Y;
  const l = Math.sqrt(x * x + y * y + 1);
  const reach = Math.min(1, (gu * gu + gv * gv) / 1.6);
  const r = GLOVE_REACH_NEAR + (GLOVE_REACH_FAR - GLOVE_REACH_NEAR) * reach;
  return [(x / l) * r, (y / l) * r, (1 / l) * r];
}

/** World-space glove pocket centre. */
export function gloveWorld(seat: Vec3, pose: Pose): Vec3 {
  const e = eyePosition(seat);
  const { f, r, u } = viewBasis(pose.yaw, pose.pitch);
  const o = gloveViewOffset(pose.gu, pose.gv);
  return [
    e[0] + r[0] * o[0] + u[0] * o[1] + f[0] * o[2],
    e[1] + r[1] * o[0] + u[1] * o[1] + f[1] * o[2],
    e[2] + r[2] * o[0] + u[2] * o[1] + f[2] * o[2],
  ];
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
  return n <= 2 ? 7.2 : n === 3 ? 7.6 : n === 4 ? 8.1 : 8.6;
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
