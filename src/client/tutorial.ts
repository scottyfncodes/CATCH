// First-session hints. They never block play: each one reads what you're
// doing and shows the single line that matters right now, then gets out of
// the way.  throw (when you have the ball) → move (when it's coming) → streak.

import { prefs, save } from './storage';

type Skill = 'throw' | 'move' | 'catch';

export class Tutorial {
  private el: HTMLDivElement;
  private ghost: HTMLDivElement;
  private done = new Set<Skill>();
  private holding = false;
  private incoming = false;
  private finished = false;
  private finale = 0;
  private current = '';
  private flashUntil = 0;
  private flashText = '';

  constructor(private host: HTMLElement, private canThrow: () => boolean) {
    this.el = document.createElement('div');
    this.el.className = 'coach';
    this.el.setAttribute('role', 'status');
    this.ghost = document.createElement('div');
    this.ghost.className = 'ghost';
    this.el.style.display = 'none';
    this.ghost.style.display = 'none';
    host.append(this.ghost, this.el);
  }

  get active() { return !this.finished; }

  moment(kind: string) {
    if (this.finished) return;
    if (kind === 'throw') this.done.add('throw');
    if (kind === 'move') this.done.add('move');
    if (kind === 'catch') this.done.add('catch');
    if (kind === 'incoming') this.incoming = true;
    if (kind === 'catch' || kind === 'drop') this.incoming = false;
    if (kind === 'drop' && !this.done.has('catch')) this.flash('So close. Get under it a little sooner.');
    this.render();
  }

  private flash(t: string) { this.flashText = t; this.flashUntil = performance.now() + 2400; }

  /** Called every ~200ms with whether you hold the ball. */
  tick(holding: boolean) {
    this.holding = holding;
    if (holding) this.incoming = false;
    this.render();
  }

  private show(id: string, html: string, ghost: 'throw' | 'move' | null) {
    if (this.current !== id) {
      this.current = id;
      this.el.innerHTML = html + '<button class="skip" type="button">Skip tips</button>';
      this.el.querySelector('.skip')!.addEventListener('click', () => this.finish());
      this.el.style.display = '';
      this.el.style.animation = 'none';
      void this.el.offsetWidth;
      this.el.style.animation = '';
    }
    if (!ghost) { this.ghost.style.display = 'none'; return; }
    const w = this.host.clientWidth, h = this.host.clientHeight;
    this.ghost.style.display = '';
    this.ghost.className = 'ghost ' + ghost;
    this.ghost.style.left = `${w * 0.5}px`;
    this.ghost.style.top = `${h * (ghost === 'throw' ? 0.6 : 0.66)}px`;
  }

  private hide() {
    this.current = '';
    this.el.style.display = 'none';
    this.ghost.style.display = 'none';
  }

  private render() {
    if (this.finished) return;
    if (performance.now() < this.flashUntil) { this.show('flash' + this.flashText, this.flashText, null); return; }
    if (this.holding && !this.done.has('throw')) {
      if (!this.canThrow()) { this.hide(); return; }
      this.show('throw', 'Pull back and let go to throw<small>Pull further for a harder throw. Pull to one side to throw to the other.</small>', 'throw');
      return;
    }
    if (!this.holding && this.incoming && !this.done.has('catch') && !this.done.has('move')) {
      this.show('move', 'Drag to get under the ball<small>Your glove does the rest.</small>', 'move');
      return;
    }
    if (this.done.has('throw') && this.done.has('catch')) {
      if (!this.finale) this.finale = performance.now();
      this.show('streak', 'That’s it. Every catch adds to the streak<small>Listen to the POP: the cleaner the catch, the better it sounds.</small>', null);
      if (performance.now() - this.finale > 4200) this.finish();
      return;
    }
    this.hide();
  }

  finish() {
    this.finished = true;
    this.hide();
    save({ tutorialDone: true });
  }

  restart() {
    this.finished = false;
    this.done.clear();
    this.finale = 0;
    save({ tutorialDone: false });
    this.render();
  }

  static needed() { return !prefs().tutorialDone; }

  destroy() { this.el.remove(); this.ghost.remove(); }
}
