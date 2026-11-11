# Audio

All sound is produced by `src/client/audio.ts` with the Web Audio API.

## Status: synthesized, not recorded

No licensed recordings of a real glove or a real throw were available while
building v1, so **every sound is physically modelled and rendered at load time**
from deterministic DSP (`src/client/dsp.ts`). They are not generic arcade
effects, but they are not recordings either. Replacing the POP and ZIP layers
with real, legally usable recordings is the main open audio task.

## THE POP (glove impact)

Layered per catch from pre-rendered variations (picked at random):

| Layer | Model | Driven by |
|---|---|---|
| Crack | 4 ms broadband slap, peaks at 2.5 kHz and 5 kHz, initial click | ball speed (^1.25), only strong on clean pocket catches |
| Body | mid "slap" band (≈430 Hz) + hand thump (170→82 Hz glide) + two leather resonances (≈760 Hz, ≈1.33 kHz) + early reflection, soft-saturated | speed sets level and playback rate; soft tosses are low-passed |
| Settle | stick-slip micro-clicks + low squeeze, 35–250 ms after impact | always, subtle |

Quality changes the mix: **pocket** = crisp crack + full body; **web** = dulled
crack, low-passed body, more settle; **bobble** = muffled first impact plus a
second squeeze 130 ms later; **deflect** = dull thwap, no settle.
Your own catches play dry and close (stereo, panned to the glove side);
others' catches are HRTF-spatialised at their glove with distance roll-off,
air absorption and speed-of-sound delay. A guard prevents double POPs between a
predicted local catch and its server confirmation.

## THE ZIP (ball in flight)

One continuous voice rides on the ball through an HRTF panner:
looped pink noise → band-pass whose centre rises with speed (≈420 Hz + 62 Hz per m/s)
and shifts with **doppler** from the ball's radial velocity → a high-shelf "air"
boost when the ball is near your head → a tremolo at the **seam rate**
(≈4 seams × spin) for the characteristic flutter. Level ∝ (speed/30)^2.1, so a
soft toss whispers and a hard throw rushes past. Rolling balls switch to a
quiet grass-brush band.

## Ambience and handling

Wind with gusts and leaf rustle, procedural bird phrases placed in the trees,
a distant lawnmower that comes and goes, ground thuds with grass brush per
bounce, glove-to-hand transfer, leather creak while winding up, and an arm
swish on release. Ambience is kept low so the ZIP and POP dominate. No music.

## Platform notes

- iOS: the context is created/resumed inside the first tap; `navigator.audioSession.type = 'playback'`
  (Safari 16.4+) lets the game be heard with the silent switch on. Interruptions
  (calls, app switches) resume on return/next touch.
- A gentle peak limiter protects phone speakers.
- Haptics: Vibration API where present (Android); on iOS 18+ a native switch
  toggle is used as a light tap. Haptics are optional; nothing depends on them.

## Still to verify on real devices

- Mix balance on iPhone speakers vs. headphones vs. low volume.
- Perceived latency of the POP on a physical iPhone.
