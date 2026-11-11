// A short, interactive first-session guide. It never blocks play: it reads
// what you're doing and shows the one hint that matters right now.
//   look → throw (when you have the ball) → catch (when it's coming) → streak.

import type { Hand } from '../shared/pose';
import { prefs, save } from './storage';

type Skill = 'look' | 'throw' | 'catch';

export class Tutorial {
  private el: HTMLDivElement;
  private ghost: HTMLDivElement;
  private done = new Set<Skill>();
  private lookAmount = 0;
  private holding = false;
  private finished = false;
  private finale = 0;
  private current = '';

  constructor(private host: HTMLElement, private hand: () => Hand, private gripPoint: () => { x: number; y: number } | null, private canThrow: () => boolean) {
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
    if (kind === 'look') { this.lookAmount++; if (this.lookAmount > 8) this.done.add('look'); }
    if (kind === 'throw') this.done.add('throw');
    if (kind === 'catch') this.done.add('catch');
    if (kind === 'drop' && !this.done.has('catch')) this.flash('So close. Line the glove up with the ball.');
    this.render();
  }

  private flashUntil = 0;
  private flashText = '';
  private flash(t: string) { this.flashText = t; this.flashUntil = performance.now() + 2200; }

  /** Called every ~200ms with whether you hold the ball. */
  tick(holding: boolean) {
    this.holding = holding;
    this.render();
  }

  private show(id: string, html: string, ghost: 'look' | 'glove' | 'throw' | null) {
    if (this.current !== id) {
      this.current = id;
      this.el.innerHTML = html + '<button class="skip" type="button">Skip tips</button>';
      this.el.querySelector('.skip')!.addEventListener('click', () => this.finish());
      this.el.style.display = '';
      this.el.style.animation = 'none';
      void this.el.offsetWidth;
      this.el.style.animation = '';
    }
    const w = this.host.clientWidth, h = this.host.clientHeight;
    const gloveLeft = this.hand() === 'R';
    if (!ghost) { this.ghost.style.display = 'none'; return; }
    this.ghost.style.display = '';
    this.ghost.className = 'ghost ' + ghost;
    let x = 0, y = 0;
    if (ghost === 'look') { x = gloveLeft ? w * 0.72 : w * 0.28; y = h * 0.3; }
    if (ghost === 'glove') { x = gloveLeft ? w * 0.22 : w * 0.78; y = h * 0.66; }
    if (ghost === 'throw') { const g = this.gripPoint(); x = g?.x ?? w * 0.75; y = (g?.y ?? h * 0.8) - 40; }
    this.ghost.style.left = `${x}px`;
    this.ghost.style.top = `${y}px`;
  }

  private hide() {
    this.current = '';
    this.el.style.display = 'none';
    this.ghost.style.display = 'none';
  }

  private render() {
    if (this.finished) return;
    const side = this.hand() === 'R' ? 'right' : 'left';
    const other = this.hand() === 'R' ? 'left' : 'right';
    if (performance.now() < this.flashUntil) { this.show('flash' + this.flashText, this.flashText, null); return; }
    if (!this.done.has('look')) {
      this.show('look', `Drag up here on the ${side} to look around`, 'look');
      return;
    }
    if (this.holding && !this.done.has('throw')) {
      if (!this.canThrow()) { this.hide(); return; }
      this.show('throw', `Hold the ball, pull down, let go to throw<small>Pull further to throw harder. Slide sideways to aim.</small>`, 'throw');
      return;
    }
    if (!this.holding && !this.done.has('catch')) {
      this.show('catch', `Your ${other} thumb moves the glove<small>Put it where the ball is coming.</small>`, 'glove');
      return;
    }
    if (this.done.has('throw') && this.done.has('catch')) {
      if (!this.finale) this.finale = performance.now();
      this.show('streak', `That’s it. Every catch adds to the streak<small>Listen to the POP: the cleaner the catch, the better it sounds.</small>`, null);
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
    this.lookAmount = 0;
    this.finale = 0;
    save({ tutorialDone: false });
    this.render();
  }

  static needed() { return !prefs().tutorialDone; }

  destroy() { this.el.remove(); this.ghost.remove(); }
}
