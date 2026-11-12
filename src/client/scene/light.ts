// Image-based light: a small golden-hour sky, baked once into an environment
// map. It is what gives leather its soft sheen, puts warm light on the side of
// a face that the sun is on and cool sky in the shade, and keeps the unlit
// side of everything from going flat.

import * as THREE from 'three';

export interface SkyLight { zenith: THREE.ColorRepresentation; horizon: THREE.ColorRepresentation; ground: THREE.ColorRepresentation; sun: THREE.ColorRepresentation; sunDir: THREE.Vector3 }

const cache = new WeakMap<THREE.WebGLRenderer, Map<string, THREE.Texture>>();

/** The environment map for a sky (made once per renderer and sky). */
export function skyEnvironment(renderer: THREE.WebGLRenderer, sky: SkyLight): THREE.Texture {
  const key = JSON.stringify([new THREE.Color(sky.zenith).getHex(), new THREE.Color(sky.horizon).getHex(), new THREE.Color(sky.ground).getHex(), new THREE.Color(sky.sun).getHex(), sky.sunDir.toArray().map((v) => +v.toFixed(3))]);
  let byKey = cache.get(renderer);
  if (!byKey) cache.set(renderer, (byKey = new Map()));
  const hit = byKey.get(key);
  if (hit) return hit;

  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 32, 16);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const zen = new THREE.Color(sky.zenith), hor = new THREE.Color(sky.horizon), gnd = new THREE.Color(sky.ground), c = new THREE.Color();
  const dir = sky.sunDir.clone().normalize(), p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).normalize();
    if (p.y >= 0) c.copy(hor).lerp(zen, Math.pow(p.y, 0.55));
    else c.copy(hor).lerp(gnd, Math.min(1, -p.y * 5));
    // The sky glows round the sun.
    const near = Math.max(0, p.dot(dir));
    c.lerp(new THREE.Color(sky.sun), Math.pow(near, 6) * 0.7).multiplyScalar(1 + Math.pow(near, 24) * 2.2);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  // The sun itself: small and very bright, so polished things catch a highlight.
  const disc = new THREE.Mesh(new THREE.SphereGeometry(0.75, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(sky.sun).multiplyScalar(14) }));
  disc.position.copy(dir).multiplyScalar(9);
  scene.add(disc);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(scene, 0.035).texture;
  pmrem.dispose();
  geo.dispose();
  byKey.set(key, tex);
  return tex;
}

/** Light for the authoring pages: the game's evening sun, on a plain backdrop. */
export function studioLight(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
  const sunDir = new THREE.Vector3(-0.62, 0.42, -0.75).normalize();
  scene.environment = skyEnvironment(renderer, { zenith: '#4f86c6', horizon: '#f5b27a', ground: '#6b6a45', sun: '#ffd7a8', sunDir });
  scene.environmentIntensity = 0.7;
  scene.add(new THREE.HemisphereLight('#cfe0f5', '#5b4a2e', 0.5));
  const sun = new THREE.DirectionalLight('#ffd2a1', 2.6);
  sun.position.copy(sunDir).multiplyScalar(6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = sun.shadow.camera;
  s.left = -2; s.right = 2; s.top = 3; s.bottom = -1; s.near = 0.5; s.far = 20;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.01;
  scene.add(sun);
}
