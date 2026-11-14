// Signature windups: a data-driven library of pitching deliveries.
//
// A windup is a set of high-level parameters (leg-kick height, hip turn, arm
// slot, stride, tempo, follow-through…) that a generator turns into keyframes,
// plus optional hand-authored keyframes for the moments that make a delivery
// recognisable. Adding one is adding an entry to WINDUPS: nothing else in the
// game changes. Shared by the client (animation) and the server (where the
// ball leaves the hand), so both always agree.
//
// Everything is authored for a right-hander in the "pitch frame":
//   x = toward the throwing-arm side, y = up, z = toward the target,
//   origin = the spot on the grass between the feet.
// Left-handers mirror x.
//
// Presets are identified by number only. See docs/WINDUPS.md (including the
// legal-review note) before changing how they are presented.

import type { Hand } from './pose.js';
import type { Vec3 } from './vec.js';

/**
 * Seconds from letting go of the aim to the ball leaving the hand. A gameplay
 * constant shared by every delivery, so no windup throws sooner than another.
 */
export const RELEASE_TIME = 0.3;
/**
 * The furthest from the thrower's eyes a delivery may let go of the ball (m).
 * The server refuses a throw that starts further away than this; the longest
 * stride in the library lets go about 1.8 m out.
 */
export const RELEASE_REACH = 2.0;
/**
 * Length of the delivery clip: stride, release, follow-through, and the landing held a beat.
 * Then the avatar walks back to the spot on its own (see the avatar's step planner).
 */
export const DELIVERY_LENGTH = 1.0;
/** Both feet down in the fielding stance (s after letting go). */
export const LAND_TIME = 0.8;
/** The arm at its furthest laid back, just before it comes through (s after letting go). */
const LAYBACK_TIME = 0.265;

/** Avatar proportions the deliveries are authored against (metres). */
export const RIG = {
  hipY: 0.92, hipW: 0.1, hipDrop: 0.02, torsoY: 0.04, shoulderX: 0.215, shoulderY: 0.5,
  leg: 0.885, ankle: 0.07, wrist: 0.54, grip: 0.075,
} as const;

/** One instant of a delivery. */
export interface DeliveryPose {
  /** Hips turned away from the target toward the throwing side (rad). 0 = square, π/2 = side-on, more = back to the target. */
  hip: number;
  /** Shoulders turned past the hips, same sense (rad). */
  coil: number;
  /** Trunk bent forward (rad). */
  lean: number;
  /** Trunk bent sideways toward the glove side (rad); negative leans to the arm side. */
  tilt: number;
  /** Hips: [across, how far they sink (m), toward the target]. */
  pelvis: Vec3;
  /** Glove-side (striding) foot. */
  lead: Vec3;
  /** Throwing-side (pivot) foot. */
  pivot: Vec3;
  /** Throwing hand (wrist). */
  ball: Vec3;
  /** Glove. */
  glove: Vec3;
}

export interface Key { t: number; pose: DeliveryPose }
/** A hand-authored key: at time `t`, start from the curve (or from the key at `from`, to hold a pose) and override `pose`. */
export interface KeyPatch { t: number; pose: Partial<DeliveryPose>; from?: number }

/** The dials a delivery is described with. */
export interface WindupParams {
  /** Seconds from the set position to the top of the leg kick. */
  tempo: number;
  /** Where the hands go on the way up. */
  hands: 'overhead' | 'chest' | 'belt';
  /** Height of the lifted foot at the top (m). */
  kick: number;
  /** How far in front of the hips the lifted foot hangs (m). */
  kickReach: number;
  /** How far the knee comes back across the body (m). */
  kickTuck: number;
  /** Hip turn at the top (rad). */
  turn: number;
  /** Shoulder turn beyond the hips at the top (rad). */
  coil: number;
  /** Lean away from the target at the top (rad). */
  layback: number;
  /** Stride length (m). */
  stride: number;
  /** How far across the body the stride lands (m, + = closed). */
  closed: number;
  /** How far the hips travel toward the target by release (m). */
  drive: number;
  /** Arm slot at release, degrees above horizontal (90 = straight over the top, 0 = sidearm). */
  slot: number;
  /** Trunk tilt toward the glove side at release (rad). */
  tilt: number;
  /** Trunk flexion at release (rad). */
  flex: number;
  /** How high the trailing leg whips through the follow-through (m). */
  finish: number;
}

