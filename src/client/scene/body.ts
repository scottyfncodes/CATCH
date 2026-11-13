// The shapes a person is made of. Each is built once and shared by everyone:
// a torso with shoulders and a waist, limbs with some muscle on them, a head
// with a jaw, a pair of sneakers. They are rigid pieces hung on the joints the
// body solver places (see avatar.ts); nothing here moves.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const cache = new Map<string, THREE.BufferGeometry>();
function once(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = cache.get(key);
  if (!g) cache.set(key, (g = make()));
  return g;
}

const smooth01 = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

/** A surface of revolution through (radius, height) points, bottom to top, closed at both ends. */
function lathe(points: [number, number][], radial: number, openBottom = false): THREE.BufferGeometry {
  const pts = [...(openBottom ? [] : [new THREE.Vector2(0, points[0][1])]), ...points.map(([r, y]) => new THREE.Vector2(r, y)), new THREE.Vector2(0, points[points.length - 1][1])];
  return new THREE.LatheGeometry(pts, radial);
}

/** Paint a geometry one colour (for pieces that are welded together and told apart by vertex colour). */
function paint(g: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const c = new THREE.Color(color), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

const plain = (g: THREE.BufferGeometry) => { const n = g.index ? g.toNonIndexed() : g; n.deleteAttribute('uv'); return n; };

/**
 * A limb segment: one unit long from its upper joint (the origin) along +Y, so
 * the solver can stretch it to the bone's true length. `profile` is (radius,
 * fraction along the bone).
 */
export function limbGeo(key: string, profile: [number, number][], radial = 10): THREE.BufferGeometry {
  return once('limb:' + key, () => lathe(profile, radial));
}

/**
 * How big round a joint is (m, for a medium build). The two pieces that meet
 * at a joint both end exactly on it at this radius, and a ball of the same
 * radius sits there: however far it bends, the outline stays one smooth curve.
 */
export const KNEE = 0.063, ELBOW = 0.04, SHOULDER = 0.053;

/** The ball in a joint. */
export function jointGeo(r: number): THREE.BufferGeometry {
  // (A hair inside the pieces it joins: two surfaces in exactly the same place shimmer.)
  return once('joint:' + r.toFixed(4), () => new THREE.SphereGeometry(r * 0.965, 14, 10));
}

/** The limbs of one build (`w` scales thickness only: joints stay where they are). */
export function limbs(w: number) {
  const k = w.toFixed(2);
  const s = (p: [number, number][]) => p.map(([r, y]) => [r * w, y] as [number, number]);
  return {
    // Hip to knee: full at the top, tapering to the knee.
    thigh: limbGeo('thigh' + k, s([[0.07, -0.04], [0.09, 0.04], [0.092, 0.22], [0.082, 0.55], [0.067, 0.88], [KNEE, 1]])),
    // Knee to just above the ankle: the calf, then a trouser leg that hangs straight to its cuff (the sock shows below it).
    shin: limbGeo('shin' + k, s([[KNEE, 0], [0.067, 0.1], [0.069, 0.3], [0.061, 0.6], [0.056, 0.8], [0.058, 0.86], [0.05, 0.868]])),
    // Shoulder to just above the elbow: a T-shirt sleeve, a little loose, with a hem.
    sleeve: limbGeo('sleeve' + k, s([[SHOULDER, 0], [0.055, 0.18], [0.054, 0.48], [0.056, 0.58], [0.05, 0.595]])),
    // The arm coming out of it, down to the elbow.
    upperArm: limbGeo('upper' + k, s([[0.043, 0.3], [0.047, 0.5], [0.044, 0.8], [ELBOW, 1]])),
    // Elbow to wrist: fuller below the elbow, fine at the wrist.
    forearm: limbGeo('fore' + k, s([[ELBOW, 0], [0.044, 0.14], [0.043, 0.35], [0.034, 0.8], [0.029, 1.0], [0.027, 1.02]])),
  };
}

/** Half the width of the torso's round at a height (m, before the body's own width is applied). `y` is in the trunk's frame: 0 at the belt. */
export function torsoRadius(y: number): number {
  const P = TORSO;
  if (y <= P[0][1]) return P[0][0];
  for (let i = 1; i < P.length; i++) if (y <= P[i][1]) { const t = (y - P[i - 1][1]) / (P[i][1] - P[i - 1][1]); return P[i - 1][0] + (P[i][0] - P[i - 1][0]) * t; }
  return P[P.length - 1][0];
}
/** The shirt, hem to collar: a little loose at the hem (which stops at the belt, clear of the legs), in at the waist, out to the chest and shoulders, up to the neck. */
const TORSO: [number, number][] = [[0.157, -0.022], [0.16, 0.0], [0.153, 0.06], [0.149, 0.14], [0.16, 0.26], [0.172, 0.37], [0.176, 0.44], [0.166, 0.5], [0.128, 0.546], [0.08, 0.574], [0.058, 0.588]];
/** How much wider than deep the shoulders are, compared with the waist. */
export const torsoSpread = (y: number) => 1 + 0.12 * smooth01((y - 0.24) / 0.24);

/**
 * The trunk in a shirt. Built in the trunk's frame and then moved so its
 * origin is mid-chest (the mesh sits at y = 0.3), wider across the shoulders
 * than deep, a chest in front and a flatter back.
 */
export function torsoGeo(): THREE.BufferGeometry {
  return once('torso', () => {
    // (Open at the hem: it hangs over the hips, it does not close under them.)
    const g = lathe(TORSO, 18, true);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      let x = p.getX(i) * torsoSpread(y), z = p.getZ(i);
      // Chest forward (-Z), shoulder blades back, a hollow at the small of the back.
      const chest = smooth01((y - 0.2) / 0.16) * (1 - smooth01((y - 0.46) / 0.12));
      if (z < 0) z *= 1 + 0.1 * chest; else z *= 1 - 0.08 * smooth01((0.26 - y) / 0.2) + 0.04 * chest;
      // The shoulders slope: the top of the trunk falls away toward the arms.
      const slope = smooth01((y - 0.48) / 0.1);
      x *= 1 + 0.22 * slope * (1 - slope) * 4 * 0.5;
      p.setXYZ(i, x, y - 0.3, z);
    }
    g.computeVertexNormals();
    return g;
  });
}

