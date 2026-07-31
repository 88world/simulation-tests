/* rig-particles.js — GPGPU particles.
   Position and velocity live in float textures; the whole system is integrated
   in two fragment passes per frame and drawn with one attribute-less point call
   that pulls its vertices straight out of the position texture. */
(function (Bench) {
  'use strict';

  const { Program, PingPong, Target, screenProgram, Orbit, M4 } = Bench;
  const { HASH, NOISE, CURL, TONEMAP, COLORMAP } = Bench.glsl;

  const SPAWN = `
uniform int uShape;   // 0 sphere, 1 disc, 2 ring, 3 fountain
vec3 spawnPoint(vec3 rnd){
  float a = rnd.x * 6.2831853;
  if (uShape == 0) {
    float z = rnd.y * 2.0 - 1.0;
    float r = sqrt(max(0.0, 1.0 - z * z));
    return vec3(r * cos(a), r * sin(a), z) * (0.35 + rnd.z * 0.05);
  } else if (uShape == 1) {
    float r = sqrt(rnd.y) * 0.85;
    return vec3(r * cos(a), (rnd.z - 0.5) * 0.05, r * sin(a));
  } else if (uShape == 2) {
    float r = 0.75 + (rnd.y - 0.5) * 0.09;
    return vec3(r * cos(a), (rnd.z - 0.5) * 0.09, r * sin(a));
  }
  return vec3((rnd.y - 0.5) * 0.12, -0.85, (rnd.z - 0.5) * 0.12);
}
vec3 spawnVelocity(vec3 rnd, vec3 p){
  if (uShape == 3) return vec3((rnd.x - 0.5) * 0.4, 1.6 + rnd.y * 0.8, (rnd.z - 0.5) * 0.4);
  return normalize(p + 1e-4) * (0.1 + rnd.z * 0.25);
}`;

  const COMMON = `
in vec2 vUv;
uniform sampler2D uPos, uVel;
uniform float uDt, uTime, uLifespan, uSalt;
// Per-particle lifespan jitter derived from the texel — deterministic, so both
// integration passes agree on exactly when a particle dies without storing it.
float rateAt(vec2 uv){ return mix(0.55, 1.45, hash22(uv * 91.7).x) / max(uLifespan, 0.05); }`;

  const VEL_PASS = HASH + NOISE + CURL + COMMON + SPAWN + `
uniform vec3 uAttractor;
uniform float uFlow, uScale, uEvolve, uAttract, uPull, uDrag;
out vec4 fragColor;
void main(){
  vec4 P = texture(uPos, vUv);
  vec3 v = texture(uVel, vUv).xyz;
  float life = P.w - uDt * rateAt(vUv);

  if (life <= 0.0) {
    vec3 rnd = hash33(vec3(vUv * 512.0, uSalt));
    fragColor = vec4(spawnVelocity(rnd, spawnPoint(rnd)), 0.0);
    return;
  }

  vec3 p = P.xyz;
  vec3 acc = curlNoise(p * uScale, uTime * uEvolve) * uFlow;

  vec3 toA = uAttractor - p;
  float d2 = dot(toA, toA) + 0.08;
  acc += normalize(toA) * uAttract / d2;

  acc -= p * uPull;                       // keeps the cloud from wandering off
  v += acc * uDt;
  v *= exp(-uDrag * uDt);
  fragColor = vec4(v, 0.0);
}`;

  const POS_PASS = HASH + COMMON + SPAWN + `
uniform sampler2D uVelNew;
out vec4 fragColor;
void main(){
  vec4 P = texture(uPos, vUv);
  float life = P.w - uDt * rateAt(vUv);
  if (life <= 0.0) {
    vec3 rnd = hash33(vec3(vUv * 512.0, uSalt));
    fragColor = vec4(spawnPoint(rnd), 1.0);
    return;
  }
  vec3 v = texture(uVelNew, vUv).xyz;
  fragColor = vec4(P.xyz + v * uDt, life);
}`;

  const DRAW_VS = `
uniform sampler2D uPos, uVel;
uniform mat4 uViewProj;
uniform vec2 uGrid;
uniform float uSize, uViewHeight;
out vec3 vColor;
out float vFade;
` + COLORMAP + `
uniform int uPalette;
void main(){
  ivec2 ij = ivec2(gl_VertexID % int(uGrid.x), gl_VertexID / int(uGrid.x));
  vec4 P = texelFetch(uPos, ij, 0);
  vec3 v = texelFetch(uVel, ij, 0).xyz;

  gl_Position = uViewProj * vec4(P.xyz, 1.0);
  float w = max(gl_Position.w, 0.05);
  gl_PointSize = clamp(uSize * uViewHeight / w, 1.0, 64.0);

  float speed = length(v);
  float life = P.w;
  // Fade in on birth and out on death so respawns never pop.
  vFade = smoothstep(0.0, 0.08, 1.0 - life) * smoothstep(0.0, 0.22, life);

  if (uPalette == 0)      vColor = rampCool(speed * 0.55);
  else if (uPalette == 1) vColor = rampHot(speed * 0.5 + 0.05);
  else if (uPalette == 2) vColor = rampCool(1.0 - life);
  else                    vColor = mix(vec3(0.55, 0.72, 1.0), vec3(1.0, 0.55, 0.85), clamp(P.y * 0.6 + 0.5, 0.0, 1.0));
}`;

  const DRAW_FS = `
in vec3 vColor;
in float vFade;
uniform float uIntensity;
out vec4 fragColor;
void main(){
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 3.2) * vFade * uIntensity;
  fragColor = vec4(vColor * a, a);
}`;

  const FADE = `
in vec2 vUv;
uniform sampler2D uPrev;
uniform float uFade;
out vec4 fragColor;
void main(){ fragColor = texture(uPrev, vUv) * uFade; }`;

  const PRESENT = TONEMAP + `
in vec2 vUv;
uniform sampler2D uScene;
uniform float uExposure, uTime;
uniform vec2 uResolution;
out vec4 fragColor;
void main(){
  vec3 c = texture(uScene, vUv).rgb * uExposure;
  c = aces(c);
  vec2 q = vUv - 0.5;
  c *= 1.0 - dot(q, q) * 0.55;                       // vignette
  c += (grain(vUv, uTime) - 0.5) * 0.02;
  fragColor = vec4(toSRGB(max(c, 0.0)), 1.0);
}`;

  /* ------------------------------------------------------------------- the rig */

  Bench.registerRig({
    id: 'particles',
    name: 'Particles',
    method: 'GPGPU',
    accent: '#5B6CFF',
    blurb: 'A million particles integrated entirely on the GPU. Their velocity comes from curl noise — the curl of a vector field is divergence-free, so the flow swirls without ever collapsing into sinks.',
    hint: 'Drag to orbit · scroll to zoom · click to pull',
    controls: [
      { id: 'count', label: 'Particles', type: 'select', value: '512', options: [['128', '16 K'], ['256', '65 K'], ['512', '262 K'], ['1024', '1 M']] },
      { id: 'shape', label: 'Source', type: 'select', value: 'sphere', options: [['sphere', 'Sphere'], ['disc', 'Disc'], ['ring', 'Ring'], ['fountain', 'Fountain']] },
      { id: 'palette', label: 'Colour by', type: 'select', value: 'speed', options: [['speed', 'Speed · cool'], ['heat', 'Speed · hot'], ['age', 'Age'], ['height', 'Height']] },
      { id: 'flow', label: 'Curl force', type: 'range', min: 0, max: 8, step: 0.05, value: 2.6 },
      { id: 'scale', label: 'Noise scale', type: 'range', min: 0.2, max: 6, step: 0.05, value: 1.65 },
      { id: 'evolve', label: 'Field drift', type: 'range', min: 0, max: 2, step: 0.01, value: 0.35 },
      { id: 'attract', label: 'Pointer pull', type: 'range', min: -6, max: 6, step: 0.1, value: 2.4 },
      { id: 'pull', label: 'Centre pull', type: 'range', min: 0, max: 4, step: 0.05, value: 0.9 },
      { id: 'drag', label: 'Drag', type: 'range', min: 0, max: 4, step: 0.05, value: 0.85 },
      { id: 'lifespan', label: 'Lifespan', type: 'range', min: 0.5, max: 12, step: 0.1, value: 5, unit: ' s' },
      { id: 'size', label: 'Point size', type: 'range', min: 0.2, max: 6, step: 0.1, value: 1.4 },
      { id: 'intensity', label: 'Intensity', type: 'range', min: 0.02, max: 1, step: 0.01, value: 0.34 },
      { id: 'trails', label: 'Trails', type: 'range', min: 0, max: 0.98, step: 0.01, value: 0.82 },
      { id: 'reset', label: 'Reseed', type: 'button' }
    ],

    create(gl, ctx) {
      const caps = ctx.caps;
      if (!caps.renderHalf) throw new Error('This rig needs float render targets (EXT_color_buffer_float).');
      // 16-bit positions quantise visibly at this scale, so prefer full float.
      const fmt = caps.renderFloat ? 'rgba32f' : 'rgba16f';

      const progs = {
        vel: screenProgram(gl, VEL_PASS),
        pos: screenProgram(gl, POS_PASS),
        draw: new Program(gl, DRAW_VS, DRAW_FS),
        fade: screenProgram(gl, FADE),
        present: screenProgram(gl, PRESENT)
      };

      const orbit = new Orbit(ctx.canvas, { dist: 3.1, phi: 1.35, minDist: 1.2, maxDist: 10 });
      let pos = null, vel = null, side = 0, scene = null, sceneW = 0, sceneH = 0;
      const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3);

      function seed(n) {
        const data = new Float32Array(n * n * 4);
        for (let i = 0; i < n * n; i++) {
          const z = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2;
          const r = Math.sqrt(Math.max(0, 1 - z * z)) * 0.38;
          data[i * 4] = r * Math.cos(a);
          data[i * 4 + 1] = r * Math.sin(a);
          data[i * 4 + 2] = z * 0.38;
          data[i * 4 + 3] = Math.random();   // staggered life so deaths spread out
        }
        return data;
      }

      function allocParticles() {
        side = parseInt(ctx.params.count, 10);
        if (pos) { pos.dispose(); vel.dispose(); }
        const opts = { format: fmt, filter: 'NEAREST' };
        pos = new PingPong(gl, side, side, opts);
        vel = new PingPong(gl, side, side, opts);
        const data = seed(side);
        gl.bindTexture(gl.TEXTURE_2D, pos.a.tex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, side, side, gl.RGBA, gl.FLOAT, data);
        gl.bindTexture(gl.TEXTURE_2D, pos.b.tex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, side, side, gl.RGBA, gl.FLOAT, data);
        vel.a.bind(true); vel.b.bind(true);
      }

      function allocScene(w, h) {
        if (scene) scene.dispose();
        sceneW = w; sceneH = h;
        scene = new PingPong(gl, w, h, { format: 'rgba16f', filter: 'LINEAR' });
        scene.a.bind(true); scene.b.bind(true);
      }

      let lastCount = ctx.params.count;
      allocParticles();
      allocScene(ctx.width, ctx.height);

      const shapes = { sphere: 0, disc: 1, ring: 2, fountain: 3 };
      const palettes = { speed: 0, heat: 1, age: 2, height: 3 };

      return {
        resize(w, h) { allocScene(w, h); },

        frame(dt, time) {
          const P = ctx.params, p = ctx.pointer;
          if (P.count !== lastCount) { lastCount = P.count; allocParticles(); }

          const vp = orbit.update(dt, ctx.width / ctx.height, 0.85);
          const salt = Math.floor(time * 37.0) % 4096;
          const shape = shapes[P.shape];

          // Put the attractor on the plane through the origin that faces the
          // camera, so a click always pulls where the pointer visually is.
          const e = orbit.eye;
          const fwd = [-e[0], -e[1], -e[2]];
          const fl = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1;
          fwd[0] /= fl; fwd[1] /= fl; fwd[2] /= fl;
          let right = [fwd[2], 0, -fwd[0]];
          const rl = Math.hypot(right[0], right[1], right[2]) || 1;
          right = [right[0] / rl, right[1] / rl, right[2] / rl];
          const up = [
            right[1] * fwd[2] - right[2] * fwd[1],
            right[2] * fwd[0] - right[0] * fwd[2],
            right[0] * fwd[1] - right[1] * fwd[0]
          ];
          const ax = (p.x * 2 - 1) * 1.1, ay = (p.y * 2 - 1) * 1.1;
          const att = [right[0] * ax + up[0] * ay, right[1] * ax + up[1] * ay, right[2] * ax + up[2] * ay];
          const attractStrength = p.down ? P.attract : 0;

          gl.disable(gl.BLEND);
          gl.disable(gl.DEPTH_TEST);

          // --- velocity
          vel.write.bind();
          progs.vel.use()
            .tex('uPos', pos.read.tex).tex('uVel', vel.read.tex)
            .f('uDt', dt).f('uTime', time).f('uLifespan', P.lifespan).f('uSalt', salt)
            .i('uShape', shape)
            .v3('uAttractor', att[0], att[1], att[2])
            .f('uFlow', P.flow).f('uScale', P.scale).f('uEvolve', P.evolve)
            .f('uAttract', attractStrength).f('uPull', P.pull).f('uDrag', P.drag);
          draw(); vel.swap();

          // --- position (uses the velocity we just wrote: semi-implicit Euler)
          pos.write.bind();
          progs.pos.use()
            .tex('uPos', pos.read.tex).tex('uVel', vel.read.tex).tex('uVelNew', vel.read.tex)
            .f('uDt', dt).f('uTime', time).f('uLifespan', P.lifespan).f('uSalt', salt)
            .i('uShape', shape);
          draw(); pos.swap();

          // --- fade the accumulation buffer, then splat points into it
          scene.write.bind();
          progs.fade.use().tex('uPrev', scene.read.tex).f('uFade', P.trails);
          draw();

          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE);
          progs.draw.use()
            .tex('uPos', pos.read.tex).tex('uVel', vel.read.tex)
            .mat4('uViewProj', vp)
            .v2('uGrid', side, side)
            .f('uSize', P.size).f('uViewHeight', ctx.height * 0.5)
            .f('uIntensity', P.intensity).i('uPalette', palettes[P.palette]);
          gl.drawArrays(gl.POINTS, 0, side * side);
          gl.disable(gl.BLEND);
          scene.swap();

          // --- present
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, ctx.width, ctx.height);
          progs.present.use().tex('uScene', scene.read.tex)
            .f('uExposure', 1.0).f('uTime', time)
            .v2('uResolution', ctx.width, ctx.height);
          draw();
        },

        action(id) { if (id === 'reset') { allocParticles(); scene.a.bind(true); scene.b.bind(true); } },

        stats() {
          const n = side * side;
          return [
            ['particles', n >= 1e6 ? (n / 1e6).toFixed(2) + ' M' : Math.round(n / 1000) + ' K'],
            ['state', side + '×' + side + ' ×2'],
            ['precision', fmt === 'rgba32f' ? 'fp32' : 'fp16'],
            ['buffer', sceneW + '×' + sceneH]
          ];
        },

        dispose() {
          Object.values(progs).forEach(p => p.dispose());
          if (pos) { pos.dispose(); vel.dispose(); }
          if (scene) scene.dispose();
          orbit.dispose();
        }
      };
    }
  });
})(window.Bench);
