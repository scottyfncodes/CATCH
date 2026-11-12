# The body and the glove

How a player's body gets the glove to the ball, how the glove is turned, and
how to check both. The code is `src/client/scene/avatar.ts` (the body) and
`src/client/scene/gear.ts` (the glove).

## What is fixed, and what follows

The game decides where the **pocket** is: the glove position you drag is the
point the server checks the ball against. Nothing here changes that. Everything
else is worked back from it, the way a person's body follows their hand:

1. **The glove's facing** is chosen first (below), which gives the wrist: 88 mm
   down the palm from the pocket and 32 mm behind the leather.
2. **The arm** is two bones of fixed length (0.29 m and 0.27 m). They never
   stretch. If the wrist is further from the shoulder than the arm is long, the
   body has to bring the shoulder closer:
   - across the body, the **trunk turns** (up to about 55°, the hips taking a
     third of it) to bring the glove shoulder round;
   - the **shoulder girdle** travels up to 65 mm toward the ball;
   - the **trunk leans**, forward and to the side (capped: past about 25° of
     extra lean it would be a fall);
   - the **hips shift** and drop or rise (a foot has already stepped out under
     a wide reach, so they can go further that way);
   - a leg at full stretch goes **up on its toes**.
3. Before any of that is *needed*, there is **comfort**: with the glove out in
   front, the trunk comes forward until the elbow has a working bend, because
   nobody catches with a locked arm if they can help it.
4. **The elbow** hangs down and out to the glove side; for a ball near the
   grass it comes up and back.
5. **The head** stays level when the trunk bends, and watches the ball.

## How the glove is turned

There is no look-at and no camera-facing. The glove's rotation is built from
two directions and applied as a quaternion.

- **Pocket normal**: toward the ball (straight out in front when there isn't
  one), cupped a little up and back toward the catcher's own eyes. After a
  catch it turns up to show the ball.
- **Fingers**: from the belt out to the glove, flattened against the pocket
  normal. So they point up for a ball above the belt, down for one below it,
  out to the side for a wide one and across for a backhand, and turn through
  those continuously. There is no height at which the glove flips.
- **The wrist's limit**: the hand can bend about 83° off the line of the
  forearm. Past that, the hand comes round toward the forearm: in the pocket's
  own plane where the forearm lies across it (the forearm rolls freely, and the
  pocket keeps facing the ball), tipping the pocket only where the forearm
  points through it. The arm is solved again each time, up to six passes.
- The result is eased with a 50 ms time constant (a slerp), so a fast move
  turns the wrist fast but never in one frame.

The glove is then drawn where the wrist puts it. When the arm reaches the pose
(always, unless the body truly can't) that is exactly the pocket the server
checks.

## The catch

- The ball goes from where it struck the leather down into the pocket over
  90 ms, and sits in it: the pocket is a real bowl, 34 mm deep, so more than half
  the ball is below the rim.
- The arm gives along the ball's path and returns; how far depends on speed.
- A ball off the middle of the pocket turns the glove: tipped back by one up
  in the fingers, twisted by one out on the web or the heel.
- The glove snaps shut on a spring that overshoots (a squeeze), then settles.

## Response, by layer

| What | Response |
| --- | --- |
| Glove position (your thumb) | immediate: the pocket is the pose |
| Glove facing | 50 ms slerp |
| Trunk, shoulder, hips | solved from the pose each frame; posture offsets ease over 100 ms |
| Feet | planted until left behind, then a step of 0.17–0.32 s |
| Glove closing | spring: stiff and fast shut, soft open |
| Impact give | 0.24 s out and back, scaled by ball speed |

## Checking it

`tests/unit/biomech.test.ts` holds each of eight positions (centre chest, above
the head, below the waist, far glove side, far across, across the body, fully
extended, near the body) for both hands and asserts: bone lengths to the
millimetre, the elbow bending the right way and never folded flat, the wrist
inside its limit, a clean glove frame, the pocket within 6 mm of the pose and
within 34° of the incoming ball. It also sweeps the glove from the grass to
overhead and moves it between opposite positions in six frames, checking that
nothing stretches or snaps on the way.

Numbers are not enough, so there are pages to look at (run `npm run dev:client`):

- `/tests/visual/poses.html?view=front` (also `side`, `top`, `eye`; `hand=L`)
- `/tests/visual/poses.html?seq=far glove side>far across` a move, frame by frame
- `/tests/visual/poses.html?impact=1` a catch, frame by frame
- `/tests/visual/glove.html?glove=0` the glove on its own

## Known limits

- The body is jointed primitives, not a skinned mesh: there is no shoulder
  blade, spine curve or finger articulation inside the glove.
- A far backhand without moving the feet is a deep lean. In play, the chase
  step usually carries the body there first.
- Ball and glove do not collide physically: the catch is decided by the
  server's distance test, and the seating is drawn.
