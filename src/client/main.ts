import './style.css';
import * as THREE from 'three';
import { CHEST_HEIGHT } from '../shared/constants';
import { positionAt, simulateFlight, solveThrowTo, type Trajectory } from '../shared/physics';
import { type Hand, clampReach, gloveReady, interceptPlan, lookAngles, seatLayout } from '../shared/pose';
import { Arm, MODES, type Mode, type BallEvent, type PlayerInfo, type ScoreState, isGreatCatch, isRoomCode, randomRoomCode, sanitizeName } from '../shared/protocol';
import type { Vec3 } from '../shared/vec';
import { sameStyle } from '../shared/style';
import { DEFAULT_WINDUP, HOUSE_WINDUP, RELEASE_TIME, WINDUPS, getWindup, releasePointFor } from '../shared/windups';
import { audio } from './audio';
import { Game } from './game';
import { haptic } from './haptics';
import type { NetStatus } from './net';
import { serverHttpUrl } from './net';
import { BUILDS, GLOVES, HAIRS, HAIR_COLORS, HATS, type Kind, MILESTONES, PANTS, S, SKINS, type Style, TOPS, defaultStyle, nextMilestone, owns, rewardAt } from '../shared/style';
import { Avatar } from './scene/avatar';
import { buildBall } from './scene/gear';
import { CameraRig } from './scene/camera';
import { buildWorld } from './scene/world';
import { prefs, save } from './storage';
import { Tutorial } from './tutorial';

const app = document.getElementById('app')!;
const ui = document.getElementById('ui')!;
const canvas = document.getElementById('gl') as HTMLCanvasElement;
const touch = document.getElementById('touch')!;