export interface WindupDef {
  /** Jersey number: the only identity a preset has. */
  id: number;
  /** A plain description of the mechanics (never a person). */
  blurb: string;
  params: WindupParams;
  /** Hand-authored keyframes layered on the generated ones (t: 0..1 through the windup). */
  windupKeys?: KeyPatch[];
  /** Hand-authored keyframes for the delivery (t: seconds after letting go). */
  deliveryKeys?: KeyPatch[];
}

export interface Windup extends WindupDef {
  label: string;
  windup: Key[];
  delivery: Key[];
  /** Where the ball leaves the hand (pitch frame). */
  release: Vec3;
}

// ---------------------------------------------------------------- geometry

const DEG = Math.PI / 180;
const fwdOf = (h: number): [number, number] => [Math.sin(h), Math.cos(h)];
const sideOf = (h: number): [number, number] => [Math.cos(h), -Math.sin(h)];
const mix = (a: number, b: number, k: number) => a + (b - a) * k;
const mix3 = (a: Vec3, b: Vec3, k: number): Vec3 => [mix(a[0], b[0], k), mix(a[1], b[1], k), mix(a[2], b[2], k)];

/**
 * Height of the hips for a pose: as authored, but never so high that a planted
 * foot would come off the end of its leg. Long striders sink on their own.
 */
export function pelvisHeight(p: DeliveryPose): number {
  let y = RIG.hipY - p.pelvis[1];
  const [rx, rz] = sideOf(p.hip);
  for (const [foot, sx] of [[p.lead, -1], [p.pivot, 1]] as const) {
    if (foot[1] > 0.05) continue;
    const dx = foot[0] - (p.pelvis[0] + rx * RIG.hipW * sx);
    const dz = foot[2] - (p.pelvis[2] + rz * RIG.hipW * sx);
    const d2 = dx * dx + dz * dz;
    const max = RIG.hipDrop + RIG.ankle + foot[1] + Math.sqrt(Math.max(0.02, RIG.leg * RIG.leg - d2));
    if (y > max) y = max;
  }
  return Math.max(0.42, y);
}

/** A shoulder in the pitch frame (the throwing one unless `gloveSide`). */
export function shoulderOf(p: DeliveryPose, gloveSide = false): Vec3 {
  const a0 = gloveSide ? -RIG.shoulderX : RIG.shoulderX;
  const b0 = RIG.shoulderY;
  // Side bend, then forward bend, then the turn (the avatar's YXZ order).
  const a = a0 * Math.cos(p.tilt) - b0 * Math.sin(p.tilt);
  const b = a0 * Math.sin(p.tilt) + b0 * Math.cos(p.tilt);
  const up = b * Math.cos(p.lean), f = b * Math.sin(p.lean);
  const th = p.hip + p.coil;
  const [fx, fz] = fwdOf(th), [rx, rz] = sideOf(th);
  return [p.pelvis[0] + a * rx + f * fx, pelvisHeight(p) + RIG.torsoY + up, p.pelvis[2] + a * rz + f * fz];
}

// ---------------------------------------------------------------- keyframes

const FIELDS = ['hip', 'coil', 'lean', 'tilt'] as const;
const VECS = ['pelvis', 'lead', 'pivot', 'ball', 'glove'] as const;
const N = FIELDS.length + VECS.length * 3;
/** Where the two feet start in a flattened pose. */
const FEET = [FIELDS.length + 3, FIELDS.length + 6];

function flat(p: DeliveryPose): number[] {
  const o: number[] = [];
  for (const f of FIELDS) o.push(p[f]);
  for (const v of VECS) o.push(p[v][0], p[v][1], p[v][2]);
  return o;
}

function unflat(a: number[]): DeliveryPose {
  const v = (i: number): Vec3 => [a[4 + i * 3], a[5 + i * 3], a[6 + i * 3]];
  const p: DeliveryPose = { hip: a[0], coil: a[1], lean: a[2], tilt: a[3], pelvis: v(0), lead: v(1), pivot: v(2), ball: v(3), glove: v(4) };
  // Feet never go through the grass.
  if (p.lead[1] < 0) p.lead[1] = 0;
  if (p.pivot[1] < 0) p.pivot[1] = 0;
  return p;
}

