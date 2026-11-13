// Glove, bare throwing hand and baseball, built from primitives.

import * as THREE from 'three';
import { BALL_RADIUS } from '../../shared/constants';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** The leathers a glove is made of. */
export interface GloveColors { leather: string; dark: string; pocket: string; lace: string }
const TAN: GloveColors = { leather: '#b97a40', dark: '#8d5629', pocket: '#7a4720', lace: '#5a3417' };

function capsule(r: number, len: number, mat: THREE.Material, seg = 8) {
  return new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, seg), mat);
}

const smooth01 = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

/** Fine leather grain, shared by every glove (none where there is no canvas, as in the unit tests). */
let grainTex: THREE.CanvasTexture | null | undefined;
function leatherGrain(): THREE.CanvasTexture | null {
  if (grainTex !== undefined) return grainTex;
  if (typeof document === 'undefined') return (grainTex = null);
  const N = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#808080';
  g.fillRect(0, 0, N, N);
  // Pebbled pores and a few creases, drawn so the tile wraps.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 900; i++) {
    const x = rnd() * N, y = rnd() * N, r = 0.6 + rnd() * 1.7, v = rnd() < 0.55 ? 40 + rnd() * 50 : 160 + rnd() * 60;
    g.fillStyle = `rgba(${v},${v},${v},${0.25 + rnd() * 0.3})`;
    for (const ox of [-N, 0, N]) for (const oy of [-N, 0, N]) { g.beginPath(); g.arc(x + ox, y + oy, r, 0, 7); g.fill(); }
  }
  g.strokeStyle = 'rgba(40,40,40,0.22)';
  for (let i = 0; i < 14; i++) {
    const x = rnd() * N, y = rnd() * N, l = 10 + rnd() * 26, a = rnd() * 6.28;
    g.lineWidth = 0.6 + rnd();
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + (rnd() - 0.5) * 8, y + Math.sin(a) * l * 0.5 + (rnd() - 0.5) * 8, x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  return (grainTex = t);
}

/** Half-width of the palm at a height (0 heel .. 1 knuckles): narrow at the heel, full across the hand. */
const palmHalf = (v: number) => 0.078 + 0.03 * smooth01(v / 0.55) - 0.006 * smooth01((v - 0.8) / 0.2);
const PALM_Y0 = -0.118, PALM_Y1 = 0.078;
/** How far back the leather is at the bottom of the pocket: a caught ball sits in it, half hidden by the rim. */
const POCKET_DEPTH = 0.034;
/** The face of the glove, centre (0) to edge seam (1): down in the pocket, out to the padded rim, rolled back to the seam. */
const pocketZ = (r: number) => POCKET_DEPTH - (POCKET_DEPTH + 0.014) * smooth01(r / 0.86) + (r > 0.86 ? 0.026 * smooth01((r - 0.86) / 0.14) : 0);

/**
 * The body of the glove: one closed shell. The front is a real pocket (a bowl
 * a ball sits down into, with a rolled rim), the back is the rounded shell
 * over the back of the hand. Vertex colours darken the leather down into the
 * pocket, where it is worn.
 */
function palmShell(colors: GloveColors): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(1, 30, 22);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const cLeather = new THREE.Color(colors.leather), cPocket = new THREE.Color(colors.pocket), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const sx = pos.getX(i), sy = pos.getY(i), sz = pos.getZ(i);
    const v = (sy + 1) / 2;
    const y = PALM_Y0 + (PALM_Y1 - PALM_Y0) * v;
    // Flatten the poles a little so heel and knuckle line are broad, not pointed.
    const w = palmHalf(v) * Math.pow(Math.max(0, 1 - sy * sy), 0.32);
    const rr = Math.hypot(sx, sz) || 1;
    const x = (sx / rr) * w + 0.004;
    // r: 0 at the centre of the face, 1 at the edge seam.
    const ex = (sx / rr), r = Math.min(1, Math.hypot(ex * Math.sqrt(1 - sy * sy), sy));
    let z: number;
    if (sz < 0) {
      // Front: down into the pocket, up over the rolled rim, back to the seam.
      z = pocketZ(r) + 0.012 * (1 - v) * smooth01((r - 0.86) / 0.14);
      c.copy(cPocket).lerp(cLeather, smooth01((r - 0.3) / 0.5));
    } else {
      // Back: the shell over the hand.
      z = 0.012 + 0.05 * Math.sqrt(Math.max(0, 1 - r * r)) + 0.012 * (1 - v);
      c.copy(cLeather);
    }
    pos.setXYZ(i, x, y, z);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

