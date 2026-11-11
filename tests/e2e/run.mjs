// End-to-end multiplayer tests: a real room server, the production client
// build, and several independent Chromium browser contexts (one per player).
// Touch input is driven through CDP touch events, i.e. the real gesture path.
//
//   npm run build:client && npm run test:e2e
//
// Simulated mobile browsers only: real-device iPhone testing is separate.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const SERVER_PORT = 8799;
const WEB_PORT = 4179;
const WS = `ws://127.0.0.1:${SERVER_PORT}/ws`;
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const procs = [];
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const code = () => Array.from({ length: 4 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
const results = [];
let failed = 0;

function start(cmd, args, env = {}) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  procs.push(p);
  return p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, step = 100) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(step); }
  return last;
}
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

if (!existsSync('dist/index.html')) { console.error('Build the client first: npm run build:client'); process.exit(1); }
start('npx', ['tsx', 'src/server/index.ts'], { PORT: String(SERVER_PORT) });
start('npx', ['vite', 'preview', '--port', String(WEB_PORT), '--strictPort', '--host', '127.0.0.1']);
await waitFor(async () => { try { return (await fetch(`http://127.0.0.1:${SERVER_PORT}/health`)).ok; } catch { return false; } }, 15000);
await waitFor(async () => { try { return (await fetch(BASE)).ok; } catch { return false; } }, 15000);

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
let guestN = 0;