const ICON = {
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.5"/><rect x="14" y="5" width="4" height="14" rx="1.5"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// Warm the room server while the player reads the home screen (free hosts sleep).
try { fetch(serverHttpUrl() + '/health', { cache: 'no-store', mode: 'cors' }).catch(() => {}); } catch { /* ignore */ }

// ------------------------------------------------------------------ renderer

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// ------------------------------------------------------------------ home backdrop: two friends playing catch

class Backdrop {
  private world = buildWorld(true, renderer);
  private rig = new CameraRig();
  private avatars: Avatar[] = [];
  private seats = seatLayout(2);
  private ball = buildBall();
  private traj: Trajectory | null = null;
  private from = 0;
  private cycle = -1;
  private caught = false;
  private transferred = false;
  private raf = 0;
  private last = 0;
  private running = false;
  private t = 0;
  /** The windup selector's model: one player, throwing your delivery on a loop. */
  private model: Avatar | null = null;
  private show: { id: number; t: number; look: boolean } | null = null;
  private cam = new THREE.PerspectiveCamera(40, 1, 0.1, 600);

  constructor() {
    this.seats.forEach((s, i) => {
      // Two friends, two deliveries.
      const a = new Avatar(s.pos, s.yaw, i === 0 ? 'R' : 'L', i === 0 ? prefs().style : defaultStyle('a friend'), i === 0 ? DEFAULT_WINDUP : HOUSE_WINDUP);
      this.world.scene.add(a.root);
      this.avatars.push(a);
    });
    this.world.scene.add(this.ball);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.t += dt;
      if (this.show) this.frameShowcase(dt); else this.frame(this.t, dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() { this.running = false; cancelAnimationFrame(this.raf); }

  /** Show one player throwing windup `id` (or go back to the two friends with null). */
  showcase(id: number | null, hand: Hand = 'R', style: Style = prefs().style, look = false) {
    if (id === null) {
      this.show = null;
      if (this.model) this.model.root.visible = false;
      // The friend in the foreground of the home screen is you: wear what you just chose.
      if (!sameStyle(this.avatars[0].style, prefs().style)) {
        const old = this.avatars[0];
        this.avatars[0] = new Avatar(this.seats[0].pos, this.seats[0].yaw, old.hand, prefs().style, old.windupId);
        this.world.scene.add(this.avatars[0].root);
        old.dispose();
      }
      for (const a of this.avatars) a.root.visible = true;
      this.rig.reset();
      return;
    }
    const seat = this.seats[0];
    if (!this.model || this.model.hand !== hand || !sameStyle(this.model.style, style)) {
      this.model?.dispose();
      this.model = new Avatar(seat.pos, seat.yaw, hand, style, id);
      this.world.scene.add(this.model.root);
    }
    this.model.setWindup(id);
    this.model.root.visible = true;
    this.model.teleport(seat.pos, lookAngles(seat.pos, this.seats[1].pos).yaw);
    for (const a of this.avatars) a.root.visible = false;
    this.show = { id, t: look && this.show?.look ? this.show.t : 0, look };
  }

  /** The selector's loop: set, wind up, hold the top for a beat, deliver, watch it go, again. */
  private frameShowcase(dt: number) {
    const s = this.show!, av = this.model!;
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    const seat = this.seats[0], other = this.seats[1];
    const yaw = lookAngles(seat.pos, other.pos).yaw;
    if (s.look) { this.frameLook(dt, s, av, yaw, w, h); return; }
    const wu = getWindup(s.id);
    const SET = 0.55, top = SET + wu.params.tempo, go = top + 0.3, rel = go + RELEASE_TIME, end = go + 1.9;
    s.t += dt;
    if (s.t > end) { s.t = 0; this.traj = null; }
    let arm: number = Arm.Holding, charge = 0;
    if (s.t >= go && s.t < go + RELEASE_TIME + 0.45) arm = Arm.Release;
    else if (s.t >= SET && s.t < go) { arm = Arm.Windup; charge = Math.min(1, (s.t - SET) / wu.params.tempo); }
    else if (s.t >= go) arm = Arm.Idle;
    av.update(dt, { pose: { x: seat.pos[0], z: seat.pos[2], yaw, g: gloveReady(yaw, av.hand) }, arm, charge, look: [other.pos[0], 1.5, other.pos[2]] });
    if (s.t >= rel) {
      if (!this.traj) {
        const p = releasePointFor(s.id, seat.pos, yaw, av.hand);
        this.traj = simulateFlight(p, solveThrowTo(p, [other.pos[0], CHEST_HEIGHT, other.pos[2]], 0.95));
      }
      const bp = positionAt(this.traj, s.t - rel);
      this.ball.position.set(bp[0], bp[1], bp[2]);
      this.ball.visible = s.t - rel < 0.95;
    } else {
      this.ball.position.copy(av.handBall);
      this.ball.visible = true;
    }
    // A three-quarter view from the front, on the open side, with the player in
    // the upper part of the screen (the sheet has the bottom).
    const f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), r = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const side = av.hand === 'R' ? 1 : -1;
    const portrait = w < h;
    const dist = portrait ? 7.0 : 5.4;
    const at = new THREE.Vector3(seat.pos[0], 0, seat.pos[2]).addScaledVector(f, 0.6);
    this.cam.position.copy(at).addScaledVector(f, dist * 0.8).addScaledVector(r, side * dist * 0.6).setY(1.35);
    this.cam.lookAt(at.x, portrait ? 0.15 : 1.0, at.z);
    this.cam.fov = portrait ? 46 : 34;
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
    this.ball.scale.setScalar(1);
    this.world.update(dt, this.t);
    renderer.render(this.world.scene, this.cam);
  }

  /** The look editor: your player standing easy, turning slowly so you can see all of it, glove working now and then. */
  private frameLook(dt: number, s: { t: number }, av: Avatar, yaw: number, w: number, h: number) {
    const seat = this.seats[0];
    s.t += dt;
    const turn = yaw + Math.PI + Math.sin(s.t * 0.5) * 1.15;
    // Glove held easy, in close.
    const g = gloveReady(turn, av.hand);
    g[0] *= 0.75; g[2] *= 0.75; g[1] += 0.08;
    // Every few seconds the glove snaps shut, as if a ball had just arrived.
    const beat = s.t % 3.2;
    if (beat < dt) av.catchImpact([0, -0.2, 1], 12);
    av.update(dt, { pose: { x: seat.pos[0], z: seat.pos[2], yaw: turn, g }, arm: Arm.Idle, charge: 0, look: null, gloved: beat < 0.5, ready: beat > 2.5 });
    this.ball.visible = false;
    const f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const portrait = w < h;
    // Head to toe in the part of the screen the sheet leaves free.
    const dist = portrait ? 6.0 : 3.6;
    this.cam.position.set(seat.pos[0], 1.3, seat.pos[2]).addScaledVector(f, -dist);
    this.cam.lookAt(seat.pos[0], portrait ? -0.5 : 1.0, seat.pos[2]);
    this.cam.fov = portrait ? 46 : 36;
    this.cam.aspect = w / h;
    this.cam.updateProjectionMatrix();
    this.world.update(dt, this.t);
    renderer.render(this.world.scene, this.cam);
  }

  private frame(t: number, dt: number) {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    // A lazy rhythm: hold, wind up, deliver, catch, take it out of the glove, swap.
    const PERIOD = 4.3, WIND = 0.7, GO = 2.2, REL = GO + RELEASE_TIME;
    const c = Math.floor(t / PERIOD);
    const ft = t - c * PERIOD;
    if (c !== this.cycle) {
      this.cycle = c;
      this.from = ((c % 2) + 2) % 2; // (the clock can start a hair below zero)
      this.traj = null;
      this.caught = false;
      this.transferred = false;
    }
    const th = this.avatars[this.from], ca = this.avatars[1 - this.from];
    const ts = this.seats[this.from], cs = this.seats[1 - this.from];
    if (!this.traj) {
      const yaw = lookAngles(ts.pos, cs.pos).yaw;
      const p = releasePointFor(th.windupId, ts.pos, yaw, th.hand);
      const wob = Math.sin(c * 2.3);
      const target: Vec3 = [cs.pos[0] + wob * 0.35, CHEST_HEIGHT - 0.1 + Math.cos(c * 1.7) * 0.2, cs.pos[2]];
      this.traj = simulateFlight(p, solveThrowTo(p, target, 1.15));
    }
    const fl = ft - REL;
    const plan = interceptPlan(this.traj, 0, cs.pos[0], cs.pos[2]);
    const flying = fl >= 0 && fl < plan.t;
    if (!flying && fl >= plan.t && !this.caught) { this.caught = true; ca.catchImpact([0, -0.2, 1], 12); }
    if (this.caught && !this.transferred && fl > plan.t + 0.32) { this.transferred = true; ca.transfer(); }
    const ballPos: Vec3 = flying ? positionAt(this.traj, fl) : [0, 0, 0];
    this.avatars.forEach((av, i) => {
      const seat = this.seats[i];
      const other = this.seats[1 - i];
      const yaw = lookAngles(seat.pos, other.pos).yaw;
      let g = gloveReady(yaw, av.hand);
      let arm: number = Arm.Idle, charge = 0;
      if (av === th) {
        if (ft < GO) {
          arm = ft > WIND ? Arm.Windup : Arm.Holding;
          charge = ft > WIND ? Math.min(1, (ft - WIND) / getWindup(av.windupId).params.tempo) : 0;
        } else if (ft < REL + 0.45) arm = Arm.Release;
      } else {
        if (fl > plan.t - 0.7) g = clampReach([plan.point[0] - seat.pos[0], plan.point[1], plan.point[2] - seat.pos[2]]);
        if (this.caught) arm = Arm.Holding;
      }
      const look: Vec3 = flying ? ballPos : [other.pos[0], 1.5, other.pos[2]];
      av.update(dt, { pose: { x: seat.pos[0], z: seat.pos[2], yaw, g }, arm, charge, look, gloved: this.caught && !this.transferred });
    });
    this.ball.visible = true;
    if (flying) this.ball.position.set(ballPos[0], ballPos[1], ballPos[2]);
    else if (fl < 0) this.ball.position.copy(th.handBall);
    else this.ball.position.copy(this.transferred ? ca.handBall : ca.gloveWorldPos);
    this.ball.scale.setScalar(Math.max(1, this.rig.camera.position.distanceTo(this.ball.position) * 0.13));
    this.rig.aspect = w / h;
    this.rig.update(dt, { me: this.seats[0].pos, partner: this.seats[1].pos, ball: flying ? ballPos : null, side: -1 });
    this.world.update(dt, t);
    renderer.render(this.world.scene, this.rig.camera);
  }
}

const backdrop = new Backdrop();

// ------------------------------------------------------------------ screens

function setUI(html: string) { ui.innerHTML = html; }

function home(notice?: string) {
  game?.destroy(); game = null; tutorial?.destroy(); tutorial = null;
  app.classList.remove('playing');
  if (location.pathname !== '/') history.pushState({}, '', '/');
  backdrop.start();
  setUI(`
    <main class="home">
      <h1 class="wordmark">CATCH<i>.</i></h1>
      <p class="tagline">Two people. One ball.<br/>Keep it off the grass.</p>
      <div class="spacer"></div>
      <div class="stack">
        <button class="btn btn-primary" data-act="play">PLAY CATCH</button>
        <button class="btn btn-glass" data-act="join">JOIN FRIEND</button>
        <div class="pair three">
          <button class="btn btn-text" data-act="look" aria-label="Change how your player looks${prefs().fresh.length ? '. New items unlocked' : ''}">LOOK${prefs().fresh.length ? '<i class="new-dot"></i>' : ''}</button>
          <button class="btn btn-text" data-act="windup" aria-label="Choose your windup. Current: number ${getWindup(prefs().windup).id}">WINDUP <b class="num">${getWindup(prefs().windup).label}</b></button>
          <button class="btn btn-text" data-act="settings">SETTINGS</button>
        </div>
      </div>
      <div class="credit">by HaveAnApp</div>
      ${notice ? `<div class="chip notice" role="alert">${esc(notice)}</div>` : ''}
    </main>`);
  ui.querySelector('[data-act=play]')!.addEventListener('click', () => {
    audio.unlock();
    ensureProfile('Before you head out', () => modeSheet((mode) => enterRoom(randomRoomCode(), mode)));
  });
  ui.querySelector('[data-act=join]')!.addEventListener('click', () => { audio.unlock(); joinSheet(); });
  ui.querySelector('[data-act=settings]')!.addEventListener('click', () => settingsSheet(() => home()));
  ui.querySelector('[data-act=windup]')!.addEventListener('click', () => { audio.unlock(); windupSheet(() => home()); });
  ui.querySelector('[data-act=look]')!.addEventListener('click', () => { audio.unlock(); lookSheet(() => home()); });
}

function sheet(html: string, onClose?: () => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div class="scrim"></div><div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  ui.appendChild(wrap);
  const close = () => { wrap.remove(); onClose?.(); };
  wrap.querySelector('.scrim')!.addEventListener('click', close);
  (wrap as unknown as { close: () => void }).close = close;
  return wrap;
}
const closeSheet = (el: HTMLElement) => (el as unknown as { close: () => void }).close();

function handSeg(cur: Hand) {
  return `<div class="seg" role="group" aria-label="Throwing hand">
    <button type="button" data-hand="R" aria-pressed="${cur === 'R'}">Right-handed</button>
    <button type="button" data-hand="L" aria-pressed="${cur === 'L'}">Left-handed</button>
  </div>`;
}

function bindHand(root: HTMLElement, onPick: (h: Hand) => void) {
  root.querySelectorAll<HTMLButtonElement>('[data-hand]').forEach((b) => b.addEventListener('click', () => {
    root.querySelectorAll('[data-hand]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    onPick(b.dataset.hand as Hand);
  }));
}

function handHint(h: Hand) {
  return h === 'R' ? 'You throw with your right arm; the glove goes on your left.' : 'You throw with your left arm; the glove goes on your right.';
}

function ensureProfile(title: string, then: () => void, sub?: string) {
  const p = prefs();
  if (p.profiled && p.name) { then(); return; }
  let hand: Hand = p.hand;
  const el = sheet(`
    <h2>${esc(title)}</h2>
    <p class="sub">${esc(sub ?? 'Your friends will see this above your head.')}</p>
    <label class="field"><span>Name</span>
      <input class="input" id="pname" maxlength="14" autocomplete="nickname" autocapitalize="words" enterkeyhint="done" placeholder="Your name" value="${esc(p.name)}" />
    </label>
    <div class="field"><span>Throwing hand</span>${handSeg(hand)}<p class="hint" id="hhint">${handHint(hand)}</p></div>
    <div class="actions"><button class="btn btn-ink" id="go">Let’s play</button></div>`);
  const input = el.querySelector<HTMLInputElement>('#pname')!;
  const go = el.querySelector<HTMLButtonElement>('#go')!;
  const sync = () => { go.disabled = !input.value.trim(); };
  input.addEventListener('input', sync);
  sync();
  bindHand(el, (h) => { hand = h; el.querySelector('#hhint')!.textContent = handHint(h); });
  const submit = () => {
    if (!input.value.trim()) { input.focus(); return; }
    audio.unlock();
    save({ name: sanitizeName(input.value), hand, profiled: true });
    el.remove();
    then();
  };
  go.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { input.blur(); submit(); } });
  if (!p.name) setTimeout(() => input.focus(), 320);
}

function joinSheet(prefill = '') {
  const el = sheet(`
    <h2>Join a friend</h2>
    <p class="sub">Enter the four-letter code from their invite.</p>
    <input class="input code-input" id="code" maxlength="4" inputmode="text" autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="go" placeholder="····" value="${esc(prefill)}" aria-label="Room code" />
    <p class="hint" id="cerr">&nbsp;</p>
    <div class="actions two"><button class="btn btn-quiet" id="back">Back</button><button class="btn btn-ink" id="go" disabled>Join</button></div>`);
  const input = el.querySelector<HTMLInputElement>('#code')!;
  const go = el.querySelector<HTMLButtonElement>('#go')!;
  const sync = () => {
    input.value = input.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    go.disabled = !isRoomCode(input.value);
    el.querySelector('#cerr')!.innerHTML = input.value.length === 4 && !isRoomCode(input.value) ? 'Codes don’t use I, L or O.' : '&nbsp;';
  };
  input.addEventListener('input', sync);
  sync();
  el.querySelector('#back')!.addEventListener('click', () => closeSheet(el));
  const submit = () => {
    if (!isRoomCode(input.value)) return;
    const code = input.value;
    el.remove();
    audio.unlock();
    ensureProfile('Almost there', () => enterRoom(code));
  };
  go.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  setTimeout(() => input.focus(), 320);
}

function settingsBody(): string {
  const p = prefs();
  return `
    <section>
      <label class="field"><span>Name</span><input class="input" id="sname" maxlength="14" autocomplete="nickname" value="${esc(p.name)}" placeholder="Your name"/></label>
      <div class="field" style="margin:0"><span>Throwing hand</span>${handSeg(p.hand)}<p class="hint" id="hhint">${handHint(p.hand)}</p></div>
    </section>
    <section>
      <div class="row"><label for="vol">Volume</label><input id="vol" type="range" min="0" max="1" step="0.05" value="${p.volume}"/></div>
      <div class="row"><label id="hapl">Haptics</label><button class="toggle" id="hap" role="switch" aria-labelledby="hapl" aria-checked="${p.haptics}"></button></div>
      <p class="hint">Sound plays even with the silent switch on. Haptics depend on your phone and browser.</p>
    </section>
    <section>
      <button class="btn btn-quiet btn-sm" id="tut" style="width:100%">Show the how-to-play tips again</button>
    </section>`;
}

function bindSettings(el: HTMLElement) {
  const name = el.querySelector<HTMLInputElement>('#sname')!;
  name.addEventListener('change', () => {
    const n = sanitizeName(name.value);
    save({ name: n, profiled: true });
    game?.setName(n);
  });
  bindHand(el, (h) => { save({ hand: h }); el.querySelector('#hhint')!.textContent = handHint(h); game?.setHand(h); });
  el.querySelector<HTMLInputElement>('#vol')!.addEventListener('input', (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    save({ volume: v }); audio.setVolume(v);
  });
  const hap = el.querySelector<HTMLButtonElement>('#hap')!;
  hap.addEventListener('click', () => { const on = hap.getAttribute('aria-checked') !== 'true'; hap.setAttribute('aria-checked', String(on)); save({ haptics: on }); });
  el.querySelector('#tut')!.addEventListener('click', () => {
    save({ tutorialDone: false });
    if (tutorial) tutorial.restart();
    else if (game) startTutorial();
    closeSheet(el);
  });
}

/**
 * The windup selector: your player throws the delivery on the field behind
 * the sheet, on a loop; tap a number and that's how you throw. Saved at once.
 */
function windupSheet(onClose?: () => void) {
  const inGame = !!game;
  const preview = (id: number) => backdrop.showcase(id, prefs().hand, prefs().style);
  ui.querySelector('.home')?.setAttribute('hidden', '');
  app.classList.add('choosing');
  if (game) game.renderEnabled = false;
  preview(prefs().windup);
  backdrop.start();
  const tiles = WINDUPS.map((w) => `
    <button type="button" class="jersey" role="radio" data-id="${w.id}" aria-checked="${w.id === prefs().windup}" aria-label="Number ${w.id}: ${esc(w.blurb)}">
      <span>${String(w.id).padStart(2, '0')}</span>
    </button>`).join('');
  const el = sheet(`
    <div class="wu-head"><h2>Windup</h2><b class="wu-num" id="wunum"></b></div>
    <p class="sub" id="wublurb"></p>
    <div class="jerseys" role="radiogroup" aria-label="Windup">${tiles}</div>
    <div class="actions"><button class="btn btn-ink" id="done">Done</button></div>`, () => {
    app.classList.remove('choosing');
    backdrop.showcase(null);
    if (inGame && game) { backdrop.stop(); game.renderEnabled = true; }
    onClose?.();
  });
  el.classList.add('clear');
  const sync = (smoothly: boolean) => {
    const w = getWindup(prefs().windup);
    el.querySelector('#wunum')!.textContent = w.label;
    el.querySelector('#wublurb')!.textContent = w.blurb;
    el.querySelectorAll<HTMLButtonElement>('.jersey').forEach((b) => {
      const on = Number(b.dataset.id) === w.id;
      b.setAttribute('aria-checked', String(on));
      if (on) b.scrollIntoView({ block: 'nearest', inline: 'center', behavior: smoothly ? 'smooth' : 'auto' });
    });
  };
  el.querySelectorAll<HTMLButtonElement>('.jersey').forEach((b) => b.addEventListener('click', () => {
    const id = Number(b.dataset.id);
    save({ windup: id });
    game?.setWindup(id);
    preview(id);
    haptic('light');
    sync(true);
  }));
  el.querySelector('#done')!.addEventListener('click', () => closeSheet(el));
  sync(false);
}

/**
 * The look editor. Your player stands on the field behind the sheet, turning
 * slowly; what you tap is what they wear, saved at once and shown to everyone
 * you play with. Things you haven't earned yet say what earns them.
 */
function lookSheet(onClose?: () => void) {
  const inGame = !!game;
  let tab = prefs().fresh.length ? (rewardAt(prefs().fresh[0])?.kind ?? 'body') : 'body';
  const fresh = new Set(prefs().fresh);
  save({ fresh: [] });
  ui.querySelector('.home')?.setAttribute('hidden', '');
  app.classList.add('choosing');
  if (game) game.renderEnabled = false;
  const preview = () => backdrop.showcase(prefs().windup, prefs().hand, prefs().style, true);
  preview();
  backdrop.start();
  const el = sheet(`
    <div class="wu-head"><h2>Look</h2><b class="wu-num" id="lknext"></b></div>
    <div class="tabs" role="tablist">
      ${[['body', 'Body'], ['hat', 'Hat'], ['glove', 'Glove'], ['top', 'Clothes']].map(([k, n]) => `<button type="button" role="tab" data-tab="${k}">${n}</button>`).join('')}
    </div>
    <div class="look" id="lkbody"></div>
    <div class="actions"><button class="btn btn-ink" id="done">Done</button></div>`, () => {
    app.classList.remove('choosing');
    backdrop.showcase(null);
    if (inGame && game) { backdrop.stop(); game.renderEnabled = true; }
    onClose?.();
  });
  el.classList.add('clear');
  const set = (i: number, v: number) => {
    const st = [...prefs().style] as Style;
    st[i] = v;
    save({ style: st });
    game?.setStyle(st);
    preview();
    haptic('light');
    render();
  };
  const swatches = (label: string, i: number, colors: string[]) => `
    <div class="lk-row"><span>${label}</span><div class="swatches" role="radiogroup" aria-label="${label}">
      ${colors.map((c, k) => `<button type="button" class="swatch" role="radio" aria-checked="${prefs().style[i] === k}" aria-label="${label} ${k + 1}" data-set="${i}:${k}" style="--c:${c}"></button>`).join('')}
    </div></div>`;
  const chips = (label: string, i: number, names: string[]) => `
    <div class="lk-row"><span>${label}</span><div class="chips" role="radiogroup" aria-label="${label}">
      ${names.map((n, k) => `<button type="button" class="pick" role="radio" aria-checked="${prefs().style[i] === k}" data-set="${i}:${k}">${esc(n)}</button>`).join('')}
    </div></div>`;
  const items = (kind: Kind, i: number, list: { name: string; at: number }[], color: (k: number) => string) => `
    <div class="items" role="radiogroup" aria-label="${kind}">
      ${list.map((it, k) => {
        const mine = owns(kind, k, prefs().earned);
        return `<button type="button" class="item${mine ? '' : ' locked'}" role="radio" aria-checked="${prefs().style[i] === k}" ${mine ? `data-set="${i}:${k}"` : 'aria-disabled="true"'}
          aria-label="${esc(it.name)}${mine ? '' : `, earned at ${it.at} in a row`}">
          <i style="--c:${color(k)}"></i><b>${esc(it.name)}</b>
          <small>${mine ? (fresh.has(it.at) ? 'New' : it.at ? `Earned at ${it.at}` : '&nbsp;') : `${it.at} in a row`}</small>
        </button>`;
      }).join('')}
    </div>`;
  function render() {
    el.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    const body = el.querySelector<HTMLElement>('#lkbody')!;
    body.innerHTML = tab === 'body'
      ? swatches('Skin', S.skin, SKINS) + chips('Build', S.build, BUILDS.map((b) => b.name)) + chips('Hair', S.hair, HAIRS) + swatches('Hair colour', S.hairColor, HAIR_COLORS)
      : tab === 'hat' ? items('hat', S.hat, HATS, (k) => HATS[k].shape === 'none' ? 'transparent' : HATS[k].color)
      : tab === 'glove' ? items('glove', S.glove, GLOVES, (k) => GLOVES[k].leather)
      : items('top', S.top, TOPS, (k) => TOPS[k].color) + swatches('Trousers', S.pants, PANTS);
    body.querySelectorAll<HTMLButtonElement>('[data-set]').forEach((b) => b.addEventListener('click', () => {
      const [i, v] = b.dataset.set!.split(':').map(Number);
      set(i, v);
    }));
    const next = MILESTONES.find((m) => !prefs().earned.includes(m));
    const r = next ? rewardAt(next) : null;
    el.querySelector('#lknext')!.textContent = r ? `Next: ${r.name} at ${next}` : 'Everything earned';
  }
  el.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab as typeof tab; render(); }));
  el.querySelector('#done')!.addEventListener('click', () => closeSheet(el));
  render();
}

