// Wire protocol. JSON over WebSocket; messages are small and infrequent except
// for pose streams (20 Hz), which are packed into arrays.

import {
  BOBBLE_DEFLECT_SPEED,
  CATCH_BOBBLE,
  CATCH_PERFECT,
  CATCH_POCKET,
  CATCH_WEB,
  MITT_MIN,
  MITT_SHRINK,
  MITT_START,
} from './constants.js';
import type { Hand } from './pose.js';
import type { Style } from './style.js';
import type { Vec3 } from './vec.js';

export type CatchQuality = 'perfect' | 'pocket' | 'web' | 'bobble';

/**
 * How a room plays. Chosen by whoever opens the room; everyone who joins plays it.
 *   long:  every catch is a step further apart.
 *   fixed: you stay where you started, across the road.
 *   mitt:  giant gloves that shrink with every catch.
 */
export type Mode = 'long' | 'fixed' | 'mitt';
export const MODES: Mode[] = ['long', 'fixed', 'mitt'];
export const toMode = (x: unknown, fallback: Mode = 'long'): Mode => (MODES.includes(x as Mode) ? (x as Mode) : fallback);

/** How big the glove is after `steps` catches (1 = a regular glove). Only Big mitt changes it. */
export function gloveSize(mode: Mode, steps: number): number {
  if (mode !== 'mitt') return 1;
  return Math.round(Math.max(MITT_MIN, MITT_START * Math.pow(MITT_SHRINK, steps)) * 1000) / 1000;
}

/**
 * How a catch was made, beyond how cleanly: what the receiver had to do to get
 * there. `null` is a routine catch. A bad throw is a chance at one of these.
 */
export type CatchStyle = 'dive' | 'leap' | 'run' | 'high' | 'scoop' | 'backhand' | 'reach' | null;

/** The ones worth a cheer (and a tally). */
export function isGreatCatch(s: CatchStyle | undefined): boolean {
  return s === 'dive' || s === 'leap' || s === 'run';
}

/**
 * Name a catch from where the glove was. `g` is the glove in body space
 * (right, up, forward) with any leap taken out; `speed` is how fast the feet
 * were moving. Client and server run the same code.
 */
export function catchStyle(g: Vec3, hand: Hand, lift: number, dive: number, speed: number): CatchStyle {
  if (Math.abs(dive) > 0.3) return 'dive';
  if (lift > 0.1) return 'leap';
  if (speed > 2.4) return 'run';
  if (g[1] > 1.95) return 'high';
  if (g[1] < 0.52) return 'scoop';
  const across = g[0] * (hand === 'R' ? 1 : -1);
  if (across > 0.3) return 'backhand';
  if (Math.hypot(g[0], g[2]) > 0.82) return 'reach';
  return null;
}

/**
 * Classify a glove/ball encounter. `null` = clean miss, 'deflect' = off the
 * glove and out. `glove` is the glove's size (the zones grow and shrink with it).
 */
export function classifyCatch(distance: number, relSpeed: number, glove = 1): CatchQuality | 'deflect' | null {
  distance /= glove;
  if (distance <= CATCH_PERFECT) return 'perfect';
  if (distance <= CATCH_POCKET) return 'pocket';
  if (distance <= CATCH_WEB) return 'web';
  if (distance <= CATCH_BOBBLE) return relSpeed >= BOBBLE_DEFLECT_SPEED ? 'deflect' : 'bobble';
  return null;
}

/**
 * How well a ball was caught, 0..1 (1 = dead centre of the pocket). This is
 * the grade the POP plays: everyone hears the same number.
 */