async function player(room, name, hand = 'R', guest, expect = 'open') {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const g = guest ?? `e2e-${Date.now()}-${guestN++}`;
  await page.addInitScript(([g, name, hand]) => {
    if (!localStorage.getItem('catch.prefs.v1')) localStorage.setItem('catch.prefs.v1', JSON.stringify({ guest: g, name, hand, profiled: true, tutorialDone: true }));
  }, [g, name, hand]);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}/r/${room}?server=${encodeURIComponent(WS)}`);
  await page.locator('#go').tap();
  await waitFor(() => page.evaluate((x) => window.__catch?.game?.debugState().status === x, expect), 10000, 50);
  // Software GL is far too slow for real-time touch timing; keep the sim and input running, skip drawing.
  await page.evaluate(() => { window.__catch.game.renderEnabled = false; });
  const cdp = await ctx.newCDPSession(page);
  const p = { ctx, page, cdp, name, guest: g, errors };
  p.state = () => page.evaluate(() => window.__catch.game.debugState());
  p.touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q) => ({ x: q[0], y: q[1], id: q[2] ?? 0 })) });
  return p;
}

/** Real gesture: touch, pull back `pull` px (and `side` px sideways), let go. */
async function throwGesture(p, { pull = 110, side = 0, x = 195, y = 430 } = {}) {
  await p.touch('touchStart', [[x, y]]);
  const steps = 8;
  for (let i = 1; i <= steps; i++) { await p.touch('touchMove', [[x + (side * i) / steps, y + (pull * i) / steps]]); await sleep(16); }
  await sleep(120);
  await p.touch('touchEnd', []);
}

/** Real gesture: drag to move for `ms`. */
async function moveGesture(p, { dx = 50, dy = 0, ms = 600, x = 195, y = 500 } = {}) {
  await p.touch('touchStart', [[x, y]]);
  for (let i = 1; i <= 4; i++) { await p.touch('touchMove', [[x + (dx * i) / 4, y + (dy * i) / 4]]); await sleep(12); }
  const end = Date.now() + ms;
  while (Date.now() < end) { await p.touch('touchMove', [[x + dx, y + dy]]); await sleep(40); }
  await p.touch('touchEnd', []);
}

async function aimAt(p, id) { await p.page.evaluate((id) => window.__catch.game.lookAtPlayer(id), id); await sleep(60); }
async function setAutoMove(p, on) { await p.page.evaluate((on) => { window.__catch.game.autoMove = on; }, on); }
const idOf = async (p) => (await p.state()).me;
const waitCanThrow = (p) => waitFor(async () => (await p.state()).canThrow, 4000, 50);

try {
  console.log('\nMULTIPLAYER');
  const room = code();
  const A = await player(room, 'Ann');
  const B = await player(room, 'Ben');
  const sa = await waitFor(async () => { const s = await A.state(); return s.players.length === 2 ? s : null; });
  const sb = await B.state();
  check('two separate clients join one room', sa?.players.length === 2 && sb.players.length === 2 && !sa.players.some((x) => x.bot));
  check('both clients agree who holds the ball', sa.ball.holder === sb.ball.holder && !!sa.ball.holder, `holder=${sa.ball.holder}`);
  const aId = await idOf(A), bId = await idOf(B);
  const holder = sa.ball.holder === aId ? A : B, other = holder === A ? B : A;
  const otherId = await idOf(other);

  console.log('\nSCORING + PHYSICS');
  await setAutoMove(other, true);
  await aimAt(holder, otherId);
  await waitCanThrow(holder);
  await throwGesture(holder, { pull: 110 });
  const inFlight = await waitFor(async () => { const s = await other.state(); return s.ball.phase === 'flight' ? s : null; }, 3000, 30);
  check('throw is accepted by the server and seen by the receiver', !!inFlight);
  const caught = await waitFor(async () => { const s = await other.state(); return s.ball.phase === 'held' && s.ball.holder === otherId ? s : null; }, 6000);
  await sleep(300);
  const s1a = await A.state(), s1b = await B.state();
  check('successful catch increments the streak exactly once', s1a.score.streak === 1 && s1b.score.streak === 1, `A=${s1a.score.streak} B=${s1b.score.streak}`);
  check('all clients display the same streak', s1a.score.streak === s1b.score.streak);
  check('catch detection: ball actually passed through the glove (server-validated)', !!caught);
  const pops = (await other.state()).audio.filter((x) => x.k === 'pop').length;
  check('no duplicate impact sounds for one catch', pops === 1, `pops=${pops}`);
  const popEv = (await other.state()).audio.find((x) => x.k === 'pop');
  check('the POP carries the catch grade from the server', typeof popEv?.g === 'number' && popEv.g > 0, `g=${popEv?.g} q=${popEv?.q}`);
  const zipSoft = (await other.state()).zipPeak;

  // Throw back, harder: ZIP must be louder for the faster ball.
  await setAutoMove(holder, true);
  await aimAt(other, holder === A ? aId : bId);
  await waitCanThrow(other);
  await throwGesture(other, { pull: 230 });
  const back = await waitFor(async () => { const s = await holder.state(); return s.ball.phase === 'held' && s.ball.holder === (holder === A ? aId : bId) ? s : null; }, 6000);
  await sleep(300);
  check('any player can throw back (second catch)', !!back && (await A.state()).score.streak === 2);
  const zipHard = (await holder.state()).zipPeak;
  check('throw sound responds to velocity (harder throw → louder ZIP)', zipHard > zipSoft * 1.3, `soft=${zipSoft.toFixed(3)} hard=${zipHard.toFixed(3)}`);

  // Positioning matters: a throw ~2 m wide is caught by running to it…
  await aimAt(holder, otherId);
  await waitCanThrow(holder);
  const wideFrom = (await other.state()).pos.slice();
  await throwGesture(holder, { pull: 72, side: -50 });
  const wideCaught = await waitFor(async () => { const s = await other.state(); return s.ball.phase === 'held' && s.ball.holder === otherId ? s : null; }, 6000);
  const ranTo = (await other.state()).pos;
  const ran = Math.hypot(ranTo[0] - wideFrom[0], ranTo[2] - wideFrom[2]);
  check('a wide throw can be caught by moving to it', !!wideCaught && (await A.state()).score.streak === 3, `streak=${(await A.state()).score.streak}`);
  check('…and the receiver really moved to get there', ran > 0.8 || !!(wideCaught && Math.hypot(wideCaught.pos[0] - wideCaught.home[0], wideCaught.pos[2] - wideCaught.home[2]) > 0.8), `moved≈${ran.toFixed(2)} m`);

  // …and a miss: the receiver stands still, the throw sails well wide.
  await setAutoMove(other, false);
  await sleep(1800); // walk back to the spot
  await aimAt(other, holder === A ? aId : bId);
  await setAutoMove(holder, false);
  await waitCanThrow(other);
  await throwGesture(other, { pull: 120, side: 170 });
  const dropped = await waitFor(async () => { const s = await A.state(); return s.score.streak === 0 ? s : null; }, 6000);
  check('a miss resets the streak (ball can miss the receiver)', !!dropped);
  await sleep(400);
  const dropsA = (await A.state()).players.reduce((n, x) => n + x.drops, 0);
  check('a miss resets exactly once (one drop recorded)', dropsA === 1, `drops=${dropsA}`);
  const recovered = await waitFor(async () => { const s = await A.state(); return s.ball.phase === 'held' && s.ball.holder ? s : null; }, 9000);
  check('ball recovery after a drop', !!recovered, `holder=${recovered?.ball.holder}`);

  console.log('\nRECONNECTION');
  const before = await A.state();
  await B.page.reload();
  await B.page.locator('#go').tap();
  const rb = await waitFor(async () => { const s = await B.page.evaluate(() => window.__catch?.game?.debugState()); return s?.status === 'open' && s.players.length === 2 ? s : null; }, 10000);
  await B.page.evaluate(() => { window.__catch.game.renderEnabled = false; });
  check('reconnecting player keeps identity and gets the correct state', rb && rb.me === bId && rb.ball.holder === before.ball.holder && rb.score.streak === before.score.streak, `me=${rb?.me} holder=${rb?.ball.holder}`);

  console.log('\nFIVE PLAYERS');
  const C = await player(room, 'Cal');
  const D = await player(room, 'Dee');
  const E = await player(room, 'Eve');
  const all = [A, B, C, D, E];
  const five = await waitFor(async () => { const ss = await Promise.all(all.map((x) => x.state())); return ss.every((s) => s.players.length === 5) ? ss : null; });
  check('five separate clients join one room', !!five);
  check('every client sees consistent ball ownership', five && new Set(five.map((s) => s.ball.holder)).size === 1);
  const F = await player(room, 'Fay', 'R', undefined, 'full');
  const fState = await F.state();
  const fText = await F.page.locator('#statusText').textContent().catch(() => '');
  const afterF = await A.state();
  check('a sixth player is refused (room full) and told so', fState.status === 'full' && /full/i.test(fText) && afterF.players.length === 5, fText);
  const homeNotice = await waitFor(() => F.page.locator('.notice').textContent().catch(() => null), 5000);
  check('…and is returned home with an explanation', /full/i.test(homeNotice || ''), homeNotice || '');

  // Throw across the circle to a non-neighbour.
  const ss = await A.state();
  const hId = ss.ball.holder;
  const H = (await Promise.all(all.map(async (x) => [x, await idOf(x)]))).find(([, id]) => id === hId)[0];
  const others = all.filter((x) => x !== H);
  const T = others[2];
  const tId = await idOf(T);
  await setAutoMove(T, true);
  await aimAt(H, tId);
  await waitCanThrow(H);
  await throwGesture(H, { pull: 120 });
  const got = await waitFor(async () => { const s = await T.state(); return s.ball.phase === 'held' && s.ball.holder === tId ? s : null; }, 6000);
  check('any player can throw to any other player (5-player ring)', !!got);
  const agree = await Promise.all(all.map((x) => x.state()));
  check('all five clients show the same streak and holder', new Set(agree.map((s) => `${s.score.streak}/${s.ball.holder}`)).size === 1, agree.map((s) => s.score.streak).join(','));

  // A disconnected player does not corrupt the room.
  await E.ctx.close();
  await sleep(800);
  const afterE = await A.state();
  const eRow = afterE.players.find((x) => x.name === 'Eve');
  check('a disconnected player does not corrupt the room', afterE.status === 'open' && afterE.players.length === 5 && eRow && !eRow.connected);

  console.log('\nCONTROLS');
  // The holder pulls *up* (the wrong way) and lets go: never a throw.
  await waitCanThrow(T);
  const hs = await T.state();
  await T.touch('touchStart', [[200, 500]]);
  for (let i = 1; i <= 8; i++) { await T.touch('touchMove', [[200 + i * 3, 500 - i * 22]]); await sleep(12); }
  await T.touch('touchEnd', []);
  await sleep(200);
  const hs2 = await T.state();
  check('pulling the wrong way does not throw', hs2.ball.phase === 'held' && hs2.ball.holder === tId && hs2.controls.throws === hs.controls.throws, `throws=${hs2.controls.throws}`);

  // Pull back, then slide back to where you started and let go = cancel.
  const before2 = (await T.state()).controls.throws;
  await T.touch('touchStart', [[200, 420]]);
  for (let i = 1; i <= 6; i++) { await T.touch('touchMove', [[200, 420 + i * 18]]); await sleep(16); }
  for (let i = 5; i >= 0; i--) { await T.touch('touchMove', [[200, 420 + i * 18]]); await sleep(16); }
  await T.touch('touchEnd', []);
  await sleep(150);
  const ts = await T.state();
  check('pull back then return to the start cancels (no throw)', ts.controls.throws === before2 && ts.ball.phase === 'held');

  // Someone without the ball drags to move: their body moves that way, nothing is thrown.
  const mover = others.find((x) => x !== T && x !== E);
  await setAutoMove(mover, false);
  const m0 = await mover.state();
  await moveGesture(mover, { dx: 55, dy: 0, ms: 500 });
  const m1 = await mover.state();
  const moved = Math.hypot(m1.pos[0] - m0.pos[0], m1.pos[2] - m0.pos[2]);
  check('drag to move: the player runs and nothing is thrown', moved > 0.8 && m1.controls.throws === m0.controls.throws, `moved=${moved.toFixed(2)} m`);
  const back2 = await waitFor(async () => { const s = await mover.state(); return Math.hypot(s.pos[0] - s.home[0], s.pos[2] - s.home[2]) < 0.3 ? s : null; }, 8000);
  check('let go and they wander back to their spot', !!back2);

  // Release direction and power come from the pull.
  const yawOf = (v) => Math.atan2(-v[0], -v[2]);
  const holderNow = async () => { const s = await A.state(); return (await Promise.all(all.filter((x) => x !== E).map(async (x) => [x, await idOf(x)]))).find(([, id]) => id === s.ball.holder)?.[0]; };
  const waitHeld = () => waitFor(async () => { const s = await A.state(); return s.ball.phase === 'held' && s.ball.holder ? s : null; }, 12000);
  // Everyone runs under throws from here on so the ball keeps circulating.
  for (const x of all.filter((x) => x !== E)) await setAutoMove(x, true);
  const sample = async (opts) => {
    await waitHeld(); await sleep(300);
    const h = await holderNow();
    await waitCanThrow(h);
    await h.page.evaluate(() => { window.__lastThrow = null; const n = window.__catch.game.net; if (!n.__wrapped) { const orig = n.send.bind(n); n.send = (m) => { if (m.t === 'throw') window.__lastThrow = m; return orig(m); }; n.__wrapped = true; } });
    const target = all.find((x) => x !== h && x !== E);
    await aimAt(h, await idOf(target));
    const st = await h.state();
    const toYaw = Math.atan2(-(st.partnerPos[0] - st.pos[0]), -(st.partnerPos[2] - st.pos[2]));
    await throwGesture(h, opts);
    const m = await waitFor(() => h.page.evaluate(() => window.__lastThrow), 2000);
    return m ? { yawOff: Math.atan2(Math.sin(yawOf(m.v) - toYaw), Math.cos(yawOf(m.v) - toYaw)), speed: Math.hypot(...m.v) } : null;
  };
  const s0 = await sample({ pull: 110, side: 0 });
  const sR = await sample({ pull: 110, side: -70 });
  const sL = await sample({ pull: 110, side: 70 });
  check('pulling to one side throws to the other (slingshot)', s0 && sR && sL && sR.yawOff < s0.yawOff - 0.1 && sL.yawOff > s0.yawOff + 0.1, `straight=${s0?.yawOff.toFixed(2)} pull-left=${sR?.yawOff.toFixed(2)} pull-right=${sL?.yawOff.toFixed(2)}`);
  const sSoft = await sample({ pull: 50 });
  const sHard = await sample({ pull: 240 });
  check('pull length sets throw speed (soft toss vs hard throw)', sSoft && sHard && sHard.speed > sSoft.speed + 8, `soft=${sSoft?.speed.toFixed(1)} hard=${sHard?.speed.toFixed(1)} m/s`);

  console.log('\nLEFT-HANDED + AUDIO');
  const room2 = code();
  const L = await player(room2, 'Lefty', 'L');
  await sleep(400);
  check('solo player gets Coach to practise with', (await L.state()).players.some((x) => x.bot));
  await waitCanThrow(L);
  await throwGesture(L, { pull: 110 });
  const lt = await waitFor(async () => { const s = await L.state(); return s.ball.phase !== 'held' || s.ball.holder === 'coach' ? s : null; }, 3000, 30);
  check('left-handed: throwing works', !!lt);
  const coachCaught = await waitFor(async () => (await L.state()).ball.holder === 'coach', 4000);
  check('Coach catches a good throw', !!coachCaught);
  await setAutoMove(L, true);
  const lc = await waitFor(async () => { const s = await L.state(); return s.ball.holder === s.me && s.score.streak >= 2 ? s : null; }, 9000);
  check('Coach throws back and the exchange keeps going (streak 2)', !!lc, `streak=${(await L.state()).score.streak}`);

  // Audio survives an interruption (iOS suspends the context).
  const resumed = (await L.state()).audioState;
  check('audio context is running in game', resumed === 'running', resumed);
  const interrupted = await L.page.evaluate(async () => {
    const ac = window.__catchAudioCtx;
    if (!ac) return 'no-ctx';
    await ac.suspend();
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 300));
    return ac.state;
  });
  check('audio resumes after a browser interruption', interrupted === 'running', interrupted);

  console.log('\nPERFORMANCE / STABILITY');
  const errs = [A, B, C, D, L].flatMap((x) => x.errors);
  check('no page errors in any client', errs.length === 0, errs.slice(0, 3).join(' | '));
  const loops = await A.page.evaluate(async () => {
    let n = 0; const t0 = performance.now();
    await new Promise((r) => { const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else r(); }; requestAnimationFrame(f); });
    return n;
  });
  check('single animation loop (frame count sane)', loops > 0 && loops < 200, `${loops} rAF/s`);
} catch (e) {
  console.error(e);
  failed++;
} finally {
  await browser.close().catch(() => {});
  for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* gone */ } }
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
