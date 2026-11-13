// The look: golden hour on a road through the redwoods.
//
// Four things make the picture, and all of them live in the shaders every
// material already runs (no extra passes, nothing to composite):
//
//   grade     the film curve, then cool shadows and warm highlights
//   haze      air you can see: thicker near the ground, gold toward the sun,
//             lavender away from it
//   dapple    the long shadows of the trunks raking across the road and the
//             forest floor, warm light between them
//   rim       the low sun catching the edge of a person
//
// plus two things that are drawn: shafts of light coming down through the
// trees, and motes drifting in them.

import * as THREE from 'three';

/** Where the sun is: low, ahead and to the left as you look down the road. */
export const SUN_DIR = new THREE.Vector3(-0.62, 0.24, -0.75).normalize();

const glsl = (v: THREE.Vector3) => `vec3(${v.x.toFixed(5)}, ${v.y.toFixed(5)}, ${v.z.toFixed(5)})`;

let installed = false;

/** Teach three's own shaders the look. Safe to call more than once; does nothing without a DOM-less renderer either. */
export function installLook() {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk;
  const SUN = glsl(SUN_DIR);

  // ---- grade
  C.tonemapping_pars_fragment = C.tonemapping_pars_fragment.replace(
    'vec3 CustomToneMapping( vec3 color ) { return color; }',
    /* glsl */`vec3 CustomToneMapping( vec3 color ) {
      vec3 c = ACESFilmicToneMapping( color );
      float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
      // Shadows lean cool, highlights lean warm: evening light.
      c *= mix( vec3( 0.88, 0.97, 1.12 ), vec3( 1.08, 1.0, 0.88 ), smoothstep( 0.04, 0.7, l ) );
      l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
      c = mix( vec3( l ), c, 1.16 );
      c = clamp( c, 0.0, 1.0 );
      // A little more shape in the mids.
      return mix( c, c * c * ( 3.0 - 2.0 * c ), 0.24 );
    }`,
  );

  // ---- haze (the varying it adds also gives every fragment its place in the world)
  C.fog_pars_vertex = /* glsl */`
    #ifdef USE_FOG
      varying float vFogDepth;
      varying vec3 vFogVec;
    #endif`;
  C.fog_vertex = /* glsl */`
    #ifdef USE_FOG
      vFogDepth = - mvPosition.z;
      // From the eye to here, in world axes.
      vFogVec = ( vec4( mvPosition.xyz, 0.0 ) * viewMatrix ).xyz;
    #endif`;
  C.fog_pars_fragment = /* glsl */`
    #ifdef USE_FOG
      uniform vec3 fogColor;
      varying float vFogDepth;
      varying vec3 vFogVec;
      #ifdef FOG_EXP2
        uniform float fogDensity;
      #else
        uniform float fogNear;
        uniform float fogFar;
      #endif
    #endif`;
  C.fog_fragment = /* glsl */`
    #ifdef USE_FOG
      float hazeD = length( vFogVec );
      vec3 hazeDir = vFogVec / max( hazeD, 0.0001 );
      // Thicker down among the ferns than up in the crowns.
      float hazeY = cameraPosition.y + vFogVec.y * 0.5;
      float hazeK = 1.0 - exp( - hazeD * 0.0046 * mix( 1.0, 0.3, clamp( hazeY / 45.0, 0.0, 1.0 ) ) );
      float hazeSun = max( dot( hazeDir, ${SUN} ), 0.0 );
      vec3 hazeCol = mix( fogColor, vec3( 1.0, 0.79, 0.5 ), pow( hazeSun, 4.0 ) * 0.9 );
      gl_FragColor.rgb = mix( gl_FragColor.rgb, hazeCol, hazeK );
    #endif`;

  // ---- dapple (materials that ask for it with the DAPPLE define)
  C.color_pars_fragment += /* glsl */`
    #ifdef DAPPLE
      float dappleHash( vec2 p ) { vec3 q3 = fract( vec3( p.xyx ) * 0.1031 ); q3 += dot( q3, q3.yzx + 33.33 ); return fract( ( q3.x + q3.y ) * q3.z ); }
      float dappleNoise( vec2 p ) {
        vec2 i = floor( p ), f = fract( p );
        f = f * f * ( 3.0 - 2.0 * f );
        return mix( mix( dappleHash( i ), dappleHash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( dappleHash( i + vec2( 0.0, 1.0 ) ), dappleHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
      }
    #endif`;
  C.color_fragment += /* glsl */`
    #if defined( DAPPLE ) && defined( USE_FOG )
      vec2 dappleP = ( cameraPosition + vFogVec ).xz;
      // Across the sun and along it: shadows of trunks are long and thin.
      vec2 dappleS = normalize( ${SUN}.xz );
      vec2 dappleQ = vec2( dot( dappleP, vec2( - dappleS.y, dappleS.x ) ), dot( dappleP, dappleS ) );
      float dappleN = dappleNoise( dappleQ * vec2( 0.4, 0.07 ) ) * 0.6 + dappleNoise( dappleQ * vec2( 1.05, 0.21 ) + 7.3 ) * 0.4;
      float dappleLit = smoothstep( 0.36, 0.56, dappleN );
      // (Far off it settles to an even tone rather than shimmer.)
      dappleLit = mix( dappleLit, 0.45, smoothstep( 70.0, 190.0, length( vFogVec ) ) );
      diffuseColor.rgb *= mix( vec3( 0.6, 0.66, 0.84 ), vec3( 1.22, 1.07, 0.84 ), dappleLit );
    #endif`;

  // ---- rim (materials that ask for it with the RIM define)
  C.opaque_fragment = /* glsl */`
    #ifdef RIM
      float rimF = pow( 1.0 - clamp( dot( normal, normalize( vViewPosition ) ), 0.0, 1.0 ), 3.0 );
      vec3 rimSun = normalize( ( viewMatrix * vec4( ${SUN}, 0.0 ) ).xyz );
      outgoingLight += vec3( 1.0, 0.7, 0.4 ) * rimF * clamp( dot( normal, rimSun ) * 0.6 + 0.55, 0.0, 1.0 ) * float( RIM );
    #endif
    ` + C.opaque_fragment;
}