/** A streak milestone: something new to wear, once. Returns what it was (or null if you already had it). */
function earn(milestone: number): string | null {
  const p = prefs();
  const r = rewardAt(milestone);
  if (!r || p.earned.includes(milestone)) return null;
  save({ earned: [...p.earned, milestone], fresh: [...p.fresh, milestone] });
  return r.name;
}

function settingsSheet(onClose?: () => void) {
  const el = sheet(`<h2>Settings</h2><p class="sub">Saved on this device.</p>${settingsBody()}
    <div class="actions"><button class="btn btn-ink" id="done">Done</button></div>`, onClose);
  bindSettings(el);
  el.querySelector('#done')!.addEventListener('click', () => closeSheet(el));
}

// ------------------------------------------------------------------ playing

let game: Game | null = null;
let tutorial: Tutorial | null = null;
let hud: HTMLElement | null = null;
let roster: PlayerInfo[] = [];
let me: string | null = null;
let lastStreak = 0;
let statusTimer = 0;
let tutTimer = 0;

function inviteUrl(code: string) { return `${location.origin}/r/${code}`; }

async function invite(code: string) {
  const url = inviteUrl(code);
  const nav = navigator as Navigator & { share?: (d: ShareData) => Promise<void> };
  try {
    if (nav.share) { await nav.share({ title: 'CATCH.', text: `Come play catch. Room ${code}`, url }); return; }
  } catch (e) { if ((e as Error).name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
  catch { toast(`Room code: ${code}`); }
}

function toast(text: string) {
  if (!hud) return;
  hud.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'chip toast';
  t.textContent = text;
  hud.appendChild(t);
  setTimeout(() => t.remove(), 2700);
}

const MODE_INFO: Record<Mode, { name: string; line: string }> = {
  long: { name: 'Long toss', line: 'Every catch is a step further apart.' },
  fixed: { name: 'Classic', line: 'Stay 46 feet apart. Just play catch.' },
  mitt: { name: 'Big mitt', line: 'Giant gloves that shrink with every catch.' },
};

/** Which game to play. Whoever opens the room chooses; friends who join play the same one. */
function modeSheet(then: (mode: Mode) => void) {
  const last = prefs().mode;
  const el = sheet(`
    <h2>Pick a game</h2>
    <p class="sub">Friends who join your room play the same one.</p>
    <div class="modes" role="group" aria-label="Game">
      ${MODES.map((m) => `<button type="button" class="mode" data-mode="${m}" ${m === last ? 'data-last' : ''}>
        <b>${MODE_INFO[m].name}</b><span>${MODE_INFO[m].line}</span></button>`).join('')}
    </div>`);
  el.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    const mode = b.dataset.mode as Mode;
    save({ mode });
    audio.unlock();
    el.remove();
    then(mode);
  }));
}

