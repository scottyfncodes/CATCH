// A back road at golden hour: it runs out of the redwoods at one end and
// bends past an old red barn at the other, with a meadow either side. Built from a handful of merged and
// instanced meshes so it stays cheap on phones.

import * as THREE from 'three';
import { skyEnvironment } from './light';
import { SUN_DIR, buildMotes, buildShafts, dappled, installLook } from './look';

export { SUN_DIR };
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';


export const PALETTE = {
  horizon: new THREE.Color('#f7b680'),
  zenith: new THREE.Color('#3f66b4'),
  sun: new THREE.Color('#ffd7a8'),
  grassA: '#5f8a3a',
  grassB: '#6e9a42',
  // Haze away from the sun (toward it, the shaders turn it gold).
  fog: new THREE.Color('#bcb3c8'),
};

/** Painted once, shared by every world built on this page (the home screen's and the game's). */
const painted = new Map<string, THREE.CanvasTexture>();
function once(key: string, paint: () => THREE.CanvasTexture): THREE.CanvasTexture {
  let t = painted.get(key);
  if (!t) painted.set(key, (t = paint()));
  return t;
}

/** Fine grain over a whole canvas in one pass (thousands of one-pixel rectangles are slow to draw). */
function grain(g: CanvasRenderingContext2D, w: number, h: number, r: () => number, amount: number) {
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const k = 1 + (r() - 0.5) * amount;
    d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
  }
  g.putImageData(img, 0, 0);
}

function rand(seed: number) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

/** Where the old barn stands: set back from the road, clear of the players as they back up past it. */
const BARN = { x: -25, z: 46 };

/** The road's centreline: straight where you play, bending away at both ends. */
export function roadX(z: number): number {
  // (Straight for as far as two people can throw, and a little more.)
  if (z < -86) return -0.012 * (z + 86) * (z + 86);
  if (z > 84) return 0.016 * (z - 84) * (z - 84);
  return 0;
}

/**
 * The road, as one long strip across (u) and along (v): worn asphalt with the
 * tyres' two darker tracks, cracks and tar, a patch, what is left of a yellow
 * centre line, and redwood needles drifted in along both edges.
 */
