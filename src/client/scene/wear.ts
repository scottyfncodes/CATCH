// What people wear: a real baseball cap to start with, and then, for keeping a
// streak going, increasingly ridiculous things. A propeller beanie. A rubber
// duck. A ten-gallon hat. A crown. A glove with googly eyes, a shark glove, a
// disco-ball glove, a glove on fire. A Hawaiian shirt and a lei, a tuxedo with
// tails, a superhero cape, a royal robe.
//
// All of it is for looking at: none of it changes the glove's size or where
// its pocket is, or anything about a throw.
//
// Things that move (a propeller, googly pupils, flames, a cape) are given a
// `Tick`, which the avatar calls once a frame after it has posed the body.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Glove, Hat, Top } from '../../shared/style';
import { GLOVE_SHAPE } from './gear';
import { torsoSurface } from './body';

export type Mat = (c: string, r?: number) => THREE.MeshStandardMaterial;

/** What moving things need to know, once a frame. */
export interface WearFrame {
  dt: number;
  /** Seconds since this person appeared. */
  t: number;
  /** How fast the body is moving over the ground (m/s), and which way (world). */
  speed: number;
  vel: THREE.Vector3;
  torso: THREE.Object3D;
  glove: THREE.Object3D;
}
export type Tick = (f: WearFrame) => void;

const smooth01 = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };
const hasDom = () => typeof document !== 'undefined';
const UP = new THREE.Vector3(0, 1, 0);
const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion();

function rand(seed: number) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

