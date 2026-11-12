# CATCH.

Two people. One baseball. One continuous shot.

A game about the simple pleasure of throwing a ball back and forth with
someone, at golden hour in the park. You see both of you from a few steps
away, like a friend standing nearby watching you play. Two to five friends can
share a room and keep one streak of consecutive catches alive; alone, Coach
keeps you company.

No accounts, no installs: open the link, pick a name and a throwing hand, play.

## How to play

One thumb, no buttons on screen:

- **Set the target** (when your friend has the ball): your thumb is your glove.
  Drag to hold it up where you want the throw: chest, high, low, across. It
  stays where you leave it. Slow drags are precise, quick ones cover ground,
  and pushing it past your reach makes you step over after it.
- **Throw** (when you have the ball): touch anywhere, **pull back** and **let go**.
  An aim ring appears on your friend's glove plane (their pocket gets a faint
  gold mark). Pull to one side to move the ring across (like a slingshot), pull
  further to lift it (and throw harder). The ring breathes a little with your
  hand, more for hard throws and long holds, so pick your moment. It turns gold
  on the pocket. While you aim, the shot eases in on your friend.
- **Catch**: hold the glove still and let a good throw find it. If the throw is
  off, get the glove to the ball (and yourself, if you must). Late adjustments
  cost you the clean POP, and a last-instant lunge can save a near miss, but it
  won't sound good. Watch the ball's shadow to judge where it's coming down.
- **Both jobs make the POP**: a perfect POP needs a throw that finds the pocket
  *and* a glove held still. The grade word under the streak tells you how it went.
- Desktop: arrow keys / WASD also move you.
- **The POP is your grade.** The server scores each catch by how close the ball
  came to the centre of your pocket, and everyone hears that grade: a perfect
  catch cracks and rings off the houses, an off-centre one thwaps, a bobble
  squeezes twice. Perfect catches are counted in the pause sheet.
- Every caught throw adds one to the room's streak; a drop resets it.

## Architecture

```
src/shared/   deterministic ball physics, player geometry, wire protocol (used by both sides)
src/server/   authoritative room server (Node + ws): rooms, possession, catch validation, streaks, Coach bot
src/client/   Vite + TypeScript + Three.js client: third-person rendering, one-thumb controls, prediction, Web Audio
tests/unit/   Vitest: physics + room authority
tests/e2e/    Playwright: real server + production build + up to 7 independent browser clients
```

- **Server-authoritative.** The server owns possession, throws, catches, drops,
  recovery and the streak. Throw ids make every throw resolvable exactly once.
- **Deterministic flight.** A throw is `(p0, v0, t0)`; everyone simulates the
  same fixed-step (240 Hz) flight with gravity, quadratic drag, grass bounces and
  rolling, so the ball never teleports and the network carries about one message per throw.
- **Bodies and reach.** A player is a body at (x, z) near their spot (they can
  run up to 4.5 m from it), facing a direction, with the glove anywhere inside a
  shared reach envelope (an ellipsoid: crouch to the grass, stretch overhead, a
  long arm and half a step to the side). The glove is exactly where the player
  holds it (no auto-reach); only a short last-instant reflex can stretch it
  toward a near miss.
- **Grade.** The catch is claimed at the ball's true closest pass to the pocket
  (not the first frame it is within reach), and the server grades it 0..1 from
  that distance. The thrower's aim ring is solved to the exact crossing point,
  so the ring is the truth.
- **Catches** are detected on the catcher's device by a swept test of the ball
  against the real glove position, sent with the exact contact time and pose,
  and re-validated on the server against the same deterministic trajectory
  (body near its spot and its streamed position, glove within reach, ball
  through the glove). A miss is declared by the server when the ball reaches
  the ground with no valid claim.
- **Camera.** A cinematic third-person rig (`src/client/scene/camera.ts`) stands
  behind you on your glove side and frames you, your partner and the ball in
  flight, easing its pan and framing; it never cuts. Portrait phones get a tall
  frame with both players stacked diagonally and the top kept clear for the streak.
- **Pose streaming** (20 Hz): position, facing, glove point, arm state and windup
  charge, so everyone sees the others run, crouch, reach, wind up and follow
  through, interpolated ~110 ms behind.
- **Prediction**: your own throws and catches play instantly (ball, POP,
  recoil); remote throws ease in from the thrower's hand to the true timeline.
- **Connection drops** never wipe a streak: a throw that resolves while anyone
  is disconnected is voided. A dropped player keeps their spot for 90 s; if they
  held the ball, it passes on after 6 s so nobody waits.
- **Records**: current streak, session best, best per *group* (keyed by the set
  of guest ids), catches and drops per player. Guest ids live in localStorage;
  clearing site data or switching devices creates a new guest. Group bests are
  mirrored on each device and re-seeded to the server after restarts.

## Develop

```bash
npm install
npm run dev            # room server on :8787 + Vite on :5173 (open on your phone via LAN IP)
npm test               # unit tests
npm run build          # client (dist/) + server (dist-server/)
npm run test:e2e       # multi-client browser tests (needs a client build)
npm run test:live      # two browsers play on the deployed site + live room server (BASE=…)
```

## Deploy

| Environment | Client | Room server |
|---|---|---|
| Development | `vite` on localhost | `tsx` on localhost:8787 |
| Preview | Vercel preview deployment per PR | production room server (rooms are isolated by code; protocol version is checked) |
| Production | Vercel `catch` → https://catch-haveanapp.vercel.app (`main`) | Render `catch-server` → wss://catch-server-hgeo.onrender.com/ws (`main`, free plan) |

The room server must be a long-lived process (WebSockets); it cannot run as
Vercel serverless functions. Client env: `VITE_SERVER_URL=wss://…/ws`.
Server env: `ALLOWED_ORIGINS` (optional), `DATA_DIR` (optional, needs a disk).

The free Render plan sleeps after ~15 idle minutes; the first visit then waits
~30–60 s while it wakes (the home screen pings it early and the game shows
"Warming up the field…"). Render Starter (~$7/mo) removes the wait.

See [docs/AUDIO.md](docs/AUDIO.md) for the sound design and what's still open.