/** Smooth curve through the keys (Catmull-Rom on the real key times; it rests at both ends). */
export function sampleKeys(keys: Key[], t: number): DeliveryPose {
  const n = keys.length;
  if (t <= keys[0].t) return unflat(flat(keys[0].pose));
  if (t >= keys[n - 1].t) return unflat(flat(keys[n - 1].pose));
  let i = 0;
  while (i < n - 2 && keys[i + 1].t <= t) i++;
  const k0 = keys[Math.max(0, i - 1)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(n - 1, i + 2)];
  const a0 = flat(k0.pose), a1 = flat(k1.pose), a2 = flat(k2.pose), a3 = flat(k3.pose);
  const h = k2.t - k1.t;
  const s = (t - k1.t) / h;
  const s2 = s * s, s3 = s2 * s;
  const out: number[] = new Array(N);
  for (let j = 0; j < N; j++) {
    const m1 = i === 0 ? 0 : ((a2[j] - a0[j]) / (k2.t - k0.t)) * h;
    const m2 = i + 2 > n - 1 ? 0 : ((a3[j] - a1[j]) / (k3.t - k1.t)) * h;
    out[j] = (2 * s3 - 3 * s2 + 1) * a1[j] + (s3 - 2 * s2 + s) * m1 + (-2 * s3 + 3 * s2) * a2[j] + (s3 - s2) * m2;
  }
  // A foot that is in the same place at both keys is planted: it stays exactly there (the curve
  // through the keys either side would otherwise slide it about on the grass).
  for (const j of FEET) {
    if (Math.abs(a1[j] - a2[j]) + Math.abs(a1[j + 1] - a2[j + 1]) + Math.abs(a1[j + 2] - a2[j + 2]) < 1e-6) {
      out[j] = a1[j]; out[j + 1] = a1[j + 1]; out[j + 2] = a1[j + 2];
    }
  }
  return unflat(out);
}

function applyPatches(keys: Key[], patches: KeyPatch[] | undefined): Key[] {
  if (!patches) return keys;
  for (const pt of patches) {
    const at = keys.find((k) => Math.abs(k.t - pt.t) < 1e-3);
    if (at) at.pose = { ...at.pose, ...pt.pose };
    else {
      const base = pt.from === undefined ? sampleKeys(keys, pt.t) : keys.find((k) => Math.abs(k.t - pt.from!) < 1e-3)?.pose ?? sampleKeys(keys, pt.from);
      keys.push({ t: pt.t, pose: { ...base, ...pt.pose } });
      keys.sort((a, b) => a.t - b.t);
    }
  }
  return keys;
}

