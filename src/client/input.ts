// One-thumb controls, decided at touch-down by what you're doing:
//
//   You have the ball → touch anywhere and pull back. An aim ring appears on
//   your friend's glove plane: pulling off to one side moves it to the other
//   side (like a slingshot), pulling further moves it higher and throws
//   harder. Put the ring on their glove and let go. Slide back to where you
//   started (or pull upward) and let go to cancel.
//
//   You don't → your thumb is your glove. Drag to put it where you want the
//   throw (that's your friend's target); it stays where you leave it. Slow
//   drags are precise, quick ones cover ground, and pushing it past your reach
//   makes you step over after it.
//
// The gesture type is fixed at touch-down, and a second finger is ignored
// while one is active.

export interface Aim {
  /** 0..1 from how far you pulled back. */
  power: number;
  /** Sideways pull in CSS px (+ = pulled to the right). */
  side: number;
  /** Whether letting go now would throw. */
  armed: boolean;
}

export interface InputHandlers {
  canThrow(): boolean;
  onAimStart(): void;
  onAim(a: Aim): void;
  onThrow(a: Aim): void;
  onAimCancel(): void;
  /** Glove drag: movement since the last event in CSS px (x right, y up), and its speed in px/ms. */
  onGlove(dx: number, dy: number, speed: number): void;
  onGloveActive(active: boolean): void;
}

type Role = 'aim' | 'glove';

interface Track { role: Role; id: number; ox: number; oy: number; x: number; y: number; t: number }

/** Pull (as a fraction of the screen height) for a full-strength throw. */
export const FULL_PULL = 0.27;
export const DEAD = 14;

export class Controls {
  private track: Track | null = null;
  enabled = true;
  private ring: HTMLDivElement;
  private knob: HTMLDivElement;
  private band: HTMLDivElement;
  /** Diagnostics for tests. */
  stats = { gloves: 0, throws: 0, cancels: 0, aims: 0 };

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
    this.ring = document.createElement('div');
    this.ring.className = 'touch-ring';
    this.band = document.createElement('div');
    this.band.className = 'touch-band';
    this.knob = document.createElement('div');
    this.knob.className = 'touch-knob';
    el.append(this.ring, this.band, this.knob);
    this.hideMarks();
  }

  private local(e: PointerEvent) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private down = (e: PointerEvent) => {
    e.preventDefault();
    if (!this.enabled || this.track) return;
    const { x, y } = this.local(e);
    const role: Role = this.h.canThrow() ? 'aim' : 'glove';
    try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.track = { role, id: e.pointerId, ox: x, oy: y, x, y, t: e.timeStamp };
    if (role === 'aim') { this.stats.aims++; this.h.onAimStart(); }
    else { this.stats.gloves++; this.h.onGloveActive(true); }
    this.draw();
  };

  private move = (e: PointerEvent) => {
    const t = this.track;
    if (!t || t.id !== e.pointerId) return;
    e.preventDefault();
    const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ev of evs.length ? evs : [e]) {
      const { x, y } = this.local(ev);
      if (t.role === 'glove') {
        const dx = x - t.x, dy = y - t.y;
        const dt = Math.max(1, ev.timeStamp - t.t);
        this.h.onGlove(dx, -dy, Math.hypot(dx, dy) / dt);
      }
      t.x = x; t.y = y; t.t = ev.timeStamp;
    }
    if (t.role === 'aim') this.h.onAim(this.aimOf(t));
    this.draw();
  };

  aimOf(t: { ox: number; oy: number; x: number; y: number }): Aim {
    const H = this.el.clientHeight || 800;
    const dx = t.x - t.ox, dy = t.y - t.oy;
    const power = Math.min(1, Math.max(0, (dy - DEAD) / (FULL_PULL * H)));
    const armed = dy > DEAD + 4 && dy > Math.abs(dx) * 0.35;
    return { power, side: dx, armed };
  }

  private up = (e: PointerEvent) => {
    const t = this.track;
    if (!t || t.id !== e.pointerId) return;
    this.track = null;
    this.hideMarks();
    if (t.role === 'glove') { this.h.onGloveActive(false); return; }
    const a = this.aimOf(t);
    if (a.armed && this.h.canThrow()) { this.stats.throws++; this.h.onThrow(a); }
    else { this.stats.cancels++; this.h.onAimCancel(); }
  };

  private cancel = (e: Event) => {
    const t = this.track;
    if (!t || t.id !== (e as PointerEvent).pointerId) return;
    this.track = null;
    this.hideMarks();
    if (t.role === 'glove') this.h.onGloveActive(false);
    else { this.stats.cancels++; this.h.onAimCancel(); }
  };

  /** Abort any in-progress gesture (e.g. when the ball is taken away). */
  reset() {
    const t = this.track;
    this.track = null;
    this.hideMarks();
    if (!t) return;
    if (t.role === 'glove') this.h.onGloveActive(false);
    else this.h.onAimCancel();
  }

  get aiming() { return this.track?.role === 'aim'; }
  get gloving() { return this.track?.role === 'glove'; }

  // ---- the only on-screen control marks, and only under your thumb

  private hideMarks() {
    for (const m of [this.ring, this.knob, this.band]) m.style.opacity = '0';
  }

  private draw() {
    const t = this.track;
    if (!t) return;
    const put = (m: HTMLElement, x: number, y: number) => { m.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`; };
    put(this.ring, t.ox, t.oy);
    put(this.knob, t.x, t.y);
    this.ring.dataset.role = t.role;
    this.knob.dataset.role = t.role;
    if (t.role === 'glove') {
      // Just a soft dot under the thumb: the glove itself is the feedback.
      this.ring.style.opacity = '0';
      this.knob.style.opacity = '0.7';
      this.band.style.opacity = '0';
      return;
    }
    const a = this.aimOf(t);
    const dx = t.x - t.ox, dy = t.y - t.oy, l = Math.hypot(dx, dy);
    this.ring.style.opacity = '1';
    this.knob.style.opacity = a.armed ? '1' : '0.45';
    this.band.style.opacity = a.armed ? String(0.35 + 0.5 * a.power) : '0.15';
    this.band.style.width = `${l.toFixed(1)}px`;
    this.band.style.transform = `translate(${t.ox.toFixed(1)}px, ${t.oy.toFixed(1)}px) rotate(${Math.atan2(dy, dx).toFixed(3)}rad)`;
    this.knob.style.setProperty('--p', a.power.toFixed(2));
  }
}