/** Colour every vertex of a geometry (pieces welded together and told apart by colour). */
function paint(g: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  if (n.getAttribute('uv')) n.deleteAttribute('uv');
  const c = new THREE.Color(color), k = n.attributes.position.count, a = new Float32Array(k * 3);
  for (let i = 0; i < k; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  n.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return n;
}
/** No rim light on this (thin things like thread catch it along their whole length and glow). */
function matte<T extends THREE.Material>(m: T): T {
  const d = m as THREE.Material & { defines?: Record<string, unknown> };
  if (d.defines?.RIM !== undefined) { d.defines = { ...d.defines }; delete d.defines.RIM; m.needsUpdate = true; }
  return m;
}
const shade = (hex: string, k: number) => `#${new THREE.Color(hex).multiplyScalar(k).getHexString()}`;

/** A grid surface from a function of (u, v) in [0, 1]². */
function surface(nu: number, nv: number, at: (u: number, v: number, out: THREE.Vector3) => void, uvs = true): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const p = new THREE.Vector3();
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    at(i / nu, j / nv, p);
    pos.push(p.x, p.y, p.z);
    uv.push(i / nu, 1 - j / nv);
    if (i < nu && j < nv) { const a = j * (nu + 1) + i, b = a + nu + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (uvs) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A thin round cord along a path (stitching, a seam, a hatband's edge). */
function cord(points: THREE.Vector3[], r: number, closed = false): THREE.BufferGeometry {
  const c = new THREE.CatmullRomCurve3(points, closed);
  return new THREE.TubeGeometry(c, Math.max(6, points.length * 3), r, 4, closed);
}

// ------------------------------------------------------------------ the cap

/** Crown of a six-panel cap: radius and height (head space; the head's own scale applies on top). */
const CAP_R = 0.124, CAP_H = 0.118;

/**
 * A point on the crown at angle `az` round it (0 = straight ahead, π/2 = the
 * wearer's right) and `t` up it, from the band (0) to the button (1). Upright
 * at the band and over the front (the panels there are stiffened), round over
 * the top: the profile of a structured cap, not a bowl.
 */
function capPoint(az: number, t: number, out: THREE.Vector3): THREE.Vector3 {
  const a = (t * Math.PI) / 2;
  const r = CAP_R * Math.pow(Math.cos(a), 0.68);
  const front = Math.max(0, Math.cos(az));
  const y = CAP_H * Math.pow(Math.sin(a), 0.92) * (1 + 0.07 * front * Math.sin(a));
  return out.set(Math.sin(az) * r * 0.95, y, -Math.cos(az) * r * (1.05 + 0.03 * front));
}
const capNormal = (az: number, t: number, out: THREE.Vector3) => {
  const a = capPoint(az + 0.01, t, new THREE.Vector3()).sub(capPoint(az - 0.01, t, new THREE.Vector3()));
  const b = capPoint(az, Math.min(1, t + 0.01), new THREE.Vector3()).sub(capPoint(az, Math.max(0, t - 0.01), new THREE.Vector3()));
  return out.crossVectors(b, a).normalize();
};

/**
 * The bill, in the crown's frame: its inner edge follows the band, it comes out
 * `L` in front and is `W` either side, it tips down and curves down at the
 * sides (a worn-in bill, not a flat one), and it is a few millimetres thick.
 */
function bill(W: number, L: number, top: string, under: string): { geo: THREE.BufferGeometry; at: (x: number, v: number) => THREE.Vector3 } {
  const Rx = CAP_R * 0.95, Rz = CAP_R * 1.08;
  const inner = (x: number) => Rz * Math.sqrt(Math.max(0, 1 - (x / Rx) ** 2)) - 0.004;
  const at = (x: number, v: number, lift = 0) => {
    const u = x / W;
    const d0 = inner(x), d = d0 + v * L * Math.sqrt(Math.max(0, 1 - u * u));
    const e = d - d0;
    return new THREE.Vector3(x, -e * 0.28 - 2.4 * x * x * Math.min(1, e / 0.025) + lift, -d);
  };
  const T = 0.0055;
  const make = (side: 1 | -1) => surface(20, 6, (u, v, o) => o.copy(at((u * 2 - 1) * W, v, side > 0 ? 0 : -T)), false);
  const topG = make(1), bot = make(-1);
  // (The underside faces down: turn its triangles over.)
  const ix = bot.index!;
  for (let i = 0; i < ix.count; i += 3) { const t = ix.getX(i + 1); ix.setX(i + 1, ix.getX(i + 2)); ix.setX(i + 2, t); }
  bot.computeVertexNormals();
  const edge = surface(40, 1, (u, v, o) => o.copy(at((u * 2 - 1) * W, 1, -v * T)), false);
  return { geo: mergeGeometries([paint(topG, top), paint(bot, under), paint(edge, top)])!, at: (x, v) => at(x, v, 0.0011) };
}

/**
 * A baseball cap, as one is made: six panels sewn into a crown, a seam down
 * each, an eyelet in each, a button on top, a stiffened front with the team's
 * letter on it, a curved bill with rows of stitching, and an adjustable strap
 * across an opening at the back.
 */
function buildCap(hat: Hat, mat: Mat): THREE.Group {
  const g = new THREE.Group();
  const crown = new THREE.Group();
  crown.position.y = 0.032;
  // Worn level-ish: the band rides a little higher at the forehead than at the back of the head.
  crown.rotation.x = 0.13;
  g.add(crown);
  // (Every piece is welded into one of two meshes, told apart by vertex colour: the cloth, which
  // catches the low sun like the rest of a person, and the thread and trim, which don't. Two draw calls a cap.)
  const lit: THREE.BufferGeometry[] = [], trim: THREE.BufferGeometry[] = [];
  const o = new THREE.Object3D();
  const put = (list: THREE.BufferGeometry[], geo: THREE.BufferGeometry, color: string | null, place?: (o: THREE.Object3D) => void) => {
    o.position.set(0, 0, 0); o.rotation.set(0, 0, 0); o.scale.set(1, 1, 1);
    place?.(o);
    o.updateMatrix();
    const placed = geo.clone().applyMatrix4(o.matrix);
    if (color) list.push(paint(placed, color));
    else { const n = placed.index ? placed.toNonIndexed() : placed; if (n.getAttribute('uv')) n.deleteAttribute('uv'); list.push(n); }
  };
  const facing = (at: THREE.Vector3, n: THREE.Vector3, off: number) => (x: THREE.Object3D) => { x.position.copy(at).addScaledVector(n, off); x.lookAt(tmpV.copy(x.position).add(n)); };
  put(lit, surface(36, 10, (u, v, out) => capPoint(u * Math.PI * 2, v, out)), hat.color);
  // Seams down every panel, and rows of stitching on the bill: thread a shade darker than the cloth.
  const thread = shade(hat.color, 0.55);
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  for (let k = 0; k < 6; k++) {
    const az = (k * Math.PI) / 3;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 10; i++) { const t = (i / 10) * 0.97; capPoint(az, t, p); capNormal(az, t, n); pts.push(p.clone().addScaledVector(n, 0.0012)); }
    put(trim, cord(pts, 0.0016), thread);
  }
  const b = bill(0.098, 0.084, hat.color, shade(hat.color, 0.5));
  put(lit, b.geo, null);
  for (const v of [0.42, 0.66, 0.9]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 16; i++) pts.push(b.at(((i / 16) * 2 - 1) * 0.092 * (1 - v * 0.15), v));
    put(trim, cord(pts, 0.0009), thread);
  }
  // Eyelets: a little vent near the top of each panel.
  for (let k = 0; k < 6; k++) {
    const az = ((k + 0.5) * Math.PI) / 3;
    capPoint(az, 0.72, p); capNormal(az, 0.72, n);
    put(trim, new THREE.TorusGeometry(0.0042, 0.0016, 4, 10), shade(hat.color, 0.45), facing(p, n, 0.001));
  }
  // The button.
  put(lit, new THREE.SphereGeometry(0.011, 10, 6), hat.color, (x) => { x.scale.y = 0.5; capPoint(0, 1, x.position); });
  // The back: an arched opening over an adjustable strap.
  capNormal(Math.PI, 0.05, n);
  capPoint(Math.PI, 0.0, p);
  put(trim, new THREE.CircleGeometry(0.036, 14, 0, Math.PI), '#14100d', (x) => { facing(p, n, 0.0016)(x); x.scale.y = 1.05; });
  capPoint(Math.PI, 0.05, p);
  put(lit, new THREE.BoxGeometry(0.078, 0.012, 0.003), hat.color, facing(p, n, 0.003));
  const cloth = mat('#ffffff', 0.92);
  cloth.vertexColors = true;
  cloth.side = THREE.DoubleSide;
  const thr = matte(mat('#ffffff', 0.85));
  thr.vertexColors = true;
  crown.add(new THREE.Mesh(mergeGeometries(lit)!, cloth), new THREE.Mesh(mergeGeometries(trim)!, thr));
  // The front: the game's own wordmark, CATCH., embroidered across the front panels (cream, the dot in stitch red).
  // (On a red cap a red dot would vanish into the cloth: there it's in the lettering's colour.)
  const hsl = new THREE.Color(hat.color).getHSL({ h: 0, s: 0, l: 0 });
  const reddish = (hsl.h < 0.05 || hsl.h > 0.95) && hsl.s > 0.35;
  const word = wordmark(hat.accent ?? '#efe6d2', reddish ? hat.accent ?? '#efe6d2' : '#c8372d');
  if (word) {
    const AZ = 0.6, T0 = 0.27, T1 = 0.5;
    const patch = surface(16, 4, (u, v, out) => {
      const az = AZ - u * AZ * 2, t = T1 - v * (T1 - T0);
      capPoint(az, t, out).addScaledVector(capNormal(az, t, n), 0.0018);
    });
    const ink = matte(mat('#ffffff', 0.8));
    ink.map = word;
    ink.alphaTest = 0.45;
    const decal = new THREE.Mesh(patch, ink);
    // (It lies on the cap: the cap's own shadow is the shadow.)
    decal.userData.noShadow = true;
    crown.add(decal);
  }
  if (hat.shape === 'back') g.rotation.y = Math.PI;
  return g;
}

/** CATCH. as embroidery: the home screen's wordmark (heavy, tight, the dot in stitch red), on a clear ground. */
const marks = new Map<string, THREE.CanvasTexture>();
function wordmark(ink: string, dot: string): THREE.CanvasTexture | null {
  if (!hasDom()) return null;
  const hit = marks.get(ink + dot);
  if (hit) return hit;
  const W = 512, H = 128;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;
  const font = (px: number) => `900 ${px}px -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif`;
  let px = 104;
  g.font = font(px);
  const ctx = g as CanvasRenderingContext2D & { letterSpacing?: string };
  ctx.letterSpacing = '-4px';
  const fit = () => g.measureText('CATCH').width + g.measureText('.').width;
  while (fit() > W * 0.9 && px > 40) { px -= 4; g.font = font(px); }
  const w1 = g.measureText('CATCH').width, total = fit();
  const x0 = (W - total) / 2, y = H * 0.74;
  // A thin darker edge, the way the stitching sits up off the cloth.
  g.lineJoin = 'round';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.strokeText('CATCH', x0, y);
  g.fillStyle = ink;
  g.fillText('CATCH', x0, y);
  g.strokeText('.', x0 + w1, y);
  g.fillStyle = dot;
  g.fillText('.', x0 + w1, y);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  marks.set(ink + dot, t);
  return t;
}

// ------------------------------------------------------------------ the silly hats

/** A propeller beanie: four bright panels, a little bill, and a propeller that spins faster when you run. */
function buildPropeller(mat: Mat): { group: THREE.Group; tick: Tick } {
  const g = new THREE.Group();
  const colors = ['#d8402f', '#f2c230', '#2f6fd8', '#3b9b4a'];
  const dome = surface(32, 8, (u, v, o) => {
    const az = u * Math.PI * 2, a = (v * Math.PI) / 2;
    const r = 0.127 * Math.cos(a);
    o.set(Math.sin(az) * r * 0.95, 0.03 + 0.122 * Math.sin(a), -Math.cos(az) * r * 1.04);
  }, false).toNonIndexed();
  {
    const pos = dome.attributes.position, col = new Float32Array(pos.count * 3), c = new THREE.Color();
    for (let i = 0; i < pos.count; i += 3) {
      // Colour each triangle by the quarter its middle is in.
      const x = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3, z = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
      const q = Math.floor(((Math.atan2(x, -z) + Math.PI * 2 + Math.PI / 4) % (Math.PI * 2)) / (Math.PI / 2));
      c.set(colors[q]);
      for (let k = 0; k < 3; k++) { col[(i + k) * 3] = c.r; col[(i + k) * 3 + 1] = c.g; col[(i + k) * 3 + 2] = c.b; }
    }
    dome.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const fabric = mat('#ffffff', 0.8);
  fabric.vertexColors = true;
  fabric.side = THREE.DoubleSide;
  g.add(new THREE.Mesh(dome, fabric));
  const b = bill(0.08, 0.04, '#2f6fd8', '#1d3f7a');
  const bm = mat('#ffffff', 0.7);
  bm.vertexColors = true;
  const billMesh = new THREE.Mesh(b.geo, bm);
  billMesh.position.y = 0.03;
  g.add(billMesh);
  const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.008, 0.05, 8), mat('#f4efe4', 0.5));
  stalk.position.y = 0.175;
  g.add(stalk);
  const prop = new THREE.Group();
  prop.position.y = 0.205;
  const hub = new THREE.Mesh(new THREE.SphereGeometry(0.014, 10, 8), mat('#f2c230', 0.35));
  prop.add(hub);
  for (const [sx, col] of [[1, '#d8402f'], [-1, '#2f6fd8']] as const) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.004, 0.036), mat(col, 0.35));
    blade.position.x = sx * 0.072;
    blade.rotation.x = sx * 0.38;
    prop.add(blade);
  }
  g.add(prop);
  let spin = 0;
  return { group: g, tick: (f) => { spin += f.dt * (5 + Math.min(4, f.speed) * 9); prop.rotation.y = spin; } };
}

