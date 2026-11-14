# Audio

All sound is produced by `src/client/audio.ts` with the Web Audio API.

## Status: synthesized, not recorded

No licensed recordings of a real glove or a real throw were available while
building v1, so **every sound is physically modelled and rendered at load time**
from deterministic DSP (`src/client/dsp.ts`). They are not generic arcade
effects, but they are not recordings either. Replacing the POP and ZIP layers
with real, legally usable recordings is the main open audio task.

## THE POP is the catch grade

The server measures how far the ball's centre passed from the glove pocket's
centre and sends a grade `g` (0..1, `catchGrade()` in `src/shared/protocol.ts`)
with every catch. The POP is synthesised from that number, so the sound *is* the
score and every player hears the same one:

| Grade | Distance from pocket centre | What you hear |
|---|---|---|
| perfect (g ≳ 0.78) | ≤ 4.5 cm | the **whip crack** on top + full-band crack + tight body + tonal pocket **ring** + the **report** (dry: nothing comes back off the houses) |
| pocket | ≤ 9.5 cm | solid crack, full body, a little ring |
| web | ≤ 15.5 cm | crack low-passed away, dull body, more leather shuffle |
| bobble | ≤ 20.5 cm | muffled impact, then a second squeeze 130 ms later |

Within the clean range it is continuous: crack level ∝ g^1.6, crack low-pass
2.2 kHz → 17 kHz, body pitch/tightness and ring amount all follow g. Ball speed
sets loudness and weight. `docs/pop-grades.wav` is an offline render of the
ladder (perfect hard, perfect soft toss, pocket, web, bobble). Measured on that
render: peak 1.00 / 0.78 / 0.88 / 0.49 / 0.32 (perfect hard, perfect soft, pocket,
web, bobble), energy above 3 kHz 8.8× higher for a perfect hard catch than a web
catch. Balance of a perfect hard catch (first 80 ms): about 12% below 200 Hz,
14% at 200–800 Hz, 38% at 0.8–3 kHz, 35% at 3–12 kHz: a pop with a crack on it,
not a thud. (Tuned from a listening test on a phone: "too much thud, not enough
pop, needs a crack like a whip". It had been 80% below 200 Hz.)

The transient layers (whip, crack, shot) are faded in over two samples, not a
millisecond: their first-sample click is the attack.

The master bus uses a transparent soft clip (linear below about -3 dBFS) instead
of a DynamicsCompressor; the compressor was flattening the crack transient.

## THE POP layers

Layered per catch from pre-rendered variations (picked at random):

| Layer | Model | Driven by |
|---|---|---|
| Whip | the crack of a whip: a single N-shaped pressure wave under a millisecond long (what a whip tip breaking the sound barrier makes), then a 2 ms tear of air above 3 kHz; nothing low, no tail | how centred (g²) and how hard: the leading edge of a clean catch |
| Crack | 4 ms broadband slap, peaks at 2.5 kHz and 5 kHz, initial click | ball speed (^1.25), only strong on clean pocket catches |
| Shot | the report: full-band burst (11 ms, peak ≈2.5 kHz), a bark at ≈1.25 kHz (24 ms), a small, short 210→90 Hz punch, hard-clipped; over in about 50 ms with no tail | how centred the catch is (^1.3) and ball speed (^1.4): a hard one in the middle of the pocket goes off like a shot |
| Body | mid "slap" band (≈560 Hz) + a small, short hand thump (190→100 Hz glide) + two leather resonances (≈760 Hz, ≈1.33 kHz) + early reflection, soft-saturated | speed sets level and playback rate; soft tosses are low-passed |
| Settle | stick-slip micro-clicks + low squeeze, 35–250 ms after impact | always, subtle |

Quality changes the mix: **pocket** = crisp crack + full body; **web** = dulled
crack, low-passed body, more settle; **bobble** = muffled first impact plus a
second squeeze 130 ms later; **deflect** = dull thwap, no settle.
Your own catches play dry and close (stereo, panned to the glove side), even
though the camera is a few steps away: the POP is the game. Others' catches are
HRTF-spatialised at their glove with distance roll-off, air absorption and
speed-of-sound delay. The spatial listener sits between you and the camera,
facing the way the camera faces, so the ball's ZIP crosses the stereo field the
way you see it cross the screen. A guard prevents double POPs between a
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
