// Aim feedback while you pull back to throw: a short, faint line of dots along
// the first part of the real (simulated) flight, and a small ring on your
// friend's glove plane where the ball will actually cross it. Put the ring on
// their glove; it warms to gold when it sits in the perfect zone.

import * as THREE from 'three';
import { type Trajectory, positionAt } from '../../shared/physics';

const N = 16;

export class AimArc {
  readonly group = new THREE.Group();
  private dots: THREE.Mesh[] = [];
  private mats: THREE.MeshBasicMaterial[] = [];
  private shown = 0;
  private ring: THREE.Mesh;
  private dot: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;
  private dotMat: THREE.MeshBasicMaterial;
  /** A faint mark on your friend's pocket: what you're aiming for. */
  private pocket: THREE.Mesh;
  private pocketMat: THREE.MeshBasicMaterial;
  private cream = new THREE.Color('#fff3df');
  private gold = new THREE.Color('#ffc861');

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
    // The ring's true size is the perfect zone (radius ~4.5 cm); it never gets smaller than a few pixels.
    this.ringMat = new THREE.MeshBasicMaterial({ color: '#fff3df', transparent: true, opacity: 0, depthWrite: false, depthTest: false, fog: false, side: THREE.DoubleSide });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.78, 1, 40), this.ringMat);
    this.dotMat = new THREE.MeshBasicMaterial({ color: '#fff3df', transparent: true, opacity: 0, depthWrite: false, depthTest: false, fog: false });
    this.dot = new THREE.Mesh(new THREE.CircleGeometry(0.22, 16), this.dotMat);
    this.pocketMat = new THREE.MeshBasicMaterial({ color: '#ffd27a', transparent: true, opacity: 0, depthWrite: false, depthTest: false, fog: false, side: THREE.DoubleSide });
    this.pocket = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 40), this.pocketMat);
    for (const m of [this.pocket, this.ring, this.dot]) { m.renderOrder = 5; m.frustumCulled = false; this.group.add(m); }
    this.group.visible = false;
  }

  /** Show the first part of a predicted throw. strength 0..1 fades it in. */
  show(tr: Trajectory | null, strength: number, camera: THREE.Camera, dt: number, ring: { pos: [number, number, number]; onTarget: number; glove: [number, number, number] | null } | null = null) {
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
    if (ring) {
      for (const m of [this.ring, this.dot]) { m.position.set(ring.pos[0], ring.pos[1], ring.pos[2]); m.quaternion.copy(camera.quaternion); }
      const d = camera.position.distanceTo(this.ring.position);
      const persp = camera as THREE.PerspectiveCamera;
      // World metres per screen pixel at that distance (approx. for a ~700 px tall view).
      const mpp = (2 * d * Math.tan(((persp.fov ?? 50) * Math.PI) / 360)) / 700;
      const r = Math.max(0.05, mpp * 9);
      this.ring.scale.setScalar(r);
      this.dot.scale.setScalar(r);
      const c = this.cream.clone().lerp(this.gold, ring.onTarget);
      this.ringMat.color.copy(c);
      this.dotMat.color.copy(c);
      this.ringMat.opacity = this.shown * (0.75 + 0.25 * ring.onTarget);
      if (ring.glove) {
        this.pocket.position.set(ring.glove[0], ring.glove[1], ring.glove[2]);
        this.pocket.quaternion.copy(camera.quaternion);
        this.pocket.scale.setScalar(Math.max(0.045, mpp * 7));
        this.pocketMat.opacity = this.shown * (0.45 + 0.4 * ring.onTarget);
      } else this.pocketMat.opacity = 0;
      this.dotMat.opacity = this.shown * (0.35 + 0.6 * ring.onTarget);
    } else {
      this.ringMat.opacity = this.dotMat.opacity = this.shown * this.ringMat.opacity;
      this.pocketMat.opacity *= this.shown;
    }
  }

  dispose() {
    this.dots[0].geometry.dispose();
    this.ring.geometry.dispose(); this.dot.geometry.dispose(); this.pocket.geometry.dispose(); this.pocketMat.dispose(); this.ringMat.dispose(); this.dotMat.dispose();
    for (const m of this.mats) m.dispose();
    this.group.removeFromParent();
  }
}
