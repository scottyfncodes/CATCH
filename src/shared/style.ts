// What a player looks like: a body you choose, and hats, gloves and tops you
// can wear. Some are yours from the start; the rest are earned, one at each
// streak milestone, and kept.
//
// Everything here is cosmetic. Nothing in this file changes how anyone throws,
// reaches or catches: the glove is the same size whatever colour it is.
//
// Shared by the client (drawing, the editor, unlocks) and the server (which
// only checks that a style is well-formed before telling everyone else).

/** [skin, build, hair, hair colour, hat, glove, top, pants]: indices into the tables below. */
export type Style = [number, number, number, number, number, number, number, number];
export const S = { skin: 0, build: 1, hair: 2, hairColor: 3, hat: 4, glove: 5, top: 6, pants: 7 } as const;

export const SKINS = ['#f7dcc0', '#ecc19a', '#d7a273', '#b9814f', '#8f5f39', '#5f3d26'];
export const BUILDS = [{ name: 'Slim', w: 0.9 }, { name: 'Medium', w: 1 }, { name: 'Broad', w: 1.13 }];
export const HAIRS = ['None', 'Short', 'Curls', 'Long', 'Ponytail', 'Bun'];
export const HAIR_COLORS = ['#1b1512', '#4b2f1c', '#8b5a2b', '#dbb56c', '#b4472d', '#cfcbc4'];
export const PANTS = ['#93b1cf', '#c2b59b', '#4a4e57', '#2f3542', '#5b6b7a', '#7a5a43'];

/**
 * The streaks that are celebrated, and that each give a one-time reward. The
 * room's streak is shared, so everyone who is in the room when it gets there
 * earns it.
 */
export const MILESTONES = [10, 25, 50, 100, 250, 500, 750, 1000, 1500, 2000, 3000, 5000];

export type Kind = 'hat' | 'glove' | 'top';

interface Item {
  name: string;
  /** The streak that earns it (0 = yours from the start). */
  at: number;
}
export interface Hat extends Item { shape: 'none' | 'cap' | 'back' | 'visor' | 'bucket' | 'beanie' | 'straw'; color: string; accent?: string }
export interface Glove extends Item { leather: string; dark: string; pocket: string; lace: string }
export interface Top extends Item { color: string; pattern: 'plain' | 'stripes' | 'raglan' | 'block'; accent?: string }

export const HATS: Hat[] = [
  { name: 'Navy cap', at: 0, shape: 'cap', color: '#2d2f63' },
  { name: 'Green cap', at: 0, shape: 'cap', color: '#2f4f3a' },
  { name: 'Red cap', at: 0, shape: 'cap', color: '#8e2f2a' },
  { name: 'Backwards', at: 0, shape: 'back', color: '#3a3a3a' },
  { name: 'No hat', at: 0, shape: 'none', color: '#000000' },
  { name: 'Bucket hat', at: 25, shape: 'bucket', color: '#d8c79a' },
  { name: 'Beanie', at: 250, shape: 'beanie', color: '#b5532f', accent: '#e9dcc0' },
  { name: 'Straw hat', at: 1000, shape: 'straw', color: '#e2c27a', accent: '#5a3417' },
  { name: 'Gold cap', at: 3000, shape: 'cap', color: '#d9a92b', accent: '#fff0c2' },
];

export const GLOVES: Glove[] = [
  { name: 'Tan', at: 0, leather: '#b97a40', dark: '#8d5629', pocket: '#7a4720', lace: '#5a3417' },
  { name: 'Chestnut', at: 0, leather: '#7d4a26', dark: '#5f3519', pocket: '#4b2912', lace: '#2f1a0c' },
  { name: 'Black', at: 10, leather: '#2b2927', dark: '#1c1a19', pocket: '#141312', lace: '#8d5629' },
  { name: 'Red and cream', at: 100, leather: '#a8322a', dark: '#e9dcc0', pocket: '#7a231d', lace: '#e9dcc0' },
  { name: 'Blue', at: 750, leather: '#2f5f9a', dark: '#1f3f6b', pocket: '#172f52', lace: '#d9c9a0' },
  { name: 'Gold', at: 2000, leather: '#d9a92b', dark: '#a87c16', pocket: '#7d5b10', lace: '#fff0c2' },
];