/** A band of the shirt at a height (a stripe, or the lower half of a two-tone), lying just proud of the cloth. */
export function torsoBand(y: number, h: number): THREE.BufferGeometry {
  return once(`band:${y}:${h}`, () => {
    const n = Math.max(2, Math.round(h / 0.03));
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= n; i++) { const yy = y - h / 2 + (h * i) / n; pts.push(new THREE.Vector2(torsoRadius(yy) + 0.0025, yy)); }
    const g = new THREE.LatheGeometry(pts, 18);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const yy = p.getY(i);
      let z = p.getZ(i);
      const chest = smooth01((yy - 0.2) / 0.16) * (1 - smooth01((yy - 0.46) / 0.12));
      if (z < 0) z *= 1 + 0.1 * chest; else z *= 1 - 0.08 * smooth01((0.26 - yy) / 0.2) + 0.04 * chest;
      p.setXYZ(i, p.getX(i) * torsoSpread(yy), yy, z);
    }
    g.computeVertexNormals();
    return g;
  });
}

/** The ribbed collar of the shirt, round the base of the neck. */
export function collarGeo(): THREE.BufferGeometry {
  return once('collar', () => { const g = new THREE.TorusGeometry(0.062, 0.011, 6, 18); g.rotateX(Math.PI / 2); g.scale(1, 1, 1.05); return g; });
}

/** The neck: out of the collar, into the skull, a little forward. */
export function neckGeo(): THREE.BufferGeometry {
  return once('neck', () => lathe([[0.058, -0.06], [0.052, -0.02], [0.049, 0.03], [0.052, 0.07]], 10));
}

/**
 * The head, skin only: a skull with a jaw and a chin (it narrows below the
 * cheekbones and comes forward), a nose, ears. One mesh. The crown matches
 * what the hair and the hats were cut to fit.
 */
