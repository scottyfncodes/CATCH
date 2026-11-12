// Authoring tool: the glove on its own, turned round, open, at rest and shut on a ball.
//
//   npm run dev:client, then open /tests/visual/glove.html?glove=0   (glove: index into GLOVES)

import * as THREE from 'three';
import { GLOVES } from '../../src/shared/style';
import { buildBall, buildGlove, setGloveClosure } from '../../src/client/scene/gear';
import { studioLight } from '../../src/client/scene/light';

const q = new URLSearchParams(location.search);
const colors = GLOVES[Number(q.get('glove') ?? 0)];
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
const views: [string, number, number, number, boolean][] = [
  ['pocket, open', Math.PI, 0.1, -0.5, false], ['three-quarter', Math.PI * 0.78, 0.25, 0, false], ['side', Math.PI / 2, 0.1, 0, false], ['back', 0, 0.15, 0, false],
  ['back three-quarter', -0.6, 0.35, 0, false], ['from above', Math.PI, 1.1, 0, false], ['ball in the pocket', Math.PI * 0.85, 0.3, 0.15, true], ['shut on it', Math.PI * 0.8, 0.3, 1, true],
];
const CW = 380, CH = 400, cols = 4, rows = 2;
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
const glove = buildGlove(colors);
scene.add(glove);
const ball = buildBall();
scene.add(ball);
const cam = new THREE.PerspectiveCamera(30, CW / CH, 0.05, 10);
views.forEach(([, az, el, k, withBall], i) => {
  setGloveClosure(glove, k);
  ball.visible = withBall;
  cam.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(0.85).add(new THREE.Vector3(0.01, 0.03, 0));
  cam.lookAt(0.01, 0.03, 0);
  const cx = (i % cols) * CW, cy = (rows - 1 - Math.floor(i / cols)) * CH;
  renderer.setViewport(cx, cy, CW, CH);
  renderer.setScissor(cx, cy, CW, CH);
  renderer.render(scene, cam);
});
(window as unknown as { __done: boolean }).__done = true;
