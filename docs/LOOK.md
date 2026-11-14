# The look

Golden hour on a road through the redwoods. The sun is low, ahead and to the
left; everything in the picture follows from that. It is all procedural: no
image or model files, and no extra render passes.

## What makes the picture

| | What it does | Where |
| --- | --- | --- |
| Grade | the film curve, then cool shadows, warm highlights, a little more colour and mid-tone shape | `look.ts`, as three's custom tone mapping |
| Haze | air you can see: thicker near the ground, gold toward the sun, lavender away from it | `look.ts`, replaces three's fog |
| Tree shadows | the trunks' long shadows raking across road and forest floor, warm light between | `look.ts`, `dappled(material)` |
| Rim light | the low sun on the edge of a person and a glove | `look.ts`, `rim(material)` |
| Shafts | sheets of light coming down through the trees, along the sun's own direction | `buildShafts`, one draw call |
| Motes | pollen and dust drifting where the light is | `buildMotes`, one draw call |
| Sky | painted in its shader: gold through rose and lavender to blue, high combed cloud lit from below, the sun and its glow | `world.ts` |
| Redwoods | trunks that flare into the ground, furrowed bark, drooping tiers of boughs lit at their edges | `world.ts` |
| Ground | a forest floor of moss, duff and needles; a worn road with tyre tracks, cracks, a patch and what is left of a centre line; needle drift at its edges; sword ferns | `world.ts` |
| Ball | a thin dark edge, so it reads against a bright sky | `gear.ts` |

The grade, haze, shadows and rim are small additions to the shaders three
already runs for every material (`installLook()` patches its shader chunks once),
so they cost arithmetic per pixel and nothing else. A material opts into tree
shadows or rim light with a define.

## The players

People are still rigid pieces hung on the joints the body solver places
(`docs/BODY.md`): nothing about how they move changed. What changed is the
pieces (`src/client/scene/body.ts`, each shape built once and shared):

- a trunk with shoulders, a chest and a waist, in a T-shirt with a collar and a hem at the belt;
- short sleeves with the arm coming out of them, a forearm that tapers to the wrist;
- thighs and calves, trousers that stop above the ankle, a sock, a sneaker with a gum sole;
- a head with a jaw, a nose, ears and eyes, a touch larger than life so a face and a cap read from across the road.

Where two pieces meet at a knee, elbow or shoulder they both end exactly on
the joint at the same radius, with a ball of (almost) that radius in it: however
far it bends, the outline stays one curve.

To look at them: `/tests/visual/people.html` (`&zoom=head` for close-ups,
`&set=silly` for everything you can earn).

## What people wear (`src/client/scene/wear.ts`)

**The free caps** are made the way a baseball cap is: six panels sewn into a
crown with a seam down each and an eyelet in each, a button on top, a stiffened
front with the game's own wordmark (CATCH.) embroidered across it, a bill that curves down at the sides with rows of
stitching on it and a darker underside, and an adjustable strap across an arched
opening at the back. Worn level-ish, the band a little higher at the forehead.
"Backwards" is the same cap turned round.

**What you earn is meant to be absurd**, more so the longer the streak:

| Streak | Reward | What it does |
| --- | --- | --- |
| 10 | Googly eyes (glove) | three on the back of the glove; the pupils rattle round as it moves (they stare at you while you wait for a throw) |
| 25 | Propeller beanie | four colours and a propeller that spins faster when you run |
| 50 | Hawaiian shirt and lei | hibiscus print on the shirt and the sleeves, a garland of flowers round the neck |
| 100 | Shark (glove) | the pocket is a pink mouth full of teeth, a fin on the back, eyes |
| 250 | Rubber duck | sits on your head, bobs, rocks when you run, looks about |
| 500 | Tuxedo with tails | shirt front, studs, satin lapels, an oversized red bow tie, a rose, coat tails |
| 750 | Disco ball (glove) | every piece of the glove mirror tiles, and it glitters |
| 1000 | Ten-gallon hat | about 70 cm across, creased crown, brim curled up hard |
| 1500 | Superhero cape | a C in a diamond on the chest, a belt, a red cape that streams out when you run |
| 2000 | On fire (glove) | flames off the back, the fingertips and the heel, always going up |
| 3000 | Crown | gold, jewels, pearls on the points, velvet, an orb and a cross; it twinkles; worn at an angle |
| 5000 | Royal robe | red velvet with gold braid, an ermine mantle, a train to the ground |

None of it touches the glove's size or where its pocket is
(`tests/unit/wear.test.ts` checks that for every glove). Capes and tails are a
few dozen points worked out on the CPU each frame: they hang straight down
however the body leans and stream out behind with speed. Flames and sparkles
are sprites, so they cost a draw call each, only for the people wearing them.

## Changing it

- The sun: `SUN_DIR` in `look.ts`. Haze, shadows, rim, shafts and sky all read it.
- Mood: the two split-tone colours and the saturation in `CustomToneMapping`;
  `toneMappingExposure` in `main.ts`.
- How much shadow is on the road: the `smoothstep` thresholds on `dappleN`.
- Haze: the density constant (0.0046 per metre at ground level) and the two colours.

## Cost

Measured with two players in Chromium's software renderer at 390×664 (a CPU
rasteriser, not a phone GPU: these say what changed, not how a phone runs it).

| | Before the art pass | After it | With the new players |
| --- | --- | --- | --- |
| Draw calls a frame | 123 | 117 | 119 to 127 |
| Triangles a frame | 71 thousand | about 82 thousand | about 91 thousand |
| Software render time a frame | 177 ms | about 230 ms | about 265 ms |
| Building the world (first / second time on a page) | 99 ms / 98 ms | 133 ms / 10 ms | the same |

A vignette was tried as a full-screen overlay and taken out: it made the
browser composite a full-screen blend every frame, which showed up as CPU
even on pages that were not drawing.

The painted textures are made once a page and shared by the home screen's
world and the game's. On a phone the existing safety net applies: resolution
steps down, then shadows go, if frames run long.