export const TOPS: Top[] = [
  { name: 'Olive tee', at: 0, color: '#857f5a', pattern: 'plain' },
  { name: 'Blue tee', at: 0, color: '#3f7cac', pattern: 'plain' },
  { name: 'Yellow tee', at: 0, color: '#e3b448', pattern: 'plain' },
  { name: 'Green tee', at: 0, color: '#5f8d4e', pattern: 'plain' },
  { name: 'Cream tee', at: 0, color: '#efe6d2', pattern: 'plain' },
  { name: 'Grey tee', at: 0, color: '#8d99ae', pattern: 'plain' },
  { name: 'Striped tee', at: 50, color: '#efe6d2', pattern: 'stripes', accent: '#b23a48' },
  { name: 'Raglan', at: 500, color: '#efe6d2', pattern: 'raglan', accent: '#2f4f3a' },
  { name: 'Two-tone', at: 1500, color: '#e07a3f', pattern: 'block', accent: '#2f3542' },
  { name: 'Gold jacket', at: 5000, color: '#d9a92b', pattern: 'raglan', accent: '#2b2927' },
];

const TABLE = { hat: HATS, glove: GLOVES, top: TOPS } as const;
const LIMITS = [SKINS.length, BUILDS.length, HAIRS.length, HAIR_COLORS.length, HATS.length, GLOVES.length, TOPS.length, PANTS.length];

/** The reward a milestone gives (every milestone gives exactly one). */
export function rewardAt(milestone: number): { kind: Kind; index: number; name: string } | null {
  for (const kind of ['hat', 'glove', 'top'] as const) {
    const index = TABLE[kind].findIndex((x) => x.at === milestone);
    if (index >= 0) return { kind, index, name: TABLE[kind][index].name };
  }
  return null;
}

/** The next milestone after a streak, if there is one. */
export function nextMilestone(streak: number): number | null {
  return MILESTONES.find((m) => m > streak) ?? null;
}

/** Whether an item can be worn by someone who has earned these milestones. */
export function owns(kind: Kind, index: number, earned: number[]): boolean {
  const it = TABLE[kind][index];
  return !!it && (it.at === 0 || earned.includes(it.at));
}

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

/** A starting look for someone who hasn't chosen one: different for different people, always from the free items. */
export function defaultStyle(seed: string): Style {
  const h = hash(seed || 'catch');
  const pick = (n: number, shift: number) => ((h >>> shift) % n + n) % n;
  return [pick(SKINS.length, 0), 1, 1 + pick(HAIRS.length - 1, 3), pick(HAIR_COLORS.length, 7), pick(3, 11), 0, pick(6, 14), pick(PANTS.length, 18)];
}

/** A well-formed style from anything (the wire, storage): out-of-range parts fall back to `base`. */
export function sanitizeStyle(x: unknown, base: Style): Style {
  if (!Array.isArray(x)) return [...base] as Style;
  return LIMITS.map((n, i) => {
    const v = x[i];
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < n ? v : base[i];
  }) as Style;
}

/** Take off anything not earned (used on the device that knows what has been earned). */
export function wearable(style: Style, earned: number[]): Style {
  const out = [...style] as Style;
  if (!owns('hat', out[S.hat], earned)) out[S.hat] = 0;
  if (!owns('glove', out[S.glove], earned)) out[S.glove] = 0;
  if (!owns('top', out[S.top], earned)) out[S.top] = 0;
  return out;
}

/** Coach: grey hair, a plain cap, the classic glove. */
export const COACH_STYLE: Style = [2, 1, 1, 5, 1, 0, 1, 1];

export const sameStyle = (a: Style, b: Style) => a.every((v, i) => v === b[i]);
