// The card you get when you leave a room: the session in one picture, with a
// photo of its best catch, ready to send. Drawn on a canvas (4:5, the shape a
// photo is shared in), so it is one image wherever it goes.

import type { CatchQuality, CatchStyle } from '../shared/protocol';

export interface Recap {
  catches: number;
  perfects: number;
  /** Most perfect catches in a row. */
  heat: number;
  /** The longest catch, in feet (from where it left the hand to the glove). */
  far: number;
  /** The best streak while you were there. */
  streak: number;
  /** A daily room: the day, and whether its goal was reached. */
  day: string | null;
  /** Today's best at the day's setup, with this group. */
  dayBest: number;
  dayGoal?: string;
  dayDone?: boolean;
  best: { by: string; mine: boolean; q: CatchQuality; st: CatchStyle | null; ft: number } | null;
  names: string[];
  photo: HTMLCanvasElement | null;
}

const W = 1080, H = 1350, PHOTO_H = 760, PAD = 64;
const INK = '#1f1a15', PAPER = '#f8f2e7', CREAM = '#f7f0e3', STITCH = '#c8372d', MUTED = '#8a7d6b', GOLD = '#ffe1a8';
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const QUALITY: Record<string, string> = { perfect: 'Perfect pop', pocket: 'In the pocket', web: 'Off the web', bobble: 'Bobbled, held' };
const STYLE: Record<string, string> = { dive: 'Diving catch', leap: 'Leaping grab', run: 'On the run', high: 'High snag', scoop: 'Scooped', backhand: 'Backhand', reach: 'Reaching grab' };

/** Text with its own letter spacing (canvas letterSpacing isn't everywhere yet). Returns the width drawn. */
function spaced(c: CanvasRenderingContext2D, text: string, x: number, y: number, track: number, draw = true): number {
  let w = 0;
  for (const ch of text) {
    if (draw) c.fillText(ch, x + w, y);
    w += c.measureText(ch).width + track;
  }
  return w - track;
}

/** The biggest size up to `size` at which `text` fits in `max` pixels. */
function fit(c: CanvasRenderingContext2D, text: string, weight: number, size: number, max: number): number {
  for (let s = size; s > 10; s -= 2) {
    c.font = `${weight} ${s}px ${FONT}`;
    if (c.measureText(text).width <= max) return s;
  }
  return 10;
}

