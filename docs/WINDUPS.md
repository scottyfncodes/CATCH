# Windups

CATCH. has a small library of pitching deliveries. A player picks one, their
player throws with it, and everyone they play with sees it. Presets are
identified **by number only**.

Code: `src/shared/windups.ts` (data, generator, sampling, release point),
`src/client/scene/avatar.ts` (the body performing it),
`tests/unit/windups.test.ts` (the rules below, as tests).

## ⚠ Legal review before any public commercial release

The six numbered presets were built by studying the mechanics of well-known
deliveries. In the product they are shown as a number and a plain description
of the motion: no names, nicknames, likenesses, photographs, team names,
colours or logos, and no claim of endorsement.

**That is not legal clearance.** A jersey number together with a distinctive,
recognisable motion can still identify a real athlete, and right-of-publicity
law varies by jurisdiction. Before a public commercial release (paid, ad
supported, app-store listed, or marketed), have counsel review:

- the presets themselves (number + motion), and whether any should be
  renumbered, altered or removed;
- every player-facing string about them (`blurb` in `windups.ts`, the selector,
  store copy, screenshots, marketing);
- the research references behind each preset (see below for where they are).

The fallback is built in: `#00` is a neutral house delivery with no reference.
To ship without the signature presets, delete their entries from `DEFS` and set
`DEFAULT_WINDUP = HOUSE_WINDUP`. Nothing else changes: a saved preference or
an id the library no longer has falls back to the default on its own.

### What each preset is built on

| Preset | The mechanics it is built on |
|---|---|
| #34 | Full overhead windup; a towering leg kick with the knee by the front shoulder, standing tall; drop-and-drive; high three-quarter slot; deep finish. |
| #16 | A long overhead stretch on the toes; turning the back to the target and a beat of stillness there; a fast unwind; over-the-top slot. |
| #35 | Hands going up over the head as the knee comes to the chest, foot flared out; closed stride; a low sweeping sling; falling off to the glove side. |
| #32 | Full overhead windup; smooth high kick with a lean back; a long reach back with the front shoulder high; straight over the top with the trunk tilted; long stride. |
| #51 | Hands low, a modest kick; a long, closed stride; a low, wide arm slung from the side; finishing across the body. |
| #55 | Strong counter-rotation and layback at the top; the arm hanging straight down behind while the glove points up; a giant stride and deep drop; over the top; the back leg whipping over in the finish. |

`#00` (the house delivery, also the fallback) is original and has no reference.
Coach throws with a preset picked from the room code.

The research references behind the six numbered presets are **deliberately not
recorded in this repository** (it is public, and writing them down next to the
numbers would create exactly the association the number-only presentation
avoids). They are in the project brief held by the owner; give that to counsel
with this file.

## How a delivery is described

Everything is authored for a right-hander in the **pitch frame**: `x` toward
the throwing-arm side, `y` up, `z` toward the target, origin on the grass
between the feet. Left-handers are mirrored.

A delivery is two clips:

1. **The windup**, parameterised 0..1. It runs at the preset's `tempo` while
   the player holds their aim, rests at the top (1) until they let go, and
   comes back down if they ease off.
2. **The delivery**, in seconds from letting go: drive, plant, **release at
   `RELEASE_TIME`**, follow-through, recovery.

Each key is a `DeliveryPose`: hip turn, shoulder coil, trunk lean and tilt,
and positions for the pelvis, both feet, the throwing hand and the glove. The
avatar solves legs and arms to those with IK, so there is no skeleton to
retarget and nothing to import.

### Parameters (`WindupParams`)

| Parameter | What it controls |
|---|---|
| `tempo` | Seconds from the set position to the top of the leg kick. |
| `hands` | Where the hands go on the way up: `overhead`, `chest`, `belt`. |
| `kick`, `kickReach`, `kickTuck` | Leg-kick height, how far the foot hangs out, how far the knee comes back across. |
| `turn`, `coil` | Torso rotation at the top: hips, and shoulders beyond the hips. |
| `layback` | Lean away from the target at the top. |
| `stride`, `closed`, `drive` | Stride length, how far across the body it lands, how far the hips travel. |
| `slot` | Arm slot at release, degrees above horizontal (90 = over the top, 0 = sidearm). |
| `tilt`, `flex` | Trunk side-bend and forward bend at release. |
| `finish` | How high the trailing leg whips through the follow-through. |

**Release timing** is deliberately *not* a per-preset dial: see "Fairness".

### Hand-authored keys

`windupKeys` and `deliveryKeys` are lists of `{ t, pose, from? }`. A key at an
existing time overrides parts of the generated pose; a key at a new time is
inserted (starting from the curve, or from the key at `from`, which is how a
pose is held). Use them for the moments that make a delivery recognisable; let
the generator do the rest.

## Adding a windup

1. Add an entry to `DEFS` in `src/shared/windups.ts`: `id` (the number),
   `blurb` (a plain description of the mechanics; never a person), `params`.
2. Look at it. `npm run dev:client`, then open
   `/tests/visual/windups.html?id=<n>&view=side` (also `front`, `back`, `top`;
   add `&hand=L`). It renders the real avatar stepped through the real clip.
   The red dot is the release point.
3. Add custom keys until it reads from behind (the thrower's view) and from
   the front (the catcher's).
4. `npm test`. The windup tests run over the whole library: continuity, feet on
   the grass, legs that reach, a release point the server accepts, and the
   avatar's hand actually being at the release point (both hands).

That is all: the selector, the network, Coach and the camera pick it up from
the library. Because the server also has the library, a new windup needs the
server deployed too; until then the server treats it as the default.

## Fairness

Windups are for expression. They must not be an advantage, and the tests hold
them to it:

- **Same release time.** The ball leaves the hand `RELEASE_TIME` (0.3 s) after
  the player lets go of the aim, for every preset. `tempo` only changes how
  long the windup takes to reach the top, and the player can let go before then.
- **Same throw for the same aim.** The throw is solved from the preset's
  release point to the aim ring, at a pace measured from one shared reference
  point. So the ball arrives at the same spot at the same moment whichever
  windup threw it; only the first part of its path differs with the arm slot.
- **Same aim steadiness.** The sway of the aim ring depends on how hard and
  how long you pull, never on the windup.
- **Server limits.** The server accepts a throw from within `RELEASE_REACH` of
  the thrower's eyes; every preset is inside it.

If a future design wants windups to *play* differently (a deliberate trade-off
between presets), that is a gameplay change to make on purpose, not a side
effect of an animation.

## Multiplayer

- A player's windup id travels in `hello`/`prof` and in the roster
  (`PlayerInfo.windup`). The server validates it against the library.
- The windup phase (0..1) is part of the 20 Hz pose stream.
- Letting go sends `go`; the server relays it at once and each client starts
  the same delivery, played slightly faster until it has caught up with the
  network delay. The throw message follows at the release.
- On the receiving side the ball stays in the thrower's hand until the
  delivery being watched reaches its release, then eases into the true flight.
