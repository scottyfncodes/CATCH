// Authoring tool: a filmstrip of one delivery, frame by frame, so a windup can
// be judged (and tuned) as a still sequence.
//
//   npm run dev:client, then open
//   /tests/visual/windups.html?id=34&hand=R&view=side   (view: side | front | back | top; pull=0..1 for the size of the windup)
//
// Each figure is a real Avatar stepped through the real clip up to that moment.

import * as THREE from 'three';
import { Arm } from '../../src/shared/protocol';
import { RELEASE_TIME, getWindup } from '../../src/shared/windups';
import { defaultStyle } from '../../src/shared/style';
import { Avatar } from '../../src/client/scene/avatar';
import { buildBall } from '../../src/client/scene/gear';

const q = new URLSearchParams(location.search);
const id = Number(q.get('id') ?? 34);
const hand = q.get('hand') === 'L' ? 'L' : 'R';
const view = q.get('view') ?? 'side';
/** How far back the thumb is (0..1): the size of the windup. */
const pull = Number(q.get('pull') ?? 0.5);
const w = getWindup(id);

type Shot = { label: string; u: number; t: number };
const shots: Shot[] = [
  ...[0, 0.25, 0.5, 0.78, 1].map((u) => ({ label: `u ${u}`, u, t: -1 })),
  ...[0.1, 0.2, 0.265, RELEASE_TIME, 0.42, 0.62, 0.8, 1.06, 1.26].map((t) => ({ label: `t ${t}`, u: 1, t })),
];
const only = q.get('shots');
const list = only ? only.split(',').map(Number).map((i) => shots[i]) : shots;

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
const cols = Math.min(list.length, Number(q.get('cols') ?? 6));
const rows = Math.ceil(list.length / cols);
const CW = Number(q.get('cw') ?? 300), CH = Number(q.get('ch') ?? 380);
renderer.setSize(cols * CW, rows * CH, false);
canvas.style.width = `${cols * CW}px`;
canvas.style.height = `${rows * CH}px`;
renderer.setScissorTest(true);
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#d9d2c2');
scene.add(new THREE.HemisphereLight('#fff6e6', '#8a7f6a', 1.25));
const sun = new THREE.DirectionalLight('#fff1d6', 2.2);
sun.position.set(-3, 6, 2);
sun.castShadow = true;
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: '#b8b09a', roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
// A stripe toward the target, and a mark at the feet.
const line = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 3), new THREE.MeshBasicMaterial({ color: '#8a8272' }));
line.rotation.x = -Math.PI / 2;
line.position.set(0, 0.002, -1.5);
scene.add(line);

const avatar = new Avatar([0, 0, 0], 0, hand, defaultStyle('filmstrip'), id);
scene.add(avatar.root);
const ball = buildBall();
scene.add(ball);
const rel = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 8), new THREE.MeshBasicMaterial({ color: '#d0342c' }));
scene.add(rel);

// (Wide enough for the longest stride and the steps back.)
const cam = new THREE.OrthographicCamera(-1.45, 1.45, 1.55, -1.3, 0.1, 50);
const side = hand === 'R' ? 1 : -1;
if (view === 'front') cam.position.set(0, 1.1, -8);
else if (view === 'back') cam.position.set(0, 1.1, 8);
else if (view === 'top') { cam.position.set(0, 9, -0.6); cam.up.set(0, 0, -1); }
else cam.position.set(8 * side, 1.1, -0.75);
cam.lookAt(view === 'top' ? new THREE.Vector3(0, 0, -0.6) : new THREE.Vector3(0, 1.1, view === 'side' ? -0.75 : 0));
if (view === 'top') { cam.top = 2.3; cam.bottom = -0.9; cam.updateProjectionMatrix(); }

function pose(s: Shot) {
  avatar.teleport([0, 0, 0], 0);
  const dt = 1 / 120;
  const base = { pose: { x: 0, z: 0, yaw: 0, g: [-0.2 * side, 1.18, -0.42] as [number, number, number] }, look: [0, 1.4, -14] as [number, number, number] };
  // Settle, wind up in real time, then (maybe) deliver.
  for (let i = 0; i < 90; i++) avatar.update(dt, { ...base, arm: Arm.Holding, charge: 0 });
  const steps = Math.max(1, Math.round((w.params.tempo * s.u) / dt));
  for (let i = 1; i <= steps; i++) avatar.update(dt, { ...base, arm: Arm.Windup, charge: (s.u * i) / steps, pull });
  if (s.t >= 0) {
    const n = Math.round(s.t / dt);
    for (let i = 0; i < n; i++) avatar.update(dt, { ...base, arm: Arm.Release, charge: 0, pull });
  }
  ball.position.copy(avatar.handBall);
  ball.visible = s.t < RELEASE_TIME + 0.001;
  const r = w.release;
  rel.position.set(r[0] * side, r[1], -r[2]);
  rel.visible = Math.abs(s.t - RELEASE_TIME) < 1e-3;
}

function draw() {
  list.forEach((s, i) => {
    pose(s);
    const cx = (i % cols) * CW, cy = (rows - 1 - Math.floor(i / cols)) * CH;
    renderer.setViewport(cx, cy, CW, CH);
    renderer.setScissor(cx, cy, CW, CH);
    renderer.render(scene, cam);
    // Run the clip out before the next figure.
    for (let k = 0; k < 220; k++) avatar.update(1 / 120, { pose: { x: 0, z: 0, yaw: 0, g: [-0.2 * side, 1.18, -0.42] }, arm: Arm.Idle, charge: 0, look: null });
  });
  (window as unknown as { __done: boolean }).__done = true;
}
draw();
