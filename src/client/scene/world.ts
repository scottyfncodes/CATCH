// A back road at golden hour: it runs out of the redwoods at one end and
// bends past an old red barn at the other, with a meadow either side. Built from a handful of merged and
// instanced meshes so it stays cheap on phones.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export const SUN_DIR = new THREE.Vector3(-0.62, 0.24, -0.75).normalize();

export const PALETTE = {
  horizon: new THREE.Color('#f5b27a'),
  zenith: new THREE.Color('#4f86c6'),
  sun: new THREE.Color('#ffd7a8'),
  grassA: '#5f8a3a',
  grassB: '#6e9a42',
  fog: new THREE.Color('#e7bf95'),
};

function rand(seed: number) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

/** Where the old barn stands, beside the bend. */
const BARN = { x: -10, z: 36 };

/** The road's centreline: straight where you play, bending away at both ends. */
export function roadX(z: number): number {
  if (z < -22) return -0.012 * (z + 22) * (z + 22);
  if (z > 20) return 0.016 * (z - 20) * (z - 20);
  return 0;
}

function asphaltTexture(): THREE.CanvasTexture {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#56575a';
  g.fillRect(0, 0, S, S);
  const r = rand(19);
  // Aggregate speckle and a few darker, damp patches.
  for (let i = 0; i < 9000; i++) {
    const l = 26 + r() * 30;
    g.fillStyle = `hsla(${200 + r() * 40}, 4%, ${l}%, ${0.25 + r() * 0.35})`;
    g.fillRect(r() * S, r() * S, 1 + r(), 1 + r());
  }
  for (let i = 0; i < 18; i++) {
    const x = r() * S, y = r() * S, rad = 10 + r() * 40;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, 'rgba(30,32,36,0.28)');
    gr.addColorStop(1, 'rgba(30,32,36,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, S, S);
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function colorize(geo: THREE.BufferGeometry, color: THREE.Color, vary = 0, r = Math.random) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  const c = color.clone();
  if (vary) c.offsetHSL((r() - 0.5) * vary * 0.1, (r() - 0.5) * vary * 0.2, (r() - 0.5) * vary * 0.2);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function grassTexture(): THREE.CanvasTexture {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  // Mowing stripes.
  g.fillStyle = PALETTE.grassA;
  g.fillRect(0, 0, S, S);
  g.fillStyle = PALETTE.grassB;
  g.fillRect(0, 0, S / 2, S);
  // Blade speckle.
  const r = rand(7);
  for (let i = 0; i < 26000; i++) {
    const x = r() * S, y = r() * S;
    const l = 22 + r() * 22;
    g.fillStyle = `hsla(${84 + r() * 22}, ${38 + r() * 20}%, ${l}%, ${0.18 + r() * 0.25})`;
    g.fillRect(x, y, 1 + r() * 1.5, 2 + r() * 4);
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function skyMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    uniforms: {
      uHorizon: { value: PALETTE.horizon },
      uZenith: { value: PALETTE.zenith },
      uSun: { value: PALETTE.sun },
      uSunDir: { value: SUN_DIR },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uHorizon, uZenith, uSun, uSunDir;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 col = mix(uHorizon, uZenith, pow(h, 0.42));
        // warm band just above the horizon
        col = mix(col, vec3(1.0, 0.72, 0.48), exp(-h * 18.0) * 0.5);
        float s = max(dot(d, uSunDir), 0.0);
        col += uSun * (pow(s, 900.0) * 3.0 + pow(s, 24.0) * 0.35 + pow(s, 4.0) * 0.12);
        // below horizon fades toward the haze colour
        if (d.y < 0.0) col = mix(uHorizon, vec3(0.72, 0.62, 0.5), min(1.0, -d.y * 4.0));
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

function cloudTexture() {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 128;
  const g = cv.getContext('2d')!;
  const r = rand(11);
  for (let i = 0; i < 16; i++) {
    const x = 40 + r() * 176, y = 50 + r() * 40, rad = 24 + r() * 34;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, 'rgba(255,240,228,0.55)');
    gr.addColorStop(1, 'rgba(255,240,228,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 256, 128);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export interface World {
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  update(dt: number, t: number): void;
}

export function buildWorld(lowSpec: boolean): World {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(PALETTE.fog, 60, 210);

  // Sky dome.
  const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), skyMaterial());
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);

  // Light: low sun + sky fill.
  const hemi = new THREE.HemisphereLight('#cfe0f5', '#5b4a2e', 1.25);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight('#ffd2a1', 2.6);
  sun.position.copy(SUN_DIR).multiplyScalar(40);
  sun.target.position.set(0, 0, 0);
  if (!lowSpec) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const s = sun.shadow.camera;
    s.left = -18; s.right = 18; s.top = 18; s.bottom = -18; s.near = 5; s.far = 90;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.03;
  }
  scene.add(sun, sun.target);

  // Lawn.
  const tex = grassTexture();
  tex.repeat.set(36, 36);
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(260, 48),
    new THREE.MeshLambertMaterial({ map: tex }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // The road: you play catch down the middle of a quiet back road that runs
  // out of the redwoods at one end and bends past an old barn at the other.
  {
    const W = 5.6, SH = 1.7;
    const zs: number[] = [];
    for (let z = -200; z <= 200; z += 2) zs.push(z);
    const ribbon = (inner: number, outer: number, y: number) => {
      const pos: number[] = [], uv: number[] = [], idx: number[] = [];
      zs.forEach((z, k) => {
        const x = roadX(z);
        const d = roadX(z + 0.5) - roadX(z - 0.5);
        const nl = Math.hypot(1, d);
        const nx = 1 / nl, nz = -d / nl;
        for (const o of [inner, outer]) pos.push(x + nx * o, y, z + nz * o);
        uv.push(0, z / 6, 1, z / 6);
        if (k) { const a = (k - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      if (g.attributes.normal.getY(0) < 0) { for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; } g.setIndex(idx); g.computeVertexNormals(); }
      return g;
    };
    const road = new THREE.Mesh(ribbon(-W / 2, W / 2, 0.012), new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 0.62, metalness: 0.0, color: '#ffffff' }));
    road.receiveShadow = true;
    // Soft shoulders of red-brown redwood duff.
    const duff = new THREE.MeshLambertMaterial({ color: '#6f4430' });
    const shL = new THREE.Mesh(ribbon(-W / 2 - SH, -W / 2, 0.008), duff);
    const shR = new THREE.Mesh(ribbon(W / 2, W / 2 + SH, 0.008), duff);
    shL.receiveShadow = shR.receiveShadow = true;
    scene.add(road, shL, shR);
    // A dry, golden clearing around the barn.
    const field = new THREE.Mesh(
      new THREE.CircleGeometry(30, 40),
      new THREE.MeshBasicMaterial({ color: '#b39758', transparent: true, opacity: 0.55, depthWrite: false }),
    );
    field.rotation.x = -Math.PI / 2;
    field.position.set(BARN.x, 0.004, BARN.z);
    scene.add(field);
  }

  // Grass tufts: one instanced draw call of tiny three-blade clumps.
  {
    const blade = new THREE.BufferGeometry();
    const v: number[] = [];
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      const cx = Math.cos(a) * 0.03, cz = Math.sin(a) * 0.03;
      const tx = Math.cos(a) * 0.06, tz = Math.sin(a) * 0.06;
      v.push(cx - 0.012, 0, cz, cx + 0.012, 0, cz, tx, 0.13, tz);
    }
    blade.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    blade.computeVertexNormals();
    const count = lowSpec ? 1400 : 3200;
    const mat = new THREE.MeshLambertMaterial({ color: '#ffffff', side: THREE.DoubleSide });
    const tufts = new THREE.InstancedMesh(blade, mat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const r = rand(3);
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const a = r() * Math.PI * 2;
      const d = 2 + Math.pow(r(), 0.7) * 24;
      if (Math.abs(Math.sin(a) * d - roadX(Math.cos(a) * d)) < 3.6) { m.makeScale(0, 0, 0); tufts.setMatrixAt(i, m); continue; }
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28);
      const s = 0.35 + r() * 0.45;
      m.compose(new THREE.Vector3(Math.sin(a) * d, 0, Math.cos(a) * d), q, new THREE.Vector3(s, s * (0.8 + r() * 0.5), s));
      tufts.setMatrixAt(i, m);
      tufts.setColorAt(i, c.setHSL(0.23 + r() * 0.04, 0.45, 0.36 + r() * 0.1));
    }
    scene.add(tufts);
  }

  // Broadleaf trees out in the meadow, instanced trunks and canopies.
  {
    const r = rand(42);
    const spots: { x: number; z: number; s: number }[] = [];
    for (let i = 0; i < 34; i++) {
      const a = (i / 34) * Math.PI * 2 + (r() - 0.5) * 0.25;
      // Leave the sun side more open so the sky glows through.
      const open = Math.abs(Math.atan2(Math.sin(a - Math.atan2(SUN_DIR.x, SUN_DIR.z)), Math.cos(a - Math.atan2(SUN_DIR.x, SUN_DIR.z)))) < 0.5;
      const d = (open ? 52 : 30) + r() * 22;
      const x = Math.sin(a) * d, z = Math.cos(a) * d;
      // The redwoods own the road corridor; broadleaf trees stay out in the meadow.
      if (Math.abs(x - roadX(z)) < 24 && z < 18) continue;
      // Keep the view down the road to the barn clear.
      if (Math.hypot(x - BARN.x, z - BARN.z) < 30 || (z > 0 && Math.abs(x - roadX(z)) < 16)) continue;
      spots.push({ x, z, s: 0.8 + r() * 0.7 });
    }
    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.26, 3.2, 6);
    trunkGeo.translate(0, 1.6, 0);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: '#5a4030' }), spots.length);
    const canopyGeo = new THREE.IcosahedronGeometry(2.4, 1);
    const canopyMat = new THREE.MeshLambertMaterial({ flatShading: true });
    const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, spots.length * 3);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
    spots.forEach((p, i) => {
      m.compose(new THREE.Vector3(p.x, 0, p.z), q.identity(), new THREE.Vector3(p.s, p.s, p.s));
      trunks.setMatrixAt(i, m);
      for (let k = 0; k < 3; k++) {
        const ox = (r() - 0.5) * 2.2 * p.s, oz = (r() - 0.5) * 2.2 * p.s;
        const y = (3.6 + k * 1.1 + r() * 0.6) * p.s;
        const s = p.s * (1.15 - k * 0.22) * (0.85 + r() * 0.3);
        q.setFromEuler(new THREE.Euler(r(), r() * 6, r()));
        m.compose(new THREE.Vector3(p.x + ox, y, p.z + oz), q, new THREE.Vector3(s, s * 0.85, s));
        canopies.setMatrixAt(i * 3 + k, m);
        canopies.setColorAt(i * 3 + k, c.setHSL(0.22 + r() * 0.08, 0.38 + r() * 0.15, 0.24 + r() * 0.1));
      }
    });
    trunks.castShadow = canopies.castShadow = false;
    scene.add(trunks, canopies);
  }

  // A distant ridge: hills all round, a mountain backdrop through the trees.
  {
    const r = rand(99);
    const parts: THREE.BufferGeometry[] = [];
    // Ridge.
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      const hill = new THREE.SphereGeometry(40 + r() * 30, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
      hill.scale(1.4, 0.22 + r() * 0.18, 1);
      hill.translate(Math.sin(a) * 190, -2, Math.cos(a) * 190);
      colorize(hill, new THREE.Color('#6f8a6a'), 1, r);
      parts.push(hill.toNonIndexed());
    }
    const merged = mergeGeometries(parts.map((p) => { p.deleteAttribute('uv'); return p; }));
    merged.computeVertexNormals();
    scene.add(new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })));
  }

  // The redwoods: tall red trunks crowding both sides of the road, dark
  // conifer crowns far overhead, bright undergrowth at their feet.
  {
    const r = rand(77);
    const trees: { x: number; z: number; rad: number; h: number }[] = [];
    for (const side of [-1, 1]) {
      for (let z = -190; z < 22; z += 4 + r() * 6) {
        const n = 1 + Math.floor(r() * 2);
        for (let k = 0; k < n; k++) {
          const off = 6.4 + Math.pow(r(), 1.4) * 22;
          trees.push({ x: roadX(z) + side * off, z: z + (r() - 0.5) * 3, rad: 0.55 + r() * 0.85, h: 34 + r() * 22 });
        }
      }
    }
    // A few stand around the barn clearing, further back.
    for (let i = 0; i < 26; i++) {
      const a = r() * Math.PI * 2, d = 34 + r() * 30;
      const x = BARN.x + Math.sin(a) * d, z = BARN.z + Math.cos(a) * d;
      if (Math.abs(x - roadX(z)) < 7) continue;
      trees.push({ x, z, rad: 0.4 + r() * 0.5, h: 24 + r() * 16 });
    }
    const trunkGeo = new THREE.CylinderGeometry(0.62, 1, 1, 9, 1, true);
    trunkGeo.translate(0, 0.5, 0);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: '#ffffff' }), trees.length);
    const crownGeo = new THREE.ConeGeometry(1, 1, 7);
    crownGeo.translate(0, 0.5, 0);
    const LAYERS = 4;
    const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshLambertMaterial({ flatShading: true }), trees.length * LAYERS);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
    trees.forEach((t, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28);
      m.compose(new THREE.Vector3(t.x, 0, t.z), q, new THREE.Vector3(t.rad, t.h, t.rad));
      trunks.setMatrixAt(i, m);
      trunks.setColorAt(i, c.setHSL(0.03 + r() * 0.025, 0.42 + r() * 0.15, 0.27 + r() * 0.08));
      for (let k = 0; k < LAYERS; k++) {
        const y = t.h * (0.42 + k * 0.15);
        const w = t.rad * (5.2 - k * 0.9) * (0.85 + r() * 0.3);
        m.compose(new THREE.Vector3(t.x + (r() - 0.5), y, t.z + (r() - 0.5)), q, new THREE.Vector3(w, t.h * 0.24, w));
        crowns.setMatrixAt(i * LAYERS + k, m);
        crowns.setColorAt(i * LAYERS + k, c.setHSL(0.3 + r() * 0.06, 0.32 + r() * 0.15, 0.17 + r() * 0.08));
      }
    });
    trunks.castShadow = false; crowns.castShadow = false;
    scene.add(trunks, crowns);

    // Undergrowth: ferns and young growth along the shoulders, sunlit lime greens.
    const bush = new THREE.IcosahedronGeometry(1, 0);
    const count = lowSpec ? 360 : 900;
    const bushes = new THREE.InstancedMesh(bush, new THREE.MeshLambertMaterial({ flatShading: true }), count);
    for (let i = 0; i < count; i++) {
      const z = -150 + r() * 170;
      const side = r() < 0.5 ? -1 : 1;
      const off = 5.4 + Math.pow(r(), 1.5) * 16;
      const s2 = (0.22 + r() * 0.5) * (off < 8 ? 0.8 : 1.2);
      q.setFromEuler(new THREE.Euler(r(), r() * 6, r()));
      m.compose(new THREE.Vector3(roadX(z) + side * off, s2 * 0.3, z), q, new THREE.Vector3(s2 * 1.6, s2 * 0.7, s2 * 1.4));
      bushes.setMatrixAt(i, m);
      // Sunlit young growth, mostly muted with the odd bright fern.
      const bright = r() < 0.18;
      bushes.setColorAt(i, c.setHSL(0.21 + r() * 0.07, bright ? 0.55 : 0.38 + r() * 0.12, bright ? 0.36 : 0.2 + r() * 0.1));
    }
    scene.add(bushes);
  }

  // The old barn at the bend, weathered red boards and a dark open loft; a
  // power pole and a short run of split-rail fence.
  {
    const parts: THREE.BufferGeometry[] = [];
    const add = (g: THREE.BufferGeometry, col: string, vary = 0.6) => { parts.push(colorize(g, new THREE.Color(col), vary, rand(parts.length + 3)).toNonIndexed()); };
    const bw = 12, bd = 14, bh = 6.5, rh = 5.2;
    // Body: a house-shaped section (walls + gables) extruded along the ridge.
    const shape = new THREE.Shape();
    shape.moveTo(-bw / 2, 0); shape.lineTo(bw / 2, 0); shape.lineTo(bw / 2, bh); shape.lineTo(0, bh + rh); shape.lineTo(-bw / 2, bh); shape.closePath();
    const body = new THREE.ExtrudeGeometry(shape, { depth: bd, bevelEnabled: false });
    body.translate(0, 0, -bd / 2);
    add(body, '#5b2a22');
    // Roof: two slabs on the pitch, overhanging a little.
    const hd = bd / 2 + 0.4;
    const pitch = Math.atan2(rh, bw / 2);
    const slab = Math.hypot(bw / 2, rh) + 0.6;
    for (const sx of [-1, 1]) {
      const r = new THREE.BoxGeometry(slab, 0.18, bd + 0.8);
      r.rotateZ(-sx * pitch);
      r.translate(sx * (bw / 4 + 0.12), bh + rh / 2 + 0.12, 0);
      add(r, '#5d554c', 0.3);
    }
    // Dark openings: the big door and the loft, on the side facing the road.
    const door = new THREE.BoxGeometry(4.2, 4.2, 0.1); door.translate(0, 2.1, -bd / 2 - 0.02); add(door, '#1b1512', 0.1);
    const loft = new THREE.BoxGeometry(2.4, 2.2, 0.1); loft.translate(0, bh + 1.1, -hd + 0.33); add(loft, '#1f1814', 0.1);
    const lean = new THREE.BoxGeometry(4, 3.4, bd * 0.8); lean.translate(bw / 2 + 2, 1.7, 0); add(lean, '#6e3429');
    const trim = new THREE.BoxGeometry(bw + 0.2, 0.25, 0.15); trim.translate(0, bh, -bd / 2 - 0.05); add(trim, '#7a6a55');
    // Vertical board seams.
    for (let i = -5; i <= 5; i++) {
      if (Math.abs(i) <= 2) continue;
      const seam = new THREE.BoxGeometry(0.05, bh, 0.06); seam.translate(i * 1.05, bh / 2, -bd / 2 - 0.04); add(seam, '#2c1612', 0.2);
    }
    const merged = mergeGeometries(parts.map((p) => { if (p.getAttribute('uv')) p.deleteAttribute('uv'); if (p.getAttribute('normal')) p.deleteAttribute('normal'); return p; }));
    merged.computeVertexNormals();
    const barn = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    // Facing the road (and the player at the near end), set back in its clearing.
    barn.position.set(BARN.x, 0, BARN.z);
    barn.rotation.y = -0.23; // gable end and big door square to the road
    barn.scale.setScalar(1.15);
    scene.add(barn);

    const wood = new THREE.Color('#6d5843');
    const extra: THREE.BufferGeometry[] = [];
    const pole = new THREE.CylinderGeometry(0.13, 0.17, 10, 6); pole.translate(BARN.x - 9, 5, BARN.z - 8); extra.push(colorize(pole, wood).toNonIndexed());
    const arm = new THREE.BoxGeometry(2.2, 0.14, 0.14); arm.translate(BARN.x - 9, 9.2, BARN.z - 8); extra.push(colorize(arm, wood).toNonIndexed());
    for (let i = 0; i < 6; i++) {
      const x = -5 - i * 2.6, z = 23 + i * 0.4;
      const post = new THREE.BoxGeometry(0.14, 1.1, 0.14); post.translate(x, 0.55, z); extra.push(colorize(post, wood).toNonIndexed());
      if (i) for (const y of [0.45, 0.9]) { const rail = new THREE.BoxGeometry(2.7, 0.09, 0.09); rail.translate(x + 1.3, y, z - 0.2); extra.push(colorize(rail, wood).toNonIndexed()); }
    }
    const em = mergeGeometries(extra.map((p) => { p.deleteAttribute('uv'); return p; }));
    em.computeVertexNormals();
    scene.add(new THREE.Mesh(em, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })));
  }

  // Soft clouds drifting.
  const clouds: THREE.Sprite[] = [];
  {
    const tex2 = cloudTexture();
    const r = rand(5);
    for (let i = 0; i < 7; i++) {
      const mat = new THREE.SpriteMaterial({ map: tex2, transparent: true, depthWrite: false, fog: false, opacity: 0.75 });
      const s = new THREE.Sprite(mat);
      const a = r() * Math.PI * 2;
      s.position.set(Math.sin(a) * 220, 55 + r() * 50, Math.cos(a) * 220);
      s.scale.set(110 + r() * 80, 40 + r() * 20, 1);
      clouds.push(s);
      scene.add(s);
    }
  }

  return {
    scene,
    sun,
    update(dt) {
      for (const c of clouds) {
        const a = Math.atan2(c.position.x, c.position.z) + dt * 0.002;
        const d = Math.hypot(c.position.x, c.position.z);
        c.position.x = Math.sin(a) * d; c.position.z = Math.cos(a) * d;
      }
    },
  };
}