/** A rubber duck, sitting on your head. It looks about. */
function buildDuck(mat: Mat): { group: THREE.Group; tick: Tick } {
  const g = new THREE.Group();
  const duck = new THREE.Group();
  duck.position.y = 0.152;
  g.add(duck);
  const rubber = mat('#ffd23a', 0.32);
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), rubber);
  body.scale.set(0.115, 0.085, 0.15);
  body.position.set(0, 0.075, 0.01);
  duck.add(body);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.09, 12), rubber);
  tail.position.set(0, 0.12, 0.14);
  tail.rotation.x = 0.95;
  duck.add(tail);
  for (const sx of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), rubber);
    wing.scale.set(0.022, 0.05, 0.085);
    wing.position.set(sx * 0.105, 0.085, 0.03);
    wing.rotation.x = -0.25;
    duck.add(wing);
  }
  const head = new THREE.Group();
  head.position.set(0, 0.17, -0.085);
  duck.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.07, 18, 12), rubber);
  head.add(skull);
  const beak = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 8), mat('#ff8a1e', 0.35));
  beak.scale.set(0.042, 0.016, 0.05);
  beak.position.set(0, -0.012, -0.07);
  head.add(beak);
  const eyeMat = mat('#1a1410', 0.2), glint = mat('#ffffff', 0.2);
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.013, 10, 8), eyeMat);
    eye.position.set(sx * 0.036, 0.016, -0.054);
    head.add(eye);
    const shine = new THREE.Mesh(new THREE.SphereGeometry(0.0045, 6, 4), glint);
    shine.position.set(sx * 0.039, 0.022, -0.065);
    head.add(shine);
  }
  // (Sitting this close to the head, its shadow on the hair is all hard, jagged edges: it doesn't cast one.)
  g.userData.noShadow = true;
  return {
    group: g,
    tick: (f) => {
      // Bobs along with you, rocks as you run, and keeps an eye on things.
      duck.rotation.z = Math.sin(f.t * 2.6) * 0.07;
      duck.rotation.x = Math.sin(f.t * 1.9) * 0.04 + Math.min(0.25, f.speed * 0.06);
      duck.position.y = 0.152 + Math.abs(Math.sin(f.t * 5.5)) * 0.01 * Math.min(1, f.speed);
      head.rotation.y = Math.sin(f.t * 0.6) * 0.55 + Math.sin(f.t * 1.7) * 0.15;
      head.rotation.x = Math.sin(f.t * 0.9 + 1) * 0.12;
    },
  };
}

