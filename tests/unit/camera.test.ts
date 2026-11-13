// The camera's job at distance: your friend stays a person, you stay where you were in the frame.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraRig, standBack, watchFov, type EyeShot, type Shot } from '../../src/client/scene/camera';
import type { Vec3 } from '../../src/shared/vec';

const dt = 1 / 60;
/** How tall something is on screen, as a fraction of the screen's height. */
function tall(cam: THREE.Camera, x: number, z: number, y0: number, y1: number) {
  const a = new THREE.Vector3(x, y0, z).project(cam), b = new THREE.Vector3(x, y1, z).project(cam);
  return { h: Math.abs(b.y - a.y) / 2, top: Math.max(a.y, b.y), bottom: Math.min(a.y, b.y), x: (a.x + b.x) / 2 };
}
function third(dist: number, longLens = true) {
  const rig = new CameraRig();
  rig.longLens = longLens;
  rig.aspect = 390 / 844;
  const s: Shot = { me: [0, 0, 0], partner: [0, 0, -dist], ball: null, side: -1 };
  for (let i = 0; i < 600; i++) rig.update(dt, s);
  return rig;
}
function eyes(dist: number, wide = 0) {
  const rig = new CameraRig();
  rig.aspect = 390 / 844;
  const s: Shot = { me: [0, 0, 0], partner: [0, 0, -dist], ball: null, side: -1 };
  const far: Vec3 = [0, 1.4, -dist];
  const e: EyeShot = { eye: [0, 1.6, 0], yaw: 0, far, near: [-0.2, 1.18, -0.42], pitchK: 0.3, yawK: 0.25, wide, landing: 0, lean: 0, watch: dist };
  for (let i = 0; i < 600; i++) rig.update(dt, s, e, true);
  return rig;
}

describe('seeing a friend who is a long way off', () => {
  it('up close nothing changes: the ordinary lens, the ordinary spot behind your shoulder', () => {
    expect(standBack(14)).toBe(1);
    expect(standBack(16)).toBe(1);
    expect(watchFov(14, 60)).toBe(60);
  });

  it('the lenses change gradually with distance, and only so far', () => {
    let prevB = standBack(10), prevF = watchFov(10, 60);
    for (let d = 11; d <= 120; d++) {
      const b = standBack(d), f = watchFov(d, 60);
      expect(b).toBeGreaterThanOrEqual(prevB);
      expect(b - prevB).toBeLessThan(0.05);
      expect(f).toBeLessThanOrEqual(prevF);
      expect(prevF - f).toBeLessThan(4);
      prevB = b; prevF = f;
    }
    expect(standBack(120)).toBeLessThanOrEqual(2.3);
    expect(watchFov(120, 60)).toBeGreaterThanOrEqual(24);
  });

  it('holding the ball at 50 m (third person): your friend is well over half as tall again on screen as the close shot shows them, and you are still in the frame', () => {
    const rig = third(50);
    const friend = tall(rig.camera, 0, -50, 0, 1.8);
    const before = tall(third(50, false).camera, 0, -50, 0, 1.8);
    expect(friend.h).toBeGreaterThan(before.h * 1.6);
    const me = tall(rig.camera, 0, 0, 0.75, 2.0);
    expect(me.top).toBeLessThan(0.5);
    expect(me.bottom).toBeGreaterThan(-1.02);
    expect(Math.abs(me.x)).toBeLessThan(0.9);
    // You are about the size you are in the close shot.
    const meBefore = tall(third(50, false).camera, 0, 0, 0.75, 2.0);
    expect(me.h).toBeGreaterThan(meBefore.h * 0.8);
    expect(me.h).toBeLessThan(meBefore.h * 1.25);
  });

  it('waiting for a throw at 50 m (first person): your friend is a person, about a tenth of the screen, clear of the scoreboard', () => {
    const rig = eyes(50);
    const friend = tall(rig.camera, 0, -50, 0, 1.8);
    expect(friend.h).toBeGreaterThan(0.075);
    expect(friend.top).toBeLessThan(0.45);
    expect(friend.bottom).toBeGreaterThan(-0.3);
    // The old lens (60°) would have shown them a third of that.
    expect(friend.h).toBeGreaterThan((1.8 / 50 / (2 * Math.tan(Math.PI / 6))) * 2.4);
  });

  it('once the throw is on its way the view is as wide as it ever was (the catch needs the room)', () => {
    expect(eyes(50, 1).camera.fov).toBeCloseTo(80, 0);
    expect(eyes(14, 0).camera.fov).toBeCloseTo(60, 0);
  });
});
