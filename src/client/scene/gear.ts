// Glove, bare throwing hand and baseball, built from primitives.

import * as THREE from 'three';
import { BALL_RADIUS } from '../../shared/constants';

const leather = new THREE.MeshStandardMaterial({ color: '#b97a40', roughness: 0.66, metalness: 0 });
const leatherDark = new THREE.MeshStandardMaterial({ color: '#8d5629', roughness: 0.72 });
const pocketMat = new THREE.MeshStandardMaterial({ color: '#7a4720', roughness: 0.85 });
const laceMat = new THREE.MeshStandardMaterial({ color: '#5a3417', roughness: 0.8 });

function capsule(r: number, len: number, mat: THREE.Material, seg = 8) {
  return new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, seg), mat);
}

/**
 * Fielder's glove for the LEFT hand. Origin is the pocket centre (the catch
 * point). Pocket faces -Z, fingers point +Y, and seen from behind (+Z) the
 * thumb is on +X. Mirror with scale.x = -1 for a right-hand glove.
 */
export function buildGlove(): THREE.Group {
  const g = new THREE.Group();
  g.name = 'glove';

  // Palm shell: a deep, rounded body.
  const palm = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 14), leather);
  palm.scale.set(1.05, 1.1, 0.52);
  palm.position.set(-0.005, -0.01, 0.02);
  g.add(palm);

  // The pocket: a dark bowl facing the ball.
  const pocket = new THREE.Mesh(new THREE.SphereGeometry(0.08, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2.3), pocketMat);
  pocket.rotation.x = Math.PI / 2;
  pocket.scale.set(1, 1.05, 0.42);
  pocket.position.set(0.0, 0.01, -0.016);
  g.add(pocket);

  // Heel roll along the bottom.
  const heel = capsule(0.036, 0.12, leatherDark);
  heel.rotation.z = Math.PI / 2;
  heel.position.set(-0.008, -0.1, 0.012);
  g.add(heel);

  // Finger stalls: fat, tightly packed, the part that snaps shut.
  const fingers = new THREE.Group();
  fingers.name = 'fingers';
  fingers.position.set(0, 0.055, 0.012);
  const lens = [0.105, 0.125, 0.12, 0.1];
  for (let i = 0; i < 4; i++) {
    const f = capsule(0.029, lens[i], i % 2 ? leather : leatherDark);
    f.position.set(-0.079 + i * 0.046, 0.075 + lens[i] * 0.3, 0);
    f.rotation.z = (i - 1.5) * 0.07;
    f.scale.z = 0.85;
    fingers.add(f);
  }
  // Laced binding across the fingertips.
  const binding = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.007, 5, 18, Math.PI * 0.9), laceMat);
  binding.position.set(-0.012, 0.11, 0.0);
  binding.rotation.z = Math.PI * 0.05;
  binding.scale.set(1.05, 0.55, 1);
  fingers.add(binding);
  g.add(fingers);

  // Thumb stall.
  const thumb = new THREE.Group();
  thumb.name = 'thumb';
  thumb.position.set(0.078, -0.03, 0.006);
  const th = capsule(0.03, 0.11, leatherDark);
  th.position.set(0.022, 0.06, 0);
  th.rotation.z = -0.38;
  th.scale.z = 0.85;
  thumb.add(th);
  g.add(thumb);

  // Laced web between thumb and index.
  const web = new THREE.Group();
  web.position.set(0.066, 0.12, -0.004);
  for (let i = 0; i < 3; i++) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.011, 0.01), laceMat);
    bar.position.y = -0.032 + i * 0.032;
    web.add(bar);
  }
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.011, 0.09, 0.012), laceMat);
  web.add(post);
  web.rotation.z = -0.28;
  g.add(web);

  // Back opening and wrist strap.
  const strap = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.032, 0.022), laceMat);
  strap.position.set(-0.004, -0.06, 0.062);
  strap.rotation.x = -0.2;
  g.add(strap);

  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
  return g;
}

