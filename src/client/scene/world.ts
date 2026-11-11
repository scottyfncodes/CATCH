// The park: late-afternoon light, a mown lawn, trees, a few houses past the
// tree line, a backstop in the distance. Built from a handful of merged and
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
    s.left = -14; s.right = 14; s.top = 14; s.bottom = -14; s.near = 5; s.far = 90;
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

  // A worn patch where people stand to play catch most evenings.
  const worn = new THREE.Mesh(
    new THREE.CircleGeometry(11, 40),
    new THREE.MeshBasicMaterial({ color: '#c9b27a', transparent: true, opacity: 0.09, depthWrite: false }),
  );
  worn.rotation.x = -Math.PI / 2;
  worn.position.y = 0.005;
  scene.add(worn);

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
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6.28);
      const s = 0.35 + r() * 0.45;
      m.compose(new THREE.Vector3(Math.sin(a) * d, 0, Math.cos(a) * d), q, new THREE.Vector3(s, s * (0.8 + r() * 0.5), s));
      tufts.setMatrixAt(i, m);
      tufts.setColorAt(i, c.setHSL(0.23 + r() * 0.04, 0.45, 0.36 + r() * 0.1));
    }
    scene.add(tufts);
  }

  // Trees: clumps around the lawn, instanced trunks and canopies.
  {
    const r = rand(42);
    const spots: { x: number; z: number; s: number }[] = [];
    for (let i = 0; i < 34; i++) {
      const a = (i / 34) * Math.PI * 2 + (r() - 0.5) * 0.25;
      // Leave the sun side more open so the sky glows through.
      const open = Math.abs(Math.atan2(Math.sin(a - Math.atan2(SUN_DIR.x, SUN_DIR.z)), Math.cos(a - Math.atan2(SUN_DIR.x, SUN_DIR.z)))) < 0.5;
      const d = (open ? 52 : 30) + r() * 22;
      spots.push({ x: Math.sin(a) * d, z: Math.cos(a) * d, s: 0.8 + r() * 0.7 });
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

  // Houses past the trees and a distant ridge.
  {
    const r = rand(99);
    const parts: THREE.BufferGeometry[] = [];
    const sidings = ['#e9dcc4', '#c7d3d8', '#d9c09a', '#b8c9a8', '#e6cfc0', '#cfc4b0'];
    const roofs = ['#6b4f45', '#4e5459', '#7a5a43', '#5d4a3e'];
    for (let i = 0; i < 14; i++) {
      const a = Math.PI * 0.15 + (i / 14) * Math.PI * 1.4 + (r() - 0.5) * 0.1;
      const d = 82 + r() * 18;
      const w = 7 + r() * 4, h = 3.2 + r() * 2.6, dpt = 6 + r() * 3;
      const body = new THREE.BoxGeometry(w, h, dpt);
      body.translate(0, h / 2, 0);
      colorize(body, new THREE.Color(sidings[i % sidings.length]), 1, r);
      const roof = new THREE.CylinderGeometry(0.01, w * 0.62, 2 + r() * 1.2, 4, 1);
      roof.rotateY(Math.PI / 4);
      roof.scale(1, 1, dpt / w);
      roof.translate(0, h + 1, 0);
      colorize(roof, new THREE.Color(roofs[i % roofs.length]), 1, r);
      for (const g of [body, roof]) {
        g.rotateY(a + Math.PI);
        g.translate(Math.sin(a) * d, 0, Math.cos(a) * d);
        parts.push(g.toNonIndexed());
      }
    }
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

  // A backstop and a bench: just enough to say "park".
  {
    const parts: THREE.BufferGeometry[] = [];
    const metal = new THREE.Color('#8a8f93');
    const post = (x: number, z: number, h: number) => {
      const g = new THREE.CylinderGeometry(0.05, 0.05, h, 6); g.translate(x, h / 2, z); parts.push(colorize(g, metal).toNonIndexed());
    };
    const cx = 18, cz = 34;
    for (let i = 0; i < 5; i++) {
      const a = -0.7 + i * 0.35;
      post(cx + Math.sin(a) * 6, cz + Math.cos(a) * 6, 4.2);
    }
    const mesh = new THREE.CylinderGeometry(6, 6, 3.8, 18, 1, true, -0.7, 1.4);
    mesh.translate(cx, 2.2, cz);
    parts.push(colorize(mesh, metal).toNonIndexed());
    const wood = new THREE.Color('#7b5a3c');
    const seat = new THREE.BoxGeometry(2, 0.06, 0.45); seat.translate(-13, 0.46, -12);
    const back = new THREE.BoxGeometry(2, 0.4, 0.05); back.translate(-13, 0.8, -12.22);
    const l1 = new THREE.BoxGeometry(0.08, 0.46, 0.4); l1.translate(-13.85, 0.23, -12);
    const l2 = l1.clone(); l2.translate(1.7, 0, 0);
    for (const g of [seat, back, l1, l2]) { g.rotateY(0.6); parts.push(colorize(g, wood).toNonIndexed()); }
    const merged = mergeGeometries(parts.map((p) => { p.deleteAttribute('uv'); return p; }));
    merged.computeVertexNormals();
    const m = new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.95, side: THREE.DoubleSide }));
    scene.add(m);
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