function enterRoom(code: string, mode?: Mode) {
  backdrop.stop();
  audio.unlock();
  audio.setVolume(prefs().volume);
  audio.startAmbience();
  if (location.pathname !== `/r/${code}`) history.pushState({}, '', `/r/${code}${location.search}`);
  app.classList.add('playing');
  roster = []; me = null; lastStreak = 0; lastProgress = '';
  setUI(`
    <div class="hud">
      <div class="streak" aria-live="polite"><b id="streak">0</b><span id="streakLabel">in a row</span><em class="grade" id="grade"></em></div>
      <div class="corner left"><button class="chip tap" id="inviteBtn" aria-label="Invite friends to room ${code}">${ICON.share}<span>${code}</span></button></div>
      <div class="corner right"><button class="chip icon-btn tap" id="pauseBtn" aria-label="Pause and settings">${ICON.pause}</button></div>
      <div class="chip status" id="status" hidden><span class="pulse"></span><span id="statusText">Connecting…</span></div>
      <button class="chip company tap" id="company" hidden>Coach is keeping you company · <u>Invite a friend</u></button>
    </div>`);
  hud = ui.querySelector('.hud');
  ui.querySelector('#inviteBtn')!.addEventListener('click', () => invite(code));
  ui.querySelector('#company')!.addEventListener('click', () => invite(code));
  ui.querySelector('#pauseBtn')!.addEventListener('click', () => pauseSheet(code));

  game = new Game(app, renderer, touch, code, {
    status: onStatus,
    roster: (players, id) => { roster = players; me = id; updateCompany(); },
    score: onScore,
    moment: (k) => tutorial?.moment(k),
    toast,
    view: (first) => {
      app.classList.toggle('eyes', first);
      // Reduced motion: the view changes at once, under a quick dip instead of a move.
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        app.classList.remove('cut'); void app.offsetWidth; app.classList.add('cut');
      }
    },
  }, mode);
  (window as unknown as { __catch: unknown }).__catch = { game, tutorial: () => tutorial };
  game.start();
  onStatus('connecting');
  if (Tutorial.needed()) startTutorial();
}