/** Snap the glove closed (0..1). */
export function setGloveClosure(glove: THREE.Object3D, k: number) {
  const fingers = glove.getObjectByName('fingers');
  const thumb = glove.getObjectByName('thumb');
  if (fingers) fingers.rotation.x = -0.65 * k;
  if (thumb) thumb.rotation.y = 0.55 * k;
}

/**
 * Bare throwing hand cradling a ball; origin at the ball centre. The ball sits
 * on the fingers with the palm under it, so the ball stays fully visible from
 * first person. Wrist toward +Z. Mirror on x for a left hand.
 */
export function buildHand(skin: string): THREE.Group {
  const mat = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.62 });
  const g = new THREE.Group();
  const palm = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), mat);
  palm.scale.set(1.0, 0.42, 1.05);
  palm.position.set(0.0, -0.047, 0.026);
  g.add(palm);
  // Fingers curl up around the far side of the ball.
  for (let i = 0; i < 4; i++) {
    const f = capsule(0.0098, 0.038, mat, 6);
    const x = -0.027 + i * 0.018;
    f.position.set(x, -0.02, -0.03 + Math.abs(i - 1.5) * 0.004);
    f.rotation.set(-0.75, 0, -x * 4);
    g.add(f);
  }
  // Thumb along the near side.
  const thumb = capsule(0.011, 0.04, mat, 6);
  thumb.position.set(-0.042, -0.018, 0.02);
  thumb.rotation.set(0.5, 0, 0.9);
  g.add(thumb);
  const wrist = capsule(0.03, 0.09, mat, 8);
  wrist.rotation.x = Math.PI / 2 - 0.35;
  wrist.position.set(0.004, -0.07, 0.1);
  g.add(wrist);
  return g;
}

function ballTexture(): THREE.CanvasTexture {
  const W = 1024, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#f2ece0';
  g.fillRect(0, 0, W, H);
  // Subtle scuffs.
  for (let i = 0; i < 400; i++) {
    g.fillStyle = `rgba(150,130,100,${Math.random() * 0.06})`;
    g.fillRect(Math.random() * W, Math.random() * H, 2 + Math.random() * 10, 1 + Math.random() * 3);
  }
  // Seam: the classic two-lobe curve on the sphere.
  const a = 0.62, b = 0.38, c = 2 * Math.sqrt(a * b);
  const pts: [number, number][] = [];
  const N = 220;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2;
    let x = a * Math.cos(t) + b * Math.cos(3 * t);
    let y = a * Math.sin(t) - b * Math.sin(3 * t);
    let z = c * Math.sin(2 * t);
    const l = Math.hypot(x, y, z); x /= l; y /= l; z /= l;
    const lon = Math.atan2(x, z), lat = Math.asin(y);
    pts.push([((lon + Math.PI) / (Math.PI * 2)) * W, ((Math.PI / 2 - lat) / Math.PI) * H]);
  }
  g.strokeStyle = '#c23a2c';
  g.lineCap = 'round';
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    if (Math.abs(x1 - x0) > W / 2) continue;
    const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l, ny = dx / l;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(x0 + nx * 7 - dx * 0.3, y0 + ny * 7 - dy * 0.3); g.lineTo(x0, y0); g.lineTo(x0 - nx * 7 - dx * 0.3, y0 - ny * 7 - dy * 0.3);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

let ballTex: THREE.CanvasTexture | null = null;
export function buildBall(): THREE.Mesh {
  ballTex ??= ballTexture();
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_RADIUS, 24, 16),
    new THREE.MeshStandardMaterial({ map: ballTex, roughness: 0.55, emissive: '#ffffff', emissiveMap: ballTex, emissiveIntensity: 0.22 }),
  );
  m.castShadow = false;
  return m;
}

export function contactShadow(size = 1): THREE.Mesh {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(20,14,6,0.55)');
  gr.addColorStop(1, 'rgba(20,14,6,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 1;
  return m;
}
