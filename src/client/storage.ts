// Local, account-free persistence: guest identity, preferences, records.
// Clearing site data or switching devices creates a new guest identity.

import type { Hand } from '../shared/pose';

export interface Prefs {
  guest: string;
  name: string;
  hand: Hand;
  /** Whether the player has completed the profile step. */
  profiled: boolean;
  tutorialDone: boolean;
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
  cache = {
    guest: typeof s.guest === 'string' && s.guest ? s.guest : uuid(),
    name: typeof s.name === 'string' ? s.name : '',
    hand: s.hand === 'L' ? 'L' : 'R',
    profiled: !!s.profiled,
    tutorialDone: !!s.tutorialDone,
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
