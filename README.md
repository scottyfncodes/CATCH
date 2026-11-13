# CATCH.

Two people. One baseball. One continuous shot.

A game about the simple pleasure of throwing a ball back and forth with
someone, at golden hour in the park. Two halves of one game: you **throw in
third person**, with a windup worth watching, and you **catch in first
person**, through your own eyes, with the ball coming at you. Two to five
friends can share a room and keep one streak of consecutive catches alive;
alone, Coach keeps you company.

**Three games.** Whoever opens the room picks one; friends who join play it.

- **Long toss.** You start 46 feet apart. Every catch takes you both a step
  further back, and the throws get longer, higher and harder: at 394 feet (as
  far as anyone can throw a baseball) it is a 107 mph throw that hangs for
  five seconds. A miss brings you a step back in. Misses are counted in total:
  the third one starts the distance again.
- **Classic.** Stay 46 feet apart and just play catch.
- **Big mitt.** Everyone starts with a giant glove (three times the size), and
  it shrinks with every catch, past a regular glove to a small one. A miss
  makes it a size bigger; the third miss brings the giant one back.

Nobody is ever out, in any of them.

No accounts, no installs: open the link, pick a name and a throwing hand, play.

## How to play

One thumb, no buttons on screen:

- **Throw** (when you have the ball, third person): touch anywhere, **pull
  back** and **let go**. An aim ring appears on your friend's glove plane
  (their pocket gets a faint gold mark). Pull to one side to move the ring
  across (like a slingshot), pull further to lift it (and throw harder). The
  ring breathes a little with your hand, more for hard throws and long holds,
  so pick your moment. It turns gold on the pocket. While you hold the aim you
  go through **your windup** and wait at the top of it; let go and you stride,
  and the ball leaves your hand at the release. The camera cranes up over you
  for it: all of your delivery below, your friend and the ring above.
- **Pick your windup**: seven deliveries, known only by the number on the
  shirt (WINDUP on the home screen, or in the pause sheet). Your player throws
  the one you pick on a loop while you choose. It's saved on your device, and
  everyone you play with sees it. They only look different: every windup lets
  go at the same moment and the same aim gives the same throw.
- **Set the target** (when your friend has the ball, first person): your thumb
  is your glove. Drag to hold it up where you want the throw: chest, high, low,
  across. It stays where you leave it. Slow drags are precise, quick ones
  cover ground, and pushing it past your reach makes you step over after it.
- **Catch** (first person): a ring appears where the throw will cross your
  glove, and closes as the ball arrives. Get the mark on your pocket into the
  ring before it shuts: dead centre is a perfect POP. The ring's colour is the
  honest answer to "can I get that?": cream is routine, amber is one you have
  to go and get, red needs something special, grey is gone.