/** A ten-gallon hat. It is far too big. */
function buildCowboy(hat: Hat, mat: Mat): THREE.Group {
  const g = new THREE.Group();
  g.position.y = 0.03;
  g.rotation.x = 0.08;
  const felt = mat(hat.color, 0.95);
  felt.side = THREE.DoubleSide;
  // The crown: tall, with a crease down the top and a pinch at the front.
  const profile: [number, number][] = [[0.134, -0.005], [0.134, 0.04], [0.127, 0.09], [0.115, 0.13], [0.098, 0.158], [0.07, 0.166], [0.04, 0.148], [0, 0.136]];
  const crown = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 28);
  const cp = crown.attributes.position;
  for (let i = 0; i < cp.count; i++) {
    let x = cp.getX(i) * 0.94, z = cp.getZ(i) * 1.12;
    const y = cp.getY(i);
    // Pinched at the front, and a crease down the middle of the top from front to back.
    if (z < 0) x *= 1 - 0.24 * smooth01((y - 0.07) / 0.08) * Math.min(1, -z / 0.12);
    const ridge = smooth01((y - 0.1) / 0.06);
    cp.setY(i, y - ridge * 0.03 * Math.exp(-((x / 0.04) ** 2)));
    cp.setX(i, x); cp.setZ(i, z);
  }
  crown.computeVertexNormals();
  g.add(new THREE.Mesh(crown, felt));
  // The brim: enormous, and curled up hard at the sides.
  const brimAt = (r: number, az: number, o: THREE.Vector3) => {
    const x = Math.sin(az) * r * 0.97, z = -Math.cos(az) * r * 1.1;
    const ax = Math.abs(x);
    return o.set(x, 1.9 * Math.max(0, ax - 0.11) ** 2 + 0.6 * Math.max(0, ax - 0.2) ** 2 - 0.035 * (z / 0.37) ** 2, z);
  };
  g.add(new THREE.Mesh(surface(56, 6, (u, v, o) => brimAt(0.122 + v * 0.23, u * Math.PI * 2, o)), felt));
  const edge: THREE.Vector3[] = [];
  for (let i = 0; i < 56; i++) edge.push(brimAt(0.352, (i / 56) * Math.PI * 2, new THREE.Vector3()));
  g.add(new THREE.Mesh(cord(edge, 0.004, true), mat(shade(hat.color, 0.6), 0.9)));
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.1375, 0.1385, 0.03, 28, 1, true), mat(hat.accent ?? '#3b2618', 0.6));
  band.scale.set(0.94, 1, 1.12);
  band.position.y = 0.018;
  g.add(band);
  const concho = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.004, 12), mat('#d9dde2', 0.25));
  concho.material.metalness = 1;
  concho.rotation.z = Math.PI / 2;
  concho.position.set(0.131, 0.018, 0.02);
  g.add(concho);
  return g;
}

/** A crown. Gold, jewels, pearls, velvet, an orb and a cross, and it twinkles. Worn at an angle. */
function buildCrown(hat: Hat, mat: Mat): { group: THREE.Group; tick?: Tick } {
  const g = new THREE.Group();
  g.position.set(0, 0.03, 0.005);
  g.rotation.z = 0.13;
  const gold = mat(hat.color, 0.26);
  gold.metalness = 1;
  gold.side = THREE.DoubleSide;
  const POINTS = 8;
  const wall = (u: number, v: number, o: THREE.Vector3) => {
    const az = u * Math.PI * 2;
    const tri = 1 - Math.abs(((u * POINTS) % 1) * 2 - 1);
    const top = 0.075 + 0.085 * tri ** 1.6;
    const y = v * top, k = 1 + 0.16 * v;
    return o.set(Math.sin(az) * 0.122 * k * 0.95, y, -Math.cos(az) * 0.122 * k * 1.04);
  };
  g.add(new THREE.Mesh(surface(POINTS * 8, 4, wall, false), gold));
  // A rolled rim round the bottom.
  const rim: THREE.Vector3[] = [];
  for (let i = 0; i < 40; i++) rim.push(wall(i / 40, 0, new THREE.Vector3()));
  g.add(new THREE.Mesh(cord(rim, 0.009, true), gold));
  // Velvet inside, rising to an orb and a cross.
  const velvet = new THREE.Mesh(new THREE.SphereGeometry(0.12, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat(hat.accent ?? '#b3122a', 0.95));
  velvet.scale.set(0.95, 1.25, 1.04);
  velvet.position.y = 0.035;
  g.add(velvet);
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 8), gold);
  orb.position.y = 0.205;
  g.add(orb);
  for (const [w, h] of [[0.008, 0.05], [0.032, 0.008]]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.008), gold);
    bar.position.y = 0.245;
    g.add(bar);
  }
  // A pearl on every point; a jewel under every point, round the band.
  const pearls: THREE.BufferGeometry[] = [], gems: THREE.BufferGeometry[] = [];
  const GEM = ['#c8102e', '#1d4ed8', '#14915a'];
  for (let k = 0; k < POINTS; k++) {
    const u = (k + 0.5) / POINTS;
    const tip = wall(u, 1, new THREE.Vector3());
    const pearl = new THREE.SphereGeometry(0.012, 8, 6);
    pearl.translate(tip.x, tip.y + 0.008, tip.z);
    pearls.push(pearl.toNonIndexed());
    const at = wall(u, 0.38, new THREE.Vector3());
    const gem = new THREE.OctahedronGeometry(0.015, 0);
    gem.scale(1, 1.2, 0.55);
    const out = tmpV.set(at.x, 0, at.z).normalize();
    gem.lookAt(out);
    gem.translate(at.x + out.x * 0.006, at.y, at.z + out.z * 0.006);
    gems.push(paint(gem, GEM[k % 3]));
  }
  g.add(new THREE.Mesh(mergeGeometries(pearls)!, mat('#f6f1e6', 0.18)));
  const gemMat = mat('#ffffff', 0.08);
  gemMat.vertexColors = true;
  gemMat.metalness = 0.3;
  gemMat.flatShading = true;
  g.add(new THREE.Mesh(mergeGeometries(gems)!, gemMat));
  // The twinkle: little stars that come and go on the points.
  const stars = sparkles(g, POINTS, (k) => wall((k + 0.5) / POINTS, 1, new THREE.Vector3()).add(new THREE.Vector3(0, 0.01, 0)), 0.05);
  return { group: g, tick: stars };
}

/** Little four-pointed stars that twinkle on and off at `count` places. One draw call each, and only on the things that sparkle. */
function sparkles(parent: THREE.Object3D, count: number, at: (k: number) => THREE.Vector3, size: number): Tick | undefined {
  if (!hasDom()) return undefined;
  const tex = starTexture();
  const list: THREE.Sprite[] = [];
  for (let k = 0; k < count; k++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: '#fff6d8', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false, toneMapped: false }));
    s.position.copy(at(k));
    s.scale.setScalar(0);
    parent.add(s);
    list.push(s);
  }
  const r = rand(17);
  const phase = list.map(() => r() * 10), rate = list.map(() => 0.35 + r() * 0.5);
  return (f) => list.forEach((s, k) => {
    const c = (f.t * rate[k] + phase[k]) % 1;
    const on = c < 0.18 ? Math.sin((c / 0.18) * Math.PI) : 0;
    s.scale.setScalar(size * on);
    s.material.rotation = f.t * 0.8 + k;
  });
}

