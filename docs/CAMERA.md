# The camera at distance

Long toss moves the two of you up to 120 m apart. A lens chosen for 14 m turns
a friend at 50 m into a speck, so both views change lens with distance. Nobody
is scaled; the code is `standBack` and `watchFov` in `src/client/scene/camera.ts`.

- **Throwing (third person).** The camera stands further back along the same
  line, up to 2.3 times as far, and the framing closes in to match. You stay
  the size you were; your friend is drawn larger, the way a long lens flattens
  a ballgame. Nothing changes inside 16 m.
- **Waiting for a throw (first person).** You watch the thrower down a longer
  lens (never tighter than 24°), sized so they stand about a tenth of the
  screen tall, placed just above the middle and clear of the scoreboard.
- **The throw.** The view opens back to the full wide catching view as the ball
  comes: it starts opening 2.6 s before the ball arrives and is fully open with
  1.4 s to go, so a short throw is wide from the start.
- Settling onto the long lens is slow (0.6 s time constant); opening up is
  quick (0.22 s).
- A name label that would sit on the scoreboard or a tip is hidden until it is clear.

`tests/unit/camera.test.ts` checks the sizes on screen at 50 m against the
close shot, and that nothing changes up close.

## Frame cost

`debugState().draw` reports the last frame's draw calls and triangles. With two
players: 115 draw calls, about 70 thousand triangles (shadow pass included).
The glove's parts are welded into one mesh per leather for each piece that
moves as one (`bake` in `gear.ts`); before that it was 160. The e2e suite fails
a frame over 140 calls.
