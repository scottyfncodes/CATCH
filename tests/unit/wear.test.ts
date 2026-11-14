// Everything you can wear can be built and worn (here, with no page: no textures), moves when it
// should, and changes nothing about the glove that catches.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Arm } from '../../src/shared/protocol';
import { BUILDS, GLOVES, HATS, S, type Style, TOPS, defaultStyle } from '../../src/shared/style';
import { torsoSurface } from '../../src/client/scene/body';
import { bodyToWorld } from '../../src/shared/pose';
import { Avatar } from '../../src/client/scene/avatar';

const G: [number, number, number] = [-0.25, 1.3, 0.5];
function run(style: Style, frames = 60, move = false) {
  const av = new Avatar([0, 0, 0], 0, 'R', style, 34);
  for (let i = 0; i < frames; i++) {
    const x = move ? i * 0.06 : 0;
    av.update(1 / 60, { pose: { x, z: 0, yaw: 0, g: bodyToWorld(0, G) }, arm: Arm.Idle, charge: 0, look: [0, 1.6, -14], ready: true });
  }
  return av;
}
const base = defaultStyle('wear');
const wearing = (slot: number, k: number): Style => { const s = [...base] as Style; s[slot] = k; return s; };

describe('everything you can wear', () => {
  for (const [slot, list, kind] of [[S.hat, HATS, 'hat'], [S.glove, GLOVES, 'glove'], [S.top, TOPS, 'top']] as const) {
    list.forEach((item, k) => {
      it(`${kind}: ${item.name} builds, is worn, and nothing about it is broken`, () => {
        const av = run(wearing(slot, k));
        let bad = 0;
        av.root.traverse((o) => { if (![o.position.x, o.position.y, o.position.z].every(Number.isFinite)) bad++; });
        expect(bad).toBe(0);
        av.dispose();
      });
    });
  }

  it('a glove dressed up is the same glove: its pocket is in the same place and it is the same size', () => {
    const plain = run(wearing(S.glove, 0));
    for (let k = 1; k < GLOVES.length; k++) {
      const fancy = run(wearing(S.glove, k));
      expect(fancy.joints.glove.distanceTo(plain.joints.glove), GLOVES[k].name).toBeLessThan(1e-6);
      expect(fancy.glove.scale.toArray(), GLOVES[k].name).toEqual(plain.glove.scale.toArray());
      expect(fancy.gloveWorldPos.distanceTo(plain.gloveWorldPos), GLOVES[k].name).toBeLessThan(1e-6);
    }
  });

  it('a cape streams out behind you when you run, and hangs when you stand', () => {
    const hero = TOPS.findIndex((t) => t.pattern === 'closer');
    const back = (av: Avatar) => {
      // How far behind the trunk the bottom of the cape is (+Z is behind).
      let z = -Infinity;
      av.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry.type === 'PlaneGeometry') { const p = m.geometry.attributes.position; z = Math.max(z, p.getZ(p.count - 1)); } });
      return z;
    };
    const standing = back(run(wearing(S.top, hero), 120));
    // (Running along +X: away from the cape's side, so it streams out behind... sideways from the trunk's point of view.)
    const av = new Avatar([0, 0, 0], 0, 'R', wearing(S.top, hero), 34);
    for (let i = 0; i < 120; i++) av.update(1 / 60, { pose: { x: 0, z: -i * 0.08, yaw: 0, g: bodyToWorld(0, G) }, arm: Arm.Idle, charge: 0, look: [0, 1.6, -30], ready: false });
    expect(back(av)).toBeGreaterThan(standing + 0.15);
  });

  it('a cape lies over the back, never through it: standing, running, for every build', () => {
    for (const pattern of ['closer', 'robe'] as const) {
      const k = TOPS.findIndex((t) => t.pattern === pattern);
      BUILDS.forEach((b, bi) => {
        const style = wearing(S.top, k); style[S.build] = bi;
        const av = new Avatar([0, 0, 0], 0, 'R', style, 34);
        let worst = Infinity;
        for (let i = 0; i < 150; i++) {
          // Stand for a second, then run.
          av.update(1 / 60, { pose: { x: 0, z: i < 60 ? 0 : -(i - 60) * 0.08, yaw: 0, g: bodyToWorld(0, G) }, arm: Arm.Idle, charge: 0, look: [0, 1.6, -30], ready: i < 60 });
          av.root.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh || m.geometry.type !== 'PlaneGeometry') return;
            // (The middle of the cloth, where the back is furthest out: the shoulder blades.)
            const p = m.geometry.attributes.position, cols = (m.geometry as THREE.PlaneGeometry).parameters.widthSegments + 1, mid = (cols - 1) / 2;
            for (let v = mid; v < p.count; v += cols) {
              const y = p.getY(v);
              if (y < 0.02 || y > 0.6) continue;
              worst = Math.min(worst, p.getZ(v) - torsoSurface(y, Math.PI, b.w).z);
            }
          });
        }
        expect(worst, `${TOPS[k].name}, ${b.name}: closest the cloth comes to the back (m)`).toBeGreaterThan(0.004);
        av.dispose();
      });
    }
  });

  it('The Closer: a baseball on the chest and a stitched cape, and nothing borrowed from a comic book', () => {
    const k = TOPS.findIndex((t) => t.pattern === 'closer');
    expect(TOPS[k].name).toBe('The Closer');
    expect(TOPS[k].at).toBe(1500);
    // The streak that earns the cape is unchanged, and it is the only cape short of the robe.
    expect(TOPS.filter((t) => t.at === 1500)).toHaveLength(1);
    for (const t of TOPS) expect(t.name.toLowerCase(), t.name).not.toMatch(/super|hero/);
    let capes = 0, clasp = 0;
    run(wearing(S.top, k)).root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry.type === 'PlaneGeometry') capes++;
      if (m.isMesh && m.geometry.type === 'CylinderGeometry' && (m.material as THREE.MeshStandardMaterial).metalness > 0.5) clasp++;
    });
    expect(capes).toBe(1);
    expect(clasp).toBe(1);
  });
});
