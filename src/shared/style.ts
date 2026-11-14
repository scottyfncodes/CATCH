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
  /** How it shows in the look editor, when one colour won't do (a CSS background). */
  swatch?: string;
}
// What you start with is ordinary. What you earn is not: the further the
// streak, the more ridiculous the reward. (Still only for looking at: none of
// it changes how anyone throws or catches.)
export interface Hat extends Item { shape: 'none' | 'cap' | 'back' | 'propeller' | 'duck' | 'cowboy' | 'crown'; color: string; accent?: string }
export interface Glove extends Item { leather: string; dark: string; pocket: string; lace: string; extra?: 'eyes' | 'shark' | 'disco' | 'fire' }
export interface Top extends Item { color: string; pattern: 'plain' | 'hawaiian' | 'tux' | 'closer' | 'robe'; accent?: string }

export const HATS: Hat[] = [
  { name: 'Navy cap', at: 0, shape: 'cap', color: '#26295a', accent: '#efe6d2' },
  { name: 'Green cap', at: 0, shape: 'cap', color: '#2f4f3a', accent: '#e9dcc0' },
  { name: 'Red cap', at: 0, shape: 'cap', color: '#8e2f2a', accent: '#efe6d2' },
  { name: 'Backwards', at: 0, shape: 'back', color: '#3a3a3a', accent: '#d9a92b' },
  { name: 'No hat', at: 0, shape: 'none', color: '#000000' },
  { name: 'Propeller beanie', at: 25, shape: 'propeller', color: '#d8402f', swatch: 'conic-gradient(#d8402f 0 25%, #f2c230 0 50%, #2f6fd8 0 75%, #3b9b4a 0)' },
  { name: 'Rubber duck', at: 250, shape: 'duck', color: '#ffd23a', swatch: 'radial-gradient(circle at 62% 38%, #ff8a1e 0 16%, #ffd23a 18%)' },
  { name: 'Ten-gallon hat', at: 1000, shape: 'cowboy', color: '#a8743f', accent: '#3b2618', swatch: 'radial-gradient(ellipse 60% 40% at 50% 55%, #a8743f 0 55%, #3b2618 57% 66%, #c99a64 68%)' },
  { name: 'Crown', at: 3000, shape: 'crown', color: '#e8b923', accent: '#b3122a', swatch: 'conic-gradient(#fff3b0, #e8b923, #a8770f, #e8b923, #fff3b0)' },
];

export const GLOVES: Glove[] = [
  { name: 'Tan', at: 0, leather: '#b97a40', dark: '#8d5629', pocket: '#7a4720', lace: '#5a3417' },
  { name: 'Chestnut', at: 0, leather: '#7d4a26', dark: '#5f3519', pocket: '#4b2912', lace: '#2f1a0c' },
  { name: 'Googly eyes', at: 10, leather: '#c48a4c', dark: '#97632f', pocket: '#7a4720', lace: '#5a3417', extra: 'eyes', swatch: 'radial-gradient(circle at 36% 50%, #111 0 12%, #fff 14% 30%, transparent 32%), radial-gradient(circle at 70% 46%, #111 0 10%, #fff 12% 26%, #c48a4c 28%)' },
  { name: 'Shark', at: 100, leather: '#7f8c96', dark: '#5f6b74', pocket: '#d9737a', lace: '#f4f1ea', extra: 'shark', swatch: 'linear-gradient(#7f8c96 0 55%, #f4f1ea 55% 62%, #d9737a 62%)' },
  { name: 'Disco ball', at: 750, leather: '#dfe3e8', dark: '#b9c0c8', pocket: '#cfd5dc', lace: '#ffffff', extra: 'disco', swatch: 'conic-gradient(#fff, #9aa3ad, #fff, #c9d0d8, #fff, #9aa3ad, #fff)' },
  { name: 'On fire', at: 2000, leather: '#2e231d', dark: '#1c1511', pocket: '#3a2a20', lace: '#ff8a2a', extra: 'fire', swatch: 'radial-gradient(circle at 50% 70%, #fff3b0 0 15%, #ffb02e 30%, #ff4d1f 55%, #2e231d 75%)' },
];

export const TOPS: Top[] = [
  { name: 'Olive tee', at: 0, color: '#857f5a', pattern: 'plain' },
  { name: 'Blue tee', at: 0, color: '#3f7cac', pattern: 'plain' },
  { name: 'Yellow tee', at: 0, color: '#e3b448', pattern: 'plain' },
  { name: 'Green tee', at: 0, color: '#5f8d4e', pattern: 'plain' },
  { name: 'Cream tee', at: 0, color: '#efe6d2', pattern: 'plain' },
  { name: 'Grey tee', at: 0, color: '#8d99ae', pattern: 'plain' },
  { name: 'Hawaiian shirt and lei', at: 50, color: '#e2553a', pattern: 'hawaiian', accent: '#ffd25a', swatch: 'radial-gradient(circle at 30% 35%, #ffd25a 0 14%, transparent 16%), radial-gradient(circle at 68% 66%, #ff9ac1 0 14%, transparent 16%), #e2553a' },
  { name: 'Tuxedo with tails', at: 500, color: '#17171b', pattern: 'tux', accent: '#d81e3a', swatch: 'linear-gradient(90deg, #17171b 0 34%, #f7f4ee 34% 66%, #17171b 66%)' },
  { name: 'The Closer', at: 1500, color: '#1f2a4a', pattern: 'closer', accent: '#efe6d2', swatch: 'radial-gradient(circle at 42% 50%, #fbf8f1 0 31%, transparent 33%), linear-gradient(90deg, #1f2a4a 0 76%, #c8372d 76% 80%, #efe6d2 80%)' },
  { name: 'Royal robe', at: 5000, color: '#8e1626', pattern: 'robe', accent: '#f6f3ec', swatch: 'radial-gradient(circle at 30% 30%, #111 0 6%, transparent 7%), radial-gradient(circle at 65% 60%, #111 0 6%, transparent 7%), linear-gradient(#f6f3ec 0 40%, #8e1626 40%)' },
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