/** A leather tube along a path (welting, binding, lace). */
function tube(points: THREE.Vector3[], r: number, mat: THREE.Material, closed = false, seg = 5) {
  const curve = new THREE.CatmullRomCurve3(points, closed, 'catmullrom', 0.5);
  return new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(8, points.length * 4), r, seg, closed), mat);
}

/** A row of stitches along a path: one draw call. */
function stitches(points: THREE.Vector3[], n: number, mat: THREE.Material, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points, closed, 'catmullrom', 0.5);
  const mesh = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.0016, 0.006, 2, 4), mat, n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    q.setFromUnitVectors(up, curve.getTangentAt(t));
    mesh.setMatrixAt(i, m.compose(curve.getPointAt(t), q, one));
  }
  return mesh;
}

/**
 * Fielder's glove for the LEFT hand. Origin is the pocket centre (the catch
 * point: a caught ball's centre is here, sunk in the leather). Pocket faces
 * -Z, fingers point +Y, and seen from behind (+Z) the thumb is on +X. The
 * hand goes in at the heel: the wrist is 0.088 down and 0.032 back. Mirror
 * with scale.x = -1 for a right-hand glove.
 */
export function buildGlove(colors: GloveColors = TAN): THREE.Group {
  const g = new THREE.Group();
  g.name = 'glove';
  const grain = leatherGrain();
  const leatherProps = { roughness: 0.58, metalness: 0, bumpMap: grain, bumpScale: 0.6 };
  const shellMat = new THREE.MeshStandardMaterial({ ...leatherProps, color: '#ffffff', vertexColors: true });
  const leather = new THREE.MeshStandardMaterial({ ...leatherProps, color: colors.leather });
  const leatherDark = new THREE.MeshStandardMaterial({ ...leatherProps, color: colors.dark, roughness: 0.64 });
  const laceMat = new THREE.MeshStandardMaterial({ color: colors.lace, roughness: 0.74 });
  const hole = new THREE.MeshStandardMaterial({ color: '#2a1c12', roughness: 1 });
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  // ---- the shell: pocket in front, the back of the hand behind
  const palm = new THREE.Mesh(palmShell(colors), shellMat);
  palm.name = 'palm';
  g.add(palm);

  // Binding rolled round the edge of the shell (what gives the glove its outline).
  const ring: THREE.Vector3[] = [];
  for (let i = 0; i <= 30; i++) {
    // Down the pinky side from the knuckles, round the heel, up the thumb side.
    const t = i / 30, sy = t < 0.5 ? 0.82 - (t / 0.5) * 1.8 : -0.98 + ((t - 0.5) / 0.5) * 1.8, side = t < 0.5 ? -1 : 1, v = (sy + 1) / 2;
    ring.push(V(side * palmHalf(v) * Math.pow(Math.max(0, 1 - sy * sy), 0.32) + 0.004, PALM_Y0 + (PALM_Y1 - PALM_Y0) * v, 0.012 + 0.012 * (1 - v)));
  }
  g.add(tube(ring, 0.0062, leatherDark, false, 6));

  // Stitching round the pocket, and the padded heel with its lace.
  const seam: THREE.Vector3[] = [];
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2, r = 0.7;
    const sy = Math.sin(a) * r, v = (sy + 1) / 2;
    seam.push(V(Math.cos(a) * r * palmHalf(v) / Math.max(0.3, Math.sqrt(1 - sy * sy)) * Math.pow(1 - sy * sy, 0.32) + 0.004, PALM_Y0 + (PALM_Y1 - PALM_Y0) * v, pocketZ(r) - 0.0014));
  }
  g.add(stitches(seam, 48, laceMat, true));
  const heel = capsule(0.017, 0.092, leatherDark, 8);
  heel.rotation.z = Math.PI / 2;
  heel.scale.set(1, 1, 1.5);
  heel.position.set(0.004, -0.103, 0.008);
  g.add(heel);
  const heelLace: THREE.Vector3[] = [];
  for (let i = 0; i < 9; i++) heelLace.push(V(-0.05 + i * 0.0135, -0.1 + (i % 2 ? 0.012 : -0.012), -0.0185));
  g.add(tube(heelLace, 0.0024, laceMat, false, 4));

  // ---- finger stalls: two joints each, so the glove closes the way leather folds
  const fingers = new THREE.Group();
  fingers.name = 'fingers';
  fingers.position.set(0, 0.062, 0.02);
  const tips = new THREE.Group();
  tips.name = 'tips';
  const KNUCKLE = 0.066;
  tips.position.set(0, KNUCKLE, 0);
  // Seen from behind: pinky on -X, index next to the thumb on +X.
  const xs = [-0.074, -0.027, 0.02, 0.064], lens = [0.094, 0.118, 0.124, 0.108], fan = [0.13, 0.045, -0.03, -0.1];
  const tipPts: THREE.Vector3[] = [];
  for (let i = 0; i < 4; i++) {
    const r = i === 0 ? 0.022 : 0.0238;
    const lower = capsule(r, KNUCKLE, leather, 8);
    lower.scale.z = 0.74;
    lower.position.set(xs[i], KNUCKLE * 0.42, 0);
    lower.rotation.z = fan[i] * 0.5;
    fingers.add(lower);
    const upper = capsule(r * 0.93, lens[i] - KNUCKLE, leather, 8);
    upper.scale.z = 0.72;
    const ux = xs[i] - Math.sin(fan[i]) * (lens[i] - KNUCKLE) * 0.5 - fan[i] * 0.02;
    upper.position.set(ux, (lens[i] - KNUCKLE) * 0.5 + 0.004, 0);
    upper.rotation.z = fan[i];
    tips.add(upper);
    tipPts.push(V(xs[i] - Math.sin(fan[i]) * (lens[i] - KNUCKLE) - fan[i] * 0.02, lens[i] - KNUCKLE + 0.006, 0));
    // Welting: the raised seam down the back of each stall.
    fingers.add(tube([V(xs[i], -0.01, r * 0.8), V(xs[i] - fan[i] * 0.01, KNUCKLE * 0.5, r * 0.84), V(xs[i] - fan[i] * 0.02, KNUCKLE, r * 0.8)], 0.0026, leatherDark, false, 4));
  }
  // Lace bridging one stall to the next, so the fingers read as one piece of leather.
  for (let i = 0; i < 3; i++) for (const y of [0.02, 0.05]) {
    const tie = capsule(0.0034, 0.02, laceMat, 4);
    tie.rotation.z = Math.PI / 2;
    tie.position.set((xs[i] + xs[i + 1]) / 2, y, -0.006);
    fingers.add(tie);
  }
  // The lace that ties the fingertips together.
  const lacePath: THREE.Vector3[] = [];
  tipPts.forEach((p, i) => { lacePath.push(V(p.x - 0.012, p.y - 0.012, -0.004), V(p.x + 0.012, p.y - 0.012, -0.004)); if (i < 3) lacePath.push(V((p.x + tipPts[i + 1].x) / 2, (p.y + tipPts[i + 1].y) / 2 - 0.02, 0.004)); });
  tips.add(tube(lacePath, 0.0032, laceMat, false, 4));
  fingers.add(tips);
  g.add(fingers);

  // ---- thumb stall: long, and set wide of the hand
  const thumb = new THREE.Group();
  thumb.name = 'thumb';
  thumb.position.set(0.084, -0.062, 0.016);
  const th0 = capsule(0.027, 0.084, leather, 8);
  th0.scale.z = 0.8;
  th0.position.set(0.02, 0.05, 0);
  th0.rotation.z = -0.4;
  thumb.add(th0);
  const th1 = capsule(0.0245, 0.07, leather, 8);
  th1.scale.z = 0.76;
  th1.position.set(0.054, 0.134, -0.002);
  th1.rotation.z = -0.26;
  thumb.add(th1);
  thumb.add(tube([V(0.004, 0.0, 0.0215), V(0.03, 0.07, 0.0225), V(0.062, 0.168, 0.018)], 0.0026, leatherDark, false, 4));
  g.add(thumb);

  // ---- the web: a leather basket laced between thumb and index finger
  const web = new THREE.Group();
  web.name = 'web';
  web.position.set(0.106, 0.094, 0.014);
  web.rotation.z = -0.24;
  for (const dx of [-0.016, 0.016]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.112, 0.007), leather);
    strip.position.set(dx, 0, 0);
    web.add(strip);
  }
  for (let i = 0; i < 3; i++) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.02, 0.0075), leatherDark);
    bar.position.set(0, -0.038 + i * 0.038, -0.003);
    web.add(bar);
  }
  const crown = capsule(0.0085, 0.056, leatherDark, 6);
  crown.rotation.z = Math.PI / 2;
  crown.position.set(0, 0.06, 0);
  web.add(crown);
  // Lace crosses down the middle of the web.
  const cross: THREE.Vector3[] = [];
  for (let i = 0; i < 9; i++) cross.push(V(i % 2 ? 0.0045 : -0.0045, 0.05 - i * 0.0125, -0.0075));
  web.add(tube(cross, 0.0019, laceMat, false, 4));
  g.add(web);

  // ---- the back: wrist strap, the opening for the hand, the index-finger slot
  const opening = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), hole);
  opening.scale.set(0.04, 0.02, 0.01);
  opening.position.set(0.0, -0.06, 0.067);
  g.add(opening);
  const strap = new THREE.Mesh(new THREE.BoxGeometry(0.128, 0.03, 0.012), leatherDark);
  strap.position.set(0.0, -0.086, 0.058);
  strap.rotation.x = -0.32;
  g.add(strap);
  const patch = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.004, 14), laceMat);
  patch.rotation.x = Math.PI / 2 - 0.32;
  patch.position.set(-0.03, -0.084, 0.0655);
  g.add(patch);
  g.add(stitches([V(-0.058, -0.074, 0.066), V(0, -0.0735, 0.068), V(0.058, -0.074, 0.066)], 16, laceMat));

  bake(g);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
  return g;
}