function startTutorial() {
  if (!game || !hud) return;
  const g = game;
  tutorial?.destroy();
  tutorial = new Tutorial(hud, () => g.canThrow());
  clearInterval(tutTimer);
  tutTimer = window.setInterval(() => {
    if (!tutorial || !game) { clearInterval(tutTimer); return; }
    const s = game.debugState();
    tutorial.tick(s.ball.phase === 'held' && s.ball.holder === s.me);
    if (!tutorial.active) clearInterval(tutTimer);
  }, 200);
}

function onStatus(s: NetStatus) {
  const el = ui.querySelector<HTMLElement>('#status');
  const txt = ui.querySelector<HTMLElement>('#statusText');
  if (!el || !txt) return;
  clearTimeout(statusTimer);
  if (s === 'open') { el.hidden = true; updateCompany(); return; }
  if (s === 'full') {
    el.hidden = false;
    txt.textContent = 'This room is full — 5 players max.';
    el.querySelector('.pulse')?.remove();
    setTimeout(() => { if (game?.net.status === 'full') home('That room is full — 5 players max.'); }, 2200);
    return;
  }
  const show = () => {
    el.hidden = false;
    txt.textContent = s === 'reconnecting' ? 'Reconnecting… your streak is safe' : 'Warming up the field…';
    ui.querySelector<HTMLElement>('#company')!.hidden = true;
  };
  // Don't flash a status for quick connects.
  statusTimer = window.setTimeout(show, s === 'connecting' ? 900 : 300);
}