export function headGeo(): THREE.BufferGeometry {
  return once('head', () => {
    const skull = lathe([[0.03, -0.105], [0.052, -0.097], [0.074, -0.076], [0.091, -0.046], [0.103, -0.01], [0.108, 0.025], [0.103, 0.068], [0.087, 0.104], [0.06, 0.128], [0.03, 0.138]], 16);
    const p = skull.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      let x = p.getX(i) * 0.95, z = p.getZ(i);
      // Jaw: the lower face comes forward and the back of the skull stays round.
      const low = smooth01((0.0 - y) / 0.1);
      z -= 0.014 * low;
      if (z > 0) z *= 1 - 0.16 * low;
      // Flatter across the face than round the back.
      if (z < 0) z *= 0.96;
      x *= 1 - 0.06 * low;
      p.setXYZ(i, x, y, z);
    }
    skull.computeVertexNormals();
    const nose = new THREE.SphereGeometry(1, 8, 6);
    nose.scale(0.013, 0.02, 0.02);
    nose.translate(0, -0.012, -0.112);
    const parts = [skull, nose];
    for (const sx of [-1, 1]) {
      const ear = new THREE.SphereGeometry(1, 8, 6);
      ear.scale(0.009, 0.024, 0.015);
      ear.rotateY(sx * 0.35);
      ear.translate(sx * 0.1, -0.004, 0.012);
      parts.push(ear);
    }
    return mergeGeometries(parts.map(plain))!;
  });
}

/** Eyes: two dark, slightly oval dots. One mesh. */
export function eyesGeo(): THREE.BufferGeometry {
  return once('eyes', () => mergeGeometries([-1, 1].map((sx) => {
    const e = new THREE.SphereGeometry(1, 8, 6);
    e.scale(0.0105, 0.0135, 0.006);
    e.rotateY(sx * 0.32);
    e.translate(sx * 0.037, 0.012, -0.0965);
    return plain(e);
  }))!);
}

/**
 * A sneaker, toe toward -Z, sitting on the ground with the ankle at the
 * origin's height + 0.07: gum sole, canvas upper with a toe cap, a padded
 * collar, and the sock coming out of it. One mesh, told apart by vertex colour.
 */
export function shoeGeo(): THREE.BufferGeometry {
  return once('shoe', () => {
    const CANVAS = '#ece5d6', CAP = '#f6f1e6', GUM = '#b0845a', SOCK = '#f1eee6', LACE = '#cfc7b6';
    const parts: THREE.BufferGeometry[] = [];
    const put = (g: THREE.BufferGeometry, col: string) => parts.push(paint(plain(g), col));
    // Sole: a slab with round ends, a touch wider than the upper.
    const sole = new THREE.CapsuleGeometry(0.057, 0.165, 4, 10);
    sole.rotateX(Math.PI / 2);
    sole.scale(1, 0.25, 1);
    sole.translate(0, 0.0145, -0.055);
    put(sole, GUM);
    // Upper: low over the toes, rising to the ankle.
    const upper = new THREE.SphereGeometry(1, 12, 8);
    upper.scale(0.052, 0.05, 0.118);
    const up = upper.attributes.position;
    for (let i = 0; i < up.count; i++) {
      const z = up.getZ(i), y = up.getY(i);
      // Higher at the heel end, flat underneath.
      up.setY(i, Math.max(-0.012, y * (0.72 + 0.5 * smooth01((z + 0.02) / 0.1))));
    }
    upper.translate(0, 0.04, -0.045);
    upper.computeVertexNormals();
    put(upper, CANVAS);
    const cap = new THREE.SphereGeometry(1, 10, 6);
    cap.scale(0.05, 0.03, 0.05);
    cap.translate(0, 0.036, -0.14);
    put(cap, CAP);
    // Laces: three bars across the instep.
    for (let i = 0; i < 3; i++) {
      const lace = new THREE.BoxGeometry(0.05, 0.006, 0.012);
      lace.rotateX(0.5);
      lace.translate(0, 0.069 + i * 0.008, -0.085 + i * 0.027);
      put(lace, LACE);
    }
    const collar = new THREE.TorusGeometry(0.041, 0.012, 6, 12);
    collar.rotateX(Math.PI / 2);
    collar.scale(1, 1, 1.12);
    collar.translate(0, 0.092, 0.012);
    put(collar, CANVAS);
    const sock = new THREE.CylinderGeometry(0.036, 0.039, 0.085, 10);
    sock.translate(0, 0.125, 0.008);
    put(sock, SOCK);
    return mergeGeometries(parts)!;
  });
}