/** The generated skeleton of a delivery: set, rock, gather, top; drive, plant, layback, release, follow, land, and the jog back. */
function generate(p: WindupParams): { windup: Key[]; delivery: Key[] } {
  const s = Math.sin(p.slot * DEG), c = Math.cos(p.slot * DEG);
  const handsY = p.hands === 'belt' ? 1.03 : 1.24;

  const SET: DeliveryPose = {
    hip: 0.12, coil: 0, lean: 0.04, tilt: 0, pelvis: [0, 0.01, 0],
    lead: [-0.15, 0, 0.07], pivot: [0.15, 0, -0.05],
    ball: [0.03, handsY, 0.27], glove: [-0.05, handsY + 0.01, 0.3],
  };

  // The top: balanced over the back leg, side-on (or further), knee up, hands in front of the chest.
  const h = p.turn;
  const [fx, fz] = fwdOf(h), [rx, rz] = sideOf(h), [cx, cz] = fwdOf(h + p.coil);
  const topPelvis: Vec3 = [0.1, 0.02, -0.02];
  const kickFoot: Vec3 = [
    topPelvis[0] + rx * (p.kickTuck - RIG.hipW) + fx * p.kickReach,
    p.kick,
    topPelvis[2] + rz * (p.kickTuck - RIG.hipW) + fz * p.kickReach,
  ];
  const topHand: Vec3 = [topPelvis[0] + cx * 0.24, handsY + 0.04, topPelvis[2] + cz * 0.24];
  const TOP: DeliveryPose = {
    hip: h, coil: p.coil, lean: 0.03, tilt: -p.layback, pelvis: topPelvis,
    lead: kickFoot, pivot: [0.15, 0, 0],
    ball: topHand, glove: [topHand[0] + cx * 0.04, topHand[1] + 0.02, topHand[2] + cz * 0.04],
  };

  const windup: Key[] = [{ t: 0, pose: SET }];
  const back: Vec3 = p.hands === 'overhead' ? [-0.22, 0, -0.3] : [-0.2, 0, -0.16];
  if (p.hands === 'overhead') {
    // The old full windup: rock back, hands swing up over the head, then gather.
    const OVER: DeliveryPose = {
      ...SET, hip: 0.3, lean: -0.08, pelvis: [0, 0, -0.08], lead: back, pivot: [0.15, 0, 0],
      ball: [0.03, 2.02, 0.02], glove: [-0.04, 2.04, 0.04],
    };
    windup.push({ t: 0.25, pose: { ...SET, hip: 0.2, pelvis: [-0.03, 0, -0.1], lead: [back[0], 0.03, back[2]], ball: [0.03, 1.56, 0.25], glove: [-0.05, 1.58, 0.27] } });
    windup.push({ t: 0.5, pose: OVER });
    windup.push({
      t: 0.78,
      pose: {
        ...TOP, hip: h * 0.72, coil: p.coil * 0.5, tilt: -p.layback * 0.4, pelvis: mix3(OVER.pelvis, topPelvis, 0.8),
        lead: [mix(back[0], kickFoot[0], 0.6), p.kick * 0.45, mix(back[2], kickFoot[2], 0.6)],
        ball: mix3(OVER.ball, TOP.ball, 0.62), glove: mix3(OVER.glove, TOP.glove, 0.62),
      },
    });
  } else {
    windup.push({ t: 0.34, pose: { ...SET, hip: 0.3, pelvis: [0.02, 0, -0.06], lead: [back[0], 0.02, back[2]], pivot: [0.15, 0, 0], ball: [0.04, handsY + 0.04, 0.26], glove: [-0.04, handsY + 0.05, 0.29] } });
    windup.push({
      t: 0.7,
      pose: {
        ...TOP, hip: h * 0.75, coil: p.coil * 0.5, tilt: -p.layback * 0.4, pelvis: mix3([0.02, 0, -0.06], topPelvis, 0.8),
        lead: [mix(back[0], kickFoot[0], 0.6), p.kick * 0.5, mix(back[2], kickFoot[2], 0.6)],
        ball: mix3(SET.ball, TOP.ball, 0.65), glove: mix3(SET.glove, TOP.glove, 0.65),
      },
    });
  }
  windup.push({ t: 1, pose: TOP });

  // ---- the delivery
  const land: Vec3 = [-0.12 + p.closed, 0, p.stride];
  const drive = p.drive;

  // Drive: the leg comes down and out, the hands break, the arm swings down and back.
  const dh = h * 0.9;
  const [dsx, dsz] = sideOf(dh + p.coil), [dfx, dfz] = fwdOf(dh + p.coil);
  const dPel: Vec3 = [0.05, 0.1, drive * 0.32];
  const DRIVE: DeliveryPose = {
    hip: dh, coil: p.coil + 0.12, lean: 0, tilt: -p.layback * 0.9 - 0.04, pelvis: dPel,
    lead: [land[0] * 0.6, 0.15, p.stride * 0.58], pivot: [0.15, 0, 0],
    ball: [dPel[0] + dsx * 0.36 - dfx * 0.12, 0.84, dPel[2] + dsz * 0.36 - dfz * 0.12],
    glove: [dPel[0] - dsx * 0.5 + dfx * 0.16, 1.3, dPel[2] - dsz * 0.5 + dfz * 0.16],
  };

  // Plant: front foot down, hips opening, shoulders still closed, arm cocked.
  const PLANT: DeliveryPose = {
    hip: Math.min(h, 0.6), coil: 0.8, lean: -0.04, tilt: -0.08, pelvis: [0.02, 0.16, drive * 0.74],
    lead: land, pivot: [0.15, 0.03, 0.06], ball: [0, 0, 0], glove: [-0.1, 1.12, drive * 0.74 + 0.42],
  };
  {
    const S = shoulderOf(PLANT);
    const [px, pz] = sideOf(PLANT.hip + PLANT.coil), [qx, qz] = fwdOf(PLANT.hip + PLANT.coil);
    const out = 0.18 + 0.22 * c, bk = 0.18 + 0.1 * c;
    PLANT.ball = [S[0] + px * out - qx * bk, S[1] + 0.03 + 0.28 * s, S[2] + pz * out - qz * bk];
  }

  // Release: square (and past it), the trunk bent out over a front leg that is bracing straight,
  // the hand well out in front of the head through its slot, the glove pulled in to the chest.
  const RELEASE: DeliveryPose = {
    hip: -0.18, coil: -0.3, lean: p.flex, tilt: p.tilt, pelvis: [-0.02, 0.12, drive],
    lead: land, pivot: [0.13, 0.06, Math.min(0.5, drive * 0.6)], ball: [0, 0, 0], glove: [0, 0, 0],
  };
  const dir = armDir(p.slot);
  {
    const S = shoulderOf(RELEASE);
    RELEASE.ball = [S[0] + dir[0] * RIG.wrist, S[1] + dir[1] * RIG.wrist, S[2] + dir[2] * RIG.wrist];
    RELEASE.glove = tucked(RELEASE);
  }

  // Layback, a few hundredths before: the trunk has turned to face the target and the arm is
  // left behind, the elbow out at shoulder height and the forearm laid back behind it.
  const LAYBACK: DeliveryPose = {
    hip: -0.06, coil: 0.04, lean: p.flex * 0.45, tilt: p.tilt * 0.6, pelvis: [0, 0.13, drive * 0.94],
    lead: land, pivot: [0.14, 0.05, Math.min(0.42, drive * 0.52)], ball: [0, 0, 0], glove: [0, 0, 0],
  };
  {
    const S = shoulderOf(LAYBACK);
    LAYBACK.ball = [S[0] + 0.06 + 0.26 * c, S[1] + 0.1 + 0.18 * s, S[2] - 0.25];
    LAYBACK.glove = tucked(LAYBACK);
  }

  // Follow-through: the arm finishes across the body to the far knee, the trunk folds over the
  // front leg, and the back leg comes up off the ground behind.
  const FOLLOW: DeliveryPose = {
    hip: -0.5, coil: -0.4, lean: p.flex + 0.22, tilt: p.tilt * 0.5, pelvis: [-0.05, 0.12, drive + 0.1],
    lead: land, pivot: [0.16, 0.1 + p.finish * 0.6, drive * 0.5 + 0.06],
    ball: [mix(-0.5, -0.3, s), mix(0.9, 0.5, s), land[2] + mix(0.05, 0.12, s)],
    glove: [-0.32, 1.02, drive + 0.08],
  };
  // The back leg swings round and comes down beside the front one...
  const FINISH: DeliveryPose = {
    hip: -0.3, coil: -0.2, lean: p.flex * 0.7, tilt: 0.05, pelvis: [0.02, 0.08, p.stride - 0.22],
    lead: land, pivot: [0.36, 0.06 + p.finish * 0.12, p.stride - 0.08],
    ball: [-0.12, 0.7, p.stride + 0.12], glove: [-0.26, 1.0, p.stride + 0.2],
  };
  // ...square to the target in a fielding position, glove up. (It is held there a beat, and then
  // the avatar walks back to the spot: see `build`.)
  const LAND: DeliveryPose = {
    hip: 0, coil: 0, lean: 0.22, tilt: 0, pelvis: [0.1, 0.06, p.stride - 0.14],
    lead: land, pivot: [0.36, 0, p.stride - 0.1],
    ball: [0.24, 0.88, p.stride + 0.08], glove: [-0.18, 1.08, p.stride + 0.26],
  };
  const delivery: Key[] = [
    { t: 0, pose: TOP },
    { t: 0.1, pose: DRIVE },
    { t: 0.2, pose: PLANT },
    { t: LAYBACK_TIME, pose: LAYBACK },
    { t: RELEASE_TIME, pose: RELEASE },
    { t: 0.42, pose: FOLLOW },
    { t: 0.62, pose: FINISH },
    { t: LAND_TIME, pose: LAND },
  ];
  return { windup, delivery };
}

