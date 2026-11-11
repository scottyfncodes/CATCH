// Wire protocol. JSON over WebSocket; messages are small and infrequent except
// for pose streams (20 Hz), which are packed into arrays.

import {
  BOBBLE_DEFLECT_SPEED,
  CATCH_BOBBLE,
  CATCH_POCKET,
  CATCH_WEB,
} from './constants.js';
import type { Hand } from './pose.js';
import type { Vec3 } from './vec.js';

export type CatchQuality = 'pocket' | 'web' | 'bobble';

/** Classify a glove/ball encounter. `null` = clean miss, 'deflect' = off the glove and out. */
export function classifyCatch(distance: number, relSpeed: number): CatchQuality | 'deflect' | null {
  if (distance <= CATCH_POCKET) return 'pocket';
  if (distance <= CATCH_WEB) return 'web';
  if (distance <= CATCH_BOBBLE) return relSpeed >= BOBBLE_DEFLECT_SPEED ? 'deflect' : 'bobble';
  return null;
}

/** Arm state streamed with the pose so other players see intent. */
export const Arm = { Idle: 0, Holding: 1, Windup: 2, Release: 3 } as const;
export type ArmState = (typeof Arm)[keyof typeof Arm];

export interface PlayerInfo {
  id: string;
  name: string;
  hand: Hand;
  /** Index into the current seat layout. */
  seat: number;
  pos: Vec3;
  /** Yaw facing the centre of the ring. */
  facing: number;
  connected: boolean;
  bot: boolean;
  catches: number;
  drops: number;
  /** Shirt/cap colour index. */
  look: number;
}

export type BallPhase = 'held' | 'flight' | 'loose';

export interface BallState {
  phase: BallPhase;
  /** Holder while 'held'. */
  holder: string | null;
  /** Monotonic throw id (also used for the dead ball after a deflection). */
  tid: number;
  thrower: string | null;
  /** Server time (ms) of release for 'flight'/'loose'. */
  t0: number;
  p0: Vec3;
  v0: Vec3;
  /** False once the throw is resolved (dropped/deflected); the ball still moves but cannot be caught. */
  live: boolean;
}

export interface ScoreState {
  streak: number;
  /** Best streak this room has ever reached (session). */
  sessionBest: number;
  /** Best streak for this exact group of people (persisted). */
  groupBest: number;
  groupKey: string;
}

export type BallEvent =
  | { k: 'throw'; by: string; speed: number }
  | { k: 'catch'; by: string; q: CatchQuality; speed: number; at: number; pos: Vec3; self: boolean; milestone?: number }
  | { k: 'deflect'; by: string; speed: number; at: number; pos: Vec3 }
  | { k: 'drop'; by: string | null; void: boolean; at: number }
  | { k: 'recover'; by: string; from: Vec3 };

// ---- client -> server ------------------------------------------------------

export type ClientMsg =
  | { t: 'hello'; room: string; guest: string; name: string; hand: Hand; v: number }
  | { t: 'ping'; c: number }
  /** x, z, yaw, gx, gy, gz, arm, charge — rounded. */
  | { t: 'st'; p: PoseWire }
  | { t: 'throw'; rt: number; p: Vec3; v: Vec3; tid: number }
  /** Pose (x, z, yaw, gx, gy, gz) at the moment of contact. */
  | { t: 'catch'; tid: number; at: number; pose: [number, number, number, number, number, number] }
  | { t: 'prof'; name: string; hand: Hand }
  | { t: 'rec'; key: string; best: number }
  | { t: 'leave' };

// ---- server -> client ------------------------------------------------------

export type ServerMsg =
  | { t: 'welcome'; you: string; room: string; now: number; players: PlayerInfo[]; ball: BallState; score: ScoreState; poses: SnapEntry[] }
  | { t: 'full'; room: string; max: number }
  | { t: 'error'; msg: string }
  | { t: 'pong'; c: number; s: number }
  | { t: 'roster'; players: PlayerInfo[]; score: ScoreState }
  /** Pose snapshot: server time + entries. */
  | { t: 'snap'; s: number; e: SnapEntry[] }
  | { t: 'ball'; ball: BallState; score: ScoreState; ev?: BallEvent; players?: PlayerInfo[] };

/** [x, z, yaw, gx, gy, gz, arm, charge] */
export type PoseWire = [number, number, number, number, number, number, number, number];

/** [id, x, z, yaw, gx, gy, gz, arm, charge] */
export type SnapEntry = [string, number, number, number, number, number, number, number, number];

/** 2: third-person bodies that move (pose carries position + glove point). */
export const PROTOCOL_VERSION = 2;

/** Room codes: 4 letters, no ambiguous characters. */
export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
export function isRoomCode(s: string): boolean {
  return /^[A-Z]{4}$/.test(s) && [...s].every((c) => ROOM_ALPHABET.includes(c));
}
export function randomRoomCode(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += ROOM_ALPHABET[Math.floor(rand() * ROOM_ALPHABET.length)];
  return s;
}

/** Stable key for a group of people (sorted guest ids). */
export function groupKeyFor(guestIds: string[]): string {
  const s = [...guestIds].sort().join('|');
  // FNV-1a 32-bit, hex. Not secret — just compact.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${guestIds.length}-${h.toString(16).padStart(8, '0')}`;
}

export function sanitizeName(name: unknown): string {
  const s = String(name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);
  return s || 'Player';
}
