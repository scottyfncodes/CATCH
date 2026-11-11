import './style.css';
import * as THREE from 'three';
import { EYE_HEIGHT } from '../shared/constants';
import { positionAt, simulateFlight, solveThrowTo, type Trajectory } from '../shared/physics';
import { type Hand, eyePosition, lookAngles, releasePoint, seatLayout } from '../shared/pose';
import { type BallEvent, type PlayerInfo, type ScoreState, isRoomCode, randomRoomCode, sanitizeName } from '../shared/protocol';
import { audio } from './audio';
import { Game } from './game';
import type { NetStatus } from './net';
import { serverHttpUrl } from './net';
import { Avatar, LOOKS } from './scene/avatar';
import { buildBall } from './scene/gear';
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
  private world = buildWorld(true);
  private camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
  private avatars: Avatar[] = [];
  private ball = buildBall();
  private traj: Trajectory | null = null;
  private t0 = 0;
  private from = 0;
  private raf = 0;
  private running = false;

  constructor() {
    const seats = seatLayout(2);
    seats.forEach((s, i) => {
      const a = new Avatar(s.pos, s.yaw, i === 0 ? 'R' : 'L', i === 0 ? 0 : 2);
      this.world.scene.add(a.root, a.arms);
      this.avatars.push(a);
    });
    this.ball.scale.setScalar(1.6);
    this.world.scene.add(this.ball);
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.frame(now / 1000);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() { this.running = false; cancelAnimationFrame(this.raf); }

  private frame(t: number) {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.fov = w < h ? 58 : 42;
    this.camera.updateProjectionMatrix();
    // Over-the-shoulder of one friend, looking across at the other; a slow breathing drift.
    const drift = Math.sin(t * 0.07);
    this.camera.position.set(2.2 + drift * 0.5, 2.05 + Math.sin(t * 0.11) * 0.06, 12.8);
    this.camera.lookAt(-0.9 + drift * 0.2, 1.05, -4);

    const [A, B] = this.avatars;
    const thrower = this.avatars[this.from], catcher = this.avatars[1 - this.from];
    if (!this.traj || t - this.t0 > 2.0) {
      // Next lazy toss.
      if (this.traj) this.from = 1 - this.from;
      const th = this.avatars[this.from], ca = this.avatars[1 - this.from];
      const yaw = lookAngles(eyePosition(th.seatPos), eyePosition(ca.seatPos)).yaw;
      const p = releasePoint(th.seatPos, yaw, th.hand);
      const target: [number, number, number] = [ca.seatPos[0] * 0.95, EYE_HEIGHT - 0.25 + Math.sin(t) * 0.15, ca.seatPos[2] * 0.95];
      this.traj = simulateFlight(p, solveThrowTo(p, target, 1.05));
      this.t0 = t;
    }
    const ft = t - this.t0;
    for (const av of [A, B]) {
      const other = av === A ? B : A;
      const look = lookAngles(eyePosition(av.seatPos), eyePosition(other.seatPos));
      const isCatcher = av === catcher;
      const arm = av === thrower ? (ft < 0.25 ? 3 : 0) : ft > 1.2 ? (ft < 1.6 ? 1 : 2) : 0;
      av.update(1 / 60, { yaw: look.yaw, pitch: -0.05, gu: isCatcher ? 0 : (av.hand === 'R' ? -0.5 : 0.5), gv: isCatcher ? -0.3 : -0.45 }, arm, ft > 1.6 ? Math.min(1, (ft - 1.6) * 2.5) * 0.5 : 0);
    }
    if (ft < 1.05) {
      const p = positionAt(this.traj, ft);
      this.ball.position.set(p[0], p[1], p[2]);
    } else {
      if (ft - 1.05 < 1 / 50) catcher.catchImpact([0, 0, 1], 12);
      this.ball.position.copy(ft < 1.35 ? catcher.gloveWorldPos : catcher.handBall);
    }
    this.world.update(1 / 60, t);
    renderer.render(this.world.scene, this.camera);
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
      <p class="tagline">Two thumbs. One ball.<br/>Keep it off the grass.</p>
      <div class="spacer"></div>
      <div class="stack">
        <button class="btn btn-primary" data-act="play">PLAY CATCH</button>
        <button class="btn btn-glass" data-act="join">JOIN FRIEND</button>
        <button class="btn btn-text" data-act="settings">SETTINGS</button>
      </div>
      <div class="credit">by HaveAnApp</div>
      ${notice ? `<div class="chip notice" role="alert">${esc(notice)}</div>` : ''}
    </main>`);
  ui.querySelector('[data-act=play]')!.addEventListener('click', () => {
    audio.unlock();
    ensureProfile('Before you head out', () => enterRoom(randomRoomCode()));
  });
  ui.querySelector('[data-act=join]')!.addEventListener('click', () => { audio.unlock(); joinSheet(); });
  ui.querySelector('[data-act=settings]')!.addEventListener('click', () => settingsSheet(() => home()));
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
  return h === 'R' ? 'Left thumb works the glove. Right thumb throws.' : 'Right thumb works the glove. Left thumb throws.';
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
      <div class="row"><label for="look">Look speed</label><input id="look" type="range" min="0.5" max="1.8" step="0.05" value="${p.lookSensitivity}"/></div>
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
  el.querySelector<HTMLInputElement>('#look')!.addEventListener('input', (e) => save({ lookSensitivity: Number((e.target as HTMLInputElement).value) }));
  const hap = el.querySelector<HTMLButtonElement>('#hap')!;
  hap.addEventListener('click', () => { const on = hap.getAttribute('aria-checked') !== 'true'; hap.setAttribute('aria-checked', String(on)); save({ haptics: on }); });
  el.querySelector('#tut')!.addEventListener('click', () => {
    save({ tutorialDone: false });
    if (tutorial) tutorial.restart();
    else if (game) startTutorial();
    closeSheet(el);
  });
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

function enterRoom(code: string) {
  backdrop.stop();
  audio.unlock();
  audio.setVolume(prefs().volume);
  audio.startAmbience();
  if (location.pathname !== `/r/${code}`) history.pushState({}, '', `/r/${code}`);
  app.classList.add('playing');
  roster = []; me = null; lastStreak = 0;
  setUI(`
    <div class="hud">
      <div class="streak" aria-live="polite"><b id="streak">0</b><span id="streakLabel">in a row</span></div>
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
  });
  (window as unknown as { __catch: unknown }).__catch = { game, tutorial: () => tutorial };
  game.start();
  onStatus('connecting');
  if (Tutorial.needed()) startTutorial();
}

