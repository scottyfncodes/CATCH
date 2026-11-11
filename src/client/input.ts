// One-thumb controls, decided at touch-down by what you're doing:
//
//   You have the ball → touch anywhere and pull back. How far you pull sets
//   how hard you throw; pulling off to one side sends it to the other (like a
//   slingshot). Let go to throw. Slide back to where you started (or pull
//   upward) and let go to cancel.
//
//   You don't → touch anywhere and drag to move. The touch point is a
//   floating stick that follows your thumb; lift to stop. Your glove reaches
//   for the ball by itself: your job is to get there.
//
// A move drag can never become a throw: the gesture type is fixed at
// touch-down, and a second finger is ignored while one is active.

export interface Aim {
  /** 0..1 from how far you pulled back. */
  power: number;
  /** Throw direction, radians from straight ahead (+ = to the right). */
  angle: number;
  /** Whether letting go now would throw. */
  armed: boolean;
}

export interface InputHandlers {
  canThrow(): boolean;
  onAimStart(): void;
  onAim(a: Aim): void;
  onThrow(a: Aim): void;
  onAimCancel(): void;
  /** Stick in screen space, -1..1, x to the right, y up the screen. */
  onMove(x: number, y: number): void;
}

type Role = 'aim' | 'move';

interface Track { role: Role; id: number; ox: number; oy: number; x: number; y: number }

/** Pull (as a fraction of the screen height) for a full-strength throw. */
const FULL_PULL = 0.27;
const DEAD = 14;
const STICK = 58;

export class Controls {
  private track: Track | null = null;
  enabled = true;
  private ring: HTMLDivElement;
  private knob: HTMLDivElement;
  private band: HTMLDivElement;
  /** Diagnostics for tests. */
  stats = { moves: 0, throws: 0, cancels: 0, aims: 0 };

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
    const role: Role = this.h.canThrow() ? 'aim' : 'move';
    try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.track = { role, id: e.pointerId, ox: x, oy: y, x, y };
    if (role === 'aim') { this.stats.aims++; this.h.onAimStart(); }
    else this.stats.moves++;
    this.draw();
  };

  private move = (e: PointerEvent) => {
    const t = this.track;
    if (!t || t.id !== e.pointerId) return;
    e.preventDefault();
    const { x, y } = this.local(e);
    t.x = x; t.y = y;
    if (t.role === 'move') {
      // Floating stick: the origin follows a thumb that runs past the edge.
      const dx = t.x - t.ox, dy = t.y - t.oy, l = Math.hypot(dx, dy);
      if (l > STICK) { t.ox = t.x - (dx / l) * STICK; t.oy = t.y - (dy / l) * STICK; }
      this.emitMove(t);
    } else {
      this.h.onAim(this.aimOf(t));
    }
    this.draw();
  };

  private emitMove(t: Track) {
    const dx = t.x - t.ox, dy = t.y - t.oy, l = Math.hypot(dx, dy);
    if (l < 4) { this.h.onMove(0, 0); return; }
    const m = Math.min(1, (l - 4) / (STICK - 4));
    this.h.onMove((dx / l) * m, (-dy / l) * m);
  }

  aimOf(t: { ox: number; oy: number; x: number; y: number }): Aim {
    const H = this.el.clientHeight || 800;
    const dx = t.x - t.ox, dy = t.y - t.oy;
    const l = Math.hypot(dx, dy);
    const power = Math.min(1, Math.max(0, (l - DEAD) / (FULL_PULL * H)));
    // Throw goes opposite the pull. Straight down = straight at your friend.
    const angle = Math.max(-1, Math.min(1, Math.atan2(-dx, Math.max(1, dy))));
    const armed = l > DEAD + 4 && dy > l * 0.3;
    return { power, angle, armed };
  }

  private up = (e: PointerEvent) => {
    const t = this.track;
    if (!t || t.id !== e.pointerId) return;
    this.track = null;
    this.hideMarks();
    if (t.role === 'move') { this.h.onMove(0, 0); return; }
    const a = this.aimOf(t);
    if (a.armed && this.h.canThrow()) { this.stats.throws++; this.h.onThrow(a); }
    else { this.stats.cancels++; this.h.onAimCancel(); }
  };

  private cancel = (e: Event) => {
    const t = this.track;
    if (!t || t.id !== (e as PointerEvent).pointerId) return;
    this.track = null;
    this.hideMarks();
    if (t.role === 'move') this.h.onMove(0, 0);
    else { this.stats.cancels++; this.h.onAimCancel(); }
  };

  /** Abort any in-progress gesture (e.g. when the ball is taken away). */
  reset() {
    const t = this.track;
    this.track = null;
    this.hideMarks();
    if (!t) return;
    if (t.role === 'move') this.h.onMove(0, 0);
    else this.h.onAimCancel();
  }

  get aiming() { return this.track?.role === 'aim'; }
  get moving() { return this.track?.role === 'move'; }

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
    if (t.role === 'move') {
      this.ring.style.opacity = '1';
      this.knob.style.opacity = '1';
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