/** The low sun catches the edge of this (people, leather). */
export function rim<T extends THREE.Material>(mat: T, amount = 0.4): T {
  const d = mat as THREE.Material & { defines?: Record<string, unknown> };
  d.defines = { ...(d.defines ?? {}), RIM: amount.toFixed(3) };
  return mat;
}

/** The trunks' long shadows fall across this (the ground). */
export function dappled<T extends THREE.Material>(mat: T): T {
  const d = mat as THREE.Material & { defines?: Record<string, unknown> };
  d.defines = { ...(d.defines ?? {}), DAPPLE: 1 };
  return mat;
}

function rand(seed: number) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

/**
 * Shafts of light coming down through the trees: long, thin, soft-edged
 * sheets along the sun's own direction, each one two crossed planes so it has
 * body from wherever you stand. One draw call.
 */
export function buildShafts(lowSpec: boolean, roadX: (z: number) => number): { mesh: THREE.Mesh; update(t: number): void } {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 256;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(64, 256);
  const r = rand(23);
  const streak = Array.from({ length: 64 }, () => 0.75 + r() * 0.25);
  for (let y = 0; y < 256; y++) {
    const v = 1 - y / 255;
    // Born up in the crowns, gone before it reaches the ground.
    const along = Math.min(1, v / 0.22) * Math.min(1, (1 - v) / 0.3);
    for (let x = 0; x < 64; x++) {
      const u = x / 63;
      const across = Math.pow(Math.sin(Math.PI * u), 1.6);
      const a = across * along * along * (3 - 2 * along) * streak[x];
      const i = (y * 64 + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(255 * a);
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;

  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  const w1 = new THREE.Vector3().crossVectors(SUN_DIR, up).normalize();
  const w2 = new THREE.Vector3().crossVectors(SUN_DIR, w1).normalize();
  const n = lowSpec ? 9 : 16;
  for (let i = 0; i < n; i++) {
    // Feet of the shafts walk down the road, either side of it and across it.
    const z = -128 + (i / n) * 150 + (r() - 0.5) * 6;
    const x = roadX(z) + (r() - 0.5) * 22;
    const len = 46 + r() * 26, wide = 1.3 + r() * 2.4;
    const foot = new THREE.Vector3(x, 0.4, z), top = foot.clone().addScaledVector(SUN_DIR, len);
    for (const w of [w1, w2]) {
      const b = pos.length / 3;
      for (const [p, v] of [[foot, 0], [top, 1]] as const) {
        for (const s of [-1, 1]) { pos.push(p.x + w.x * wide * s, p.y + w.y * wide * s, p.z + w.z * wide * s); uv.push(s < 0 ? 0 : 1, v); }
      }
      idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const mat = new THREE.MeshBasicMaterial({ map: tex, color: '#ffd08a', transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  // The air moves: they breathe, slowly.
  return { mesh, update: (t) => { mat.opacity = 0.2 + Math.sin(t * 0.23) * 0.025 + Math.sin(t * 0.61 + 1.7) * 0.012; } };
}

/** Pollen and dust drifting where the light comes through. One draw call. */
export function buildMotes(lowSpec: boolean, roadX: (z: number) => number): { points: THREE.Points; update(t: number): void } {
  const n = lowSpec ? 110 : 240;
  const pos = new Float32Array(n * 3), seed = new Float32Array(n);
  const r = rand(61);
  for (let i = 0; i < n; i++) {
    const z = -120 + r() * 140;
    pos[i * 3] = roadX(z) + (r() - 0.5) * 16;
    pos[i * 3 + 1] = 0.4 + Math.pow(r(), 1.6) * 6.5;
    pos[i * 3 + 2] = z;
    seed[i] = r() * 100;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    uniforms: { uT: { value: 0 }, uPx: { value: 1 } },
    vertexShader: /* glsl */`
      attribute float seed;
      uniform float uT, uPx;
      varying float vA;
      void main() {
        vec3 p = position;
        p.x += sin( uT * 0.17 + seed ) * 0.5 + uT * 0.02;
        p.y += sin( uT * 0.11 + seed * 1.7 ) * 0.35;
        p.z += cos( uT * 0.13 + seed * 0.6 ) * 0.5;
        vec4 mv = modelViewMatrix * vec4( p, 1.0 );
        gl_Position = projectionMatrix * mv;
        float d = - mv.z;
        gl_PointSize = clamp( uPx * 26.0 / d, 1.0, 5.0 * uPx );
        // They catch the light and lose it; close to the eye they are not there at all.
        vA = ( 0.35 + 0.65 * sin( uT * 0.9 + seed * 3.1 ) ) * smoothstep( 1.5, 5.0, d ) * ( 1.0 - smoothstep( 40.0, 70.0, d ) );
      }`,
    fragmentShader: /* glsl */`
      varying float vA;
      void main() {
        float r = length( gl_PointCoord - 0.5 ) * 2.0;
        gl_FragColor = vec4( 1.0, 0.86, 0.6, max( 0.0, 1.0 - r ) * max( vA, 0.0 ) * 0.55 );
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 3;
  return { points, update: (t) => { mat.uniforms.uT.value = t; } };
}
