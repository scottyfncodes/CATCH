// Aim feedback while you pull back to throw: a short, faint line of dots along
// the first part of the real (simulated) flight, fading out before it reaches
// your friend. Enough to read height, direction and pace; not a targeting
// reticle, and it never shows where the ball will end up.

import * as THREE from 'three';
import { type Trajectory, positionAt } from '../../shared/physics';

const N = 16;

export class AimArc {
  readonly group = new THREE.Group();
  private dots: THREE.Mesh[] = [];
  private mats: THREE.MeshBasicMaterial[] = [];
  private shown = 0;

  constructor() {
    const geo = new THREE.SphereGeometry(0.028, 8, 6);
    for (let i = 0; i < N; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: '#fff3df', transparent: true, opacity: 0, depthWrite: false, fog: false });
      const m = new THREE.Mesh(geo, mat);
      m.renderOrder = 3;
      m.frustumCulled = false;
      this.dots.push(m);
      this.mats.push(mat);
      this.group.add(m);
    }
    this.group.visible = false;
  }

  /** Show the first part of a predicted throw. strength 0..1 fades it in. */
  show(tr: Trajectory | null, strength: number, camera: THREE.Camera, dt: number) {
    this.shown += ((tr ? 1 : 0) - this.shown) * Math.min(1, dt * (tr ? 14 : 8));
    this.group.visible = this.shown > 0.01;
    if (!this.group.visible) return;
    if (tr) {
      // Cover roughly the first 45% of the airborne flight (at least ~4 m of it).
      const span = Math.min(tr.groundT, Math.max(0.28, tr.groundT * 0.45));
      for (let i = 0; i < N; i++) {
        const k = (i + 1) / N;
        const p = positionAt(tr, span * k);
        this.dots[i].position.set(p[0], p[1], p[2]);
      }
    }
    for (let i = 0; i < N; i++) {
      const k = (i + 1) / N;
      const d = camera.position.distanceTo(this.dots[i].position);
      this.dots[i].scale.setScalar(Math.max(1, d * 0.09) * (1 - k * 0.35));
      this.mats[i].opacity = this.shown * Math.min(1, 0.25 + strength) * 0.62 * Math.pow(1 - k, 1.25);
    }
  }

  dispose() {
    this.dots[0].geometry.dispose();
    for (const m of this.mats) m.dispose();
    this.group.removeFromParent();
  }
}
