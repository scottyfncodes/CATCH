// Tiny offline DSP toolkit used to synthesise CATCH.'s sound layers at load
// time into AudioBuffers. Everything is deterministic per seed so variations
// are stable between sessions.

export function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function white(n: number, r: () => number): Float32Array {
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = r() * 2 - 1;
  return o;
}

export function pink(n: number, r: () => number): Float32Array {
  const o = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    o[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return o;
}

export function brown(n: number, r: () => number): Float32Array {
  const o = new Float32Array(n);
  let last = 0;
  for (let i = 0; i < n; i++) {
    last = (last + 0.02 * (r() * 2 - 1)) / 1.02;
    o[i] = last * 3.5;
  }
  return o;
}

type BiquadType = 'lowpass' | 'highpass' | 'bandpass' | 'peaking' | 'highshelf' | 'lowshelf';

/** RBJ cookbook biquad, applied in place. */
export function biquad(x: Float32Array, sr: number, type: BiquadType, f: number, q = 0.707, gainDb = 0): Float32Array {
  const w0 = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  const A = Math.pow(10, gainDb / 40);
  let b0 = 0, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
  switch (type) {
    case 'lowpass': b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'highpass': b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'bandpass': b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'peaking': b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s);
      a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s; break;
    }
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s);
      a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s; break;
    }
  }
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const y = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = y;
    x[i] = y;
  }
  return x;
}

/** Multiply by an attack/exponential-decay envelope. */
export function envelope(x: Float32Array, sr: number, attack: number, tau: number, delay = 0): Float32Array {
  const a = Math.max(1, attack * sr);
  const d = delay * sr;
  for (let i = 0; i < x.length; i++) {
    const t = i - d;
    if (t < 0) { x[i] = 0; continue; }
    const g = t < a ? t / a : Math.exp(-(t - a) / (tau * sr));
    x[i] *= g;
  }
  return x;
}

export function mix(into: Float32Array, src: Float32Array, gain = 1, offset = 0) {
  const o = Math.floor(offset);
  for (let i = 0; i < src.length && i + o < into.length; i++) if (i + o >= 0) into[i + o] += src[i] * gain;
  return into;
}

export function normalize(x: Float32Array, peak = 0.9): Float32Array {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m;
  return x;
}

/** Damped sinusoid with optional exponential pitch glide. */
export function tone(n: number, sr: number, f0: number, f1: number, tau: number, glideTau = 0.03, phase = 0): Float32Array {
  const o = new Float32Array(n);
  let ph = phase;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = f1 + (f0 - f1) * Math.exp(-t / glideTau);
    ph += (2 * Math.PI * f) / sr;
    o[i] = Math.sin(ph) * Math.exp(-t / tau);
  }
  return o;
}

/** Soft saturation to glue transients. */
export function saturate(x: Float32Array, drive = 1.5): Float32Array {
  const k = Math.tanh(drive);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * drive) / k;
  return x;
}

/** Short fade-in/out to avoid clicks at buffer edges. */
export function fadeEdges(x: Float32Array, sr: number, ms = 3): Float32Array {
  const n = Math.min(x.length >> 1, Math.floor((ms / 1000) * sr));
  for (let i = 0; i < n; i++) { const g = i / n; x[i] *= g; x[x.length - 1 - i] *= g; }
  return x;
}