let starTex: THREE.CanvasTexture | null = null;
function starTexture() {
  if (starTex) return starTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.18, 'rgba(255,255,255,0.6)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.beginPath();
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2, rr = i % 2 ? 6 : 32; g.lineTo(32 + Math.cos(a) * rr, 32 + Math.sin(a) * rr); }
  g.closePath(); g.fill();
  starTex = new THREE.CanvasTexture(cv);
  starTex.colorSpace = THREE.SRGBColorSpace;
  return starTex;
}

/** Does this hat sit over the hair (so the hair is cut to fit under it)? */
export const hatCovers = (shape: Hat['shape']) => shape === 'cap' || shape === 'back' || shape === 'propeller' || shape === 'cowboy' || shape === 'crown';

/** Whatever is on someone's head. */
export function buildHat(hat: Hat, mat: Mat): { group: THREE.Group; tick?: Tick } {
  switch (hat.shape) {
    case 'none': return { group: new THREE.Group() };
    case 'cap': case 'back': return { group: buildCap(hat, mat) };
    case 'propeller': return buildPropeller(mat);
    case 'duck': return buildDuck(mat);
    case 'cowboy': return { group: buildCowboy(hat, mat) };
    case 'crown': return buildCrown(hat, mat);
  }
}

// ------------------------------------------------------------------ gloves

/** Dress a glove up. The pocket, its size and where it is are not touched. */
export function decorateGlove(glove: THREE.Group, g: Glove): Tick | undefined {
  switch (g.extra) {
    case 'eyes': return googlyEyes(glove);
    case 'shark': sharkGlove(glove, g); return undefined;
    case 'disco': return discoGlove(glove);
    case 'fire': return fireGlove(glove);
    default: return undefined;
  }
}

/** Three googly eyes on the back of the glove. The pupils rattle round as it moves. */
function googlyEyes(glove: THREE.Group): Tick {
  const white = new THREE.MeshStandardMaterial({ color: '#fbfbf7', roughness: 0.3 });
  const black = new THREE.MeshStandardMaterial({ color: '#0d0d0d', roughness: 0.25 });
  const eyes = [[-0.03, 0.035, 0.027], [0.03, 0.028, 0.024], [0.002, -0.027, 0.017]].map(([x, y, r]) => {
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.007, 20), white);
    disc.rotation.x = Math.PI / 2;
    disc.position.set(x, y, 0.066);
    const pupil = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.48, r * 0.48, 0.003, 16), black);
    pupil.rotation.x = Math.PI / 2;
    pupil.position.set(x, y - r * 0.4, 0.0712);
    glove.add(disc, pupil);
    return { x, y, room: r * 0.5, pupil, p: new THREE.Vector2(0, -r * 0.4), v: new THREE.Vector2() };
  });
  const last = new THREE.Vector3(), lastV = new THREE.Vector3(), now = new THREE.Vector3(), acc = new THREE.Vector3();
  let started = false;
  return (f) => {
    const dt = Math.max(1e-3, f.dt);
    f.glove.getWorldPosition(now);
    if (!started) { last.copy(now); started = true; }
    const vel = tmpV.subVectors(now, last).divideScalar(dt);
    acc.subVectors(vel, lastV).divideScalar(dt).clampLength(0, 120);
    lastV.copy(vel); last.copy(now);
    // What the pupils feel, in the glove's own frame: gravity, and being left behind when the glove moves.
    f.glove.getWorldQuaternion(tmpQ).invert();
    const felt = new THREE.Vector3(0, -9.8, 0).sub(acc).applyQuaternion(tmpQ);
    for (const e of eyes) {
      e.v.x += felt.x * 0.06 * dt; e.v.y += felt.y * 0.06 * dt;
      e.v.multiplyScalar(Math.exp(-dt * 2.5));
      e.p.addScaledVector(e.v, dt);
      const l = e.p.length();
      if (l > e.room) {
        // Rattle off the rim.
        e.p.multiplyScalar(e.room / l);
        const nrm = e.p.clone().divideScalar(e.room), along = e.v.dot(nrm);
        if (along > 0) e.v.addScaledVector(nrm, -1.6 * along);
      }
      e.pupil.position.x = e.x + e.p.x;
      e.pupil.position.y = e.y + e.p.y;
    }
  };
}

/** A shark: the pocket is its mouth (pink, and full of teeth), there's a fin on the back, and it has eyes. */
function sharkGlove(glove: THREE.Group, g: Glove) {
  const { palmHalf, PALM_Y0, PALM_Y1, pocketZ } = GLOVE_SHAPE;
  const teeth: THREE.BufferGeometry[] = [];
  const cy = (PALM_Y0 + PALM_Y1) / 2;
  const N = 18;
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2, r = 0.9;
    const sy = Math.sin(a) * r, v = (sy + 1) / 2;
    const x = (Math.cos(a) * r * palmHalf(v)) / Math.max(0.3, Math.sqrt(1 - sy * sy)) * Math.pow(1 - sy * sy, 0.32) + 0.004;
    const y = PALM_Y0 + (PALM_Y1 - PALM_Y0) * v;
    const p = new THREE.Vector3(x, y, pocketZ(r) - 0.006);
    const dir = new THREE.Vector3(0.004 - x, cy - y, 0).normalize().multiplyScalar(0.75).add(new THREE.Vector3(0, 0, -0.65)).normalize();
    const tooth = new THREE.ConeGeometry(0.0075, 0.024, 4);
    tooth.translate(0, 0.012, 0);
    tooth.applyQuaternion(tmpQ.setFromUnitVectors(UP, dir));
    tooth.translate(p.x, p.y, p.z);
    teeth.push(tooth.toNonIndexed());
  }
  glove.add(new THREE.Mesh(mergeGeometries(teeth)!, new THREE.MeshStandardMaterial({ color: g.lace, roughness: 0.3 })));
  // The fin, standing up off the back of the hand.
  const shape = new THREE.Shape();
  shape.moveTo(0, -0.05);
  shape.lineTo(0, 0.03);
  shape.quadraticCurveTo(0.035, 0.0, 0.085, -0.045);
  shape.quadraticCurveTo(0.035, -0.038, 0, -0.05);
  const fin = new THREE.ExtrudeGeometry(shape, { depth: 0.01, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.003, bevelSegments: 2 });
  fin.translate(0, 0, -0.005);
  fin.rotateY(-Math.PI / 2);
  fin.translate(0, -0.005, 0.055);
  glove.add(new THREE.Mesh(fin, new THREE.MeshStandardMaterial({ color: g.dark, roughness: 0.55 })));
  const eye = new THREE.MeshStandardMaterial({ color: '#0d0d0d', roughness: 0.15 });
  for (const sx of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.011, 10, 8), eye);
    e.position.set(sx * 0.104 + 0.004, 0.0, 0.012);
    glove.add(e);
  }
}

