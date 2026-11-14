// Authoring tool: the players up close, in the game's own light and grade.
// A few different looks, each from the front, three-quarter, back and side.
//
//   npm run dev:client, then open /tests/visual/people.html   (&pose=ready for the catching stance, &set=silly for everything you can earn)

import * as THREE from 'three';
import { type Style } from '../../src/shared/style';
import { Avatar } from '../../src/client/scene/avatar';
import { installLook } from '../../src/client/scene/look';
import { studioLight } from '../../src/client/scene/light';

const q = new URLSearchParams(location.search);
installLook();
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
// [skin, build, hair, hair colour, hat, glove, top, pants]
const sets: Record<string, Style[]> = {
  // [skin, build, hair, hair colour, hat, glove, top, pants]
  plain: [[1, 1, 1, 1, 0, 0, 1, 0], [4, 0, 2, 0, 1, 1, 2, 1], [2, 2, 4, 3, 3, 0, 4, 2], [5, 1, 3, 0, 2, 1, 5, 5]],
  // Everything you can earn: the silly things.
  silly: [[1, 1, 1, 2, 5, 2, 6, 3], [3, 1, 3, 1, 6, 3, 7, 4], [0, 2, 5, 4, 7, 4, 8, 0], [4, 1, 1, 0, 8, 5, 9, 2]],
};
const looks: Style[] = sets[q.get('set') ?? 'plain'] ?? sets.plain;
const views: number[] = [0, 0.75, Math.PI, -Math.PI / 2];
const CW = 300, CH = 420, cols = views.length, rows = looks.length;
renderer.setPixelRatio(Number(q.get('dpr') ?? 2));
renderer.setSize(cols * CW, rows * CH, false);
canvas.style.width = `${cols * CW}px`;
canvas.style.height = `${rows * CH}px`;
renderer.setScissorTest(true);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.CustomToneMapping;
renderer.toneMappingExposure = 1.16;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#cfc6b4');
studioLight(renderer, scene);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: '#a59c88', roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const cam = new THREE.PerspectiveCamera(24, CW / CH, 0.1, 50);
const focus = new THREE.Vector3();
const ready = q.get('pose') === 'ready';
looks.forEach((style, row) => {
  const av = new Avatar([0, 0, 0], 0, row % 2 ? 'L' : 'R', style, 34);
  scene.add(av.root);
  const side = row % 2 ? 1 : -1;
  for (let i = 0; i < 120; i++) av.update(1 / 60, { pose: { x: 0, z: 0, yaw: 0, g: ready ? [side * 0.3, 1.3, -0.5] : [side * 0.2, 1.18, -0.42] }, arm: 0, charge: 0, look: [0, 1.6, -14], ready });
  views.forEach((az, col) => {
    // (Azimuth 0 looks at the face.)
    // (&zoom=head: the head and shoulders, close up.)
    const head = q.get('zoom') === 'head', d = head ? 1.7 : 5.2;
    focus.copy(av.eye);
    cam.position.set(-Math.sin(az) * d, head ? focus.y + 0.12 : 1.25, -Math.cos(az) * d);
    cam.lookAt(0, head ? focus.y + 0.02 : 0.92, 0);
    const cx = col * CW, cy = (rows - 1 - row) * CH;
    renderer.setViewport(cx, cy, CW, CH);
    renderer.setScissor(cx, cy, CW, CH);
    renderer.render(scene, cam);
  });
  scene.remove(av.root);
});
(window as unknown as { __done: boolean }).__done = true;