function asphaltTexture(): THREE.CanvasTexture {
  const W = 512, H = 1024;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#5d5b5c';
  g.fillRect(0, 0, W, H);
  const r = rand(19);
  // (Everything that could cross the top or bottom edge is drawn three times, so the strip tiles.)
  const wrap = (draw: (dy: number) => void) => { for (const dy of [-H, 0, H]) draw(dy); };
  // Aggregate.
  grain(g, W, H, r, 0.5);
  for (let i = 0; i < 5000; i++) {
    const l = 30 + r() * 40;
    g.fillStyle = `hsla(${20 + r() * 220}, ${3 + r() * 6}%, ${l}%, ${0.3 + r() * 0.4})`;
    g.fillRect(r() * W, r() * H, 1.5 + r() * 1.6, 1.5 + r() * 1.6);
  }
  // Broad wear: lighter down the crown, darker in the two tyre tracks.
  for (const [u, col, wd] of [[0.5, 'rgba(120,116,112,0.2)', 0.2], [0.27, 'rgba(34,34,38,0.26)', 0.1], [0.73, 'rgba(34,34,38,0.26)', 0.1]] as const) {
    const gr = g.createLinearGradient((u - wd) * W, 0, (u + wd) * W, 0);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.5, col); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, W, H);
  }
  // Damp, darker blotches.
  for (let i = 0; i < 26; i++) {
    const x = r() * W, y = r() * H, rad = 30 + r() * 90;
    wrap((dy) => {
      const gr = g.createRadialGradient(x, y + dy, 0, x, y + dy, rad);
      gr.addColorStop(0, 'rgba(28,30,36,0.26)'); gr.addColorStop(1, 'rgba(28,30,36,0)');
      g.fillStyle = gr;
      g.fillRect(x - rad, y + dy - rad, rad * 2, rad * 2);
    });
  }
  // A repair: a squarer, darker patch.
  g.fillStyle = 'rgba(46,46,50,0.38)';
  g.fillRect(W * 0.56, H * 0.18, W * 0.2, H * 0.1);
  g.strokeStyle = 'rgba(20,20,22,0.55)'; g.lineWidth = 2;
  g.strokeRect(W * 0.56, H * 0.18, W * 0.2, H * 0.1);
  // Cracks, some of them sealed with tar.
  for (let i = 0; i < 9; i++) {
    let x = r() * W, y = r() * H;
    const tar = r() < 0.3;
    const pts: [number, number][] = [[x, y]];
    const a0 = r() * 6.28;
    for (let k = 0; k < 9 + r() * 9; k++) { x += Math.cos(a0 + (r() - 0.5) * 1.6) * (8 + r() * 16); y += Math.sin(a0 + (r() - 0.5) * 1.6) * (8 + r() * 16); pts.push([x, y]); }
    wrap((dy) => {
      g.beginPath();
      pts.forEach(([px, py], k) => (k ? g.lineTo(px, py + dy) : g.moveTo(px, py + dy)));
      g.strokeStyle = tar ? 'rgba(24,24,27,0.6)' : 'rgba(26,26,29,0.5)';
      g.lineWidth = tar ? 2.2 : 0.9;
      g.lineJoin = 'round';
      g.stroke();
    });
  }
  // What is left of the centre line: one dash a tile, most of its paint gone.
  const dash = { x: W * 0.5 - 4.5, y: H * 0.36, w: 9, h: H * 0.26 };
  g.fillStyle = 'rgba(222,190,98,0.8)';
  g.fillRect(dash.x, dash.y, dash.w, dash.h);
  for (let i = 0; i < 420; i++) {
    const l = 33 + r() * 9;
    g.fillStyle = `hsla(300, 2%, ${l}%, ${0.6 + r() * 0.4})`;
    g.fillRect(dash.x - 1 + r() * (dash.w + 2), dash.y + r() * dash.h, 1 + r() * 3, 1 + r() * 7);
  }
  // Needles and duff drifted in from the shoulders: thick at the very edge, thinning out.
  for (let i = 0; i < 11000; i++) {
    const d = Math.pow(r(), 2.4) * 0.17;
    const u = r() < 0.5 ? d : 1 - d;
    const a = r() * Math.PI;
    const x = u * W, y = r() * H, len = 2 + r() * 5;
    g.strokeStyle = `hsla(${14 + r() * 16}, ${45 + r() * 20}%, ${20 + r() * 20}%, ${0.5 + r() * 0.4})`;
    g.lineWidth = 1.2 + r() * 1.2;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); g.stroke();
  }
  for (const u of [0, 1]) {
    const gr = g.createLinearGradient(u * W, 0, (u ? 1 - 0.07 : 0.07) * W, 0);
    gr.addColorStop(0, 'rgba(98,58,36,0.95)'); gr.addColorStop(1, 'rgba(98,58,36,0)');
    g.fillStyle = gr;
    g.fillRect(u ? W * 0.93 : 0, 0, W * 0.07, H);
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** The shoulders: red-brown redwood duff, needles and the odd cone, thinning out raggedly into the forest floor (u = 1). */
function duffTexture(): THREE.CanvasTexture {
  const W = 256, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;
  const r = rand(31);
  g.fillStyle = '#62391f';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 4200; i++) {
    const a = r() * Math.PI, x = r() * W, y = r() * H, len = 3 + r() * 8;
    g.strokeStyle = `hsla(${12 + r() * 20}, ${40 + r() * 25}%, ${16 + r() * 26}%, ${0.5 + r() * 0.4})`;
    g.lineWidth = 0.8 + r();
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); g.stroke();
  }
  for (let i = 0; i < 60; i++) { g.fillStyle = `hsla(22, 30%, ${12 + r() * 10}%, 0.8)`; g.beginPath(); g.ellipse(r() * W, r() * H, 2 + r() * 3, 1.5 + r() * 2, r() * 3, 0, 7); g.fill(); }
  // Ragged, fading outer edge.
  const img = g.getImageData(0, 0, W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / (W - 1);
    const edge = 0.42 + 0.14 * Math.sin(y * 0.049) + 0.1 * Math.sin(y * 0.171 + 2) + 0.06 * Math.sin(y * 0.61 + 1);
    const a = 1 - Math.min(1, Math.max(0, (u - edge) / 0.4 + (r() - 0.5) * 0.35));
    img.data[(y * W + x) * 4 + 3] = Math.round(255 * a * a);
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Redwood bark: deep, wandering vertical furrows, fibrous ridges between them. Tinted per tree. */
function barkTexture(): THREE.CanvasTexture {
  const W = 256, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d')!;
  const r = rand(53);
  g.fillStyle = '#c9c0b8';
  g.fillRect(0, 0, W, H);
  // Fibres.
  for (let i = 0; i < 1100; i++) {
    const x = r() * W, y = r() * H, len = 18 + r() * 60;
    g.strokeStyle = `rgba(${r() < 0.5 ? '255,244,232' : '96,80,70'},${0.08 + r() * 0.16})`;
    g.lineWidth = 0.7 + r() * 1.2;
    for (const dy of [-H, 0, H]) { g.beginPath(); g.moveTo(x, y + dy); g.lineTo(x + (r() - 0.5) * 5, y + dy + len); g.stroke(); }
  }
  // Furrows: dark, wandering, joining and parting.
  for (let i = 0; i < 26; i++) {
    let x = (i / 26) * W + (r() - 0.5) * 8;
    const wide = 2.2 + r() * 4.5, y0 = r() * H, len = H * (0.5 + r() * 0.9);
    for (const dx of [-W, 0, W]) for (const dy of [-H, 0, H]) {
      g.beginPath();
      let xx = x;
      const rr = rand(1000 + i);
      g.moveTo(xx + dx, y0 + dy);
      for (let y = 0; y < len; y += 14) { xx += (rr() - 0.5) * 9; g.lineTo(xx + dx, y0 + dy + y); }
      g.strokeStyle = 'rgba(38,24,20,0.7)'; g.lineWidth = wide; g.lineCap = 'round'; g.lineJoin = 'round';
      g.stroke();
      g.strokeStyle = 'rgba(20,12,10,0.6)'; g.lineWidth = wide * 0.4;
      g.stroke();
    }
    x += 0;
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

/** The forest floor: moss and sorrel, patches of bare duff, fallen needles. No two metres the same. */
function grassTexture(): THREE.CanvasTexture {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#4d6a34';
  g.fillRect(0, 0, S, S);
  const r = rand(7);
  const blot = (col: string, n: number, lo: number, hi: number) => {
    for (let i = 0; i < n; i++) {
      const x = r() * S, y = r() * S, rad = lo + r() * (hi - lo);
      for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
        const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rad);
        gr.addColorStop(0, col); gr.addColorStop(1, col.replace(/[\d.]+\)$/, '0)'));
        g.fillStyle = gr;
        g.fillRect(x + ox - rad, y + oy - rad, rad * 2, rad * 2);
      }
    }
  };
  blot('rgba(104,66,38,0.5)', 14, 30, 90);    // bare duff
  blot('rgba(118,150,58,0.42)', 22, 20, 70);  // moss in the light
  blot('rgba(40,62,34,0.45)', 18, 30, 80);    // deep green
  // Leaf and blade speckle.
  grain(g, S, S, r, 0.45);
  for (let i = 0; i < 6000; i++) {
    const x = r() * S, y = r() * S;
    g.fillStyle = `hsla(${76 + r() * 40}, ${34 + r() * 26}%, ${18 + r() * 26}%, ${0.25 + r() * 0.3})`;
    g.fillRect(x, y, 1.5 + r() * 2, 2 + r() * 4);
  }
  // Fallen needles.
  for (let i = 0; i < 1500; i++) {
    const a = r() * Math.PI, x = r() * S, y = r() * S, len = 2 + r() * 5;
    g.strokeStyle = `hsla(${16 + r() * 14}, 50%, ${24 + r() * 18}%, ${0.35 + r() * 0.35})`;
    g.lineWidth = 0.8;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); g.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * The evening sky, painted: gold at the horizon through rose and lavender to
 * a deep blue overhead, warmer on the sun's side, high streaks of cloud lit
 * from underneath, and the sun with its glow.
 */
function skyMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    uniforms: { uSunDir: { value: SUN_DIR }, uT: { value: 0 } },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSunDir;
      uniform float uT;
      varying vec3 vDir;
      float hash(vec2 p) { vec3 q3 = fract( vec3( p.xyx ) * 0.1031 ); q3 += dot( q3, q3.yzx + 33.33 ); return fract( ( q3.x + q3.y ) * q3.z ); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      float fbm(vec2 p) {
        float a = 0.5, s = 0.0;
        for (int i = 0; i < 3; i++) { s += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
        s *= 1.07;
        return s;
      }
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        float s = max(dot(d, uSunDir), 0.0);
        vec3 col = mix(vec3(0.99, 0.74, 0.52), vec3(0.74, 0.62, 0.76), smoothstep(0.0, 0.2, h));
        col = mix(col, vec3(0.24, 0.38, 0.69), smoothstep(0.1, 0.7, h));
        // The whole sky is warmer on the sun's side.
        col = mix(col, vec3(1.0, 0.8, 0.5), pow(s, 3.0) * 0.6 * (1.0 - 0.6 * smoothstep(0.0, 0.6, h)));
        // High cloud, combed out by the wind, drifting.
        vec2 cp = d.xz / (d.y + 0.2);
        float n = fbm(vec2(cp.x * 0.8 + uT * 0.003, cp.y * 2.4));
        float cl = smoothstep(0.46, 0.74, n) * smoothstep(0.03, 0.22, h);
        vec3 cloud = mix(vec3(0.95, 0.7, 0.68), vec3(1.0, 0.88, 0.62), pow(s, 2.0));
        cloud = mix(cloud * 0.82, cloud, smoothstep(0.5, 0.8, n));
        col = mix(col, cloud, cl * 0.85);
        col += vec3(1.0, 0.84, 0.56) * (pow(s, 1400.0) * 4.0 + pow(s, 70.0) * 0.55 + pow(s, 9.0) * 0.2);
        // Below the horizon it is all haze.
        if (d.y < 0.0) col = mix(vec3(0.99, 0.74, 0.52), mix(vec3(0.74, 0.7, 0.78), vec3(1.0, 0.79, 0.5), pow(s, 4.0)), min(1.0, -d.y * 5.0));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

export interface World {
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  update(dt: number, t: number): void;
  /** Keep the sun's shadows around this spot (the play can be a long way from the middle of the road). */
  focus(x: number, z: number): void;
}

export function buildWorld(lowSpec: boolean, renderer?: THREE.WebGLRenderer): World {
  installLook();
  const scene = new THREE.Scene();
  // (The haze itself is in the shaders: see look.ts. This switches it on and gives it its colour.)
  scene.fog = new THREE.Fog(PALETTE.fog, 80, 280);

  // Sky dome.
  const skyMat = skyMaterial();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 16), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  scene.add(sky);

  // Light: low sun + sky fill.
  const hemi = new THREE.HemisphereLight('#b9c9f2', '#4f4233', renderer ? 0.56 : 1.15);
  scene.add(hemi);
  // The sky itself lights things too: warm from the sun's side, blue from above (see light.ts).
  if (renderer) {
    scene.environment = skyEnvironment(renderer, { zenith: PALETTE.zenith, horizon: PALETTE.horizon, ground: '#66703c', sun: PALETTE.sun, sunDir: SUN_DIR });
    scene.environmentIntensity = 0.62;
  }
  const sun = new THREE.DirectionalLight('#ffc88c', 3.1);
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
  const tex = once('floor', grassTexture);
  tex.repeat.set(36, 36);
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(260, 48),
    dappled(new THREE.MeshLambertMaterial({ map: tex })),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // The road: you play catch down the middle of a quiet back road that runs
  // out of the redwoods at one end and bends past an old barn at the other.
  {
    const W = 5.6, SH = 2.6;
    const zs: number[] = [];
    for (let z = -200; z <= 200; z += 2) zs.push(z);
    const ribbon = (inner: number, outer: number, y: number, vScale: number, flip = false) => {
      const pos: number[] = [], uv: number[] = [], idx: number[] = [];
      zs.forEach((z, k) => {
        const x = roadX(z);
        const d = roadX(z + 0.5) - roadX(z - 0.5);
        const nl = Math.hypot(1, d);
        const nx = 1 / nl, nz = -d / nl;
        for (const o of [inner, outer]) pos.push(x + nx * o, y, z + nz * o);
        uv.push(flip ? 1 : 0, z / vScale, flip ? 0 : 1, z / vScale);
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
    const road = new THREE.Mesh(ribbon(-W / 2, W / 2, 0.012, 12), dappled(new THREE.MeshStandardMaterial({ map: once('road', asphaltTexture), roughness: 0.56, metalness: 0.0, color: '#ffffff' })));
    road.receiveShadow = true;
    // Soft shoulders of red-brown redwood duff.
    const duff = dappled(new THREE.MeshLambertMaterial({ map: once('duff', duffTexture), transparent: true, depthWrite: false }));
    const shL = new THREE.Mesh(ribbon(-W / 2 - SH, -W / 2 + 0.1, 0.008, 5, true), duff);
    const shR = new THREE.Mesh(ribbon(W / 2 - 0.1, W / 2 + SH, 0.008, 5), duff);
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
    // A trunk that spreads into the ground, furrowed bark, darker where it meets the duff.
    const profile: [number, number][] = [[1.8, 0], [1.34, 0.01], [1.1, 0.03], [1, 0.07], [0.94, 0.3], [0.8, 0.62], [0.62, 1]];
    const trunkGeo = new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), 8);
    {
      const pos = trunkGeo.attributes.position, uv = trunkGeo.attributes.uv;
      const col = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        uv.setXY(i, uv.getX(i) * 4, y * 13);
        // Root flare: the buttresses are not round.
        if (y < 0.05) { const a = Math.atan2(pos.getZ(i), pos.getX(i)); const k = 1 + 0.16 * Math.sin(a * 5.0 + 1.3) * (1 - y / 0.05); pos.setX(i, pos.getX(i) * k); pos.setZ(i, pos.getZ(i) * k); }
        const shade = 0.5 + 0.5 * Math.min(1, y / 0.06) - 0.25 * Math.max(0, (y - 0.35) / 0.65);
        col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = shade;
      }
      trunkGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      trunkGeo.computeVertexNormals();
    }
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: '#ffffff', map: once('bark', barkTexture), vertexColors: true }), trees.length);
    // Crowns: tiers of drooping boughs, dark inside, lit along their edges.
    const crownGeo = new THREE.ConeGeometry(1, 1, 8, 2).toNonIndexed();
    crownGeo.translate(0, 0.5, 0);
    {
      const pos = crownGeo.attributes.position;
      const col = new Float32Array(pos.count * 3);
      const jr = rand(5);
      const jit = new Map<string, number>();
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
        if (!jit.has(key)) jit.set(key, jr());
        const j = jit.get(key)!;
        const rimK = Math.hypot(x, z);
        // The skirt droops and is ragged.
        if (y < 0.01) { pos.setY(i, -0.1 - j * 0.22 * rimK); pos.setX(i, x * (0.86 + j * 0.3)); pos.setZ(i, z * (0.86 + j * 0.3)); }
        else if (y < 0.99) { pos.setX(i, x * (0.9 + j * 0.3)); pos.setZ(i, z * (0.9 + j * 0.3)); }
        const lit = y < 0.01 ? 1.25 : y > 0.99 ? 1.05 : 0.72;
        col[i * 3] = lit * 1.04; col[i * 3 + 1] = lit; col[i * 3 + 2] = lit * 0.82;
      }
      crownGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      crownGeo.computeVertexNormals();
    }
    const LAYERS = 4;
    const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshLambertMaterial({ flatShading: true, vertexColors: true }), trees.length * LAYERS);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
    trees.forEach((t, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28);
      m.compose(new THREE.Vector3(t.x, 0, t.z), q, new THREE.Vector3(t.rad, t.h, t.rad));
      trunks.setMatrixAt(i, m);
      trunks.setColorAt(i, c.setHSL(0.028 + r() * 0.03, 0.5 + r() * 0.15, 0.36 + r() * 0.1));
      for (let k = 0; k < LAYERS; k++) {
        const y = t.h * (0.42 + k * 0.15);
        const w = t.rad * (5.2 - k * 0.9) * (0.85 + r() * 0.3);
        m.compose(new THREE.Vector3(t.x + (r() - 0.5), y, t.z + (r() - 0.5)), q, new THREE.Vector3(w, t.h * 0.24, w));
        crowns.setMatrixAt(i * LAYERS + k, m);
        crowns.setColorAt(i * LAYERS + k, c.setHSL(0.27 + r() * 0.07, 0.36 + r() * 0.16, 0.2 + r() * 0.09));
      }
    });
    trunks.castShadow = false; crowns.castShadow = false;
    scene.add(trunks, crowns);

    // Undergrowth: sword ferns along the shoulders and back among the trunks,
    // each a rosette of arching fronds, dark at the heart and bright at the tips.
    const frond: number[] = [], fcol: number[] = [];
    const FRONDS = 5, SEG = 2;
    for (let f = 0; f < FRONDS; f++) {
      const a = (f / FRONDS) * Math.PI * 2 + (f % 2) * 0.3;
      const ca = Math.cos(a), sa = Math.sin(a);
      const at = (t: number, sgn: number): [number, number, number] => {
        const rad = 0.08 + t * 0.95, y = Math.sin(Math.PI * t * 0.82) * 0.5, wd = 0.17 * Math.sin(Math.PI * (t * 0.88 + 0.12)) * sgn;
        return [ca * rad - sa * wd, y, sa * rad + ca * wd];
      };
      for (let k = 0; k < SEG; k++) {
        const t0 = k / SEG, t1 = (k + 1) / SEG;
        const quad = [at(t0, -1), at(t0, 1), at(t1, -1), at(t1, -1), at(t0, 1), at(t1, 1)];
        const ts = [t0, t0, t1, t1, t0, t1];
        quad.forEach((p, i) => { frond.push(...p); const l = 0.42 + 0.78 * ts[i]; fcol.push(l * 0.92, l, l * 0.7); });
      }
    }
    const fernGeo = new THREE.BufferGeometry();
    fernGeo.setAttribute('position', new THREE.Float32BufferAttribute(frond, 3));
    fernGeo.setAttribute('color', new THREE.Float32BufferAttribute(fcol, 3));
    fernGeo.computeVertexNormals();
    const count = lowSpec ? 260 : 600;
    const bushes = new THREE.InstancedMesh(fernGeo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), count);
    for (let i = 0; i < count; i++) {
      const z = -150 + r() * 172;
      const side = r() < 0.5 ? -1 : 1;
      const off = 4.6 + Math.pow(r(), 1.5) * 17;
      const s2 = (0.55 + r() * 0.75) * (off < 7 ? 0.75 : 1.15);
      q.setFromEuler(new THREE.Euler((r() - 0.5) * 0.25, r() * 6.28, (r() - 0.5) * 0.25));
      m.compose(new THREE.Vector3(roadX(z) + side * off, 0, z), q, new THREE.Vector3(s2, s2 * (0.8 + r() * 0.5), s2));
      bushes.setMatrixAt(i, m);
      // Mostly deep green; here and there one standing in the sun.
      const bright = r() < 0.22;
      bushes.setColorAt(i, c.setHSL(0.24 + r() * 0.07, bright ? 0.62 : 0.42 + r() * 0.14, bright ? 0.5 : 0.27 + r() * 0.12));
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

  // Light coming down through the trees, and what drifts in it.
  const shafts = buildShafts(lowSpec, roadX);
  const motes = buildMotes(lowSpec, roadX);
  (motes.points.material as THREE.ShaderMaterial).uniforms.uPx.value = renderer ? renderer.getPixelRatio() : 1;
  scene.add(shafts.mesh, motes.points);
  let clock = 0;

  return {
    scene,
    sun,
    focus(x, z) {
      // In steps, so shadow edges don't swim as you walk.
      const qx = Math.round(x / 3) * 3, qz = Math.round(z / 3) * 3;
      if (sun.target.position.x === qx && sun.target.position.z === qz) return;
      sun.target.position.set(qx, 0, qz);
      sun.position.copy(SUN_DIR).multiplyScalar(40).add(sun.target.position);
      sun.target.updateMatrixWorld();
    },
    update(dt) {
      clock += dt;
      skyMat.uniforms.uT.value = clock;
      shafts.update(clock);
      motes.update(clock);
    },
  };
}