function updateCompany() {
  const el = ui.querySelector<HTMLElement>('#company');
  if (!el) return;
  const humans = roster.filter((p) => !p.bot).length;
  el.hidden = !(roster.some((p) => p.bot) && humans === 1) || game?.net.status !== 'open' || !!tutorial?.active;
}

function onScore(s: ScoreState, ev?: BallEvent) {
  const el = ui.querySelector<HTMLElement>('.streak');
  const n = ui.querySelector<HTMLElement>('#streak');
  const label = ui.querySelector<HTMLElement>('#streakLabel');
  if (!el || !n || !label) return;
  const changed = s.streak !== lastStreak;
  n.textContent = String(s.streak);
  if (changed) {
    el.classList.remove('bump', 'reset');
    void el.offsetWidth;
    el.classList.add(s.streak > lastStreak ? 'bump' : 'reset');
  }
  // How far apart you are, in feet (it's baseball), beside the streak.
  if (!el.classList.contains('milestone')) label.innerHTML = distLabel(s);
  const progress = `${s.mode}:${s.dist}:${s.glove}`;
  if (progress !== lastProgress) {
    if (lastProgress.startsWith(s.mode)) { label.classList.remove('step'); void label.offsetWidth; label.classList.add('step'); }
    else if (hud && !lastProgress && !Tutorial.needed()) toast(`${MODE_INFO[s.mode].name}: ${MODE_INFO[s.mode].line}`); // (not on top of the first-time tips: one thing to read at a time)
    lastProgress = progress;
  }
  if ((ev?.k === 'drop' && !ev.void) || ev?.k === 'deflect') {
    // A miss is a step in; three in a row and you start again.
    // Misses are counted in total: the third one starts the distance (or the glove) again.
    const reset = s.misses === 0;
    const what = s.mode === 'fixed' ? ''
      : s.mode === 'long' ? (reset ? 'Third miss: back to the start' : `A step in (miss ${s.misses} of 3)`)
      : reset ? 'Third miss: the big mitt is back' : `Glove a size bigger (miss ${s.misses} of 3)`;
    const said = `${lastStreak >= 5 ? `Dropped at ${lastStreak}. ` : ''}${what}`.trim();
    if (said) toast(said);
  }
  if (ev?.k === 'catch') showGrade(ev.q, ev.st);
  if (ev?.k === 'drop' && !ev.void) showGrade(ev.by && ev.by === game?.ball.thrower ? 'wild' : 'miss');
  if (ev?.k === 'deflect') showGrade('miss');
  if (ev?.k === 'catch' && ev.milestone) {
    // Everyone in the room when the streak gets there earns the reward, once.
    const got = earn(ev.milestone);
    if (got) { toast(`${ev.milestone} in a row. Unlocked: ${got}`); haptic('firm'); }
    el.classList.add('milestone');
    label.textContent = `${ev.milestone} in a row`;
    setTimeout(() => { el.classList.remove('milestone'); label.innerHTML = distLabel(game?.score ?? s); }, 3200);
  }
  if (ev?.k === 'drop' && ev.void) toast('Connection hiccup — streak kept');
  lastStreak = s.streak;
  updateCompany();
}

