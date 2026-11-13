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

## Changing it

- The sun: `SUN_DIR` in `look.ts`. Haze, shadows, rim, shafts and sky all read it.
- Mood: the two split-tone colours and the saturation in `CustomToneMapping`;
  `toneMappingExposure` in `main.ts`.
- How much shadow is on the road: the `smoothstep` thresholds on `dappleN`.
- Haze: the density constant (0.0046 per metre at ground level) and the two colours.

## Cost

Measured with two players in Chromium's software renderer at 390×664 (a CPU
rasteriser, not a phone GPU: these say what changed, not how a phone runs it).

| | Before this pass | After |
| --- | --- | --- |
| Draw calls a frame | 123 | 117 |
| Triangles a frame | 71 thousand | about 90 thousand |
| Software render time a frame | 177 ms | about 230 ms |
| Building the world (first / second time on a page) | 99 ms / 98 ms | 133 ms / 10 ms |

A vignette was tried as a full-screen overlay and taken out: it made the
browser composite a full-screen blend every frame, which showed up as CPU
even on pages that were not drawing.

The painted textures are made once a page and shared by the home screen's
world and the game's. On a phone the existing safety net applies: resolution
steps down, then shadows go, if frames run long.
