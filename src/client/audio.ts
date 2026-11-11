// CATCH. audio engine.
//
// The two signature sounds are synthesised from physical layers rather than
// played from generic SFX:
//   POP — leather crack transient + pocket body (hand thump, mid slap) +
//         leather resonances + a delayed settle/creak, mixed per catch by ball
//         speed and catch quality.
//   ZIP — a continuous air-noise voice that rides on the ball: band centre and
//         level follow ball speed, a seam flutter tremolo follows spin rate,
//         doppler follows radial velocity, and an HRTF panner places it in 3D
//         so a fast ball past your ear sounds like one.
// No recorded samples are bundled (see docs/AUDIO.md); the layers are rendered
// at load from deterministic DSP so playback has no decoding latency.

import {
  biquad, brown, envelope, fadeEdges, mix, normalize, pink, rng, saturate, tone, white,
} from './dsp';
import type { CatchQuality } from '../shared/protocol';
import type { Vec3 } from '../shared/vec';

type Bufs = Record<string, AudioBuffer[]>;

const C = 343;

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  /** Outdoor slapback (the POP bouncing off the houses) for the best catches. */
  private slap!: AudioNode;
  private amb!: GainNode;
  private bufs: Bufs = {};
  private zip: {
    src: AudioBufferSourceNode; band: BiquadFilterNode; air: BiquadFilterNode; gain: GainNode;
    flutter: GainNode; lfo: OscillatorNode; lfoDepth: GainNode; panner: PannerNode;
    rollGain: GainNode; rollBand: BiquadFilterNode;
  } | null = null;
  private listenerPos: Vec3 = [0, 1.6, 0];
  private ambienceOn = false;
  private volume = 0.9;
  private unlocked = false;
  private ready = false;
  private lastPopAt = -1;
  private lastCreak = 0;
  /** Peak ZIP level of the current/last flight (diagnostics). */
  zipPeak = 0;
  lastZipPeak = 0;
  /** Diagnostics for tests: what has been triggered. */
  log: { k: string; t: number; [x: string]: unknown }[] = [];

  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx!.currentTime, 0.05);
  }

  /** Must be called from a user gesture (iOS). Safe to call repeatedly. */
  unlock() {
    if (!this.ctx) this.create();
    const ctx = this.ctx!;
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    if (!this.unlocked) {
      const b = ctx.createBuffer(1, 1, ctx.sampleRate);
      const s = ctx.createBufferSource();
      s.buffer = b; s.connect(ctx.destination); s.start();
      this.unlocked = true;
    }
  }

  get running() { return this.ctx?.state === 'running'; }

  private create() {
    // Play through the silent switch on iOS (Safari 16.4+): the POP is the game.
    try {
      const nav = navigator as Navigator & { audioSession?: { type: string } };
      if (nav.audioSession) nav.audioSession.type = 'playback';
    } catch { /* ignore */ }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;
    (window as unknown as { __catchAudioCtx: AudioContext }).__catchAudioCtx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    // Safety stage: a transparent soft clip. Below ~-3 dBFS it's a straight line,
    // so the POP's crack keeps its full transient (a DynamicsCompressor here
    // flattened it); only overs are rounded off instead of hard clipping.
    const clip = ctx.createWaveShaper();
    const n = 2048, curve = new Float32Array(n), knee = 0.7;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1, ax = Math.abs(x);
      curve[i] = ax <= knee ? x : Math.sign(x) * (knee + (1 - knee) * Math.tanh((ax - knee) / (1 - knee)));
    }
    clip.curve = curve;
    clip.oversample = '2x';
    this.master.connect(clip).connect(ctx.destination);
    this.sfx = ctx.createGain(); this.sfx.connect(this.master);
    {
      const d = ctx.createDelay(0.5); d.delayTime.value = 0.092;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
      const g = ctx.createGain(); g.gain.value = 0.14;
      const d2 = ctx.createDelay(0.5); d2.delayTime.value = 0.067;
      const g2 = ctx.createGain(); g2.gain.value = 0.35;
      d.connect(lp).connect(g).connect(this.sfx);
      g.connect(d2).connect(g2).connect(lp);
      this.slap = d;
    }
    this.amb = ctx.createGain(); this.amb.gain.value = 0.0; this.amb.connect(this.master);
    // Keep audio alive across iOS interruptions (calls, Siri, app switching).
    ctx.addEventListener('statechange', () => {
      if (ctx.state !== 'running' && document.visibilityState === 'visible') ctx.resume().catch(() => {});
    });
    this.render();
  }

  /** Resume after the page returns to the foreground. */
  resume() {
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {});
  }

  // ------------------------------------------------------------- synthesis

  private buf(data: Float32Array): AudioBuffer {
    const ctx = this.ctx!;
    const b = ctx.createBuffer(1, data.length, ctx.sampleRate);
    b.getChannelData(0).set(data);
    return b;
  }

  private render() {
    const sr = this.ctx!.sampleRate;
    const N = (s: number) => Math.floor(s * sr);
    const out: Bufs = { ring: [], crack: [], body: [], settle: [], ground: [], transfer: [], creak: [], bird: [], noise: [], wind: [], palm: [] };

    for (let v = 0; v < 4; v++) {
      const r = rng(101 + v * 17);
      // Crack: the instant leather slaps leather. Bright, very short, a touch of click.
      const c = white(N(0.05), r);
      biquad(c, sr, 'highpass', 1000 + r() * 300, 0.7);
      biquad(c, sr, 'peaking', 2500 + r() * 500, 1.3, 8);
      biquad(c, sr, 'peaking', 5200, 2, 3);
      envelope(c, sr, 0.0002, 0.0042 + r() * 0.0012);
      c[0] += 0.9; c[1] -= 0.5;
      out.crack.push(this.buf(fadeEdges(normalize(c, 1), sr, 1)));

      // Body: the pocket. Mid slap + hand thump behind the glove + leather ring.
      const n = N(0.24);
      const body = new Float32Array(n);
      const slap = white(n, r);
      biquad(slap, sr, 'bandpass', 430 + r() * 90, 1.1);
      biquad(slap, sr, 'lowpass', 1700, 0.7);
      envelope(slap, sr, 0.0007, 0.026 + r() * 0.006);
      mix(body, normalize(slap, 1), 1);
      const thump = tone(n, sr, 170 + r() * 20, 82 + r() * 10, 0.048, 0.018);
      envelope(thump, sr, 0.001, 1);
      mix(body, thump, 0.85);
      mix(body, tone(n, sr, 760 * (0.93 + r() * 0.14), 720, 0.015, 0.05), 0.32);
      mix(body, tone(n, sr, 1330 * (0.93 + r() * 0.14), 1300, 0.01, 0.05), 0.2);
      // Early reflection off the forearm/ground.
      const refl = Float32Array.from(body);
      mix(body, refl, 0.22, N(0.0045 + r() * 0.002));
      saturate(body, 1.35);
      out.body.push(this.buf(fadeEdges(normalize(body, 0.95), sr, 2)));
    }

    for (let v = 0; v < 3; v++) {
      // Ring: the pocket's leather and the ball sounding together on a dead-centre
      // catch. Tonal, short, a little hollow — the part that makes a perfect POP sing.
      const rr = rng(707 + v * 31);
      const rn = N(0.16);
      const ring = new Float32Array(rn);
      const f0 = 1080 * (0.95 + rr() * 0.1);
      mix(ring, tone(rn, sr, f0 * 1.12, f0, 0.034, 0.006), 0.9);
      mix(ring, tone(rn, sr, f0 * 2.1, f0 * 2.02, 0.018, 0.004), 0.42);
      mix(ring, tone(rn, sr, 610 * (0.96 + rr() * 0.08), 600, 0.046, 0.01), 0.55);
      const air = white(rn, rr);
      biquad(air, sr, 'bandpass', 3200, 1.6);
      envelope(air, sr, 0.0003, 0.006);
      mix(ring, air, 0.5);
      envelope(ring, sr, 0.0004, 1);
      out.ring.push(this.buf(fadeEdges(normalize(ring, 0.9), sr, 2)));
      const r = rng(303 + v * 29);
      // Settle: the ball seating, laces and leather shifting (stick-slip micro clicks).
      const n = N(0.38);
      const s = new Float32Array(n);
      const clicks = 9 + Math.floor(r() * 7);
      let t = 0.035;
      for (let i = 0; i < clicks; i++) {
        t += 0.004 + r() * r() * 0.04;
        const g = Math.exp(-(t - 0.035) / 0.12) * (0.4 + r() * 0.6);
        const k = white(N(0.004), r);
        biquad(k, sr, 'bandpass', 1500 + r() * 1400, 4);
        envelope(k, sr, 0.0002, 0.0012);
        mix(s, k, g, N(t));
      }
      const squeeze = white(n, r);
      biquad(squeeze, sr, 'bandpass', 620, 2.2);
      envelope(squeeze, sr, 0.01, 0.06, 0.03);
      mix(s, normalize(squeeze, 0.25), 1);
      out.settle.push(this.buf(fadeEdges(normalize(s, 0.6), sr, 3)));

      // Ground: a ball thudding into turf, with a grass brush.
      const gN = N(0.32);
      const g = tone(gN, sr, 105, 52, 0.05, 0.02);
      envelope(g, sr, 0.001, 1);
      const dirt = white(gN, r);
      biquad(dirt, sr, 'lowpass', 650, 0.8);
      envelope(dirt, sr, 0.0008, 0.022);
      const grass = white(gN, r);
      biquad(grass, sr, 'highpass', 2600, 0.7);
      envelope(grass, sr, 0.002, 0.06);
      mix(g, normalize(dirt, 1), 0.8);
      mix(g, normalize(grass, 1), 0.28);
      out.ground.push(this.buf(fadeEdges(normalize(g, 0.9), sr, 2)));

      // Bird phrases: short sweeping whistles from the trees.
      for (let b = 0; b < 2; b++) {
        const rb = rng(900 + v * 13 + b * 101);
        const notes = 2 + Math.floor(rb() * 5);
        const base = 2600 + rb() * 2200;
        const ph = new Float32Array(N(0.12 * notes + 0.3));
        let at = 0.02;
        for (let i = 0; i < notes; i++) {
          const dur = 0.05 + rb() * 0.08;
          const nn = N(dur);
          const f0 = base * (0.85 + rb() * 0.35), f1 = f0 * (0.6 + rb() * 0.8);
          const note = new Float32Array(nn);
          let p = 0;
          for (let k = 0; k < nn; k++) {
            const x = k / nn;
            const f = f0 + (f1 - f0) * x + Math.sin(x * Math.PI * (4 + rb() * 0.01)) * 120;
            p += (2 * Math.PI * f) / sr;
            note[k] = Math.sin(p) * Math.sin(Math.PI * x) ** 1.5;
          }
          mix(ph, note, 0.6 + rb() * 0.4, N(at));
          at += dur + 0.02 + rb() * 0.08;
        }
        out.bird.push(this.buf(fadeEdges(normalize(ph, 0.5), sr, 4)));
      }
    }

    for (let v = 0; v < 2; v++) {
      const r = rng(505 + v * 7);
      // Transfer: glove opens, bare hand takes the ball.
      const n = N(0.14);
      const tr = white(n, r);
      biquad(tr, sr, 'bandpass', 1500, 1.4);
      envelope(tr, sr, 0.0005, 0.006);
      const palm = white(n, r);
      biquad(palm, sr, 'bandpass', 900, 1.6);
      envelope(palm, sr, 0.0005, 0.009, 0.038);
      mix(tr, palm, 1.2);
      mix(tr, tone(n, sr, 240, 150, 0.02), 0.35);
      out.transfer.push(this.buf(fadeEdges(normalize(tr, 0.7), sr, 2)));

      // Creak: leather under grip pressure (stick-slip impulse train).
      const cn = N(0.75);
      const imp = new Float32Array(cn);
      let t = 0;
      while (t < 0.72) {
        const x = t / 0.72;
        const rate = 140 + 260 * Math.sin(x * Math.PI) + r() * 60;
        t += 1 / rate * (0.6 + r() * 0.8);
        const i = N(t);
        if (i < cn) imp[i] += (r() * 0.5 + 0.5) * Math.sin(Math.PI * x) ** 0.8;
      }
      const a = Float32Array.from(imp), b = Float32Array.from(imp);
      biquad(a, sr, 'bandpass', 1050 + r() * 200, 7);
      biquad(b, sr, 'bandpass', 2300 + r() * 300, 6);
      mix(a, b, 0.7);
      out.creak.push(this.buf(fadeEdges(normalize(a, 0.5), sr, 6)));
    }

    // Loopable noise beds.
    const nb = pink(N(2), rng(77));
    out.noise.push(this.buf(loopify(nb, sr, 0.25)));
    const wind = brown(N(7), rng(88));
    biquad(wind, sr, 'lowpass', 520, 0.7);
    out.wind.push(this.buf(loopify(normalize(wind, 0.8), sr, 1)));

    this.bufs = out;
    this.ready = true;
  }

  private pick(name: string): AudioBuffer {
    const list = this.bufs[name];
    return list[Math.floor(Math.random() * list.length)];
  }

  private play(name: string, dest: AudioNode, gain: number, when = 0, rate = 1, filter?: { type: BiquadFilterType; f: number; q?: number }) {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.pick(name);
    s.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    let node: AudioNode = s;
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = filter.type; f.frequency.value = filter.f; f.Q.value = filter.q ?? 0.7;
      node.connect(f); node = f;
    }
    node.connect(g).connect(dest);
    s.start(Math.max(ctx.currentTime, when || ctx.currentTime));
    return s;
  }

  /** A short-lived destination node for a sound at a world position (or on your own hand). */
  private placeAt(pos: Vec3 | null, pan = 0): { node: AudioNode; delay: number } {
    const ctx = this.ctx!;
    if (!pos) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      p.connect(this.sfx);
      return { node: p, delay: 0 };
    }
    const d = Math.hypot(pos[0] - this.listenerPos[0], pos[1] - this.listenerPos[1], pos[2] - this.listenerPos[2]);
    const panner = this.makePanner(pos);
    // Air absorbs highs over distance; sound takes time to arrive.
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = 18000 / (1 + d / 9);
    air.connect(panner).connect(this.sfx);
    return { node: air, delay: d / C };
  }

  private makePanner(pos: Vec3): PannerNode {
    const ctx = this.ctx!;
    const p = ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 1.4;
    p.rolloffFactor = 1.15;
    p.maxDistance = 80;
    setPannerPos(p, pos, ctx.currentTime);
    return p;
  }

  // ------------------------------------------------------------- one-shots

  /**
   * THE POP — and the grade. `g` (0..1, from the server) is how close the ball
   * came to the dead centre of the pocket; the POP is how you hear it:
   *   ~1.0  perfect: a crisp, ringing crack that slaps back off the houses
   *   ~0.6  pocket:  a solid, clean pop
   *   ~0.35 web:     a dull leather thwap
   *   <0.25 bobble:  a muffled double squeeze
   * Speed scales loudness and weight; the grade sets the character.
   * `pos` null = your own glove (stereo, close); otherwise spatialised.
   */
  pop(o: { speed: number; q: CatchQuality | 'deflect'; g: number; pos: Vec3 | null; side?: number }) {
    if (!this.ready || !this.ctx) return;
    const ctx = this.ctx;
    // De-duplicate: a predicted local catch and its server confirmation must not double up.
    if (ctx.currentTime - this.lastPopAt < 0.09) return;
    this.lastPopAt = ctx.currentTime;
    const s = Math.min(1, Math.max(0, o.speed / 28));
    const g = Math.min(1, Math.max(0, o.g));
    const { node, delay } = this.placeAt(o.pos, (o.side ?? 0) * 0.28);
    const t = ctx.currentTime + delay;
    const jitter = () => 1 + (Math.random() - 0.5) * 0.04;
    this.log.push({ k: 'pop', t: performance.now(), q: o.q, g, speed: o.speed });
    const loud = 0.55 + 0.45 * s;

    if (o.q === 'deflect') {
      this.play('body', node, 0.5 + 0.2 * s, t, (0.95 + 0.1 * s) * jitter(), { type: 'lowpass', f: 1200 });
      this.play('crack', node, 0.1, t, 0.8, { type: 'bandpass', f: 1700, q: 1 });
      return;
    }
    if (o.q === 'bobble') {
      this.play('body', node, 0.45 * loud, t, (0.95 + 0.1 * s) * jitter(), { type: 'lowpass', f: 1300 });
      this.play('crack', node, 0.06, t, 0.85, { type: 'lowpass', f: 2400 });
      // It pops up and is squeezed again.
      this.play('body', node, 0.3, t + 0.13, 0.88 * jitter(), { type: 'lowpass', f: 1700 });
      this.play('settle', node, 0.32, t + 0.15, 0.95);
      return;
    }
    // Clean catches: one continuous ladder from thwap to POP.
    // Crack: brighter and louder the closer to the centre.
    const crackGain = (0.06 + 1.15 * Math.pow(g, 1.6)) * (0.25 + 0.75 * Math.pow(s, 1.1));
    const crackCut = 2200 + 15000 * g * g;
    this.play('crack', node, crackGain, t, (0.94 + 0.08 * g) * jitter(), { type: 'lowpass', f: crackCut });
    // Body: tighter (higher, shorter) on a centred catch, duller off it.
    const bodyRate = (0.86 + 0.12 * s + 0.1 * g) * jitter();
    const bodyCut = 1500 + 9000 * g;
    this.play('body', node, (0.5 + 0.35 * g) * loud, t, bodyRate, { type: 'lowpass', f: bodyCut });
    // Ring: only near the centre.
    const ringAmt = Math.max(0, (g - 0.5) / 0.5);
    if (ringAmt > 0) {
      this.play('ring', node, Math.pow(ringAmt, 1.4) * (0.32 + 0.4 * s), t + 0.001, (0.97 + 0.06 * s) * jitter());
    }
    // A perfect one echoes off the houses across the street.
    if (g >= 0.78) {
      this.play('crack', this.slap, crackGain * 0.9, t, 1);
      this.play('body', this.slap, 0.4 * loud, t, bodyRate);
    }
    // Settle: more leather shuffling when it wasn't clean.
    this.play('settle', node, 0.12 + 0.22 * (1 - g), t + 0.012, 0.92 + 0.1 * g);
  }

  thud(speed: number, pos: Vec3) {
    if (!this.ready || speed < 0.6) return;
    const g = Math.min(1, speed / 14) * 0.85;
    const { node, delay } = this.placeAt(pos);
    this.play('ground', node, g, this.ctx!.currentTime + delay, 0.9 + Math.random() * 0.2);
    this.log.push({ k: 'thud', t: performance.now(), speed });
  }

  transfer(side: number) {
    if (!this.ready) return;
    const { node } = this.placeAt(null, side * 0.12);
    this.play('transfer', node, 0.32, 0, 0.95 + Math.random() * 0.1);
  }

  pickup() {
    if (!this.ready) return;
    const { node } = this.placeAt(null, 0.15);
    this.play('transfer', node, 0.22, 0, 0.8);
  }

  creak(amount: number) {
    if (!this.ready || !this.ctx) return;
    if (this.ctx.currentTime - this.lastCreak < 0.6) return;
    this.lastCreak = this.ctx.currentTime;
    const { node } = this.placeAt(null, -0.2);
    this.play('creak', node, 0.1 + 0.18 * amount, 0, 0.9 + amount * 0.25);
  }

  /** Arm whip at release: a low swish plus the fingertips letting go. */
  armSwish(power: number, side: number) {
    if (!this.ready || !this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.bufs.noise[0];
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass'; band.Q.value = 1.4;
    band.frequency.setValueAtTime(260, t);
    band.frequency.exponentialRampToValueAtTime(700 + power * 700, t + 0.09);
    band.frequency.exponentialRampToValueAtTime(300, t + 0.26);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12 + power * 0.28, t + 0.07);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    const pan = ctx.createStereoPanner(); pan.pan.value = side * 0.35;
    src.connect(band).connect(g).connect(pan).connect(this.sfx);
    src.start(t, Math.random()); src.stop(t + 0.32);
    this.log.push({ k: 'throw', t: performance.now(), power });
  }

  /** A soft two-note chime for streak milestones (quiet; no fanfare). */
  milestone() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.25;
    [659.25, 987.77].forEach((f, i) => {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + i * 0.11);
      g.gain.exponentialRampToValueAtTime(0.07, t + i * 0.11 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.11 + 0.9);
      o.connect(g).connect(this.sfx);
      o.start(t + i * 0.11); o.stop(t + i * 0.11 + 1);
    });
  }

  // ------------------------------------------------------------- the ZIP

  private ensureZip() {
    if (this.zip || !this.ctx || !this.ready) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.bufs.noise[0]; src.loop = true;
    const band = ctx.createBiquadFilter(); band.type = 'bandpass'; band.Q.value = 0.85; band.frequency.value = 900;
    const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 3500; air.gain.value = 0;
    const flutter = ctx.createGain(); flutter.gain.value = 1;
    const lfo = ctx.createOscillator(); lfo.type = 'triangle'; lfo.frequency.value = 120;
    const lfoDepth = ctx.createGain(); lfoDepth.gain.value = 0;
    lfo.connect(lfoDepth).connect(flutter.gain);
    const gain = ctx.createGain(); gain.gain.value = 0;
    const panner = this.makePanner([0, 1, 0]);
    panner.refDistance = 1.0;
    panner.rolloffFactor = 1.35;
    src.connect(band).connect(air).connect(flutter).connect(gain).connect(panner).connect(this.sfx);
    // Rolling-through-grass brush shares the panner.
    const rollBand = ctx.createBiquadFilter(); rollBand.type = 'bandpass'; rollBand.frequency.value = 2400; rollBand.Q.value = 0.9;
    const rollGain = ctx.createGain(); rollGain.gain.value = 0;
    src.connect(rollBand).connect(rollGain).connect(panner);
    src.start(); lfo.start();
    this.zip = { src, band, air, gain, flutter, lfo, lfoDepth, panner, rollGain, rollBand };
  }

  /**
   * Called every frame. `vel` in m/s. `airborne` false when rolling/held.
   */
  ball(o: { active: boolean; pos: Vec3; vel: Vec3; airborne: boolean; rolling: number }) {
    if (!this.ctx || !this.ready) return;
    this.ensureZip();
    const z = this.zip!;
    const t = this.ctx.currentTime;
    const k = 0.012;
    if (!o.active) {
      if (this.zipPeak) this.lastZipPeak = this.zipPeak;
      this.zipPeak = 0;
      z.gain.gain.setTargetAtTime(0, t, 0.03);
      z.rollGain.gain.setTargetAtTime(0, t, 0.05);
      return;
    }
    setPannerPos(z.panner, o.pos, t);
    const sp = Math.hypot(o.vel[0], o.vel[1], o.vel[2]);
    if (o.airborne) {
      // Radial velocity toward the listener → doppler.
      const dx = this.listenerPos[0] - o.pos[0], dy = this.listenerPos[1] - o.pos[1], dz = this.listenerPos[2] - o.pos[2];
      const d = Math.hypot(dx, dy, dz) || 1;
      const vr = (o.vel[0] * dx + o.vel[1] * dy + o.vel[2] * dz) / d;
      const dop = Math.min(1.25, Math.max(0.8, C / (C - vr)));
      const s = Math.min(1.2, sp / 30);
      // A soft toss barely whispers; a hard throw rushes.
      const level = 0.04 + 0.95 * Math.pow(s, 2.1);
      // Close passes get extra air: shelf lifts as the ball nears your head.
      const near = Math.exp(-d / 1.2);
      z.band.frequency.setTargetAtTime((420 + 62 * sp) * dop, t, k);
      z.band.Q.setTargetAtTime(0.75 + 0.5 * s, t, 0.05);
      z.air.gain.setTargetAtTime(near * 9, t, k);
      z.gain.gain.setTargetAtTime(level * (1 + near * 1.4), t, k);
      this.zipPeak = Math.max(this.zipPeak, level);
      // Seam flutter: four seams passing per revolution of a ~1800 rpm ball.
      z.lfo.frequency.setTargetAtTime(Math.max(20, sp * 4.2) * dop, t, 0.05);
      z.lfoDepth.gain.setTargetAtTime(0.16 + 0.12 * s, t, 0.05);
      z.rollGain.gain.setTargetAtTime(0, t, 0.03);
    } else {
      z.gain.gain.setTargetAtTime(0, t, 0.02);
      z.rollGain.gain.setTargetAtTime(Math.min(0.25, o.rolling * 0.06), t, 0.05);
    }
  }

  setListener(pos: Vec3, fwd: Vec3, up: Vec3) {
    this.listenerPos = pos;
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener;
    const t = ctx.currentTime;
    if (l.positionX) {
      l.positionX.setValueAtTime(pos[0], t); l.positionY.setValueAtTime(pos[1], t); l.positionZ.setValueAtTime(pos[2], t);
      l.forwardX.setValueAtTime(fwd[0], t); l.forwardY.setValueAtTime(fwd[1], t); l.forwardZ.setValueAtTime(fwd[2], t);
      l.upX.setValueAtTime(up[0], t); l.upY.setValueAtTime(up[1], t); l.upZ.setValueAtTime(up[2], t);
    } else {
      (l as unknown as { setPosition(...a: number[]): void }).setPosition(...pos);
      (l as unknown as { setOrientation(...a: number[]): void }).setOrientation(...fwd, ...up);
    }
  }

  // ------------------------------------------------------------- ambience

  startAmbience() {
    if (!this.ctx || !this.ready || this.ambienceOn) return;
    this.ambienceOn = true;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    this.amb.gain.setValueAtTime(0, t);
    this.amb.gain.linearRampToValueAtTime(1, t + 2.5);

    // Wind: low and breathing, with gusts.
    const w = ctx.createBufferSource(); w.buffer = this.bufs.wind[0]; w.loop = true;
    const wg = ctx.createGain(); wg.gain.value = 0.05;
    w.connect(wg).connect(this.amb); w.start();
    // Leaves: a bright rustle that rises with gusts.
    const leaves = ctx.createBufferSource(); leaves.buffer = this.bufs.noise[0]; leaves.loop = true; leaves.playbackRate.value = 0.7;
    const lb = ctx.createBiquadFilter(); lb.type = 'bandpass'; lb.frequency.value = 3800; lb.Q.value = 0.6;
    const lg = ctx.createGain(); lg.gain.value = 0.006;
    leaves.connect(lb).connect(lg).connect(this.amb); leaves.start();
    const gust = () => {
      if (!this.ambienceOn) return;
      const now = ctx.currentTime;
      const peak = 0.04 + Math.random() * 0.06;
      wg.gain.setTargetAtTime(peak, now, 1.4);
      lg.gain.setTargetAtTime(peak * 0.22, now, 1.2);
      setTimeout(() => {
        wg.gain.setTargetAtTime(0.035, ctx.currentTime, 2.2);
        lg.gain.setTargetAtTime(0.005, ctx.currentTime, 2);
      }, 1800 + Math.random() * 2500);
      setTimeout(gust, 5000 + Math.random() * 9000);
    };
    setTimeout(gust, 2000);

    // A lawnmower a few yards over: a buzz that comes and goes, far away.
    const mowOsc = ctx.createOscillator(); mowOsc.type = 'sawtooth'; mowOsc.frequency.value = 49;
    const mowOsc2 = ctx.createOscillator(); mowOsc2.type = 'square'; mowOsc2.frequency.value = 98.6;
    const mowLp = ctx.createBiquadFilter(); mowLp.type = 'lowpass'; mowLp.frequency.value = 260; mowLp.Q.value = 0.9;
    const mowG = ctx.createGain(); mowG.gain.value = 0;
    const mowPan = ctx.createStereoPanner(); mowPan.pan.value = -0.55;
    const g2 = ctx.createGain(); g2.gain.value = 0.35;
    mowOsc.connect(mowLp); mowOsc2.connect(g2).connect(mowLp);
    mowLp.connect(mowG).connect(mowPan).connect(this.amb);
    mowOsc.start(); mowOsc2.start();
    const mow = () => {
      if (!this.ambienceOn) return;
      const now = ctx.currentTime;
      const on = Math.random() < 0.55;
      mowG.gain.setTargetAtTime(on ? 0.008 + Math.random() * 0.006 : 0, now, 4);
      mowOsc.frequency.setTargetAtTime(47 + Math.random() * 5, now, 3);
      mowPan.pan.setTargetAtTime(Math.random() * 1.4 - 0.7, now, 8);
      setTimeout(mow, 12000 + Math.random() * 20000);
    };
    setTimeout(mow, 6000);

    // Birds in the trees around the park.
    const bird = () => {
      if (!this.ambienceOn) return;
      const a = Math.random() * Math.PI * 2, r = 18 + Math.random() * 20;
      const pos: Vec3 = [Math.sin(a) * r, 6 + Math.random() * 5, Math.cos(a) * r];
      const p = this.makePanner(pos);
      p.refDistance = 6;
      p.connect(this.amb);
      const src = this.play('bird', p, 0.18 + Math.random() * 0.12, 0, 0.9 + Math.random() * 0.25);
      if (Math.random() < 0.4) setTimeout(() => this.ambienceOn && this.play('bird', p, 0.14, 0, 0.95 + Math.random() * 0.2), 500 + Math.random() * 700);
      src.onended = () => setTimeout(() => p.disconnect(), 1500);
      window.setTimeout(bird, 3500 + Math.random() * 8000);
    };
    window.setTimeout(bird, 1500);
  }
}

function setPannerPos(p: PannerNode, pos: Vec3, t: number) {
  if (p.positionX) {
    p.positionX.setValueAtTime(pos[0], t);
    p.positionY.setValueAtTime(pos[1], t);
    p.positionZ.setValueAtTime(pos[2], t);
  } else {
    (p as unknown as { setPosition(...a: number[]): void }).setPosition(...pos);
  }
}

/** Crossfade the tail into the head so a noise bed loops seamlessly. */
function loopify(x: Float32Array, sr: number, fade: number): Float32Array {
  const n = Math.floor(fade * sr);
  const out = x.slice(0, x.length - n);
  for (let i = 0; i < n; i++) {
    const g = i / n;
    out[i] = out[i] * g + x[x.length - n + i] * (1 - g);
  }
  return out;
}

export const audio = new AudioEngine();