function startTutorial() {
  if (!game || !hud) return;
  const g = game;
  tutorial?.destroy();
  tutorial = new Tutorial(hud, () => prefs().hand, () => g.gripScreen(), () => g.canThrow());
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
  if (ev?.k === 'catch' && ev.milestone) {
    el.classList.add('milestone');
    label.textContent = `${ev.milestone} in a row`;
    setTimeout(() => { el.classList.remove('milestone'); label.textContent = 'in a row'; }, 3200);
  }
  if (ev?.k === 'drop' && ev.void) toast('Connection hiccup — streak kept');
  if (ev?.k === 'drop' && !ev.void && lastStreak >= 5) toast(`Dropped at ${lastStreak}`);
  if (ev?.k === 'deflect' && lastStreak >= 5) toast(`Off the glove at ${lastStreak}`);
  lastStreak = s.streak;
  updateCompany();
}

function pauseSheet(code: string) {
  const s = game?.score;
  const people = [...roster].sort((a, b) => a.seat - b.seat).map((p) => `
    <li><span class="dot" style="background:${LOOKS[p.look % LOOKS.length].shirt}"></span>
      <span class="nm">${esc(p.name)}${p.id === me ? ' <em>you</em>' : ''}${p.bot ? ' <em>practice</em>' : ''}${p.connected ? '' : ' <em>reconnecting</em>'}</span>
      <span class="num">${p.catches} caught${p.perfects ? ` · ${p.perfects} perfect` : ''}</span><span class="num">${p.drops} dropped</span></li>`).join('');
  const el = sheet(`
    <h2>Paused</h2>
    <p class="sub">The game keeps going for everyone else.</p>
    <section>
      <h3>Invite</h3>
      <div class="invite-code"><div><small>Room code</small><b>${code}</b></div><button class="btn btn-ink btn-sm" id="share">Share link</button></div>
    </section>
    <section>
      <h3>Streaks</h3>
      <div class="stats">
        <div class="stat"><b>${s?.streak ?? 0}</b><span>Current</span></div>
        <div class="stat"><b>${s?.sessionBest ?? 0}</b><span>Best this session</span></div>
        <div class="stat"><b>${s?.groupBest ?? 0}</b><span>Best with this group</span></div>
      </div>
      <ul class="people">${people}</ul>
    </section>
    ${settingsBody()}
    <div class="actions">
      <button class="btn btn-ink" id="resume">Resume</button>
      <button class="btn btn-danger" id="leave">Leave room</button>
    </div>`);
  bindSettings(el);
  el.querySelector('#share')!.addEventListener('click', () => invite(code));
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
