// Validation tool: the catching positions as stills, so the body and the glove
// can be judged by eye (the numbers are checked in tests/unit/biomech.test.ts).
//
//   npm run dev:client, then open
//   /tests/visual/poses.html?view=front&hand=R     (view: front | side | top | eye)
//   &seq=far glove side>far across                 a move between two, frame by frame
//   &impact=1                                      a catch at centre chest, frame by frame
//
// Each figure is a real Avatar, updated the way the game updates it.

import * as THREE from 'three';
import { bodyToWorld, clampReach } from '../../src/shared/pose';
import { defaultStyle } from '../../src/shared/style';
import type { Vec3 } from '../../src/shared/vec';
import { Avatar } from '../../src/client/scene/avatar';
import { buildBall } from '../../src/client/scene/gear';
import { studioLight } from '../../src/client/scene/light';

const q = new URLSearchParams(location.search);
const hand = q.get('hand') === 'L' ? 'L' : 'R';
const view = q.get('view') ?? 'front';
const m = hand === 'R' ? 1 : -1;

/** Body space (right, up, forward), written for a right-hander (glove on the left hand). */
const POSITIONS: Record<string, Vec3> = {
  'centre chest': [-0.15, 1.25, 0.5],
  'above the head': [-0.1, 2.25, 0.3],
  'below the waist': [-0.15, 0.4, 0.6],
  'far glove side': [-0.95, 1.2, 0.3],
  'far across': [0.9, 1.2, 0.3],
  'across the body': [0.45, 1.1, 0.45],
  'fully extended': clampReach([-0.75, 1.95, 0.55], 0.98),
  'near the body': [-0.08, 1.1, 0.26],
};
const at = (name: string): Vec3 => { const p = POSITIONS[name]; return [p[0] * m, p[1], p[2]]; };
const BALL: Vec3 = [0, 1.9, -14];

type Shot = { label: string; run: (av: Avatar) => Vec3 };
const dt = 1 / 60;
const frame = (g: Vec3, extra: object = {}) => ({ pose: { x: 0, z: 0, yaw: 0, g: bodyToWorld(0, g) }, arm: 0, charge: 0, look: BALL, ready: true, ...extra });
const hold = (av: Avatar, g: Vec3, n: number, extra: object = {}) => { for (let i = 0; i < n; i++) av.update(dt, frame(g, extra)); };

let shots: Shot[];
const seq = q.get('seq');
if (q.get('impact')) {
  // A hard one into the chest: the frames around the catch.
  shots = [-1, 0, 1, 2, 4, 7, 11, 18].map((k) => ({
    label: k < 0 ? 'before' : `+${k} frames`,
    run: (av) => {
      const g = at('centre chest');
      hold(av, g, 90);
      if (k >= 0) { av.catchImpact([0, -2, 24], 24); hold(av, g, k, { gloved: true }); }
      return g;
    },
  }));
} else if (seq) {
  const [a, b] = seq.split('>');
  const A = at(a), B = at(b);
  shots = [0, 1, 2, 3, 4, 5, 6, 8, 12, 20].map((k) => ({
    label: `frame ${k}`,
    run: (av) => {
      hold(av, A, 60);
      let g = A;
      for (let i = 1; i <= k; i++) { const t = Math.min(1, i / 6); g = [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]; hold(av, g, 1); }
      return g;
    },
  }));
} else {
  shots = Object.keys(POSITIONS).map((name) => ({ label: name, run: (av) => { hold(av, at(name), 90); return at(name); } }));
}

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
const cols = Math.min(shots.length, Number(q.get('cols') ?? 4));
const rows = Math.ceil(shots.length / cols);
const CW = Number(q.get('cw') ?? 360), CH = Number(q.get('ch') ?? 440);
renderer.setPixelRatio(Number(q.get('dpr') ?? 2));
renderer.setSize(cols * CW, rows * CH, false);
canvas.style.width = `${cols * CW}px`;
canvas.style.height = `${rows * CH}px`;
renderer.setScissorTest(true);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#d9d2c2');
studioLight(renderer, scene);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshStandardMaterial({ color: '#b8b09a', roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const ball = buildBall();
scene.add(ball);

const ortho = new THREE.OrthographicCamera(-1.3, 1.3, 1.95, -1.23, 0.1, 50);
const persp = new THREE.PerspectiveCamera(74, CW / CH, 0.05, 60);
if (view === 'side') { ortho.position.set(-8 * m, 1.1, -0.2); ortho.lookAt(0, 1.1, -0.2); }
else if (view === 'top') { ortho.position.set(0, 9, -0.3); ortho.up.set(0, 0, -1); ortho.lookAt(0, 0, -0.3); ortho.top = 1.6; ortho.bottom = -1.57; ortho.updateProjectionMatrix(); }
else { ortho.position.set(0, 1.1, -8); ortho.lookAt(0, 1.1, 0); }

const label = document.createElement('div');
label.style.cssText = 'position:absolute;inset:0;pointer-events:none;font:600 13px system-ui;color:#3b352a';
document.body.appendChild(label);

shots.forEach((s, i) => {
  const av = new Avatar([0, 0, 0], 0, hand, defaultStyle('poses'), 34);
  scene.add(av.root);
  const g = s.run(av);
  // The ball on its way in, a stride out from the pocket (or in it, once caught).
  const gw = bodyToWorld(0, g);
  const caught = !!q.get('impact') && i > 0;
  const dir = new THREE.Vector3(BALL[0] - gw[0], BALL[1] - gw[1], BALL[2] - gw[2]).normalize();
  if (caught) ball.position.copy(av.joints.glove); else ball.position.set(gw[0], gw[1], gw[2]).addScaledVector(dir, 0.55);
  const col = i % cols, row = Math.floor(i / cols);
  const cx = col * CW, cy = (rows - 1 - row) * CH;
  renderer.setViewport(cx, cy, CW, CH);
  renderer.setScissor(cx, cy, CW, CH);
  let cam: THREE.Camera = ortho;
  if (view === 'eye') {
    // Your own eyes, the way the game looks out of them: a little back from the head.
    persp.position.copy(av.eye).add(new THREE.Vector3(0, 0.06, 0.24));
    persp.lookAt(gw[0] + dir.x * 0.5, gw[1] + dir.y * 0.5 + (1.5 - gw[1]) * 0.12, gw[2] + dir.z * 0.5);
    av.setCoreOpacity?.(0);
    cam = persp;
  }
  renderer.render(scene, cam);
  scene.remove(av.root);
  const tag = document.createElement('span');
  tag.textContent = s.label;
  tag.style.cssText = `position:absolute;left:${col * CW + 10}px;top:${row * CH + 8}px`;
  label.appendChild(tag);
});
(window as unknown as { __done: boolean }).__done = true;
