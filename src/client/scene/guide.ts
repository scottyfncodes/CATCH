// What the catcher sees coming: a ring on the spot where the ball will cross
// your glove, closing as the ball does, a faint trail of where the ball is
// headed on its way there, and a small mark on your own pocket.
// Put the mark in the ring before it shuts. The ring's colour is the honest
// answer to "can I get that?": cream for a routine catch, amber for one you
// have to go and get, red for one that needs something special, grey for gone.

import * as THREE from 'three';
import type { Vec3 } from '../../shared/vec';

/** How hard the catch is from where you are standing right now. */
export const Tier = { Easy: 0, Reach: 1, Great: 2, Gone: 3 } as const;
export type TierId = (typeof Tier)[keyof typeof Tier];

export interface GuideState {
  /** Where the ball crosses your glove plane. */
  at: Vec3;
  /** Your pocket. */
  pocket: Vec3;
  /** 0 as the ball leaves the hand → 1 as it arrives. */
  k: number;
  tier: TierId;
  /** 1 when the pocket is dead on the spot, 0 when it is a glove away. */
  on: number;
  /** The glove's size (the ring is the size of its pocket). */
  size?: number;
  /** Points along the rest of the flight, from the ball to the spot (a depth cue). */
  path: Vec3[];
}

const COLORS = ['#fff3df', '#ffbf6b', '#ff8f6b', '#b9b2a6'].map((c) => new THREE.Color(c));
const GOLD = new THREE.Color('#ffd27a');
/** The ring's resting size: about the pocket of the glove (metres). */
const R = 0.105;
/** Dots in the trail ahead of the ball. */
export const TRAIL = 7;

const gone0 = (tier: number) => (tier === 3 ? 0.5 : 1);

function flat(geo: THREE.BufferGeometry, color: string) {
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, depthTest: false, fog: false, side: THREE.DoubleSide });
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = 6;
  m.frustumCulled = false;
  return { m, mat };
}

export class CatchGuide {
  readonly group = new THREE.Group();
  private spot = flat(new THREE.RingGeometry(0.9, 1, 48), '#fff3df');
  private closing = flat(new THREE.RingGeometry(0.965, 1, 64), '#fff3df');
  private pocket = flat(new THREE.CircleGeometry(1, 20), '#fff3df');
  private pocketRing = flat(new THREE.RingGeometry(0.8, 1, 32), '#fff3df');
  private pop = flat(new THREE.RingGeometry(0.86, 1, 48), '#ffd27a');
  private trail: { m: THREE.Mesh; mat: THREE.MeshBasicMaterial }[] = [];
  private shown = 0;
  private popT = -1;
  private popGrade = 0;
  private col = new THREE.Color('#fff3df');

  constructor() {
    this.group.add(this.spot.m, this.closing.m, this.pocket.m, this.pocketRing.m, this.pop.m);
    const dot = new THREE.SphereGeometry(1, 8, 6);
    for (let i = 0; i < TRAIL; i++) {
      // In the world (the trees and your glove hide them), not painted over it.
      const mat = new THREE.MeshBasicMaterial({ color: '#fff3df', transparent: true, opacity: 0, depthWrite: false, fog: false });
      const m = new THREE.Mesh(dot, mat);
      m.renderOrder = 3;
      m.frustumCulled = false;
      this.trail.push({ m, mat });
      this.group.add(m);
    }
    this.group.visible = false;
  }

  /** A caught ball: a ring bursts off the pocket (bigger and warmer for a cleaner catch). */
  burst(at: Vec3, grade: number) {
    this.pop.m.position.set(at[0], at[1], at[2]);
    this.popT = 0;
    this.popGrade = grade;
  }

  /** `view` fades the whole thing with the first-person view (0..1). */
  update(s: GuideState | null, view: number, camera: THREE.Camera, dt: number) {
    this.shown += ((s ? 1 : 0) - this.shown) * Math.min(1, dt * (s ? 16 : 10));
    if (this.popT >= 0) { this.popT += dt; if (this.popT > 0.28) this.popT = -1; }
    const a = this.shown * view;
    this.group.visible = a > 0.01 || this.popT >= 0;
    if (!this.group.visible) return;
    const q = camera.quaternion;
    if (s) {
      this.col.copy(COLORS[s.tier]).lerp(GOLD, s.tier === 0 ? s.on : 0);
      for (const o of [this.spot, this.closing]) { o.m.position.set(s.at[0], s.at[1], s.at[2]); o.m.quaternion.copy(q); o.mat.color.copy(this.col); }
      const r = R * (s.size ?? 1);
      this.spot.m.scale.setScalar(r);
      // The closing ring: wide when the ball leaves the hand, shut on the spot as it arrives.
      const open = 1 - s.k;
      this.closing.m.scale.setScalar(r * (1 + 3.4 * open * open));
      this.pocket.m.position.set(s.pocket[0], s.pocket[1], s.pocket[2]);
      this.pocketRing.m.position.copy(this.pocket.m.position);
      this.pocket.m.quaternion.copy(q); this.pocketRing.m.quaternion.copy(q);
      this.pocket.m.scale.setScalar(0.013);
      this.pocketRing.m.scale.setScalar(0.045);
      this.pocket.mat.color.copy(this.col); this.pocketRing.mat.color.copy(this.col);
      const cam = camera.position;
      this.trail.forEach((d, i) => {
        const p = s.path[i];
        d.m.visible = !!p;
        if (!p) return;
        d.m.position.set(p[0], p[1], p[2]);
        // A steady few pixels across, wherever it is.
        d.m.scale.setScalar(Math.max(0.012, cam.distanceTo(d.m.position) * 0.0045));
        d.mat.color.copy(this.col);
        d.mat.opacity = a * 0.5 * (1 - i / (TRAIL + 1)) * gone0(s.tier);
      });
    } else for (const d of this.trail) d.mat.opacity *= 0.8;
    const gone = s?.tier === 3 ? 0.55 : 1;
    this.spot.mat.opacity = a * 0.9 * gone;
    this.closing.mat.opacity = a * (0.25 + 0.6 * (s ? s.k : 0)) * gone;
    this.pocket.mat.opacity = a * 0.95;
    this.pocketRing.mat.opacity = a * (0.5 + 0.4 * (s ? s.on : 0));
    if (this.popT >= 0) {
      const k = this.popT / 0.28;
      this.pop.m.quaternion.copy(q);
      this.pop.m.scale.setScalar(0.07 + (0.09 + 0.13 * this.popGrade) * (1 - (1 - k) * (1 - k)));
      this.pop.mat.opacity = (1 - k) * (0.5 + 0.5 * this.popGrade);
    } else this.pop.mat.opacity = 0;
  }

  dispose() {
    for (const o of [this.spot, this.closing, this.pocket, this.pocketRing, this.pop]) { o.m.geometry.dispose(); o.mat.dispose(); }
    this.trail[0].m.geometry.dispose();
    for (const d of this.trail) d.mat.dispose();
    this.group.removeFromParent();
  }
}