- **Bad throws are a chance at a great catch.** Off to one side: **move your
  thumb toward it** and you run under it (your view slides over with you; it
  doesn't swing round). Too far to run: **flick toward it** and you dive. Over your head: **flick up** and you leap. Low: get the
  glove down and scoop it. A last-instant lunge can still save a near miss.
  Everyone sees how it was caught ("Diving catch · Pocket"), and great catches
  are counted in the pause sheet.
- **Make the player yours** (LOOK on the home screen, or in the pause sheet):
  skin, build, hair, and what you wear. Hats, gloves and tops are **earned**:
  one new thing, once, at 10, 25, 50, 100, 250, 500, 750, 1000, 1500, 2000,
  3000 and 5000 in a row, for everyone in the room when the streak gets
  there. What you wear changes nothing about how you play: every glove is the
  same regular-sized glove.
- **Both jobs make the POP**: a perfect POP needs a throw that finds the pocket
  *and* a glove held still. The grade word under the streak tells you how it went.
- Desktop: arrow keys / WASD also move you.
- **The POP is your grade.** The server scores each catch by how close the ball
  came to the centre of your pocket, and everyone hears that grade: a perfect
  catch goes off like a shot (dry, no echo), an off-centre one thwaps, a bobble
  squeezes twice. Perfect catches are counted in the pause sheet.
- Every caught throw adds one to the room's streak and a step to the distance;
  a drop resets the streak and costs a step.

## Architecture

```
src/shared/   deterministic ball physics, player geometry, wire protocol (used by both sides)
src/server/   authoritative room server (Node + ws): rooms, possession, catch validation, streaks, Coach bot
src/client/   Vite + TypeScript + Three.js client: third-person rendering, one-thumb controls, prediction, Web Audio
tests/unit/   Vitest: physics, room authority, the windup library (and the avatar performing it)
tests/e2e/    Playwright: real server + production build + up to 7 independent browser clients
tests/visual/ authoring tools: a filmstrip of any windup, the catching poses, the glove (docs/BODY.md)
```

- **Server-authoritative.** The server owns possession, throws, catches, drops,
  recovery and the streak. Throw ids make every throw resolvable exactly once.
- **Deterministic flight.** A throw is `(p0, v0, t0)`; everyone simulates the
  same fixed-step (240 Hz) flight with gravity, quadratic drag, grass bounces and
  rolling, so the ball never teleports and the network carries about one message per throw.
- **Distance.** The room carries how many steps back it is (`steps`); the seat
  layout is computed from it, so the server, Coach and every client agree where
  everyone stands. A throw is solved as an arc (`solveArc`): the launch angle
  comes from the distance (flat across the road, 38° for the longest) and the
  speed is whatever that takes, so the same pull is the same throw at any range.
  Your own long throw is filmed by letting go of you and framing the ball and
  your friend: wide on the arc, closing in like a long lens as it comes down.
- **Looks** (`src/shared/style.ts`). A style is eight small numbers (skin,
  build, hair, hair colour, hat, glove, top, trousers) indexing shared tables;
  the avatar is built from it out of primitives, so there are no assets. The
  server checks a style is well-formed and relays it. What has been earned
  lives on the device (there are no accounts), so it does not follow you to
  another phone, and the server takes it on trust; that is acceptable only
  because nothing cosmetic affects play. A build changes how thick the limbs
  are drawn, never where the joints are, so reach and release are identical.
- **Modes** (`Mode` in `src/shared/protocol.ts`). The room carries its mode;
  `gloveSize(mode, steps)` and the seat layout are both computed from the same
  `steps`, so one counter drives either the distance or the glove. In Big
  mitt the catch zones scale with the glove on the client and the server
  alike; in the other two the glove is always size 1.
- **The throw has a moment of its own.** As the ball leaves the hand: a snap
  and a hiss that grow with how hard it was thrown, a knock through the shot,
  a haptic tap, a ring off the hand. In flight the ball is drawn at its true
  size (only kept from vanishing), so it shrinks into the distance, with a
  streak behind it as long as it is fast.
- **The glove** is a regular glove at its real size (except in Big mitt). It rests as a cup, opens
  to take a throw, and snaps shut on the ball on a stiff spring (so it
  overshoots into a squeeze) before easing back.
- **Bodies and reach.** A player is a body at (x, z) near their spot (they can
  run up to 4.5 m from it), facing a direction, with the glove anywhere inside a
  shared reach envelope (an ellipsoid: crouch to the grass, stretch overhead, a
  long arm and half a step to the side). The glove is exactly where the player
  holds it (no auto-reach); only a short last-instant reflex can stretch it
  toward a near miss. A **leap** carries the whole envelope up to half a metre
  off the grass for a moment; a **dive** is a burst of the feet along the grass
  with the glove tracking the ball. Both are things the body does, validated
  by the same rule as any other catch: the ball has to pass through the glove,
  and the glove has to be within reach of where the body is.
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
- **Two views, one camera** (`src/client/scene/camera.ts`). Each client picks
  its view from its *own* role, so the two players are never switched
  together: whoever has the ball is in third person (behind them on the glove
  side; craning up over the pitcher during the windup), and whoever it is
  coming to is in first person (their own eyes, glove and arm in the
  foreground, the ball in the upper part of the view and the catch point in
  the lower). The camera never cuts: it travels between the two in one eased
  move (about 0.7 s), and the player's own head and chest fade by how close
  the camera is. With "reduce motion" on, the view changes under a quick dip
  instead of a move.
- **Windups** (`src/shared/windups.ts`, [docs/WINDUPS.md](docs/WINDUPS.md)). A
  data-driven library: each delivery is a handful of parameters (tempo, leg
  kick, hip turn, stride, arm slot, follow-through…) that a generator turns
  into keyframes, plus hand-authored keys for its signature moments. The
  avatar is procedural (IK legs and arms on a moving pelvis), so a delivery
  drives feet, hips, trunk and hands directly. The same data gives the server
  and every client the point the ball leaves the hand.
- **Throw timing.** Letting go of the aim starts the delivery; the ball leaves
  the hand `RELEASE_TIME` (0.3 s) later, at the animation's release point, for
  every windup. The thrower tells the room at once ("here it comes"), so the
  delivery everyone else watches is in step with the throw that follows.
- **Pose streaming** (20 Hz): position, facing, glove point, arm state, windup
  phase, and any leap or dive, so everyone sees the others run, crouch, reach,
  wind up, follow through, jump and lay out, interpolated ~110 ms behind.
- **Prediction**: your own throws and catches play instantly (ball, POP,
  recoil); a remote throw stays in the thrower's hand until the delivery you
  are watching reaches its release, then eases into the true timeline.
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

See [docs/AUDIO.md](docs/AUDIO.md) for the sound design and what's still open,
and [docs/WINDUPS.md](docs/WINDUPS.md) for the windup library: how to add one,
the authoring filmstrip, and the **legal-review note** to read before any
public commercial release.
