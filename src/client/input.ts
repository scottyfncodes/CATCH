// Two-thumb controls.
//
//   Glove thumb (left for right-handers): drag anywhere on that half. The
//   glove follows relative motion and stays where you leave it.
//
//   Throwing thumb (right for right-handers), on the other half:
//     • while you DON'T have the ball: drag anywhere to look around
//     • while you DO have the ball:
//         upper part of the screen → look around (aim with your eyes)
//         lower part, or on the ball → grip it:
//           pull down   → wind up (further = harder; your arm draws back)
//           slide left/right → aim the arm (a faint arc shows the throw)
//           let go      → throw
//           slide back up to where you started and let go → cancel
//
// The gesture type is fixed at touch-down by where the thumb lands, so a look
// drag can never become a throw, and a throw only happens on release with a
// real pull-back.

import type { Hand } from '../shared/pose';

export interface ThrowRelease {
  /** 0..1 from how far the ball was pulled back. */
  charge: number;
  /** -1..1 arm aim from the sideways slide (+ = right). */
  aim: number;
  /** 0..1 bonus from snapping the thumb up as you let go (optional skill). */
  snap: number;
}

export interface InputHandlers {
  canGrip(): boolean;
  /** Screen position (CSS px) of the ball in your throwing hand. */
  gripPoint(): { x: number; y: number } | null;
  onLook(dx: number, dy: number): void;
  onLookActive(active: boolean): void;
  onGlove(du: number, dv: number): void;
  onGloveActive(active: boolean): void;
  onGrip(): void;
  /** Live windup: charge 0..1 and arm aim -1..1. */
  onWind(charge: number, aim: number): void;
  onRelease(r: ThrowRelease): void;
  onCancel(): void;
}

type Role = 'glove' | 'look' | 'throw';

interface Track {
  role: Role;
  x: number; y: number;
  sx: number; sy: number;
  hist: { x: number; y: number; t: number }[];
}

export const GRIP_RADIUS = 90;
/** Fraction of screen height from the top where the throwing side's grip zone starts. */
export const GRIP_ZONE_TOP = 0.5;
/** Pull distance (fraction of screen height) for a full-power throw. */
const FULL_PULL = 0.3;
/** Sideways slide (fraction of screen width) for full arm aim. */
const FULL_AIM = 0.32;
export const MIN_CHARGE = 0.07;

export class Controls {
  private tracks = new Map<number, Track>();
  hand: Hand = 'R';
  enabled = true;
  /** Diagnostics for tests. */
  stats = { looks: 0, throws: 0, cancels: 0, grips: 0 };

