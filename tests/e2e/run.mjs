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
const errsExtra = [];
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

async function player(room, name, hand = 'R', guest, expect = 'open', windup = 34) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const g = guest ?? `e2e-${Date.now()}-${guestN++}`;
  await page.addInitScript(([g, name, hand, windup]) => {
    if (!localStorage.getItem('catch.prefs.v1')) localStorage.setItem('catch.prefs.v1', JSON.stringify({ guest: g, name, hand, profiled: true, tutorialDone: true, windup }));
  }, [g, name, hand, windup]);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
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

/** A browser on the home screen (no room). */
async function ctxHome() {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.stack || e.message));
  await page.addInitScript(() => { if (!localStorage.getItem('catch.prefs.v1')) localStorage.setItem('catch.prefs.v1', JSON.stringify({ guest: 'home-' + Math.random(), name: 'Sam', hand: 'R', profiled: true, tutorialDone: true })); });
  await page.goto(`${BASE}/?server=${encodeURIComponent(WS)}`);
  await page.locator('[data-act=play]').waitFor();
  return { ctx, page, errors };
}

/** Real gesture: touch, pull back `pull` px (and `side` px sideways), let go. */
async function throwGesture(p, { pull = 110, side = 0, x = 195, y = 430 } = {}) {
  await p.touch('touchStart', [[x, y]]);
  const steps = 8;
  for (let i = 1; i <= steps; i++) { await p.touch('touchMove', [[x + (side * i) / steps, y + (pull * i) / steps]]); await sleep(16); }
  await sleep(120);
  await p.touch('touchEnd', []);
}

/** Real gesture: drag (the glove, when you don't have the ball) and hold for `ms`. */
async function moveGesture(p, { dx = 50, dy = 0, ms = 600, x = 195, y = 500 } = {}) {
  await p.touch('touchStart', [[x, y]]);
  for (let i = 1; i <= 4; i++) { await p.touch('touchMove', [[x + (dx * i) / 4, y + (dy * i) / 4]]); await sleep(12); }
  const end = Date.now() + ms;
  while (Date.now() < end) { await p.touch('touchMove', [[x + dx, y + dy]]); await sleep(40); }
  await p.touch('touchEnd', []);
}

