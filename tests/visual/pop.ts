// Offline render of the catch POP through the game's own audio engine (npm run dev:client, then
// open /tests/visual/pop.html): an
// OfflineAudioContext stands in for the device, so the real layers, filters and
// master bus are what get measured. Writes the samples to window.__pop.
import { audio } from '../../src/client/audio';

const SR = 48000, LEN = 0.5;
const cases = [
  { name: 'perfect, hard', q: 'perfect', g: 0.95, speed: 30 },
  { name: 'perfect, soft', q: 'perfect', g: 0.9, speed: 12 },
  { name: 'pocket', q: 'pocket', g: 0.65, speed: 26 },
  { name: 'web', q: 'web', g: 0.35, speed: 26 },
  { name: 'bobble', q: 'bobble', g: 0.15, speed: 26 },
];
const out: { name: string; data: number[] }[] = [];
for (const c of cases) {
  const off = new OfflineAudioContext(2, SR * LEN, SR);
  (off as unknown as { resume: () => Promise<void> }).resume = () => Promise.resolve();
  const W = window as unknown as { AudioContext: unknown };
  W.AudioContext = function () { return off; };
  const a = audio as unknown as { ctx: AudioContext | null; ready: boolean; lastPopAt: number; create: () => void };
  a.ctx = null; a.ready = false; a.lastPopAt = -1;
  a.create();
  audio.pop({ speed: c.speed, q: c.q as never, g: c.g, pos: null });
  const buf = await off.startRendering();
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  out.push({ name: c.name, data: Array.from(L, (v, i) => (v + R[i]) / 2) });
}
(window as unknown as { __pop: typeof out }).__pop = out;
