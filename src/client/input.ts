// Two-thumb controls.
//
//   Glove thumb (left for right-handers): drag anywhere on that half. The
//   glove follows relative motion and stays where you leave it.
//
//   Throwing thumb (right for right-handers), on the other half:
//     • drag from anywhere that is NOT the ball → look around
//     • press ON the ball (only while you hold it) → grip
//         pull down → wind up (how far = how hard)
//         flick up → release (flick angle bends the throw left/right)
//         lift without a flick, or slide back → cancel, nothing is thrown
//
// A look drag can never become a throw: the gesture type is decided at
// touch-down by where the thumb lands, and a throw needs a pull-back plus an
// upward flick.

import type { Hand } from '../shared/pose';

export interface ThrowRelease {
  /** 0..1 from how far the ball was pulled back. */
  charge: number;
  /** 0..1 how fast the flick was (beyond the threshold). */
  flick: number;
  /** Flick direction, radians from straight up (+ = toward the right). */
  angle: number;
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
  onCharge(charge: number): void;
  onRelease(r: ThrowRelease): void;
  onCancel(): void;
}

type Role = 'glove' | 'look' | 'throw';

interface Track {
  role: Role;
  x: number; y: number;
  sx: number; sy: number;
  /** Lowest point reached while winding (max pull). */
  maxPullY: number;
  hist: { x: number; y: number; t: number }[];
}

export const GRIP_RADIUS = 78;
const FLICK_SPEED = 0.85; // screen heights per second
const MIN_CHARGE = 0.04;

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
    const w = this.el.clientWidth;
    const leftHalf = x < w / 2;
    if (leftHalf === this.gloveSideIsLeft()) return 'glove';
    if (this.h.canGrip()) {
      const g = this.h.gripPoint();
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
    const t: Track = { role, x, y, sx: x, sy: y, maxPullY: y, hist: [{ x, y, t: e.timeStamp }] };
    this.tracks.set(e.pointerId, t);
    if (role === 'glove') this.h.onGloveActive(true);
    else if (role === 'look') { this.h.onLookActive(true); this.stats.looks++; }
    else { this.h.onGrip(); this.stats.grips++; }
  };

  private move = (e: PointerEvent) => {
    const t = this.tracks.get(e.pointerId);
    if (!t) return;
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    // Use coalesced events for smooth, high-rate input where available.
    const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    const list = evs.length ? evs : [e];
    for (const ev of list) {
      const x = ev.clientX - r.left, y = ev.clientY - r.top;
      const dx = x - t.x, dy = y - t.y;
      t.x = x; t.y = y;
      t.hist.push({ x, y, t: ev.timeStamp });
      if (t.hist.length > 24) t.hist.shift();
      if (t.role === 'glove') {
        const W = this.el.clientWidth, H = this.el.clientHeight;
        this.h.onGlove(dx * (2.3 / (0.46 * W)), -dy * (2.3 / (0.34 * H)));
      } else if (t.role === 'look') {
        this.h.onLook(dx, dy);
      } else if (this.windAndMaybeRelease(t)) {
        this.tracks.delete(e.pointerId);
        return;
      }
    }
  };

  private chargeOf(t: Track) {
    const H = this.el.clientHeight;
    return Math.min(1, Math.max(0, (t.maxPullY - t.sy) / (0.24 * H)));
  }

  /** Returns true when the throw was released. */
  private windAndMaybeRelease(t: Track): boolean {
    const H = this.el.clientHeight;
    if (t.y > t.maxPullY) t.maxPullY = t.y;
    const charge = this.chargeOf(t);
    this.h.onCharge(charge);
    const v = this.flickVelocity(t);
    const risen = (t.maxPullY - t.y) / H;
    if (charge >= MIN_CHARGE && v.up >= FLICK_SPEED && risen > 0.035) {
      this.release(t, charge, v);
      return true;
    }
    return false;
  }

  /** Velocity over the last ~70 ms, in screen heights per second. */
  private flickVelocity(t: Track) {
    const H = this.el.clientHeight;
    const last = t.hist[t.hist.length - 1];
    let first = last;
    for (let i = t.hist.length - 1; i >= 0; i--) {
      first = t.hist[i];
      if (last.t - t.hist[i].t > 70) break;
    }
    const dt = Math.max(8, last.t - first.t) / 1000;
    const vx = (last.x - first.x) / H / dt;
    const vy = (last.y - first.y) / H / dt;
    return { up: -vy, side: vx };
  }

  private release(_t: Track, charge: number, v: { up: number; side: number }) {
    const flick = Math.min(1, Math.max(0, (v.up - FLICK_SPEED) / 3));
    const angle = Math.atan2(v.side, Math.max(0.01, v.up));
    this.stats.throws++;
    this.h.onRelease({ charge, flick, angle });
  }

  private up = (e: PointerEvent) => {
    const t = this.tracks.get(e.pointerId);
    if (!t) return;
    this.tracks.delete(e.pointerId);
    if (t.role === 'glove') this.h.onGloveActive(false);
    else if (t.role === 'look') this.h.onLookActive(false);
    else {
      // Lifting mid-flick still throws if the thumb was clearly moving up.
      const charge = this.chargeOf(t);
      const v = this.flickVelocity(t);
      const risen = (t.maxPullY - t.y) / this.el.clientHeight;
      if (charge >= MIN_CHARGE && v.up >= FLICK_SPEED * 0.7 && risen > 0.03) this.release(t, charge, v);
      else { this.stats.cancels++; this.h.onCancel(); }
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