/**
 * Many small parts drawn one at a time cost more than their triangles do. Each
 * part of the glove that moves as one piece (the shell, the fingers, the
 * fingertips, the thumb, the web) is welded into one mesh per leather.
 */
function bake(group: THREE.Group) {
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const done: THREE.Mesh[] = [];
  for (const o of [...group.children]) {
    if ((o as THREE.Group).isGroup) { bake(o as THREE.Group); continue; }
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as unknown as THREE.InstancedMesh).isInstancedMesh || m.name || m.geometry.getAttribute('color')) continue;
    m.updateMatrix();
    const geo = m.geometry.clone().applyMatrix4(m.matrix);
    const list = byMat.get(m.material as THREE.Material) ?? [];
    list.push(geo);
    byMat.set(m.material as THREE.Material, list);
    done.push(m);
  }
  for (const m of done) { group.remove(m); m.geometry.dispose(); }
  for (const [mat, list] of byMat) {
    const merged = mergeGeometries(list, false);
    for (const geo of list) geo.dispose();
    if (merged) group.add(new THREE.Mesh(merged, mat));
  }
}

/**
 * Shape the glove. At rest (0) it is a cup: fingers curled a little over the
 * pocket, thumb turned in, the way a broken-in glove sits. Below zero it
 * opens wide to take a ball; at 1 it is shut around one. Values past 1 are a
 * squeeze (the snap overshoots, and the leather gives).
 */
