// Live smoke test: two independent browsers play catch on a deployed build
// against its real room server.  BASE=https://catch-haveanapp.vercel.app node tests/e2e/live.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const BASE = process.env.BASE || 'https://catch-haveanapp.vercel.app';
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const room = Array.from({ length: 4 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10000) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; }
let failed = 0;
const check = (n, ok, d = '') => { if (!ok) failed++; console.log(`${ok ? '  ✓' : '  ✗'} ${n}${d ? ' — ' + d : ''}`); };

const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
const browser = await chromium.launch({ proxy, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
async function player(name, i) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(([g, n]) => localStorage.setItem('catch.prefs.v1', JSON.stringify({ guest: g, name: n, hand: 'R', profiled: true, tutorialDone: true })), [`live-${Date.now()}-${i}`, name]);
  await page.goto(`${BASE}/r/${room}`);
  await page.locator('#go').tap();
  const ok = await waitFor(() => page.evaluate(() => window.__catch?.game?.debugState().status === 'open'), 90000);
  const cdp = await ctx.newCDPSession(page);
  return { page, ctx, errors, ok, state: () => page.evaluate(() => window.__catch.game.debugState()), touch: (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q) => ({ x: q[0], y: q[1], id: 0 })) }) };
}
try {
  console.log(`LIVE ${BASE}  room ${room}`);
  const A = await player('Ann', 0);
  check('player 1 connects to the live room server', !!A.ok);
  await A.page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/live-solo.png` : '/dev/null' }).catch(() => {});
  const B = await player('Ben', 1);
  check('player 2 joins the same live room', !!B.ok);
  const both = await waitFor(async () => { const [a, b] = [await A.state(), await B.state()]; return a.players.length === 2 && b.players.length === 2 ? [a, b] : null; });
  check('both see each other and agree on the ball holder', !!both && both[0].ball.holder === both[1].ball.holder, `rtt≈${both?.[0].rtt.toFixed(0)}ms`);
  for (const p of [A, B]) await p.page.evaluate(() => { window.__catch.game.renderEnabled = false; window.__catch.game.autoGlove = true; });
  const [a] = both;
  const H = a.ball.holder === a.me ? A : B, R = H === A ? B : A;
  const rId = (await R.state()).me;
  await H.page.evaluate((id) => window.__catch.game.lookAtPlayer(id), rId);
  const g = await H.page.evaluate(() => window.__catch.game.gripScreen());
  await H.touch('touchStart', [[g.x, g.y]]);
  // Grip, pull down, let go.
  for (let i = 1; i <= 6; i++) { await H.touch('touchMove', [[g.x, g.y + i * 12]]); await sleep(14); }
  await sleep(150);
  await H.touch('touchEnd', []);
  const caught = await waitFor(async () => { const s = await R.state(); return s.ball.phase === 'held' && s.ball.holder === rId ? s : null; }, 8000);
  await sleep(400);
  const [sa, sb] = [await A.state(), await B.state()];
  check('real touch throw → real glove catch through the live server', !!caught);
  check('streak synced on both phones', sa.score.streak === 1 && sb.score.streak === 1, `A=${sa.score.streak} B=${sb.score.streak}`);
  const pop = (await R.state()).audio.find((x) => x.k === 'pop');
  check('catch is graded and the POP plays that grade', typeof pop?.g === 'number', `q=${pop?.q} g=${pop?.g}`);
  check('no page errors', A.errors.length + B.errors.length === 0, [...A.errors, ...B.errors].join(' | '));
  if (process.env.SHOT_DIR) { await R.page.evaluate(() => { window.__catch.game.renderEnabled = true; }); await sleep(800); await R.page.screenshot({ path: `${process.env.SHOT_DIR}/live-caught.png` }); }
} catch (e) { console.error(e); failed++; }
await browser.close();
process.exit(failed ? 1 : 0);