let lastProgress = '';
const feet = (m: number) => Math.round(m * 3.28084);
/** Beside the streak: the thing this game is about (how far apart, or how big the glove). */
function distLabel(s: ScoreState) {
  if (s.mode === 'long') return `in a row · <em class="ft">${feet(s.dist)} ft</em>`;
  if (s.mode === 'mitt') return `in a row · <em class="ft">glove ×${s.glove.toFixed(1)}</em>`;
  return 'in a row';
}

const GRADE_WORDS: Record<string, string> = { perfect: 'Perfect pop', pocket: 'Pocket', web: 'Off the web', bobble: 'Bobbled', miss: 'Dropped', wild: 'Wild throw' };
const STYLE_WORDS: Record<string, string> = { dive: 'Diving catch', leap: 'Leaping grab', run: 'On the run', high: 'High snag', scoop: 'Scooped', backhand: 'Backhand', reach: 'Reaching grab' };
let gradeTimer = 0;
/**
 * A quiet line under the streak: how the catch was made (when the throw asked
 * for something) and how clean it was. Everyone sees the same line.
 */
function showGrade(q: string, st?: string | null) {
  const el = ui.querySelector<HTMLElement>('#grade');
  if (!el) return;
  const how = st ? STYLE_WORDS[st] : '';
  const great = isGreatCatch((st ?? null) as Parameters<typeof isGreatCatch>[0]);
  el.textContent = how ? `${how} · ${GRADE_WORDS[q] ?? ''}` : GRADE_WORDS[q] ?? '';
  el.className = `grade show ${q}${great ? ' great' : ''}`;
  clearTimeout(gradeTimer);
  gradeTimer = window.setTimeout(() => { el.className = 'grade'; }, great ? 2400 : 1700);
}