export function catchGrade(distance: number, glove = 1): number {
  const g = 1 - distance / glove / CATCH_BOBBLE;
  return Math.round(Math.max(0, Math.min(1, g)) * 100) / 100;
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
  /** Catches graded perfect. */
  perfects: number;
  /** Dives, leaps and running grabs: bad throws rescued. */
  saves: number;
  /** Which windup they throw with (a number from the library). */
  windup: number;
  /** What they look like and wear (cosmetic only). */
  style: Style;
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
  /** How far across the ring is right now (m): for two players, how far apart you are. */
  dist: number;
  /** Misses so far (in total). The third and the distance, or the glove, starts again. */
  misses: number;
  mode: Mode;
  /** The size of everyone's glove (1 = regular; Big mitt starts at 3 and shrinks). */
  glove: number;
}

export type BallEvent =
  | { k: 'throw'; by: string; speed: number }
  | { k: 'catch'; by: string; q: CatchQuality; g: number; speed: number; at: number; pos: Vec3; self: boolean; milestone?: number; st?: CatchStyle }
  | { k: 'deflect'; by: string; speed: number; at: number; pos: Vec3 }
  | { k: 'drop'; by: string | null; void: boolean; at: number }
  | { k: 'recover'; by: string; from: Vec3 };

// ---- client -> server ------------------------------------------------------

export type ClientMsg =
  | { t: 'hello'; room: string; guest: string; name: string; hand: Hand; v: number; w?: number; s?: number[]; m?: Mode }
  | { t: 'ping'; c: number }
  /** x, z, yaw, gx, gy, gz, arm, windup phase, lift, dive, pull (how big the windup is) — rounded. */
  | { t: 'st'; p: PoseWire }
  /** "Here it comes": the holder has let go of the aim and the delivery has started (the throw follows RELEASE_TIME later). */
  | { t: 'go' }
  | { t: 'throw'; rt: number; p: Vec3; v: Vec3; tid: number }
  /** Pose (x, z, yaw, gx, gy, gz, lift, dive) at the moment of contact. */
  | { t: 'catch'; tid: number; at: number; pose: number[] }
  | { t: 'prof'; name: string; hand: Hand; w?: number; s?: number[] }
  | { t: 'rec'; key: string; best: number }
  | { t: 'leave' };

// ---- server -> client ------------------------------------------------------

export type ServerMsg =
  | { t: 'welcome'; you: string; room: string; now: number; players: PlayerInfo[]; ball: BallState; score: ScoreState; poses: SnapEntry[] }
  | { t: 'full'; room: string; max: number }
  | { t: 'error'; msg: string }
  | { t: 'pong'; c: number; s: number }
  | { t: 'roster'; players: PlayerInfo[]; score: ScoreState }
  /** A player has started their delivery (server time `at`): everyone starts the same animation, in step. */
  | { t: 'go'; by: string; at: number }
  /** Pose snapshot: server time + entries. */
  | { t: 'snap'; s: number; e: SnapEntry[] }
  | { t: 'ball'; ball: BallState; score: ScoreState; ev?: BallEvent; players?: PlayerInfo[] };

/**
 * [x, z, yaw, gx, gy, gz, arm, charge, lift, dive]
 * `charge` is how far through the windup the thrower is (0..1); `lift` is a
 * leap's height off the grass (m); `dive` is -1..1 toward the body's left/right.
 */
export type PoseWire = [number, number, number, number, number, number, number, number, number, number, number];

/** [id, x, z, yaw, gx, gy, gz, arm, charge, lift, dive, pull] */
export type SnapEntry = [string, number, number, number, number, number, number, number, number, number, number, number];

/**
 * 6: rooms have a mode (long toss, fixed distance, big mitt).
 * 5: players carry a style (body, hat, glove, top) instead of a palette number.
 * 4: long-distance catch (the room carries its distance; throws are as hard as the distance takes).
 * 2: third-person bodies that move (pose carries position + glove point).
 * 3: signature windups (players carry a windup; the ball leaves the hand a
 *    beat after the arm starts forward) and leaps/dives in the pose.
 * 7: a pose carries the pull (how far back the thumb is: how big the windup is); throws are flatter.
 */
export const PROTOCOL_VERSION = 7;

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
