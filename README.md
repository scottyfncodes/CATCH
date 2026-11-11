# CATCH.

A multiplayer, first-person game of catch for phones. Two to five friends stand
in a park at golden hour, toss one baseball around, and try to keep a shared
streak of consecutive catches alive.

No accounts, no installs: open the link, pick a name and a throwing hand, play.

## How to play

| | Right-handed | Left-handed |
|---|---|---|
| Glove | left thumb | right thumb |
| Look + throw | right thumb | left thumb |

- **Look around**: drag on the throwing side (the upper part while you hold the ball).
- **Move the glove**: drag on the glove side. It follows your thumb and stays put.
  A catch only happens if the ball actually passes through the glove.
- **Throw**: put your thumb on the ball or anywhere in the lower part of the
  throwing side, **pull down** to wind up (further = harder), **slide sideways**
  to aim your arm (a faint arc shows the throw; this is how you make a no-look
  throw), and **let go**. Slide back up to where you started before letting go
  to cancel. Snapping your thumb up as you let go adds a little extra zip.
- **Aim** by looking, then fine-tune with the slide. The arc adapts to the
  distance of whoever you're aiming at; look higher or lower to throw higher or lower.
- **The POP is your grade.** The server scores each catch by how close the ball
  came to the centre of your pocket, and everyone hears that grade: a perfect
  catch cracks and rings off the houses, an off-centre one thwaps, a bobble
  squeezes twice. Perfect catches are counted in the pause sheet.
- Every caught throw adds one to the room's streak; a drop resets it.
  Alone? **Coach** keeps you company until a friend joins.

## Architecture

```
src/shared/   deterministic ball physics, player geometry, wire protocol (used by both sides)
src/server/   authoritative room server (Node + ws): rooms, possession, catch validation, streaks, Coach bot
src/client/   Vite + TypeScript + Three.js client: rendering, two-thumb controls, prediction, Web Audio
tests/unit/   Vitest: physics + room authority
tests/e2e/    Playwright: real server + production build + up to 7 independent browser clients
```

- **Server-authoritative.** The server owns possession, throws, catches, drops,
  recovery and the streak. Throw ids make every throw resolvable exactly once.
- **Deterministic flight.** A throw is `(p0, v0, t0)`; everyone simulates the
  same fixed-step (240 Hz) flight with gravity, quadratic drag, grass bounces and
  rolling, so the ball never teleports and the network carries about one message per throw.
- **Catches** are detected on the catcher's device by a swept test of the ball
  against the real glove position, sent with the exact contact time and pose,
  and re-validated on the server against the same deterministic trajectory
  (latency-compensated, not automatic). A miss is declared by the server when
  the ball reaches the ground with no valid claim.
- **Pose streaming** (20 Hz): yaw, pitch, glove position, arm state and windup
  charge, so other players see the head, shoulders, torso twist, the reaching glove
  and the throwing arm cock back, interpolated ~110 ms behind.
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
