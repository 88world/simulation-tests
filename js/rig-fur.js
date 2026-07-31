/* rig-fur.js — Shell-rendered fur in a wind field.
   The mesh is drawn N times as concentric shells pushed out along the normal.
   A baked strand texture decides which texels survive at each shell height, so
   the fur is really a stack of cross-sections through a field of tapered cones.
   Wind and gravity bend the strand as a cantilever: displacement grows as h². */
(function (Bench) {
  'use strict';

  const { Program, screenProgram, Orbit, mulberry32, hexToRgb } = Bench;
  const { HASH, NOISE, TONEMAP } = Bench.glsl;

  /* --------------------------------------------------------------- geometry */

  function sphereMesh(segs, rings, radius) {
    const pos = [], nrm = [], uv = [], idx = [];
    for (let y = 0; y <= rings; y++) {
      const v = y / rings, phi = v * Math.PI;
      for (let x = 0; x <= segs; x++) {
        const u = x / segs, theta = u * Math.PI * 2;
        const nx = Math.sin(phi) * Math.cos(theta), ny = Math.cos(phi), nz = Math.sin(phi) * Math.sin(theta);
        nrm.push(nx, ny, nz);
        pos.push(nx * radius, ny * radius, nz * radius);
        uv.push(u, v);
      }
    }
    for (let y = 0; y < rings; y++) {
      for (let x = 0; x < segs; x++) {
        const a = y * (segs + 1) + x, b = a + segs + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    return { pos, nrm, uv, idx };
  }

  /** Tube swept along a parametric curve, framed by parallel transport so the
      strand texture does not shear or flip on a knotted path. */
  function tubeMesh(curve, segs, sides, radius) {
    const pts = [], tans = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const p = curve(t * Math.PI * 2);
      const q = curve((t + 1e-3) * Math.PI * 2);
      let tx = q[0] - p[0], ty = q[1] - p[1], tz = q[2] - p[2];
      const l = Math.hypot(tx, ty, tz) || 1;
      pts.push(p); tans.push([tx / l, ty / l, tz / l]);
    }
    // Seed a normal perpendicular to the first tangent, then transport it.
    let n = [0, 1, 0];
    const t0 = tans[0];
    if (Math.abs(t0[1]) > 0.9) n = [1, 0, 0];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    let bi = norm(cross(t0, n));
    n = norm(cross(bi, t0));

    const pos = [], nrm = [], uvs = [], idx = [];
    for (let i = 0; i <= segs; i++) {
      const T = tans[i];
      if (i > 0) { bi = norm(cross(T, n)); n = norm(cross(bi, T)); }
      const P = pts[i];
      for (let j = 0; j <= sides; j++) {
        const a = (j / sides) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const nx = n[0] * ca + bi[0] * sa, ny = n[1] * ca + bi[1] * sa, nz = n[2] * ca + bi[2] * sa;
        nrm.push(nx, ny, nz);
        pos.push(P[0] + nx * radius, P[1] + ny * radius, P[2] + nz * radius);
        uvs.push(i / segs, j / sides);
      }
    }
    for (let i = 0; i < segs; i++) {
      for (let j = 0; j < sides; j++) {
        const a = i * (sides + 1) + j, b = a + sides + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    return { pos, nrm, uv: uvs, idx };
  }

  const CURVES = {
    torus: (t) => [Math.cos(t) * 0.72, Math.sin(t) * 0.72, 0],
    knot: (t) => {
      const p = 2, q = 3, r = 0.62 * (2 + Math.cos(q * t));
      return [r * Math.cos(p * t) * 0.62, r * Math.sin(p * t) * 0.62, 0.62 * Math.sin(q * t)];
    }
  };

  /* -------------------------------------------------------- strand texture */

  /** Bakes tapered strands: each texel stores the shell height the strand still
      covers, so thresholding by height carves a cone out of the stack. */
  function bakeFur(gl, size, strands, seed) {
    const rnd = mulberry32(seed);
    const data = new Uint8Array(size * size * 4);
    for (let s = 0; s < strands; s++) {
      const cx = rnd() * size, cy = rnd() * size;
      const len = 0.35 + rnd() * 0.65;
      const rad = 2.0 + rnd() * 3.4;
      const tintA = (rnd() * 255) | 0, tintB = (rnd() * 255) | 0;
      const r0 = Math.ceil(rad);
      for (let dy = -r0; dy <= r0; dy++) {
        for (let dx = -r0; dx <= r0; dx++) {
          const d = Math.hypot(dx, dy);
          if (d > rad) continue;
          // Wrap: the texture tiles across the surface, so strands must too.
          const x = ((((cx + dx) | 0) % size) + size) % size;
          const y = ((((cy + dy) | 0) % size) + size) % size;
          const i = (y * size + x) * 4;
          // Flat-topped profile rather than a linear cone: bilinear filtering
          // smooths this field, and a soft edge lets the gaps between hairs
          // fill in until the coat reads as a sheet.
          const v = len * Math.pow(1 - d / rad, 0.55);
          const q = Math.min(255, (v * 255) | 0);
          if (q > data[i]) { data[i] = q; data[i + 1] = tintA; data[i + 2] = tintB; data[i + 3] = 255; }
        }
      }
    }
    // Deliberately unmipped: the shader thresholds this value per shell, and a
    // filtered-down mask closes the gaps between hairs into a solid sheet.
    return Bench.createTexture(gl, size, size, { format: 'rgba8', filter: 'LINEAR', wrap: 'REPEAT', data });
  }

  /* ---------------------------------------------------------------- shaders */

  const FUR_VS = HASH + NOISE + `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
uniform mat4 uViewProj;
uniform float uShells, uLength, uTime, uWind, uGust, uAngle, uGravity, uStiffness, uShellBase;
out vec2 vUv;
out float vH;
out vec3 vNormal, vWorld, vStrand;

vec3 windField(vec3 p, float t){
  vec3 dir = vec3(cos(uAngle), 0.0, sin(uAngle));
  // A travelling gust front plus rolling turbulence — the two together are what
  // stop the coat looking like it is being blown by a fan.
  float front = sin(dot(p, dir) * 3.4 - t * 2.6);
  float rough = noise3(p * 2.6 + vec3(0.0, 0.0, t * 0.9));
  float gust = mix(1.0, 0.35 + 0.65 * (front * 0.5 + 0.5) + rough * 0.8, uGust);
  vec3 turb = vec3(rough, noise3(p * 3.1 + vec3(11.0, t * 1.1, 0.0)) * 0.45, noise3(p * 2.9 + vec3(0.0, 4.0, t * 0.7)));
  return dir * uWind * gust + turb * uWind * uGust * 0.55;
}

void main(){
  float h = (float(gl_InstanceID) + uShellBase) / max(uShells - 1.0, 1.0);
  vec3 n = normalize(aNormal);

  vec3 bend = windField(aPos, uTime) + vec3(0.0, -uGravity, 0.0);
  // Only the tangential part bends the strand. Clamping the result per-vertex
  // instead would kink the displacement along mesh edges and facet the coat.
  bend -= n * dot(bend, n);
  // Stiff strands resist near the root; the exponent controls how much.
  float k = pow(h, mix(1.15, 2.6, uStiffness));

  vec3 offset = n * (h * uLength) + bend * k * uLength;

  vec3 world = aPos + offset;
  // d(offset)/dh — the actual direction the strand points, used for hair specular.
  vec3 strandDir = normalize(n * uLength + bend * uLength * 2.0 * max(h, 0.05));

  vH = h;
  vUv = aUv;
  vNormal = n;
  vStrand = strandDir;
  vWorld = world;
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

  const FUR_FS = TONEMAP + `
in vec2 vUv;
in float vH;
in vec3 vNormal, vWorld, vStrand;
uniform sampler2D uFur;
uniform vec2 uTile;
uniform vec3 uRoot, uTip, uEye, uLight;
uniform float uDensity, uShine, uOcclusion, uRim, uCoat;
uniform int uMode;   // 0 lit, 1 shell height, 2 strand direction
out vec4 fragColor;

void main(){
  vec4 f = texture(uFur, vUv * uTile * uCoat);
  float len = f.r * uDensity;
  if (vH > 0.0 && len < vH) discard;

  // Soft tip: fade the last sliver of each strand instead of cutting it flat.
  float alpha = vH > 0.0 ? clamp((len - vH) * 26.0, 0.0, 1.0) : 1.0;
  if (alpha < 0.02) discard;

  if (uMode == 1) {
    fragColor = vec4(toSRGB(mix(vec3(0.05, 0.10, 0.16), vec3(0.85, 0.95, 0.45), vH)), alpha);
    return;
  }
  if (uMode == 2) {
    fragColor = vec4(toSRGB(normalize(vStrand) * 0.5 + 0.5), alpha);
    return;
  }

  vec3 V = normalize(uEye - vWorld);
  vec3 L = normalize(uLight);
  vec3 T = normalize(vStrand);
  vec3 N = normalize(mix(vNormal, T, 0.35));

  // Kajiya–Kay: a hair strand has no single normal, so the highlight comes off
  // the tangent. The body form still has to come from N·L, though — leaning on
  // the tangent term alone lights the terminator and flattens the silhouette.
  float TdotL = dot(T, L), TdotV = dot(T, V);
  float sinTL = sqrt(max(0.0, 1.0 - TdotL * TdotL));
  float sinTV = sqrt(max(0.0, 1.0 - TdotV * TdotV));
  float wrap = clamp(dot(N, L) * 0.7 + 0.3, 0.0, 1.0);   // fur scatters: soft terminator
  float diffuse = wrap * 0.9 + sinTL * 0.22;
  float fill = clamp(N.y * 0.5 + 0.5, 0.0, 1.0) * 0.16;  // bounce from above
  float spec = pow(max(0.0, -TdotL * TdotV + sinTL * sinTV), mix(12.0, 160.0, uShine));

  // Deeper shells sit inside the coat and receive less light.
  float ao = mix(1.0 - uOcclusion, 1.0, pow(vH, 1.35));
  float tint = 0.78 + 0.44 * f.g;

  vec3 base = mix(uRoot, uTip, pow(vH, 0.85)) * tint;
  vec3 col = base * (0.05 + diffuse + fill) * ao;
  col += vec3(1.0, 0.95, 0.86) * spec * 0.55 * ao * (0.25 + 0.75 * vH);

  float rim = pow(1.0 - max(dot(N, V), 0.0), 2.6);
  col += mix(uRoot, uTip, 0.8) * rim * uRim * (0.3 + 0.7 * vH);

  fragColor = vec4(toSRGB(aces(col)), alpha);
}`;

  const BACKDROP = TONEMAP + `
in vec2 vUv;
uniform vec2 uResolution;
uniform vec3 uTint;
uniform float uTime;
out vec4 fragColor;
void main(){
  vec2 p = (vUv - vec2(0.5, 0.42)) * vec2(uResolution.x / uResolution.y, 1.0);
  float d = length(p);
  // Studio sweep: one soft key from upper left, everything else falls to ink.
  vec3 col = mix(uTint * 0.035, vec3(0.006, 0.008, 0.011), smoothstep(0.0, 0.62, d));
  col += uTint * 0.028 * smoothstep(0.7, 0.0, length(p - vec2(-0.30, 0.30)));
  col += (grain(vUv, uTime) - 0.5) * 0.008;
  fragColor = vec4(toSRGB(max(col, 0.0)), 1.0);
}`;

  /* ------------------------------------------------------------------ the rig */

  Bench.registerRig({
    id: 'fur',
    name: 'Fur',
    method: 'Shell rendering',
    accent: '#9BD642',
    blurb: 'Sixty-four concentric shells of the same mesh, each one a slice through a field of tapered strands. Wind and gravity bend every strand as a cantilever, so displacement grows with the square of the distance from the root.',
    hint: 'Drag to orbit · scroll to zoom',
    controls: [
      { id: 'object', label: 'Body', type: 'select', value: 'sphere', options: [['sphere', 'Sphere'], ['torus', 'Torus'], ['knot', 'Trefoil knot']] },
      { id: 'mode', label: 'View', type: 'select', value: 'lit', options: [['lit', 'Lit'], ['height', 'Shell height'], ['strand', 'Strand direction']] },
      { id: 'shells', label: 'Shells', type: 'range', min: 8, max: 128, step: 1, value: 64 },
      { id: 'length', label: 'Fur length', type: 'range', min: 0.02, max: 0.6, step: 0.005, value: 0.3 },
      { id: 'density', label: 'Density', type: 'range', min: 0.2, max: 1.6, step: 0.01, value: 1.0 },
      { id: 'coat', label: 'Strand scale', type: 'range', min: 0.4, max: 4, step: 0.05, value: 1.0 },
      { id: 'wind', label: 'Wind', type: 'range', min: 0, max: 2.5, step: 0.01, value: 0.62 },
      { id: 'gust', label: 'Gustiness', type: 'range', min: 0, max: 1, step: 0.01, value: 0.7 },
      { id: 'angle', label: 'Wind bearing', type: 'range', min: 0, max: 6.28, step: 0.01, value: 0.8 },
      { id: 'gravity', label: 'Gravity', type: 'range', min: 0, max: 2, step: 0.01, value: 0.45 },
      { id: 'stiffness', label: 'Stiffness', type: 'range', min: 0, max: 1, step: 0.01, value: 0.55 },
      { id: 'shine', label: 'Sheen', type: 'range', min: 0, max: 1, step: 0.01, value: 0.5 },
      { id: 'occlusion', label: 'Depth shading', type: 'range', min: 0, max: 1, step: 0.01, value: 0.88 },
      { id: 'rim', label: 'Rim light', type: 'range', min: 0, max: 2, step: 0.01, value: 0.7 },
      { id: 'root', label: 'Root', type: 'color', value: '#1B2608' },
      { id: 'tip', label: 'Tip', type: 'color', value: '#C8E86A' }
    ],

    create(gl, ctx) {
      const prog = new Program(gl, FUR_VS, FUR_FS);
      const backdrop = screenProgram(gl, BACKDROP);
      const orbit = new Orbit(ctx.canvas, { dist: 2.9, phi: 1.35, minDist: 1.1, maxDist: 8 });
      const furTex = bakeFur(gl, 1024, 14000, 20260731);

      let vao = null, ibo = null, vbo = null, indexCount = 0, tile = [1.5, 0.75], tris = 0;

      function buildMesh(kind) {
        tile = kind === 'sphere' ? [1.5, 0.75] : [4, 1];
        const m = kind === 'sphere' ? sphereMesh(96, 64, 0.9) : tubeMesh(CURVES[kind], kind === 'knot' ? 420 : 220, 56, 0.3);
        const n = m.pos.length / 3;
        const inter = new Float32Array(n * 8);
        for (let i = 0; i < n; i++) {
          inter[i * 8] = m.pos[i * 3]; inter[i * 8 + 1] = m.pos[i * 3 + 1]; inter[i * 8 + 2] = m.pos[i * 3 + 2];
          inter[i * 8 + 3] = m.nrm[i * 3]; inter[i * 8 + 4] = m.nrm[i * 3 + 1]; inter[i * 8 + 5] = m.nrm[i * 3 + 2];
          inter[i * 8 + 6] = m.uv[i * 2]; inter[i * 8 + 7] = m.uv[i * 2 + 1];
        }
        if (vao) { gl.deleteVertexArray(vao); gl.deleteBuffer(vbo); gl.deleteBuffer(ibo); }
        vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, inter, gl.STATIC_DRAW);
        const stride = 32;
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
        ibo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(m.idx), gl.STATIC_DRAW);
        gl.bindVertexArray(null);
        indexCount = m.idx.length;
        tris = indexCount / 3;
      }

      let lastObject = ctx.params.object;
      buildMesh(lastObject);

      const modes = { lit: 0, height: 1, strand: 2 };

      return {
        resize() {},

        frame(dt, time) {
          const P = ctx.params;
          if (P.object !== lastObject) { lastObject = P.object; buildMesh(lastObject); }

          const vp = orbit.update(dt, ctx.width / ctx.height, 0.85);
          const tint = hexToRgb(P.tip);

          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, ctx.width, ctx.height);
          gl.disable(gl.DEPTH_TEST);
          gl.disable(gl.BLEND);
          gl.depthMask(false);
          backdrop.use().v2('uResolution', ctx.width, ctx.height)
            .v3('uTint', tint[0], tint[1], tint[2]).f('uTime', time);
          gl.drawArrays(gl.TRIANGLES, 0, 3);

          // depthMask must be restored *before* the clear: glClear honours the
          // write mask, so clearing with writes disabled is silently a no-op and
          // every frame would then test against last frame's depth.
          gl.depthMask(true);
          gl.clear(gl.DEPTH_BUFFER_BIT);
          gl.enable(gl.DEPTH_TEST);
          gl.depthFunc(gl.LEQUAL);
          gl.enable(gl.CULL_FACE);
          gl.cullFace(gl.BACK);

          const root = hexToRgb(P.root), tipc = hexToRgb(P.tip);
          const e = orbit.eye;
          prog.use()
            .mat4('uViewProj', vp)
            .f('uShells', P.shells).f('uLength', P.length).f('uTime', time)
            .f('uWind', P.wind).f('uGust', P.gust).f('uAngle', P.angle)
            .f('uGravity', P.gravity).f('uStiffness', P.stiffness)
            .v3('uRoot', root[0], root[1], root[2])
            .v3('uTip', tipc[0], tipc[1], tipc[2])
            .v3('uEye', e[0], e[1], e[2])
            .v3('uLight', -0.45, 0.85, 0.5)
            .v2('uTile', tile[0], tile[1])
            .f('uDensity', P.density).f('uShine', P.shine).f('uCoat', P.coat)
            .f('uOcclusion', P.occlusion).f('uRim', P.rim)
            .i('uMode', modes[P.mode])
            .tex('uFur', furTex);

          gl.bindVertexArray(vao);

          // Pass 1 — the skin. Opaque, and the only thing that writes depth.
          gl.disable(gl.BLEND);
          gl.depthMask(true);
          prog.f('uShellBase', 0.0);
          gl.drawElementsInstanced(gl.TRIANGLES, indexCount, gl.UNSIGNED_INT, 0, 1);

          // Pass 2 — the coat. Shells are wind-displaced, so an outer shell can
          // land behind an inner one and depth-reject it; with writes off, the
          // inner-to-outer draw order alone resolves the stack.
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.depthMask(false);
          prog.f('uShellBase', 1.0);
          const coat = Math.max(0, (P.shells | 0) - 1);
          if (coat > 0) gl.drawElementsInstanced(gl.TRIANGLES, indexCount, gl.UNSIGNED_INT, 0, coat);

          gl.depthMask(true);
          gl.bindVertexArray(null);

          gl.disable(gl.CULL_FACE);
          gl.disable(gl.BLEND);
          gl.disable(gl.DEPTH_TEST);
        },

        stats() {
          const shells = ctx.params.shells | 0;
          const total = tris * shells;
          return [
            ['shells', String(shells)],
            ['mesh', (tris / 1000).toFixed(1) + ' K tri'],
            ['drawn', total >= 1e6 ? (total / 1e6).toFixed(2) + ' M tri' : Math.round(total / 1000) + ' K tri'],
            ['strands', '14 K baked']
          ];
        },

        dispose() {
          prog.dispose(); backdrop.dispose(); orbit.dispose();
          gl.deleteTexture(furTex);
          if (vao) { gl.deleteVertexArray(vao); gl.deleteBuffer(vbo); gl.deleteBuffer(ibo); }
        }
      };
    }
  });
})(window.Bench);