/** A disco ball: every piece of the glove is little mirrors, and it glitters. */
function discoGlove(glove: THREE.Group): Tick | undefined {
  const mirror = new THREE.MeshStandardMaterial({ color: '#f4f6f9', metalness: 0.85, roughness: 0.12, flatShading: true, emissive: '#4a4f58', envMapIntensity: 2.2 });
  if (hasDom()) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const c = cv.getContext('2d')!;
    const r = rand(5);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const l = 62 + r() * 38; c.fillStyle = `hsl(210, 8%, ${l}%)`; c.fillRect(x * 8, y * 8, 8, 8); }
    c.strokeStyle = 'rgba(40,44,52,0.85)';
    for (let i = 0; i <= 8; i++) { c.beginPath(); c.moveTo(i * 8, 0); c.lineTo(i * 8, 64); c.moveTo(0, i * 8); c.lineTo(64, i * 8); c.stroke(); }
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(4, 4);
    t.colorSpace = THREE.SRGBColorSpace;
    mirror.map = t;
  }
  glove.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.material = mirror; });
  const r = rand(9);
  return sparkles(glove, 10, () => new THREE.Vector3((r() - 0.5) * 0.22, -0.11 + r() * 0.32, (r() - 0.3) * 0.14), 0.09);
}

/** On fire. Flames off the back, the fingertips and the heel, flickering, always going up. */
function fireGlove(glove: THREE.Group): Tick | undefined {
  if (!hasDom()) return undefined;
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 128;
  const c = cv.getContext('2d')!;
  // A tongue of flame: white-hot at its root, orange, then red, then gone.
  const img = c.createImageData(64, 128);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 64; x++) {
    const u = (x - 32) / 32, v = 1 - y / 127;
    const w = 0.85 * Math.pow(1 - v, 0.55) * (0.7 + 0.3 * Math.sin(v * 9));
    const inside = Math.max(0, 1 - Math.abs(u) / Math.max(0.02, w));
    const a = Math.pow(inside, 1.4) * smooth01((1 - v) / 0.95) * smooth01(v / 0.06);
    const heat = Math.pow(inside, 2) * (1 - v);
    const i = (y * 64 + x) * 4;
    img.data[i] = 255; img.data[i + 1] = Math.round(70 + 185 * Math.min(1, heat * 1.6)); img.data[i + 2] = Math.round(40 + 200 * Math.max(0, heat - 0.55) * 2);
    img.data[i + 3] = Math.round(255 * a);
  }
  c.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const spots: [number, number, number, number][] = [[0, -0.03, 0.075, 0.22], [-0.05, 0.03, 0.07, 0.19], [0.05, 0.025, 0.07, 0.17], [-0.07, 0.19, 0.0, 0.17], [0.0, 0.21, 0.0, 0.21], [0.06, 0.19, 0.0, 0.16], [0.0, -0.12, 0.05, 0.15], [0.1, -0.02, 0.02, 0.13], [-0.1, -0.03, 0.02, 0.13]];
  const flames = spots.map(([x, y, z, s]) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false, toneMapped: false, opacity: 0.95 }));
    sp.center.set(0.5, 0.08);
    sp.position.set(x, y, z);
    glove.add(sp);
    return { sp, s };
  });
  return (f) => flames.forEach(({ sp, s }, k) => {
    const flick = 1 + 0.28 * Math.sin(f.t * 13 + k * 1.7) + 0.16 * Math.sin(f.t * 23.7 + k * 2.9) + Math.min(0.5, f.speed * 0.1);
    sp.scale.set(s * 0.55 * (1 + 0.1 * Math.sin(f.t * 17 + k)), s * flick, 1);
    sp.material.rotation = Math.sin(f.t * 6 + k) * 0.12;
  });
}

// ------------------------------------------------------------------ clothes