  constructor(private el: HTMLElement, private h: InputHandlers) {
    el.addEventListener('pointerdown', this.down, { passive: false });
    el.addEventListener('pointermove', this.move, { passive: false });
    el.addEventListener('pointerup', this.up, { passive: false });
    el.addEventListener('pointercancel', this.cancel, { passive: false });
    el.addEventListener('lostpointercapture', this.cancel);
    // Stop iOS from scrolling, zooming or showing the callout.
    for (const ev of ['touchstart', 'touchmove', 'touchend', 'gesturestart', 'gesturechange', 'dblclick', 'contextmenu']) {
      el.addEventListener(ev, (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
    }
  }

  private gloveSideIsLeft() { return this.hand === 'R'; }

  private roleFor(x: number, y: number): Role {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    const leftHalf = x < w / 2;
    if (leftHalf === this.gloveSideIsLeft()) return 'glove';
    if (this.h.canGrip()) {
      const g = this.h.gripPoint();
      if (y > h * GRIP_ZONE_TOP) return 'throw';
      if (g && Math.hypot(x - g.x, y - g.y) <= GRIP_RADIUS) return 'throw';
    }
    return 'look';
  }

  private down = (e: PointerEvent) => {
    e.preventDefault();
    if (!this.enabled) return;
    const r = this.el.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const role = this.roleFor(x, y);
    // One finger per role; a second finger on the same side is ignored.
    for (const t of this.tracks.values()) {
      if (t.role === role || (role !== 'glove' && t.role !== 'glove')) return;
    }
    try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.tracks.set(e.pointerId, { role, x, y, sx: x, sy: y, hist: [{ x, y, t: e.timeStamp }] });
    if (role === 'glove') this.h.onGloveActive(true);
    else if (role === 'look') { this.h.onLookActive(true); this.stats.looks++; }
    else { this.h.onGrip(); this.h.onWind(0, 0); this.stats.grips++; }
  };

  private move = (e: PointerEvent) => {
    const t = this.tracks.get(e.pointerId);
    if (!t) return;
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list = evs.length ? evs : [e];
    for (const ev of list) {
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      const dx = x - t.x, dy = y - t.y;
      t.x = x; t.y = y;
      t.hist.push({ x, y, t: ev.timeStamp });
      if (t.hist.length > 32) t.hist.shift();
      if (t.role === 'glove') {
        const W = this.el.clientWidth, H = this.el.clientHeight;
        this.h.onGlove(dx * (2.3 / (0.46 * W)), -dy * (2.3 / (0.34 * H)));
      } else if (t.role === 'look') {
        this.h.onLook(dx, dy);
      }
    }
    if (t.role === 'throw') {
      const w = this.wind(t);
      this.h.onWind(w.charge, w.aim);
    }
  };

  /** Current windup from the thumb's offset to where it gripped. */
  private wind(t: Track, x = t.x, y = t.y) {
    const W = this.el.clientWidth, H = this.el.clientHeight;
    const pull = Math.max(0, (y - t.sy) / (FULL_PULL * H));
    const charge = Math.min(1, pull);
    const aim = Math.max(-1, Math.min(1, (x - t.sx) / (FULL_AIM * W)));
    return { charge, aim };
  }

  private up = (e: PointerEvent) => {
    const t = this.tracks.get(e.pointerId);
    if (!t) return;
    this.tracks.delete(e.pointerId);
    if (t.role === 'glove') { this.h.onGloveActive(false); return; }
    if (t.role === 'look') { this.h.onLookActive(false); return; }
    // Release. If the thumb snapped upward just before lifting, use the windup
    // from just before the snap (so "pull, then flick" also works) and give a
    // little extra zip.
    const H = this.el.clientHeight;
    const last = t.hist[t.hist.length - 1];
    let before = last;
    for (let i = t.hist.length - 1; i >= 0; i--) {
      before = t.hist[i];
      if (last.t - t.hist[i].t > 90) break;
    }
    const dt = Math.max(8, last.t - before.t) / 1000;
    const upSpeed = (before.y - last.y) / H / dt; // screen heights / s
    let w = this.wind(t);
    let snap = 0;
    if (upSpeed > 1.2) {
      const pre = this.wind(t, before.x, before.y);
      if (pre.charge > w.charge) w = pre;
      snap = Math.min(1, (upSpeed - 1.2) / 3);
    }
    if (w.charge >= MIN_CHARGE) {
      this.stats.throws++;
      this.h.onRelease({ charge: w.charge, aim: w.aim, snap });
    } else {
      this.stats.cancels++;
      this.h.onCancel();
    }
  };

  private cancel = (e: Event) => {
    const id = (e as PointerEvent).pointerId;
    const t = this.tracks.get(id);
    if (!t) return;
    this.tracks.delete(id);
    if (t.role === 'glove') this.h.onGloveActive(false);
    else if (t.role === 'look') this.h.onLookActive(false);
    else { this.stats.cancels++; this.h.onCancel(); }
  };

  /** Abort any in-progress gesture (e.g. when the ball is taken away). */
  reset() {
    for (const t of this.tracks.values()) {
      if (t.role === 'throw') this.h.onCancel();
      if (t.role === 'look') this.h.onLookActive(false);
      if (t.role === 'glove') this.h.onGloveActive(false);
    }
    this.tracks.clear();
  }

  get gripping() { return [...this.tracks.values()].some((t) => t.role === 'throw'); }
}