export function setGloveClosure(glove: THREE.Object3D, k: number) {
  const d = glove.userData as { parts?: Record<string, THREE.Object3D | undefined> };
  const parts = (d.parts ??= Object.fromEntries(['fingers', 'tips', 'thumb', 'web', 'palm'].map((n) => [n, glove.getObjectByName(n)])));
  const { fingers, tips, thumb, web, palm } = parts;
  if (fingers) fingers.rotation.x = -0.16 - 0.4 * k;
  if (tips) tips.rotation.x = -0.24 - 0.62 * k;
  if (thumb) { thumb.rotation.y = 0.2 + 0.55 * k; thumb.rotation.x = -0.12 - 0.3 * k; }
  if (web) { web.rotation.x = -0.2 - 0.5 * k; web.rotation.y = 0.1 + 0.3 * k; }
  // Shut, the shell folds in round the ball a little.
  if (palm) { const sq = Math.max(0, k); palm.scale.set(1 - 0.07 * sq, 1, 1 + 0.1 * sq); }
}

/**
 * Bare throwing hand cradling a ball; origin at the ball centre. The ball sits
 * on the fingers with the palm under it, so the ball stays visible in the
 * hand. Wrist toward +Z. Mirror on x for a left hand.
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
  // A thin dark edge, so a white ball still reads against a bright evening sky and the haze under it.
  const edge = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS * 1.1, 16, 10), new THREE.MeshBasicMaterial({ color: '#2b1c14', side: THREE.BackSide, fog: false, toneMapped: false }));
  m.add(edge);
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
