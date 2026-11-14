// A frame-timing readout for measuring on a real phone. Hidden unless the page
// is opened with ?fps=1 (it carries through into a room: /r/ABCD?fps=1).
//
// It shows what the adaptive quality is deciding from: frame rate, average and
// worst frame time, how many frames ran long, how much of a frame is spent on
// the CPU, the resolution being drawn at, and whether shadows are on. It reads
// those numbers; it changes nothing.
//
// Cost: two writes to a Float32Array a frame, and the text redrawn four times a
// second. It times itself and shows that too ("overlay").

import * as THREE from 'three';

/** What the overlay reads about the frame (from the game, after it has drawn). */
export interface PerfSource {
  renderer: THREE.WebGLRenderer;
  /** The pixel ratio the game started at (the adaptive quality only ever steps it down). */
  startRatio: number;
  shadows: boolean;
  drawing: boolean;
}

/** Frames longer than this count as a spike (two frames at 60 Hz). */
const SPIKE_MS = 33.4;
/** The window the numbers are over (frames). */
const N = 240;

export class PerfOverlay {
  /** Whether this page asked for it. */
  static wanted(): boolean {
    try { return new URLSearchParams(location.search).get('fps') === '1'; } catch { return false; }
  }

  private el: HTMLDivElement;
  private gap = new Float32Array(N);
  private cpu = new Float32Array(N);
  private n = 0;
  private i = 0;
  private last = 0;
  private shownAt = 0;
  private spikesAll = 0;
  private framesAll = 0;
  private selfMs = 0;
  private size = new THREE.Vector2();

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'perf';
    this.el.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.el);
  }

  /** Once a frame, after drawing: `now` is the frame's timestamp, `cpuMs` how long the frame's own work took. */
  frame(now: number, cpuMs: number, src: PerfSource) {
    const t0 = performance.now();
    if (this.last) {
      const gap = now - this.last;
      this.gap[this.i] = gap;
      this.cpu[this.i] = cpuMs;
      this.i = (this.i + 1) % N;
      this.n = Math.min(N, this.n + 1);
      this.framesAll++;
      if (gap > SPIKE_MS) this.spikesAll++;
    }
    this.last = now;
    if (now - this.shownAt >= 250 && this.n > 1) {
      this.shownAt = now;
      this.show(src);
    }
    this.selfMs = this.selfMs * 0.95 + (performance.now() - t0) * 0.05;
  }

  private show(src: PerfSource) {
    let sum = 0, worst = 0, spikes = 0, cpu = 0;
    for (let k = 0; k < this.n; k++) {
      const g = this.gap[k];
      sum += g; cpu += this.cpu[k];
      if (g > worst) worst = g;
      if (g > SPIKE_MS) spikes++;
    }
    const avg = sum / this.n;
    const r = src.renderer;
    r.getDrawingBufferSize(this.size);
    const ratio = r.getPixelRatio();
    const info = r.info.render;
    const secs = (sum / 1000).toFixed(0);
    this.el.textContent = [
      `${(1000 / avg).toFixed(0)} fps  ${avg.toFixed(1)} ms avg  ${worst.toFixed(0)} ms worst`,
      `long frames (>${SPIKE_MS.toFixed(0)} ms): ${spikes} in ${secs}s, ${this.spikesAll} of ${this.framesAll} total`,
      `cpu ${(cpu / this.n).toFixed(1)} ms/frame  overlay ${(this.selfMs * 1000).toFixed(0)} µs`,
      `draw ${this.size.x}×${this.size.y} @${ratio.toFixed(2)}x${ratio < src.startRatio - 1e-3 ? ` (stepped down from ${src.startRatio.toFixed(2)})` : ''}  screen ${(window.devicePixelRatio || 1).toFixed(0)}x`,
      `shadows ${src.shadows ? 'on' : 'off'}  ${info.calls} draws  ${(info.triangles / 1000).toFixed(0)}k tris${src.drawing ? '' : '  (not drawing)'}`,
    ].join('\n');
  }

  dispose() { this.el.remove(); }
}