export function drawRecap(r: Recap, date = new Date()): HTMLCanvasElement {
  const cv = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const c = cv.getContext('2d')!;
  c.fillStyle = PAPER;
  c.fillRect(0, 0, W, H);

  // ---- the photo (cover, a little above centre: the catch is in the middle of the screen, the sky above it)
  if (r.photo && r.photo.width) {
    const p = r.photo, k = Math.max(W / p.width, PHOTO_H / p.height);
    const sw = W / k, sh = PHOTO_H / k;
    const sx = (p.width - sw) / 2, sy = Math.max(0, Math.min(p.height - sh, (p.height - sh) * 0.45));
    c.drawImage(p, sx, sy, sw, sh, 0, 0, W, PHOTO_H);
  } else {
    const g = c.createLinearGradient(0, 0, 0, PHOTO_H);
    g.addColorStop(0, '#6f8f5a'); g.addColorStop(1, '#3f5a33');
    c.fillStyle = g; c.fillRect(0, 0, W, PHOTO_H);
  }
  // Shade top and bottom, so the type reads on any sky or grass.
  let g = c.createLinearGradient(0, 0, 0, 260);
  g.addColorStop(0, 'rgba(20,15,10,0.42)'); g.addColorStop(1, 'rgba(20,15,10,0)');
  c.fillStyle = g; c.fillRect(0, 0, W, 260);
  g = c.createLinearGradient(0, PHOTO_H - 330, 0, PHOTO_H);
  g.addColorStop(0, 'rgba(20,15,10,0)'); g.addColorStop(1, 'rgba(20,15,10,0.72)');
  c.fillStyle = g; c.fillRect(0, PHOTO_H - 330, W, 330);

  // ---- wordmark
  c.textBaseline = 'alphabetic';
  c.shadowColor = 'rgba(40,20,5,0.35)'; c.shadowBlur = 24; c.shadowOffsetY = 2;
  c.font = `900 112px ${FONT}`;
  c.fillStyle = CREAM;
  const wm = spaced(c, 'CATCH', PAD - 4, PAD + 92, -6);
  c.fillStyle = STITCH;
  c.fillText('.', PAD - 4 + wm - 2, PAD + 92);

  // ---- the best catch, on the photo
  if (r.best) {
    const how = [r.best.st ? STYLE[r.best.st] : '', QUALITY[r.best.q] ?? ''].filter(Boolean).join(' · ');
    c.font = `800 26px ${FONT}`;
    c.fillStyle = GOLD;
    spaced(c, 'BEST CATCH', PAD, PHOTO_H - 150, 4.5);
    c.fillStyle = CREAM;
    const line = `${r.best.mine ? 'You' : r.best.by} · ${how}`;
    fit(c, line, 800, 52, W - PAD * 2);
    c.fillText(line, PAD, PHOTO_H - 92);
    c.font = `600 32px ${FONT}`;
    c.fillStyle = 'rgba(247,240,227,0.82)';
    c.fillText(`${r.best.ft} ft`, PAD, PHOTO_H - 46);
  }
  c.shadowColor = 'transparent'; c.shadowBlur = 0; c.shadowOffsetY = 0;

  // ---- the numbers, two by two
  const stats: [string, string, string][] = [
    [String(r.streak), '', 'Best streak'],
    [String(r.far), ' ft', 'Longest catch'],
    [String(r.perfects), '', r.perfects === 1 ? 'Perfect pop' : 'Perfect pops'],
    // (A run of one isn't a run: then, how many were caught.)
    r.heat >= 2 ? [`×${r.heat}`, '', 'Perfects in a row'] : [String(r.catches), '', r.catches === 1 ? 'Catch' : 'Catches'],
  ];
  const colW = (W - PAD * 2) / 2;
  stats.forEach(([n, unit, label], i) => {
    const x = PAD + colW * (i % 2), y = PHOTO_H + 124 + Math.floor(i / 2) * 132;
    c.fillStyle = INK;
    c.font = `800 92px ${FONT}`;
    const nw = spaced(c, n, x - 3, y, -3);
    if (unit) { c.font = `800 40px ${FONT}`; c.fillText(unit, x + nw + 6, y); }
    c.fillStyle = MUTED;
    c.font = `700 24px ${FONT}`;
    spaced(c, label.toUpperCase(), x, y + 40, 2.6);
  });

  // ---- who, when, and the day's challenge
  c.fillStyle = 'rgba(31,26,21,0.12)';
  c.fillRect(PAD, PHOTO_H + 330, W - PAD * 2, 2);
  let y = PHOTO_H + 396;
  if (r.day && r.dayGoal) {
    c.font = `800 32px ${FONT}`;
    c.fillStyle = r.dayDone ? STITCH : INK;
    c.fillText(`Today’s catch: ${r.dayGoal}${r.dayDone ? ' ✓' : r.dayBest ? ` · best ${r.dayBest}` : ''}`, PAD, y);
    y += 50;
  }
  const who = r.names.length <= 2 ? r.names.join(' & ') : `${r.names.slice(0, -1).join(', ')} & ${r.names[r.names.length - 1]}`;
  const when = date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  c.font = `600 30px ${FONT}`;
  const ww = c.measureText(when).width;
  c.fillStyle = INK;
  fit(c, who, 600, 30, W - PAD * 2 - ww - 40);
  c.fillText(who, PAD, y);
  c.font = `600 30px ${FONT}`;
  c.fillStyle = MUTED;
  c.fillText(when, W - PAD - ww, y);

  c.font = `600 22px ${FONT}`;
  c.fillStyle = 'rgba(138,125,107,0.75)';
  const cw = c.measureText('by HaveAnApp').width;
  c.fillText('by HaveAnApp', (W - cw) / 2, H - 44);
  return cv;
}