function pauseSheet(code: string) {
  const s = game?.score;
  const people = [...roster].sort((a, b) => a.seat - b.seat).map((p) => `
    <li><span class="dot" style="background:${TOPS[p.style[S.top]]?.color ?? '#888'}"></span>
      <span class="nm">${esc(p.name)}${p.id === me ? ' <em>you</em>' : ''}${p.bot ? ' <em>practice</em>' : ''}${p.connected ? '' : ' <em>reconnecting</em>'}</span>
      <span class="num">${p.catches} caught${p.perfects ? ` · ${p.perfects} perfect` : ''}${p.saves ? ` · ${p.saves} great` : ''}</span><span class="num">${p.drops} dropped</span></li>`).join('');
  const el = sheet(`
    <h2>Paused</h2>
    <p class="sub">${s ? `${MODE_INFO[s.mode].name}. ` : ''}The game keeps going for everyone else.</p>
    <section>
      <h3>Invite</h3>
      <div class="invite-code"><div><small>Room code</small><b>${code}</b></div><button class="btn btn-ink btn-sm" id="share">Share link</button></div>
    </section>
    <section>
      <h3>Streaks</h3>
      <div class="stats">
        ${s?.mode === 'mitt'
    ? `<div class="stat"><b>×${s.glove.toFixed(1)}</b><span>Glove size right now</span></div>`
    : `<div class="stat"><b>${s ? feet(s.dist) : 0}<small> ft</small></b><span>Apart${s?.mode === 'long' ? ' right now' : ''}</span></div>`}
        <div class="stat"><b>${s?.streak ?? 0}</b><span>Current</span></div>
        <div class="stat"><b>${s?.sessionBest ?? 0}</b><span>Best this session</span></div>
        <div class="stat"><b>${s?.groupBest ?? 0}</b><span>Best with this group</span></div>
      </div>
      <ul class="people">${people}</ul>
    </section>
    <section>
      <div class="row"><label id="lkl">Look</label><button class="btn btn-quiet btn-sm" id="lk" aria-labelledby="lkl lk">${prefs().fresh.length ? '<i class="new-dot"></i>' : ''}Change</button></div>
      <p class="hint" style="margin:0 2px 10px">${(() => { const n = nextMilestone(s?.streak ?? 0); const nx = MILESTONES.find((m) => !prefs().earned.includes(m)); const r = nx ? rewardAt(nx) : null; return r ? `Next reward: ${esc(r.name)} at ${nx} in a row${n === nx && s ? ` (${nx - s.streak} to go)` : ''}.` : 'You have earned everything there is.'; })()}</p>
      <div class="row"><label id="wul">Windup</label><button class="btn btn-quiet btn-sm" id="wu" aria-labelledby="wul wu"><b class="num">${getWindup(prefs().windup).label}</b>&nbsp;Change</button></div>
    </section>
    ${settingsBody()}
    <div class="actions">
      <button class="btn btn-ink" id="resume">Resume</button>
      <button class="btn btn-danger" id="leave">Leave room</button>
    </div>`);
  bindSettings(el);
  el.querySelector('#share')!.addEventListener('click', () => invite(code));
  el.querySelector('#wu')!.addEventListener('click', () => { el.remove(); windupSheet(); });
  el.querySelector('#lk')!.addEventListener('click', () => { el.remove(); lookSheet(); });
  el.querySelector('#resume')!.addEventListener('click', () => closeSheet(el));
  el.querySelector('#leave')!.addEventListener('click', () => { el.remove(); home(); });
}

// ------------------------------------------------------------------ routing

function route() {
  const m = location.pathname.match(/^\/r\/([A-Za-z]{4})\/?$/);
  const q = new URLSearchParams(location.search).get('room');
  const code = (m?.[1] ?? q ?? '').toUpperCase();
  if (code && isRoomCode(code)) {
    if (game?.room === code) return;
    game?.destroy(); game = null;
    backdrop.start();
    setUI('');
    // An invite: one tap (which also unlocks audio on iOS), name if needed, play.
    const p = prefs();
    if (p.profiled && p.name) {
      const el = sheet(`
        <h2>Come play catch</h2>
        <p class="sub">You’re joining room <b>${code}</b> as ${esc(p.name)}.</p>
        <div class="actions"><button class="btn btn-ink" id="go">Join the game</button><button class="btn btn-quiet" id="edit">Change name or hand</button></div>`, () => home());
      el.querySelector('#go')!.addEventListener('click', () => { el.remove(); enterRoom(code); });
      el.querySelector('#edit')!.addEventListener('click', () => { el.remove(); save({ profiled: false }); ensureProfile('Come play catch', () => enterRoom(code), `You’re joining room ${code}.`); });
    } else {
      ensureProfile('Come play catch', () => enterRoom(code), `You’re joining room ${code}. Your friends will see your name above your head.`);
    }
    return;
  }
  home();
}

window.addEventListener('popstate', route);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') audio.resume(); });
// iOS may suspend audio after interruptions; any touch revives it.
window.addEventListener('pointerdown', () => { if (audio.ctx && !audio.running) audio.unlock(); }, { capture: true });

route();
