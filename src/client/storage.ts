// Local, account-free persistence: guest identity, preferences, records.
// Clearing site data or switching devices creates a new guest identity.

import type { Hand } from '../shared/pose';
import { type Style, defaultStyle, sanitizeStyle, wearable } from '../shared/style';
import { windupId } from '../shared/windups';

export interface Prefs {
  guest: string;
  name: string;
  hand: Hand;
  /** The windup you throw with (a number from the library). */
  windup: number;
  /** What you look like and wear. */
  style: Style;
  /** The streak milestones you have reached (each gave you something to wear, once). */
  earned: number[];
  /** Rewards you haven't looked at yet. */
  fresh: number[];
  /** Whether the player has completed the profile step. */
  profiled: boolean;
  tutorialDone: boolean;
  /** Which set of tips they have seen (the tips are shown again when how you play changes). */
  tipsSeen: number;
  /** Dives and leaps made: the flick is hinted at until you have the hang of it. */
  acts: number;
  volume: number;
  haptics: boolean;
  /** Best streak per group key (mirrors the server; re-seeds it after restarts). */
  records: Record<string, number>;
}

const KEY = 'catch.prefs.v1';

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'g' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function safeGet(): Partial<Prefs> {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}

let cache: Prefs | null = null;

export function prefs(): Prefs {
  if (cache) return cache;
  const s = safeGet();
  const guest = typeof s.guest === 'string' && s.guest ? s.guest : uuid();
  const earned = Array.isArray(s.earned) ? s.earned.filter((x) => typeof x === 'number') : [];
  cache = {
    guest,
    style: wearable(sanitizeStyle(s.style, defaultStyle(guest)), earned),
    earned,
    fresh: Array.isArray(s.fresh) ? s.fresh.filter((x) => typeof x === 'number') : [],
    name: typeof s.name === 'string' ? s.name : '',
    hand: s.hand === 'L' ? 'L' : 'R',
    windup: windupId(s.windup),
    profiled: !!s.profiled,
    tutorialDone: !!s.tutorialDone,
    tipsSeen: typeof s.tipsSeen === 'number' ? s.tipsSeen : 0,
    acts: typeof s.acts === 'number' ? s.acts : 0,
    volume: typeof s.volume === 'number' ? s.volume : 0.9,
    haptics: s.haptics !== false,
    records: s.records && typeof s.records === 'object' ? s.records : {},
  };
  save();
  return cache;
}

export function save(patch: Partial<Prefs> = {}) {
  cache = { ...(cache ?? prefs()), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* private mode */ }
}

export function recordFor(key: string): number { return prefs().records[key] ?? 0; }
export function raiseRecord(key: string, v: number) {
  const p = prefs();
  if ((p.records[key] ?? 0) >= v) return;
  save({ records: { ...p.records, [key]: v } });
}
