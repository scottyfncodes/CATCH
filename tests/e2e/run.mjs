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

/**
 * Real gesture: grip the ball, pull down `pull` px while sliding `slide` px
 * sideways, hold, then let go. `flick` adds an upward snap before letting go.
 */
async function throwGesture(p, { pull = 60, slide = 0, flick = false, start } = {}) {
  const g = start ?? await p.page.evaluate(() => window.__catch.game.gripScreen());
  await p.touch('touchStart', [[g.x, g.y]]);
  const steps = 6;
  for (let i = 1; i <= steps; i++) { await p.touch('touchMove', [[g.x + (slide * i) / steps, g.y + (pull * i) / steps]]); await sleep(14); }
  await sleep(120);
  if (flick) for (let i = 1; i <= 4; i++) { await p.touch('touchMove', [[g.x + slide, g.y + pull - 30 * i]]); await sleep(10); }
  await p.touch('touchEnd', []);
}

async function aimAt(p, id) { await p.page.evaluate((id) => window.__catch.game.lookAtPlayer(id), id); await sleep(60); }
async function setAutoGlove(p, on) { await p.page.evaluate((on) => { window.__catch.game.autoGlove = on; }, on); }
const idOf = async (p) => (await p.state()).me;

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
  await setAutoGlove(other, true);
  await aimAt(holder, otherId);
  await throwGesture(holder, { pull: 70 });
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
  await setAutoGlove(holder, true);
  await sleep(500);
  await aimAt(other, holder === A ? aId : bId);
  await throwGesture(other, { pull: 150 });
  const back = await waitFor(async () => { const s = await holder.state(); return s.ball.phase === 'held' && s.ball.holder === (holder === A ? aId : bId) ? s : null; }, 6000);
  await sleep(300);
  check('any player can throw back (second catch)', !!back && (await A.state()).score.streak === 2);
  const zipHard = (await holder.state()).zipPeak;
  check('throw sound responds to velocity (harder throw → louder ZIP)', zipHard > zipSoft * 1.3, `soft=${zipSoft.toFixed(3)} hard=${zipHard.toFixed(3)}`);

  // A miss: receiver keeps the glove far away.
  await setAutoGlove(other, false);
  await other.page.evaluate(() => { const g = window.__catch.game; g.glove.u = g.glove.v = 1.15; g['gloveT'].u = g['gloveT'].v = 1.15; });
  await sleep(500);
  await aimAt(holder, otherId);
  await throwGesture(holder, { pull: 70 });
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
  await setAutoGlove(T, true);
  await aimAt(H, tId);
  await throwGesture(H, { pull: 80 });
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
  // Holder looks around without throwing: drag that does not start on the ball.
  const hs = await T.state();
  const yaw0 = hs.yaw;
  await T.touch('touchStart', [[300, 250]]);
  for (let i = 1; i <= 10; i++) { await T.touch('touchMove', [[300 - i * 12, 250 + (i % 2) * 40]]); await sleep(12); }
  // Fast upward swipe at the end — still a look, never a throw.
  for (let i = 1; i <= 4; i++) { await T.touch('touchMove', [[180, 250 - i * 40]]); await sleep(8); }
  await T.touch('touchEnd', []);
  await sleep(200);
  const hs2 = await T.state();
  check('camera drag does not trigger a throw', hs2.ball.phase === 'held' && hs2.ball.holder === tId && hs2.controls.throws === hs.controls.throws, `throws=${hs2.controls.throws}`);
  check('drag looks around', Math.abs(hs2.yaw - yaw0) > 0.3, `Δyaw=${(hs2.yaw - yaw0).toFixed(2)}`);

  // Glove moves while another touch is active (two thumbs at once).
  await setAutoGlove(T, false);
  const g0 = (await T.state()).glove;
  await T.touch('touchStart', [[300, 300, 1]]);
  await T.touch('touchStart', [[300, 300, 1], [90, 520, 2]]);
  for (let i = 1; i <= 8; i++) { await T.touch('touchMove', [[300 + i * 4, 300, 1], [90 + i * 8, 520 - i * 10, 2]]); await sleep(14); }
  await sleep(150);
  const g1 = (await T.state()).glove;
  await T.touch('touchEnd', []);
  check('glove moves while the other thumb is also touching', g1.u - g0.u > 0.2 && g1.v - g0.v > 0.2, `Δu=${(g1.u - g0.u).toFixed(2)} Δv=${(g1.v - g0.v).toFixed(2)}`);

  // Pull back, then slide back up to where you started and let go = cancel, no throw.
  const before2 = (await T.state()).controls.throws;
  const gp = await T.page.evaluate(() => window.__catch.game.gripScreen());
  await T.touch('touchStart', [[gp.x, gp.y]]);
  for (let i = 1; i <= 6; i++) { await T.touch('touchMove', [[gp.x, gp.y + i * 10]]); await sleep(20); }
  for (let i = 5; i >= 0; i--) { await T.touch('touchMove', [[gp.x, gp.y + i * 10]]); await sleep(40); }
  await sleep(200);
  await T.touch('touchEnd', []);
  await sleep(150);
  const ts = await T.state();
  check('pull back, slide back to the start and let go cancels (no throw)', ts.controls.throws === before2 && ts.ball.phase === 'held');

  // Release direction responds to flick angle; power responds to pull.
  const rel = async (opts) => {
    await T.page.evaluate(() => { window.__lastThrow = null; const n = window.__catch.game.net; const orig = n.send.bind(n); n.send = (m) => { if (m.t === 'throw') window.__lastThrow = m; return orig(m); }; });
    await aimAt(T, await idOf(others.find((x) => x !== T && x !== E) ?? H));
    await throwGesture(T, opts);
    return T.page.evaluate(() => window.__lastThrow);
  };
  const straight = await rel({ pull: 50 });
  check('pull and let go releases the ball', !!straight?.v);
  // Get the ball back to T for comparison throws: whoever catches/recovers it, wait until T holds again is not guaranteed — compare against the predicted vector instead.
  const yawOf = (v) => Math.atan2(-v[0], -v[2]);
  // Compute the flick-angle effect directly through the same release path on a fresh holder later.
  console.log('    (direction/power comparisons use the client release path on the holder)');
  const holderNow = async () => { const s = await A.state(); return (await Promise.all(all.filter((x) => x !== E).map(async (x) => [x, await idOf(x)]))).find(([, id]) => id === s.ball.holder)?.[0]; };
  const waitHeld = () => waitFor(async () => { const s = await A.state(); return s.ball.phase === 'held' && s.ball.holder ? s : null; }, 12000);
  // Everyone catches automatically from here on so the ball keeps circulating.
  for (const x of all.filter((x) => x !== E)) await setAutoGlove(x, true);
  const sample = async (opts) => {
    await waitHeld(); await sleep(700);
    const h = await holderNow();
    await h.page.evaluate(() => { window.__lastThrow = null; const n = window.__catch.game.net; if (!n.__wrapped) { const orig = n.send.bind(n); n.send = (m) => { if (m.t === 'throw') window.__lastThrow = m; return orig(m); }; n.__wrapped = true; } });
    const target = all.find((x) => x !== h && x !== E);
    await aimAt(h, await idOf(target));
    const yawView = (await h.state()).yaw;
    await throwGesture(h, opts);
    const m = await waitFor(() => h.page.evaluate(() => window.__lastThrow), 2000);
    return m ? { yawOff: yawOf(m.v) - yawView, speed: Math.hypot(...m.v) } : null;
  };
  const s0 = await sample({ pull: 60 });
  const sR = await sample({ pull: 60, slide: 70 });
  const sL = await sample({ pull: 60, slide: -70 });
  check('arm aim follows the sideways slide (right → right of view, left → left; no-look throws)', s0 && sR && sL && sR.yawOff < s0.yawOff - 0.1 && sL.yawOff > s0.yawOff + 0.1, `straight=${s0?.yawOff.toFixed(2)} right=${sR?.yawOff.toFixed(2)} left=${sL?.yawOff.toFixed(2)}`);
  const sSoft = await sample({ pull: 30 });
  const sHard = await sample({ pull: 200 });
  const sFlick = await sample({ pull: 120, flick: true });
  check('pull-then-flick also throws (with the windup from before the flick)', sFlick && sFlick.speed > 15, `speed=${sFlick?.speed.toFixed(1)}`);
  check('pull length sets throw speed (soft toss vs hard throw)', sSoft && sHard && sHard.speed > sSoft.speed + 8, `soft=${sSoft?.speed.toFixed(1)} hard=${sHard?.speed.toFixed(1)} m/s`);

  console.log('\nLEFT-HANDED + AUDIO');
  const room2 = code();
  const L = await player(room2, 'Lefty', 'L');
  await sleep(400);
  const ls = await L.state();
  const lgrip = await L.page.evaluate(() => window.__catch.game.gripScreen());
  check('left-handed: throwing hand (ball) is on the left side', lgrip.x < 195, `grip.x=${lgrip.x.toFixed(0)}`);
  const lg0 = ls.glove;
  await L.touch('touchStart', [[300, 520]]);
  for (let i = 1; i <= 8; i++) { await L.touch('touchMove', [[300 - i * 8, 520 - i * 8]]); await sleep(14); }
  await L.touch('touchEnd', []);
  await sleep(120);
  const lg1 = (await L.state()).glove;
  check('left-handed: right thumb moves the glove', lg1.u < lg0.u - 0.2, `Δu=${(lg1.u - lg0.u).toFixed(2)}`);
  await aimAt(L, 'coach');
  await throwGesture(L, { pull: 70 });
  const lt = await waitFor(async () => { const s = await L.state(); return s.ball.phase !== 'held' || s.ball.holder === 'coach' ? s : null; }, 3000, 30);
  check('left-handed: throw from the left thumb works', !!lt);
  await waitFor(async () => (await L.state()).ball.holder === 'coach', 4000);
  check('solo player gets Coach to practise with', (await L.state()).players.some((x) => x.bot));

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