/**
 * Direction of the throwing arm at release for an arm slot (pitch frame). The hand lets go
 * well out in front of the head: about as far forward of the shoulder as it is up (over the
 * top) or out to the side (sidearm).
 */
function armDir(slot: number): Vec3 {
  const s = Math.sin(slot * DEG), c = Math.cos(slot * DEG);
  const d: Vec3 = [0.75 * c + 0.05, 0.62 * s + 0.04, 0.8];
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
}

/** The glove pulled in to the chest (by the glove-side armpit), for the moment the arm comes through. */
function tucked(p: DeliveryPose): Vec3 {
  const G = shoulderOf(p, true), T = shoulderOf(p);
  const [fx, fz] = fwdOf(p.hip + p.coil);
  return [mix(T[0], G[0], 0.85) + fx * 0.2, mix(T[1], G[1], 0.5) - 0.2, mix(T[2], G[2], 0.85) + fz * 0.2];
}

function build(def: WindupDef): Windup {
  const g = generate(def.params);
  const windup = applyPatches(g.windup, def.windupKeys);
  // A custom top carries into the delivery, which starts from the same pose.
  g.delivery[0].pose = windup[windup.length - 1].pose;
  const delivery = applyPatches(g.delivery, def.deliveryKeys);
  // The finish is held: balanced in the fielding stance, feet planted, settling a little taller.
  const land = delivery.find((k) => Math.abs(k.t - LAND_TIME) < 1e-3)!.pose;
  delivery.push({ t: DELIVERY_LENGTH, pose: { ...land, lean: land.lean * 0.75, pelvis: [land.pelvis[0], land.pelvis[1] - 0.02, land.pelvis[2]] } });
  // The ball leaves the hand at RELEASE_TIME, a grip's length beyond the wrist along the arm.
  const rel = sampleKeys(delivery, RELEASE_TIME);
  const S = shoulderOf(rel);
  const d: Vec3 = [rel.ball[0] - S[0], rel.ball[1] - S[1], rel.ball[2] - S[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  const release: Vec3 = [rel.ball[0] + (d[0] / l) * RIG.grip, rel.ball[1] + (d[1] / l) * RIG.grip, rel.ball[2] + (d[2] / l) * RIG.grip];
  return { ...def, label: '#' + String(def.id).padStart(2, '0'), windup, delivery, release };
}

// ---------------------------------------------------------------- the library

const DEFS: WindupDef[] = [
  {
    // The house delivery: compact, from the set. Coach throws like this.
    id: 0,
    blurb: 'Compact and easy, from the set',
    params: { tempo: 0.75, hands: 'chest', kick: 0.42, kickReach: 0.3, kickTuck: 0, turn: 1.3, coil: 0.1, layback: 0.02, stride: 1.05, closed: 0, drive: 0.62, slot: 55, tilt: 0.18, flex: 0.45, finish: 0.3 },
  },
  {
    id: 34,
    blurb: 'Towering leg kick, over the top',
    params: { tempo: 1.05, hands: 'overhead', kick: 0.94, kickReach: 0.2, kickTuck: 0.13, turn: 1.62, coil: 0.22, layback: 0.1, stride: 1.28, closed: 0.02, drive: 0.76, slot: 66, tilt: 0.3, flex: 0.62, finish: 0.55 },
    // Standing tall at the top, knee by the front shoulder, hands tucked under the chin.
    windupKeys: [
      // (The hands go to the top of the cap, elbows out: not a full stretch.)
      { t: 0.5, pose: { ball: [0.05, 1.9, 0.06], glove: [-0.03, 1.92, 0.08] } },
      { t: 1, pose: { pelvis: [0.1, -0.02, -0.02] } },
    ],
    // Drop and drive: sit deep on the back leg before the stride.
    deliveryKeys: [
      { t: 0.1, pose: { pelvis: [0.06, 0.22, 0.24] } },
    ],
  },
  {
    id: 16,
    blurb: 'Hands high, back to the target, then unwind',
    params: { tempo: 1.3, hands: 'overhead', kick: 0.72, kickReach: 0.26, kickTuck: 0.16, turn: 2.5, coil: 0.35, layback: 0.04, stride: 1.22, closed: 0.05, drive: 0.72, slot: 76, tilt: 0.4, flex: 0.58, finish: 0.42 },
    windupKeys: [
      // A long reach for the sky, up on the toes, back arched...
      { t: 0.5, pose: { ball: [0.02, 2.2, -0.08], glove: [-0.04, 2.22, -0.06], lean: -0.2, pelvis: [0, -0.04, -0.08] } },
      // ...then all the way round, and a beat of stillness with the back to the target.
      { t: 0.86, from: 1, pose: {} },
    ],
  },
  {
    id: 35,
    blurb: 'Sky-high kick, hands overhead, a sweeping sling',
    params: { tempo: 0.9, hands: 'chest', kick: 1.0, kickReach: 0.42, kickTuck: 0.04, turn: 1.95, coil: 0.2, layback: 0.18, stride: 1.18, closed: 0.2, drive: 0.68, slot: 36, tilt: 0, flex: 0.5, finish: 0.5 },
    windupKeys: [
      // The hands go up as the knee does: knee to the chest, glove over the head.
      { t: 0.7, pose: { ball: [0.2, 1.62, 0.04], glove: [0.22, 1.66, 0.06] } },
      { t: 1, pose: { ball: [0.27, 1.95, -0.13], glove: [0.3, 1.99, -0.15] } },
    ],
    // Slings across the body and falls away to the glove side.
    deliveryKeys: [
      // (Spun open past the target, the trunk over the planted front foot; the back leg swings wide
      // across behind it and lands well over on the glove side, so the base is under the body.)
      { t: 0.42, pose: { pelvis: [-0.04, 0.12, 0.8], hip: -0.8 } },
      { t: 0.62, pose: { pelvis: [-0.12, 0.1, 0.92], hip: -0.95, pivot: [-0.18, 0.24, 1.0] } },
      { t: 0.8, pose: { pelvis: [-0.2, 0.08, 1.02], hip: -0.45, pivot: [-0.46, 0, 1.1] } },
    ],
  },
  {
    id: 32,
    blurb: 'Tall and smooth, straight over the top',
    params: { tempo: 1.1, hands: 'overhead', kick: 0.82, kickReach: 0.3, kickTuck: 0.05, turn: 1.5, coil: 0.15, layback: 0.38, stride: 1.36, closed: 0, drive: 0.8, slot: 85, tilt: 0.5, flex: 0.6, finish: 0.6 },
    deliveryKeys: [
      // A long reach back, the front shoulder riding high...
      { t: 0.1, pose: { ball: [0.18, 0.62, -0.5], glove: [-0.05, 1.5, 0.78], tilt: -0.3 } },
      // ...and still tilted back at foot strike, before it all comes over the top.
      { t: 0.2, pose: { tilt: -0.22 } },
    ],
  },
  {
    id: 51,
    blurb: 'Long stride, low arm, slung from the side',
    params: { tempo: 1.0, hands: 'belt', kick: 0.55, kickReach: 0.34, kickTuck: 0.02, turn: 1.55, coil: 0.22, layback: 0.03, stride: 1.34, closed: 0.22, drive: 0.78, slot: 24, tilt: -0.12, flex: 0.36, finish: 0.22 },
    // Across the body and off toward the glove side.
    deliveryKeys: [
      { t: 0.42, pose: { pelvis: [-0.16, 0.12, 0.86], hip: -0.7 } },
      { t: 0.62, pose: { pelvis: [-0.24, 0.08, 0.98], hip: -0.7 } },
    ],
  },
  {
    id: 55,
    blurb: 'Deep load, a giant stride, everything at once',
    params: { tempo: 0.85, hands: 'chest', kick: 0.8, kickReach: 0.22, kickTuck: 0.14, turn: 1.95, coil: 0.45, layback: 0.3, stride: 1.58, closed: 0, drive: 0.96, slot: 78, tilt: 0.46, flex: 0.74, finish: 0.95 },
    deliveryKeys: [
      // The arm hangs straight down behind while the glove points at the sky...
      { t: 0.1, pose: { pelvis: [0.05, 0.22, 0.36], ball: [0.2, 0.46, -0.1], glove: [-0.02, 1.64, 0.9], tilt: -0.38, coil: 0.6 } },
      // ...the stride goes on and on...
      { t: 0.2, pose: { pelvis: [0.02, 0.3, 0.74] } },
      // ...and the back leg comes over the top after it.
      { t: 0.42, pose: { pivot: [0.25, 1.0, 0.98] } },
      { t: 0.62, pose: { pivot: [0.42, 0.2, 1.5], pelvis: [-0.06, 0.12, 1.26] } },
    ],
  },
];

export const WINDUPS: Windup[] = DEFS.map(build);
export const WINDUP_IDS: number[] = WINDUPS.map((w) => w.id);
/** What a new player throws with. */
export const DEFAULT_WINDUP = 34;
/** The neutral house delivery (Coach, and the fallback for unknown ids). */
export const HOUSE_WINDUP = 0;

const BY_ID = new Map(WINDUPS.map((w) => [w.id, w]));

export function getWindup(id: unknown): Windup {
  return BY_ID.get(typeof id === 'number' ? id : NaN) ?? BY_ID.get(HOUSE_WINDUP)!;
}

/** A valid windup id from untrusted input. */
export function windupId(x: unknown, fallback = DEFAULT_WINDUP): number {
  return typeof x === 'number' && BY_ID.has(x) ? x : fallback;
}

/** Pose `u` (0..1) of the way through the windup. */
export function windupPose(w: Windup, u: number): DeliveryPose {
  return sampleKeys(w.windup, u);
}

/** Pose `t` seconds after letting go. A delivery started early (`fromU` < 1) eases in from wherever the windup was. */
export function deliveryPose(w: Windup, t: number, fromU = 1): DeliveryPose {
  const d = sampleKeys(w.delivery, t);
  if (fromU >= 0.999 || t >= 0.14) return d;
  const k = t / 0.14;
  const e = k * k * (3 - 2 * k);
  const a = flat(windupPose(w, fromU)), b = flat(d);
  return unflat(a.map((v, i) => v + (b[i] - v) * e));
}

/**
 * How big a windup is for a pull of the thumb (0..1): a short pull is a
 * compact, quick-looking motion; a full pull is the whole show.
 */
export function windupScale(pull: number): number {
  return 0.5 + Math.max(0, Math.min(1, pull));
}

/**
 * The same windup, bigger or smaller: every part of the pose is moved further
 * from (or held closer to) the set position by `scale`. Kept inside what a
 * body can do: the kick, the turn and the hands only go so far.
 */
export function exaggerate(w: Windup, pose: DeliveryPose, scale: number): DeliveryPose {
  if (Math.abs(scale - 1) < 1e-3) return pose;
  const a = flat(windupPose(w, 0)), b = flat(pose);
  const p = unflat(a.map((v, i) => v + (b[i] - v) * scale));
  // More of a kick and a turn, never a different delivery.
  p.hip = Math.min(p.hip, Math.max(pose.hip, 2.7));
  p.coil = Math.max(-1.2, Math.min(p.coil, Math.max(pose.coil, 1.1)));
  p.lean = Math.max(-0.75, Math.min(0.9, p.lean));
  p.tilt = Math.max(-0.7, Math.min(0.7, p.tilt));
  p.lead[1] = Math.max(0, Math.min(p.lead[1], Math.max(pose.lead[1], 1.25)));
  p.pivot[1] = Math.max(0, p.pivot[1]);
  p.ball[1] = Math.max(0.5, Math.min(p.ball[1], 2.35));
  p.glove[1] = Math.max(0.5, Math.min(p.glove[1], 2.35));
  return p;
}

/** Pitch-frame offset → world-axes offset for a body facing `yaw`. */
export function pitchToWorld(yaw: number, hand: Hand, p: Vec3): Vec3 {
  const side = hand === 'R' ? 1 : -1;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x = p[0] * side;
  return [cy * x - sy * p[2], p[1], -sy * x - cy * p[2]];
}

/** Where the ball leaves the hand (world) for a thrower standing at `feet`, facing `yaw`. */
export function releasePointFor(id: number, feet: Vec3, yaw: number, hand: Hand): Vec3 {
  const o = pitchToWorld(yaw, hand, getWindup(id).release);
  return [feet[0] + o[0], o[1], feet[2] + o[2]];
}