/** A shirt's pattern, painted on a strip that goes round the body (u = 0.5 straight ahead) from the hem (bottom) to the collar (top). */
function shirtTexture(top: Top): THREE.CanvasTexture | null {
  if (!hasDom()) return null;
  const W = 512, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;
  const r = rand(top.pattern.length * 31 + 7);
  // (Things that cross the left or right edge are drawn twice, so the shirt has no seam down the back.)
  const both = (draw: (dx: number) => void) => { draw(0); draw(-W); draw(W); };
  g.fillStyle = top.color;
  g.fillRect(0, 0, W, H);
  if (top.pattern === 'hawaiian') {
    for (let i = 0; i < 26; i++) {
      const x = r() * W, y = r() * H, s = 14 + r() * 14, a = r() * 6.28;
      both((dx) => {
        g.save(); g.translate(x + dx, y); g.rotate(a);
        // Leaves first, then a hibiscus over them.
        g.fillStyle = r() < 0.5 ? '#2f7d3b' : '#3f9a48';
        for (const la of [0.6, -0.9, 2.4]) { g.save(); g.rotate(la); g.beginPath(); g.ellipse(s * 1.25, 0, s * 1.1, s * 0.38, 0, 0, 7); g.fill(); g.restore(); }
        const petal = ['#ffd25a', '#ff9ac1', '#fff4e0', '#ffb347'][i % 4];
        g.fillStyle = petal;
        for (let k = 0; k < 5; k++) { g.save(); g.rotate((k / 5) * Math.PI * 2); g.beginPath(); g.ellipse(s * 0.55, 0, s * 0.55, s * 0.36, 0, 0, 7); g.fill(); g.restore(); }
        g.fillStyle = '#b3122a'; g.beginPath(); g.arc(0, 0, s * 0.22, 0, 7); g.fill();
        g.strokeStyle = '#ffe9a8'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(0, 0); g.lineTo(s * 0.6, -s * 0.2); g.stroke();
        g.restore();
      });
    }
  } else if (top.pattern === 'tux') {
    const cx = W / 2;
    // The shirt front in the V, satin lapels along it, studs, the jacket's buttons, and a pocket square.
    const v = (k: number) => H * (1 - k);
    g.fillStyle = '#f7f4ee';
    g.beginPath(); g.moveTo(cx - 0.085 * W, v(1)); g.lineTo(cx + 0.085 * W, v(1)); g.lineTo(cx, v(0.42)); g.closePath(); g.fill();
    g.strokeStyle = '#34343c'; g.lineWidth = 16;
    g.beginPath(); g.moveTo(cx - 0.1 * W, v(1)); g.lineTo(cx, v(0.4)); g.lineTo(cx + 0.1 * W, v(1)); g.stroke();
    g.fillStyle = '#111';
    for (const k of [0.82, 0.72, 0.62]) { g.beginPath(); g.arc(cx, v(k), 3.5, 0, 7); g.fill(); }
    g.fillStyle = '#2b2b31';
    for (const k of [0.32, 0.2]) { g.beginPath(); g.arc(cx, v(k), 5, 0, 7); g.fill(); }
    const px = cx + 0.11 * W, py = v(0.72);
    g.fillStyle = top.accent ?? '#d81e3a';
    g.beginPath(); g.moveTo(px - 16, py); g.lineTo(px - 6, py - 18); g.lineTo(px + 2, py - 6); g.lineTo(px + 10, py - 20); g.lineTo(px + 18, py); g.closePath(); g.fill();
    g.strokeStyle = '#f7f4ee'; g.lineWidth = 3; g.beginPath(); g.moveTo(px - 20, py); g.lineTo(px + 22, py); g.stroke();
  } else if (top.pattern === 'hero') {
    const cx = W / 2, cyy = H * 0.3;
    // The belt.
    g.fillStyle = '#f2c230'; g.fillRect(0, H * 0.88, W, H * 0.08);
    g.fillStyle = '#c99a12'; g.fillRect(cx - 14, H * 0.875, 28, H * 0.09);
    // The emblem: a diamond, with a baseball's C in it.
    g.fillStyle = '#f2c230'; g.strokeStyle = top.accent ?? '#e43a2f'; g.lineWidth = 9;
    g.beginPath(); g.moveTo(cx, cyy - 62); g.lineTo(cx + 54, cyy); g.lineTo(cx, cyy + 62); g.lineTo(cx - 54, cyy); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = top.accent ?? '#e43a2f';
    g.font = '900 72px Arial Black, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('C', cx, cyy + 4);
  } else if (top.pattern === 'robe') {
    // Velvet, with a sheen; gold braid down the front and round the hem.
    for (let i = 0; i < 2500; i++) { g.fillStyle = `rgba(${r() < 0.5 ? '255,200,210' : '40,0,10'},${0.04 + r() * 0.06})`; g.fillRect(r() * W, r() * H, 1 + r() * 3, 2 + r() * 8); }
    g.fillStyle = '#e8b923';
    g.fillRect(W / 2 - 7, 0, 14, H);
    g.fillRect(0, H - 14, W, 14);
    g.fillStyle = '#fff3b0';
    for (let y = 6; y < H; y += 18) { g.beginPath(); g.arc(W / 2, y, 3, 0, 7); g.fill(); }
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** Ermine: white fur with the little black tails on it. */
function ermineTexture(base = '#f6f3ec'): THREE.CanvasTexture | null {
  if (!hasDom()) return null;
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 128;
  const g = cv.getContext('2d')!;
  g.fillStyle = base; g.fillRect(0, 0, 256, 128);
  const r = rand(3);
  for (let i = 0; i < 700; i++) { g.fillStyle = `rgba(200,190,175,${0.15 + r() * 0.2})`; g.fillRect(r() * 256, r() * 128, 1, 3 + r() * 4); }
  g.fillStyle = '#141210';
  for (let y = 14; y < 128; y += 32) for (let x = (y / 32) % 2 ? 22 : 6; x < 256; x += 32) {
    g.beginPath(); g.moveTo(x, y - 7); g.quadraticCurveTo(x + 5, y + 2, x, y + 9); g.quadraticCurveTo(x - 5, y + 2, x, y - 7); g.fill();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/**
 * A cape (or a coat's tails): cloth hanging from a line across the back. It
 * hangs straight down whichever way the body leans, streams out behind when
 * you run, and ripples. Its shape is worked out on the CPU each frame (a few
 * dozen points), in the trunk's frame.
 */
class Cape {
  readonly mesh: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private theta = 0.2;
  private thetaV = 0;
  private dir = new THREE.Vector3();
  constructor(mat: THREE.Material, private w: number, private L: number, private at: THREE.Vector3, private wrap: number, private cols = 6, private rows = 10, private flare = 0.35) {
    this.geo = new THREE.PlaneGeometry(w, L, cols, rows);
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
  }
  tick(f: WearFrame) {
    // Which way is down for the cloth, in the trunk's frame: straight down, and away from the way you're going.
    f.torso.getWorldQuaternion(tmpQ).invert();
    // (Running leans the trunk forward, which takes back most of what the wind gives: the cloth has to catch plenty.)
    this.dir.set(0, -1, 0).addScaledVector(f.vel, -0.32).normalize().applyQuaternion(tmpQ);
    const want = Math.min(1.45, Math.max(0.1, Math.atan2(this.dir.z, -this.dir.y)));
    const dt = Math.min(0.05, f.dt);
    this.thetaV += ((want - this.theta) * 60 - this.thetaV * 9) * dt;
    this.theta += this.thetaV * dt;
    const pos = this.geo.attributes.position as THREE.BufferAttribute;
    const flutter = 0.012 + Math.min(0.04, f.speed * 0.012);
    for (let j = 0; j <= this.rows; j++) {
      const s = j / this.rows;
      // Bend a little more the further down the cloth.
      let y = 0, z = 0;
      for (let k = 1; k <= j; k++) {
        const sk = k / this.rows, a = 0.06 + (this.theta - 0.06) * Math.pow(sk, 0.6);
        y -= Math.cos(a) * (this.L / this.rows); z += Math.sin(a) * (this.L / this.rows);
      }
      for (let i = 0; i <= this.cols; i++) {
        const xn = i / this.cols - 0.5;
        const x = xn * this.w * (1 + this.flare * s);
        const ripple = Math.sin(f.t * 6.5 - s * 7 + xn * 9) * flutter * s;
        const round = -this.wrap * (xn * 2) ** 2 * (1 - s) ** 2;
        pos.setXYZ(j * (this.cols + 1) + i, this.at.x + x, this.at.y + y, this.at.z + z + ripple + round);
      }
    }
    pos.needsUpdate = true;
    this.geo.computeVertexNormals();
  }
}

/** What dressing up adds: the body's own materials get the pattern; anything extra hangs off the trunk. */
export interface Outfit { ticks: Tick[]; sleeve: THREE.Texture | null; collar: string }

/**
 * Put a costume on: a printed shirt and whatever goes with it. `torso` is the
 * trunk (0 at the belt); `chest` is the shirt's material, `core` makes
 * materials that fade away in first person.
 */
export function dress(top: Top, torso: THREE.Object3D, chest: THREE.MeshStandardMaterial, core: Mat, w: number): Outfit {
  const out: Outfit = { ticks: [], sleeve: null, collar: shade(top.color, 0.8) };
  if (top.pattern === 'plain') return out;
  const tex = shirtTexture(top);
  if (tex) { chest.map = tex; chest.color.set('#ffffff'); chest.needsUpdate = true; }
  const at = (y: number, a: number, lift: number) => { const p = torsoSurface(y, a, w); const n = new THREE.Vector3(p.x, 0, p.z).normalize(); return p.addScaledVector(n, lift); };
  const cape = (mat: THREE.MeshStandardMaterial, width: number, len: number, y: number, x = 0, wrap = 0.06, rows = 10, flare = 0.35) => {
    mat.side = THREE.DoubleSide;
    const c = new Cape(mat, width, len, new THREE.Vector3(x, y, at(y, Math.PI, 0.012).z), wrap, 6, rows, flare);
    torso.add(c.mesh);
    out.ticks.push((f) => c.tick(f));
  };
  if (top.pattern === 'hawaiian') {
    out.sleeve = tex;
    out.collar = top.accent ?? '#ffd25a';
    // A lei: a garland of flowers round the neck, down over the chest.
    const parts: THREE.BufferGeometry[] = [];
    const N = 30, cols = ['#ff7fb0', '#ffd25a', '#fff4e0', '#ff8a3d', '#d6336c'];
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2;
      const y = 0.592 - 0.2 * ((1 + Math.cos(a)) / 2) ** 3;
      const p = at(y, a, 0.016);
      const bloom = new THREE.IcosahedronGeometry(0.021, 0);
      bloom.scale(1, 0.85, 1);
      bloom.rotateY(a * 3.1);
      bloom.translate(p.x, p.y, p.z);
      parts.push(paint(bloom, cols[k % cols.length]));
    }
    const lei = core('#ffffff', 0.6);
    lei.vertexColors = true;
    lei.flatShading = true;
    torso.add(new THREE.Mesh(mergeGeometries(parts)!, lei));
  } else if (top.pattern === 'tux') {
    out.collar = '#f7f4ee';
    // A bow tie, much too big, in red; a rose in the lapel; and tails.
    const red = core(top.accent ?? '#d81e3a', 0.35);
    const bow = new THREE.Group();
    bow.position.copy(at(0.566, 0, 0.012));
    for (const sx of [-1, 1]) {
      const lobe = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.065, 4), red);
      lobe.rotation.z = sx * Math.PI / 2;
      lobe.scale.set(1, 1, 0.45);
      lobe.position.x = sx * 0.034;
      bow.add(lobe);
    }
    bow.add(new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 6), red));
    torso.add(bow);
    const rose = new THREE.Group();
    rose.position.copy(at(0.45, -0.5, 0.012));
    const petals = core('#c1122f', 0.5);
    for (let k = 0; k < 5; k++) { const p = new THREE.Mesh(new THREE.SphereGeometry(0.011, 6, 5), petals); const a = (k / 5) * Math.PI * 2; p.position.set(Math.cos(a) * 0.008, Math.sin(a) * 0.008, -0.004); rose.add(p); }
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(1, 6, 4), core('#2f7d3b', 0.6));
    leaf.scale.set(0.006, 0.018, 0.004); leaf.position.set(0.004, -0.02, 0); leaf.rotation.z = 0.5;
    rose.add(leaf);
    torso.add(rose);
    for (const sx of [-1, 1]) cape(core(top.color, 0.7), 0.12, 0.52, 0.02, sx * 0.068, 0.0, 8, 0.15);
  } else if (top.pattern === 'hero') {
    out.collar = top.accent ?? '#e43a2f';
    cape(core(top.accent ?? '#e43a2f', 0.6), 0.46, 1.0, 0.535, 0, 0.08);
  } else if (top.pattern === 'robe') {
    out.sleeve = tex;
    out.collar = '#e8b923';
    // An ermine mantle over the shoulders, and a train to the ground.
    const fur = core('#ffffff', 0.95);
    fur.map = ermineTexture();
    fur.side = THREE.DoubleSide;
    const prof: [number, number][] = [[0.07, 0.605], [0.14, 0.59], [0.215, 0.555], [0.255, 0.505], [0.27, 0.44], [0.262, 0.395]];
    const mantle = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 22);
    mantle.scale(1.12 * w, 1, 0.78 * w);
    torso.add(new THREE.Mesh(mantle, fur));
    const train = core('#ffffff', 0.9);
    if (hasDom()) {
      const cv = document.createElement('canvas');
      cv.width = 64; cv.height = 256;
      const g = cv.getContext('2d')!;
      g.fillStyle = top.color; g.fillRect(0, 0, 64, 256);
      g.fillStyle = '#e8b923'; g.fillRect(0, 214, 64, 6);
      const e = ermineTexture()!.image as HTMLCanvasElement;
      g.drawImage(e, 0, 0, 128, 64, 0, 220, 64, 36);
      const t = new THREE.CanvasTexture(cv);
      t.colorSpace = THREE.SRGBColorSpace;
      train.map = t;
    } else train.color.set(top.color);
    cape(train, 0.56, 1.32, 0.5, 0, 0.1, 12, 0.6);
  }
  return out;
}