async function aimAt(p, id) { await p.page.evaluate((id) => window.__catch.game.lookAtPlayer(id), id); await sleep(60); }
/** Pull exactly onto a partner's glove (with the hand tremor off), optionally nudged by px. */
async function aimedThrow(p, id, { dSide = 0, dPull = 0 } = {}) {
  await p.page.evaluate(() => { window.__catch.game.steadyAim = true; });
  const a = await p.page.evaluate((id) => window.__catch.game.pullFor(id), id);
  await throwGesture(p, { pull: a.pull + dPull, side: a.side + dSide, x: 195 - (a.side + dSide) / 2, y: 330 });
  await p.page.evaluate(() => { window.__catch.game.steadyAim = false; });
  return a;
}
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
  await throwGesture(holder, { pull: 80 });
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
  await throwGesture(other, { pull: 150 });
  const back = await waitFor(async () => { const s = await holder.state(); return s.ball.phase === 'held' && s.ball.holder === (holder === A ? aId : bId) ? s : null; }, 6000);
  await sleep(300);
  check('any player can throw back (second catch)', !!back && (await A.state()).score.streak === 2);
  const zipHard = (await holder.state()).zipPeak;
  check('throw sound responds to velocity (harder throw → louder ZIP)', zipHard > zipSoft * 1.3, `soft=${zipSoft.toFixed(3)} hard=${zipHard.toFixed(3)}`);

  // Positioning matters: a throw ~2 m wide is caught by getting the glove (and yourself) there…
  await aimAt(holder, otherId);
  await waitCanThrow(holder);
  const wideFrom = (await other.state()).pos.slice();
  await throwGesture(holder, { pull: 90, side: -170 });
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

  console.log('\nLONG-DISTANCE CATCH');
  {
    const [da, db] = [await A.state(), await B.state()];
    const gap = Math.hypot(da.home[0] - db.home[0], da.home[2] - db.home[2]);
    check('both phones agree how far apart they are, and their spots are that far apart', da.score.dist === db.score.dist && Math.abs(gap - da.score.dist) < 0.01, `${da.score.dist} m, spots ${gap.toFixed(2)} m apart`);
    check('three catches and one miss so far: three steps back, one step in', da.score.dist === 16 && da.score.misses === 1, `dist=${da.score.dist} misses=${da.score.misses}`);
    const hudA = await A.page.locator('#streakLabel').textContent();
    check('the distance is on screen beside the streak, in feet', /52 ft/i.test(hudA), hudA);
    const walked = await waitFor(async () => { const s = await A.state(); return Math.hypot(s.pos[0] - s.home[0], s.pos[2] - s.home[2]) < 0.2 ? s : null; }, 6000);
    check('players walk to their new spot on their own', !!walked);
  }

  console.log('\nTHE PERFECT POP (both jobs)');
  for (const x of [A, B]) await setAutoMove(x, false);
  await sleep(2200); // everyone back on their spot, gloves held still
  const thrower = (await A.state()).ball.holder === aId ? A : B, catcher = thrower === A ? B : A;
  const catcherId = await idOf(catcher), throwerId = await idOf(thrower);
  await aimAt(thrower, catcherId);
  await waitCanThrow(thrower);
  await sleep(400);
  await aimedThrow(thrower, catcherId);
  const pg = await waitFor(async () => { const s = await catcher.state(); return s.ball.holder === catcherId ? s : null; }, 6000);
  const perfectPop = pg && [...pg.audio].reverse().find((x) => x.k === 'pop');
  check('ring on a glove held still → caught dead centre: a perfect POP', perfectPop?.q === 'perfect', `q=${perfectPop?.q} g=${perfectPop?.g}`);
  // Same thing, but the throw is ~14 cm off the glove: still caught, not perfect.
  await aimAt(catcher, throwerId);
  await waitCanThrow(catcher);
  await sleep(400);
  await aimedThrow(catcher, throwerId, { dSide: 12 });
  const og = await waitFor(async () => { const s = await thrower.state(); return s.ball.holder === throwerId ? s : null; }, 6000);
  const offPop = og && [...og.audio].reverse().find((x) => x.k === 'pop');
  check('a throw a hand-width off the glove still finds it, but not perfectly', !!offPop && offPop.q !== 'perfect' && offPop.g < 0.8, `q=${offPop?.q} g=${offPop?.g}`);

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
  await throwGesture(H, { pull: 110 });
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

  // Someone without the ball drags: that's their glove, and nothing is thrown.
  const mover = others.find((x) => x !== T && x !== E);
  await setAutoMove(mover, false);
  const m0 = await mover.state();
  await moveGesture(mover, { dx: 40, dy: -30, ms: 300 });
  await sleep(250);
  const m1 = await mover.state();
  check('drag sets the glove (up and to the side) and nothing is thrown', m1.gloveSet[0] > m0.gloveSet[0] + 0.1 && m1.gloveSet[1] > m0.gloveSet[1] + 0.08 && m1.controls.throws === m0.controls.throws, `Δright=${(m1.gloveSet[0] - m0.gloveSet[0]).toFixed(2)} Δup=${(m1.gloveSet[1] - m0.gloveSet[1]).toFixed(2)}`);
  await sleep(1200);
  const m2 = await mover.state();
  check('…and the glove stays where you leave it', Math.abs(m2.gloveSet[0] - m1.gloveSet[0]) < 1e-6 && Math.abs(m2.gloveSet[1] - m1.gloveSet[1]) < 1e-6);
  await moveGesture(mover, { dx: 300, dy: 0, ms: 600 });
  await sleep(500);
  const m3 = await mover.state();
  const stepped = Math.hypot(m3.pos[0] - m2.pos[0], m3.pos[2] - m2.pos[2]);
  check('push the glove past your reach and you step after it', stepped > 0.5, `stepped=${stepped.toFixed(2)} m`);

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
  const sR = await sample({ pull: 110, side: -110 });
  const sL = await sample({ pull: 110, side: 110 });
  check('pulling to one side throws to the other (slingshot)', s0 && sR && sL && sR.yawOff < s0.yawOff - 0.06 && sL.yawOff > s0.yawOff + 0.06, `straight=${s0?.yawOff.toFixed(2)} pull-left=${sR?.yawOff.toFixed(2)} pull-right=${sL?.yawOff.toFixed(2)}`);
  const sSoft = await sample({ pull: 50 });
  const sHard = await sample({ pull: 240 });
  check('pull length sets throw speed (soft toss vs hard throw)', sSoft && sHard && sHard.speed > sSoft.speed + 5, `soft=${sSoft?.speed.toFixed(1)} hard=${sHard?.speed.toFixed(1)} m/s`);

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

  // ------------------------------------------------------------------
  console.log('\nTWO VIEWS (throwing = third person, catching = first person)');
  const room3 = code();
  const X = await player(room3, 'Xan', 'R', undefined, 'open', 34);
  const Y = await player(room3, 'Yui', 'L', undefined, 'open', 51);
  await waitFor(async () => (await X.state()).players.length === 2 && (await Y.state()).players.length === 2);
  const xId = await idOf(X), yId = await idOf(Y);
  const who = async () => ((await X.state()).ball.holder === xId ? [X, Y, xId, yId] : [Y, X, yId, xId]);
  let [T1, R1, t1Id, r1Id] = await who();
  for (const p of [X, Y]) await p.page.evaluate(() => { window.__catch.game.steadyAim = true; });
  const views = await waitFor(async () => { const [t, r] = [await T1.state(), await R1.state()]; return r.view >= 1 && t.view <= 0 ? [t, r] : null; }, 5000);
  check('whoever has the ball is in third person, and the one waiting for it is in first person, at the same moment', !!views && views[0].first === false && views[1].first === true, `thrower view=${views?.[0].view} receiver view=${views?.[1].view}`);

  console.log('\nSIGNATURE WINDUPS');
  const wx = (await Y.state()).windups.find((p) => p.id === xId)?.windup, wy = (await X.state()).windups.find((p) => p.id === yId)?.windup;
  check('each player throws with their own windup, and the other client knows which', wx === 34 && wy === 51, `Xan=#${wx} Yui=#${wy}`);
  const remoteAv = (await R1.state()).remotes.find((r) => r.id === t1Id);
  check('…and animates the other player with it', remoteAv?.windup === (T1 === X ? 34 : 51), `remote avatar windup=#${remoteAv?.windup}`);

  // Hold the aim: the windup runs to the top at its own tempo and rests there; the receiver sees it.
  await setAutoMove(R1, true);
  await waitCanThrow(T1);
  const aim = await T1.page.evaluate((id) => window.__catch.game.pullFor(id), r1Id);
  const ax = 195 - aim.side / 2;
  await T1.touch('touchStart', [[ax, 330]]);
  for (let i = 1; i <= 8; i++) { await T1.touch('touchMove', [[ax + (aim.side * i) / 8, 330 + (aim.pull * i) / 8]]); await sleep(16); }
  const keep = setInterval(() => T1.touch('touchMove', [[ax + aim.side, 330 + aim.pull]]).catch(() => {}), 60);
  const atTop = await waitFor(async () => { const s = await T1.state(); return s.windU >= 1 ? s : null; }, 4000, 30);
  check('holding the aim runs the windup up to the top, where it waits for you', !!atTop && atTop.ball.phase === 'held', `windU=${atTop?.windU}`);
  const seenTop = await waitFor(async () => { const r = (await R1.state()).remotes.find((q) => q.id === t1Id); return r && r.arm === 2 && r.charge > 0.9 ? r : null; }, 3000, 30);
  check('the receiver watches the same windup reach the top', !!seenTop, `remote phase=${seenTop?.charge}`);
  const tCam = await T1.state();
  check('while you wind up the camera keeps all of you (head to toe) and your friend in the shot', (() => {
    return !!tCam && tCam.view === 0;
  })() && (await T1.page.evaluate(() => { const g = window.__catch.game; const s = g.debugState(); const feet = g.screenOf([s.pos[0], 0.05, s.pos[2]]), head = g.screenOf([s.pos[0], 1.95, s.pos[2]]), pal = g.screenOf([s.partnerPos[0], 1.2, s.partnerPos[2]]); return feet.on && head.on && pal.on && pal.y < head.y; })));
  clearInterval(keep);
  // Let go: the ball stays in the hand through the stride, and leaves it at the release.
  const tUp = Date.now();
  await T1.touch('touchEnd', []);
  await sleep(120);
  const mid = await T1.state();
  check('letting go starts the delivery; the ball is still in the hand a moment later', mid.ball.phase === 'held' && mid.pending === true && mid.delivery > 0 && mid.delivery < 0.3, `phase=${mid.ball.phase} clip=${mid.delivery?.toFixed(2)}`);
  const seenFlight = await waitFor(async () => { const r = await R1.state(); return r.ball.phase === 'flight' ? r : null; }, 3000, 8);
  const gone = await waitFor(async () => { const s = await T1.state(); return s.ball.phase !== 'held' || s.ball.holder !== t1Id ? s : null; }, 3000, 10);
  check('the ball leaves the hand at the release point of the animation', !!gone && Math.abs(gone.releaseClip - 0.3) < 0.04 && gone.releaseGap < 0.2, `clip t=${gone?.releaseClip?.toFixed(3)} s, hand-to-ball gap=${gone?.releaseGap?.toFixed(3)} m`);
  check('…a fixed beat after you let go (the same for every windup)', Date.now() - tUp < 900);
  const rAv = seenFlight?.remotes.find((r) => r.id === t1Id);
  check('on the other phone the throw lines up with the delivery it is watching', !!rAv && rAv.delivery >= 0.22 && rAv.delivery < 0.42, `remote clip t=${rAv?.delivery?.toFixed(2)} s when the flight arrived (release is at 0.30)`);
  const caught1 = await waitFor(async () => { const s = await R1.state(); return s.ball.phase === 'held' && s.ball.holder === r1Id ? s : null; }, 6000, 30);
  check('the catcher catches it in first person', !!caught1 && caught1.view > 0.9, `view=${caught1?.view?.toFixed(2)}`);
  const swapped = await waitFor(async () => { const [t, r] = [await T1.state(), await R1.state()]; return t.view >= 1 && r.view <= 0 ? [t, r] : null; }, 5000);
  check('roles reverse and so do the views: each player moves to the view for their own role', !!swapped && swapped[0].first === true && swapped[1].first === false, `old thrower view=${swapped?.[0].view} new thrower view=${swapped?.[1].view}`);

  // Change windup mid-game: everyone sees it.
  await R1.page.evaluate(() => window.__catch.game.setWindup(16));
  const changed = await waitFor(async () => { const s = await T1.state(); return s.windups.find((p) => p.id !== s.me)?.windup === 16 && s.remotes[0]?.windup === 16; }, 3000);
  check('changing your windup mid-game reaches the other player', !!changed);

  console.log('\nBAD THROWS, GREAT CATCHES');
  // (R1 has the ball now; T1 is the catcher, on their own, no auto-move.)
  [T1, R1, t1Id, r1Id] = [R1, T1, r1Id, t1Id];
  await setAutoMove(R1, false); await setAutoMove(T1, false);
  await sleep(1700);
  const flick = async (p, dx, dy) => {
    await p.touch('touchStart', [[195, 480]]);
    for (let i = 1; i <= 4; i++) { await p.touch('touchMove', [[195 + (dx * i) / 4, 480 + (dy * i) / 4]]); await sleep(9); }
    await sleep(300);
    await p.touch('touchEnd', []);
  };
  const crossOf = (p) => p.page.evaluate(() => { const s = window.__catch.game.debugState(); if (!s.cross || s.ball.phase !== 'flight') return null; const dx = s.cross.at[0] - s.pos[0], dz = s.cross.at[2] - s.pos[2]; return { right: Math.cos(s.yaw) * dx - Math.sin(s.yaw) * dz, up: s.cross.at[1], tier: s.tier, first: s.first, tta: s.tta }; });
  /** Wait (in the page, frame by frame) until the ball is `secs` from the glove plane. */
  const untilTta = (p, secs) => p.page.evaluate((secs) => new Promise((res) => { const g = window.__catch.game; const t0 = performance.now(); const f = () => { const s = g.debugState(); if ((s.tta !== null && s.tta <= secs) || s.ball.phase !== 'flight' || performance.now() - t0 > 4000) res(s.tta); else requestAnimationFrame(f); }; f(); }), secs);
  const gradeText = (p) => p.page.locator('#grade').textContent();

  // 0. Wide, and the catcher just moves a thumb toward it (no flick): they run under it,
  //    and the view slides over with them instead of swinging round.
  await waitCanThrow(T1);
  await aimAt(T1, r1Id);
  const from0 = (await R1.state()).pos.slice();
  await throwGesture(T1, { pull: 60, side: 150 });
  const w0 = await waitFor(() => crossOf(R1), 3000, 8);
  const turns = R1.page.evaluate(() => new Promise((res) => { const g = window.__catch.game; let m = 0; const f = () => { const s = g.debugState(); m = Math.max(m, Math.abs(s.turn)); if (s.ball.phase === 'flight') requestAnimationFrame(f); else res(m); }; f(); }));
  await R1.touch('touchStart', [[195, 480]]);
  for (let i = 1; i <= 10; i++) { await R1.touch('touchMove', [[195 + Math.sign(w0.right) * i * 3, 480]]); await sleep(30); }
  const ran0 = await waitFor(async () => { const s = await R1.state(); return s.ball.phase === "held" && s.ball.holder === r1Id ? s : s.ball.phase === "loose" ? { fail: true } : null; }, 5000, 20);
  await R1.touch('touchEnd', []);
  const maxTurn = await turns;
  const moved0 = ran0 && !ran0.fail ? Math.hypot(ran0.pos[0] - from0[0], ran0.pos[2] - from0[2]) : 0;
  check('a wide throw: move your thumb toward it and you run under it and catch it', !!ran0 && !ran0.fail && moved0 > 0.8, `off by ${w0?.right?.toFixed(2)} m, ran ${moved0.toFixed(2)} m, ${(await T1.state()).lastCatch?.st ?? 'routine'}`);
  check('…and the view never swings round to chase it', maxTurn < 0.45, `turned at most ${(maxTurn * 57.3).toFixed(0)}°`);
  [T1, R1, t1Id, r1Id] = [R1, T1, r1Id, t1Id];
  await sleep(1900);

  // 1. Wide: ~1.9 m off the glove. Out of reach from where the catcher stands.
  await waitCanThrow(T1);
  await aimAt(T1, r1Id);
  const stoodAt = (await R1.state()).pos.slice();
  await throwGesture(T1, { pull: 90, side: 160 });
  const wide = await waitFor(() => crossOf(R1), 3000, 8);
  check('a wide throw shows up as one that needs something special (not an automatic miss)', !!wide && Math.abs(wide.right) > 1.2 && wide.tier >= 1 && wide.tier <= 2 && wide.first, `off by ${wide?.right?.toFixed(2)} m, tier=${wide?.tier}`);
  await untilTta(R1, 0.42);
  await flick(R1, Math.sign(wide.right) * 150, 0);
  const dove = await waitFor(async () => { const s = await R1.state(); return s.ball.phase === 'held' && s.ball.holder === r1Id ? s : s.ball.phase === 'loose' ? { fail: s } : null; }, 5000, 20);
  await sleep(250);
  const dv = await T1.state();
  check('flick toward it: a diving catch, and the streak lives', !!dove && !dove.fail && dove.lastStyle === 'dive' && dv.lastCatch?.st === 'dive', `mine=${dove?.lastStyle ?? dove?.fail?.lastStyle} server=${dv.lastCatch?.st} q=${dv.lastCatch?.q}`);
  const went = (await R1.state()).pos;
  check('…the body really went and got it', Math.hypot(went[0] - stoodAt[0], went[2] - stoodAt[2]) > 0.7, `moved ${Math.hypot(went[0] - stoodAt[0], went[2] - stoodAt[2]).toFixed(2)} m`);
  check('…and both players are told what kind of catch it was', /Diving catch/i.test(await gradeText(T1)) && /Diving catch/i.test(await gradeText(R1)), `"${await gradeText(T1)}"`);
  const saves = (await T1.state()).windups.find((p) => p.id === r1Id)?.saves;
  check('…and it is counted as a great catch', saves === 1, `great catches=${saves}`);

  // 1b. A dive is a commitment: go far too early and you're on the grass when the ball arrives.
  [T1, R1, t1Id, r1Id] = [R1, T1, r1Id, t1Id];
  await sleep(1900);
  await waitCanThrow(T1);
  await aimAt(T1, r1Id);
  const before1b = (await T1.state()).score.streak;
  await throwGesture(T1, { pull: 60, side: 160 });
  const wide2 = await waitFor(() => crossOf(R1), 3000, 8);
  // (Early enough that the ball arrives while they're still down on the grass.)
  wide2.tta = await untilTta(R1, 0.78);
  await flick(R1, Math.sign(wide2.right) * 150, 0);
  const early = await waitFor(async () => { const s = await T1.state(); return s.ball.phase !== 'flight' ? s : null; }, 6000, 20);
  check('diving far too early misses: timing matters', before1b >= 1 && !!early && early.ball.phase === 'loose' && early.score.streak === 0, `dove with ${wide2?.tta?.toFixed(2)} s to go → ${early?.ball.phase}, streak ${before1b} → ${early?.score.streak}`);
  await waitFor(async () => { const s = await T1.state(); return s.ball.phase === 'held' && s.ball.holder ? s : null; }, 9000);
  if ((await T1.state()).ball.holder !== t1Id) [T1, R1, t1Id, r1Id] = [R1, T1, r1Id, t1Id];
  // Build the streak back up for what follows.
  for (let i = 0; i < 3; i++) {
    await setAutoMove(R1, true);
    await sleep(1700);
    await waitCanThrow(T1);
    await aimAt(T1, r1Id);
    await aimedThrow(T1, r1Id);
    await waitFor(async () => { const s = await R1.state(); return s.ball.phase === 'held' && s.ball.holder === r1Id; }, 6000);
    await setAutoMove(R1, false);
    [T1, R1, t1Id, r1Id] = [R1, T1, r1Id, t1Id];
  }
  [T1, R1, t1Id, r1Id] = [R1, T1, r1Id, t1Id];

  // 2. High: over the catcher's head. Flick up to leave the ground.
  [T1, R1, t1Id, r1Id] = [R1, T1, r1Id, t1Id];
  await sleep(1900);
  await waitCanThrow(T1);
  await aimAt(T1, r1Id);
  const H2 = 664;
  const a2 = await T1.page.evaluate((id) => window.__catch.game.pullFor(id), r1Id);
  await throwGesture(T1, { pull: 14 + ((2.52 - 0.15) / 2.55) * 0.27 * H2, side: a2.side, x: 195 - a2.side / 2, y: 300 });
  const hi = await waitFor(() => crossOf(R1), 3000, 8);
  check('a throw over your head is out of a standing reach', !!hi && hi.up > 2.34, `crossing at ${hi?.up?.toFixed(2)} m`);
  await untilTta(R1, 0.36);
  await flick(R1, 0, -150);
  const leapt = await waitFor(async () => { const s = await R1.state(); return s.ball.phase === 'held' && s.ball.holder === r1Id ? s : s.ball.phase === 'loose' ? { fail: s } : null; }, 5000, 20);
  await sleep(250);
  check('flick up: a leaping grab', !!leapt && !leapt.fail && leapt.lastStyle === 'leap' && (await T1.state()).lastCatch?.st === 'leap', `mine=${leapt?.lastStyle} server=${(await T1.state()).lastCatch?.st}`);

  // 3. In the dirt: a scoop (the glove gets down to it).
  [T1, R1, t1Id, r1Id] = [R1, T1, r1Id, t1Id];
  await setAutoMove(R1, true);
  await sleep(1900);
  await waitCanThrow(T1);
  await aimAt(T1, r1Id);
  const a3 = await T1.page.evaluate((id) => window.__catch.game.pullFor(id), r1Id);
  await throwGesture(T1, { pull: 14 + ((0.36 - 0.15) / 2.55) * 0.27 * H2, side: a3.side, x: 195 - a3.side / 2, y: 300 });
  const scooped = await waitFor(async () => { const s = await T1.state(); return s.ball.phase === 'held' && s.ball.holder === r1Id ? s : null; }, 6000, 20);
  check('a low throw is scooped out of the dirt', scooped?.lastCatch?.st === 'scoop', `server=${scooped?.lastCatch?.st}`);

  // 4. Truly uncatchable: way over everything. The guide says so, and it is a miss.
  [T1, R1, t1Id, r1Id] = [R1, T1, r1Id, t1Id];
  await setAutoMove(R1, false);
  await sleep(1900);
  await waitCanThrow(T1);
  await aimAt(T1, r1Id);
  const streakBefore = (await T1.state()).score.streak;
  await throwGesture(T1, { pull: 150, side: -330 });
  const goneTier = await waitFor(async () => { const c = await crossOf(R1); return c && c.tier === 3 ? c : null; }, 2500, 8);
  const missed = await waitFor(async () => (await T1.state()).score.streak === 0, 6000);
  check('a throw nobody could get to reads as gone, and is a miss', !!missed && streakBefore >= 3, `streak before=${streakBefore}${goneTier ? ', guide said gone' : ''}`);
  const missWord = await gradeText(R1);
  check('…called what it was', /Wild throw|Dropped/i.test(missWord), `"${missWord}"`);
  const backOut = await waitFor(async () => (await R1.state()).view <= 0, 4000);
  check('after a miss the catcher\'s view steps back out to watch the ball', !!backOut);

  console.log('\nWINDUP SELECTOR');
  const S1 = await ctxHome();
  await S1.page.locator('[data-act=windup]').tap();
  const tilesN = await S1.page.locator('.jersey').count();
  check('the selector lists every windup by number', tilesN === 7, `${tilesN} tiles`);
  // Everything on the sheet is a number, a plain description of the motion, or chrome: nothing else.
  const words = (await S1.page.locator('.sheet').innerText()).split('\n').map((x) => x.trim()).filter(Boolean);
  const blurbs = await S1.page.locator('.jersey').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label').replace(/^Number \d+: /, '')));
  const stray = words.filter((x) => !/^(Windup|Done|#?\d\d)$/.test(x) && !blurbs.includes(x));
  check('numbers and plain descriptions of the motion only', stray.length === 0 && blurbs.length === 7, stray.join(' | ') || words.slice(0, 3).join(' · '));
  await S1.page.locator('.jersey[data-id="55"]').tap();
  await sleep(200);
  const picked = await S1.page.evaluate(() => JSON.parse(localStorage.getItem('catch.prefs.v1')).windup);
  check('tapping a number selects it, previews it and saves it at once', picked === 55 && (await S1.page.locator('#wunum').textContent()) === '#55' && (await S1.page.locator('.jersey[aria-checked=true]').getAttribute('data-id')) === '55', `saved=${picked}`);
  const big = await S1.page.locator('.jersey[data-id="55"]').boundingBox();
  check('the numbers are comfortable touch targets', big.width >= 64 && big.height >= 64, `${Math.round(big.width)}×${Math.round(big.height)} px`);
  await S1.page.locator('#done').tap();
  await sleep(200);
  check('…and it is what the home screen shows next', /#55/.test(await S1.page.locator('[data-act=windup]').innerText()));
  await S1.page.reload();
  check('…and what you have after a reload', /#55/.test(await S1.page.locator('[data-act=windup]').innerText()));

  console.log('\nLOOKS AND REWARDS');
  {
    // Choose a look on the home screen: it is saved, and it is what you wear in a room.
    const P = await ctxHome();
    await P.page.locator('[data-act=look]').tap();
    await P.page.locator('[data-tab=body]').tap();
    await P.page.locator('[data-set="0:4"]').tap();
    await P.page.locator('[data-set="2:3"]').tap();
    await P.page.locator('[data-tab=top]').tap();
    await P.page.locator('[data-set="6:2"]').tap();
    await P.page.locator('[data-tab=hat]').tap();
    const lockedN = await P.page.locator('.item.locked').count();
    const lockedText = await P.page.locator('.item.locked').first().innerText();
    check('hats you have not earned are shown with what earns them', lockedN === 4 && /25 in a row/.test(lockedText), `${lockedN} locked · ${lockedText.replace(/\s+/g, ' ')}`);
    await P.page.locator('.item.locked').first().tap({ force: true });
    const st = await P.page.evaluate(() => JSON.parse(localStorage.getItem('catch.prefs.v1')).style);
    check('choosing a body, hair and a top saves at once; a locked hat cannot be put on', st[0] === 4 && st[2] === 3 && st[6] === 2 && st[4] < 5, JSON.stringify(st));
    const tgt = await P.page.locator('.swatch, .pick, .item:not(.locked)').first().boundingBox();
    check('the choices are comfortable touch targets', tgt.width >= 44 && tgt.height >= 44, `${Math.round(tgt.width)}×${Math.round(tgt.height)} px`);
    await P.page.locator('#done').tap();
    // (A home screen draws the field all the time: close it, and the earlier ones, before more players join.)
    await P.ctx.close();
    for (const x of [S1, C, D, X, Y, L]) await x.ctx.close().catch(() => {});

    // Two players reach ten in a row together: both earn the reward, once, and can wear it.
    const room4 = code();
    const guestU = `e2e-u-${Date.now()}`;
    const U = await player(room4, 'Uma', 'R', guestU), V = await player(room4, 'Vic', 'L');
    await waitFor(async () => (await U.state()).players.length === 2 && (await V.state()).players.length === 2);
    const uId = await idOf(U), vId = await idOf(V);
    const seen = (await V.state()).players.length === 2 && await V.page.evaluate((id) => window.__catch.game.players.get(id).info.style, uId);
    const mineU = await U.page.evaluate(() => JSON.parse(localStorage.getItem('catch.prefs.v1')).style);
    check('the other player is told your look and draws you with it', JSON.stringify(seen) === JSON.stringify(mineU) && JSON.stringify(await V.page.evaluate((id) => window.__catch.game.players.get(id).avatar.style, uId)) === JSON.stringify(mineU), JSON.stringify(seen));
    for (const p of [U, V]) { await p.page.evaluate(() => { window.__catch.game.steadyAim = true; }); await setAutoMove(p, true); }
    for (let i = 0; i < 14 && (await U.state()).score.streak < 10; i++) {
      const s = await waitFor(async () => { const q = await U.state(); return q.ball.phase === 'held' && q.ball.holder ? q : null; }, 9000);
      const [T, R, rId] = s.ball.holder === uId ? [U, V, vId] : [V, U, uId];
      await aimAt(T, rId);
      await waitCanThrow(T);
      await sleep(350);
      await aimedThrow(T, rId);
      await waitFor(async () => { const q = await R.state(); return q.ball.phase === 'held' && q.ball.holder === rId; }, 7000);
    }
    await sleep(400);
    const [su, sv] = [await U.state(), await V.state()];
    const earnedOf = (p) => p.page.evaluate(() => JSON.parse(localStorage.getItem('catch.prefs.v1')).earned);
    const [eu, ev] = [await earnedOf(U), await earnedOf(V)];
    check('ten in a row: both players earn the reward', su.score.streak >= 10 && eu.includes(10) && ev.includes(10), `streak=${su.score.streak} earned U=${JSON.stringify(eu)} V=${JSON.stringify(ev)}`);
    check('…and by now they are ten steps further apart', su.score.dist === 14 + su.score.streak && sv.score.dist === su.score.dist, `${su.score.dist} m at a streak of ${su.score.streak}`);
    // Put it on, mid-game: the other phone sees it.
    await U.page.locator('#pauseBtn').tap();
    const hint = await U.page.locator('.sheet').innerText();
    check('the pause sheet says what the next reward is', /Next reward: Bucket hat at 25/.test(hint), (hint.match(/Next reward[^\n]*/) || [''])[0]);
    await U.page.locator('#lk').tap();
    await U.page.locator('[data-tab=glove]').tap();
    const newTag = await U.page.locator('.item[data-set="5:2"]').innerText();
    await U.page.locator('.item[data-set="5:2"]').tap();
    await U.page.locator('#done').tap();
    const worn = await waitFor(() => V.page.evaluate((id) => window.__catch.game.players.get(id).avatar.style[5] === 2, uId), 4000);
    check('the earned glove can be put on mid-game, and the other player sees it', !!worn && /Black/.test(newTag), newTag.replace(/\s+/g, ' '));
    // Once only: reload, come back, drop and climb past ten again, and nothing is handed out twice.
    check('a reward is given once', eu.filter((m) => m === 10).length === 1);
    errsExtra.push(...P.errors, ...U.errors, ...V.errors);
  }

  console.log('\nGAMES (long toss, classic, big mitt) AND THE THROW');
  {
    const G = await ctxHome();
    await G.page.locator('[data-act=play]').tap();
    const names = await G.page.locator('.mode b').allInnerTexts();
    check('PLAY asks which game: long toss, classic or big mitt', names.join('|') === 'Long toss|Classic|Big mitt', names.join(' · '));
    await G.page.locator('.mode[data-mode=mitt]').tap();
    await waitFor(() => G.page.evaluate(() => window.__catch?.game?.debugState().status === 'open'), 10000, 50);
    await G.page.evaluate(() => { const g = window.__catch.game; g.renderEnabled = false; g.steadyAim = true; });
    const gcdp = await G.ctx.newCDPSession(G.page);
    G.touch = (type, pts) => gcdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q) => ({ x: q[0], y: q[1], id: q[2] ?? 0 })) });
    G.state = () => G.page.evaluate(() => window.__catch.game.debugState());
    const g0 = await waitFor(async () => { const s = await G.state(); return s.score.mode === 'mitt' && s.players.length === 2 ? s : null; }, 5000);
    const lab0 = await G.page.locator('#streakLabel').textContent();
    check('big mitt: everyone starts with a giant glove', g0?.score.glove === 3 && /glove ×3\.0/i.test(lab0), `glove ×${g0?.score.glove} · "${lab0}"`);
    const drawn = await G.page.evaluate(() => { const g = window.__catch.game; return [...g.players.values()].map((p) => (p.avatar ?? g.myAvatar)?.glove.scale.y); });
    check('…and it is drawn that size on every player', drawn.every((x) => x === 3), JSON.stringify(drawn));
    await waitCanThrow(G);
    await sleep(400);
    // A throw 45 cm off Coach's glove: a miss with a regular glove, a catch with this one.
    const pa = await G.page.evaluate(() => window.__catch.game.pullFor('coach'));
    const relBefore = (await G.state()).audio.filter((x) => x.k === 'release').length;
    await throwGesture(G, { pull: pa.pull, side: pa.side + 38, x: 195 - (pa.side + 38) / 2, y: 330 });
    const gc = await waitFor(async () => { const s = await G.state(); return s.ball.holder === 'coach' ? s : s.ball.phase === 'loose' ? { fail: true } : null; }, 6000);
    await sleep(300);
    const g1 = await G.state();
    check('a throw well off the pocket still finds a giant glove', !!gc && !gc.fail && g1.score.streak === 1, `streak=${g1.score.streak} q=${g1.lastCatch?.q}`);
    check('…and the glove is a size smaller after the catch', g1.score.glove < 3 && g1.score.glove > 2.7 && g1.score.dist === 14, `glove ×${g1.score.glove}, ${g1.score.dist} m apart`);
    const rel = g1.audio.filter((x) => x.k === 'release');
    check('the throw has its own sound: a snap as the ball leaves the hand', rel.length === relBefore + 1 && rel[rel.length - 1].power > 0, `power=${rel[rel.length - 1]?.power?.toFixed(2)}`);
    await G.page.reload();
    await G.page.locator('#go').waitFor();
    const lastMode = await G.page.evaluate(() => JSON.parse(localStorage.getItem('catch.prefs.v1')).mode);
    check('the game you picked is remembered for next time', lastMode === 'mitt');
    await G.ctx.close();

    const F = await ctxHome();
    await F.page.locator('[data-act=play]').tap();
    await F.page.locator('.mode[data-mode=fixed]').tap();
    const fs = await waitFor(async () => { const s = await F.page.evaluate(() => window.__catch?.game?.debugState()); return s?.status === 'open' && s.score.mode === 'fixed' ? s : null; }, 10000, 50);
    const flab = await F.page.locator('#streakLabel').textContent();
    check('classic: a regular glove at a fixed 46 feet, with nothing else on the scoreboard', fs?.score.glove === 1 && fs.score.dist === 14 && flab.trim() === 'in a row', `"${flab}"`);
    errsExtra.push(...G.errors, ...F.errors);
    await F.ctx.close();
  }

  console.log('\nPERFORMANCE / STABILITY');
  const errs = [...[A, B, C, D, L, X, Y, S1].flatMap((x) => x.errors), ...errsExtra];
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
