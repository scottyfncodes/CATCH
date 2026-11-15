// The daily setup: one challenge a day, the same for everyone who plays that
// day. It is picked from the date, so no server has to hand it out: any phone
// (and the server, to keep the day's best) works out the same one.

import type { Traits } from './protocol.js';

export type DailyMetric = 'streak' | 'heat';

export interface Daily {
  /** The day, as YYYY-MM-DD. */
  day: string;
  traits: Traits;
  /** What counts: catches in a row, or perfect catches in a row (heat). */
  metric: DailyMetric;
  /** Reach this to clear the day. */
  target: number;
}

const T = (t: Partial<Traits>): Traits => ({ back: false, speed: false, wild: false, mitt: false, ...t });

/** The setups the days go round (a mix of the traits, and a target that suits it). */
const SETUPS: { traits: Traits; metric: DailyMetric; target: number }[] = [
  { traits: T({ speed: true, wild: true }), metric: 'streak', target: 20 },
  { traits: T({ back: true }), metric: 'streak', target: 30 },
  { traits: T({ mitt: true, speed: true }), metric: 'heat', target: 4 },
  { traits: T({ wild: true }), metric: 'streak', target: 15 },
  { traits: T({ back: true, speed: true }), metric: 'streak', target: 20 },
  { traits: T({}), metric: 'heat', target: 5 },
  { traits: T({ back: true, wild: true, mitt: true }), metric: 'streak', target: 25 },
  { traits: T({ speed: true }), metric: 'heat', target: 3 },
];

/** A day as YYYY-MM-DD, in the player's own time zone (a day starts at their midnight). */
export function dayKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const isDayKey = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

/** The setup for a day. The same day always gives the same setup; neighbouring days never repeat one. */
export function dailyFor(day: string): Daily {
  const n = Math.floor(Date.parse(day + 'T00:00:00Z') / 86_400_000);
  // Walk the list by a step that is coprime to its length: every setup comes round, never twice running.
  const s = SETUPS[(((n * 3) % SETUPS.length) + SETUPS.length) % SETUPS.length];
  return { day, traits: { ...s.traits }, metric: s.metric, target: s.target };
}
