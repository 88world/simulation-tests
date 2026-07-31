/* rig-water.js — Heightfield water.
   Integrates the 2D wave equation on a ping-ponged texture that carries the
   surface at t and t-1, then shades it: refraction through the surface onto a
   tiled floor, curvature-driven caustics, Fresnel sky, and specular glints. */
(function (Bench) {
  'use strict';

  const { screenProgram } = Bench;
  const { HASH, NOISE, TONEMAP } = Bench.glsl;

  /* --------------------------------------------------------------- integrator */

  // state.r = height now, state.g = height one step ago.
  const STEP = `
in vec2 vUv;
uniform sampler2D uState;
uniform vec2 uTexel;
uniform float uC2, uDamping, uEdge;
out vec4 fragColor;

float H(vec2 uv){ return texture(uState, clamp(uv, vec2(0.0), vec2(1.0))).r; }

void main(){
  vec2 t = uTexel;
  float c  = H(vUv);
  float l  = H(vUv - vec2(t.x, 0.0));
  float r  = H(vUv + vec2(t.x, 0.0));
  float b  = H(vUv - vec2(0.0, t.y));
  float u  = H(vUv + vec2(0.0, t.y));
  float bl = H(vUv + vec2(-t.x, -t.y));
  float br = H(vUv + vec2( t.x, -t.y));
  float tl = H(vUv + vec2(-t.x,  t.y));
  float tr = H(vUv + vec2( t.x,  t.y));

  // 9-point Laplacian: the diagonal taps keep wavefronts round instead of
  // square, which a 5-point stencil never manages.
  float lap = 0.5 * (l + r + b + u) + 0.25 * (bl + br + tl + tr) - 3.0 * c;

  float prev = texture(uState, vUv).g;
  float next = 2.0 * c - prev + uC2 * lap;
  next *= uDamping;

  // Optional absorbing rim: soaks up energy so the pool does not ring forever.
  vec2 d = min(vUv, 1.0 - vUv);
  float rim = smoothstep(0.0, 0.06, min(d.x, d.y));
  next *= mix(1.0 - uEdge, 1.0, rim);

  fragColor = vec4(next, c, 0.0, 1.0);
}`;

  const DROP = `
in vec2 vUv;
uniform sampler2D uState;
uniform vec2 uPoint;
uniform float uRadius, uAmount, uAspect;
out vec4 fragColor;
void main(){
  vec2 d = vUv - uPoint;
  d.x *= uAspect;
  float f = exp(-dot(d, d) / uRadius) * uAmount;
  vec2 s = texture(uState, vUv).rg;
  fragColor = vec4(s + vec2(f), 0.0, 1.0);
}`;

  /* ------------------------------------------------------------------ shading */

  const SHADE = HASH + NOISE + TONEMAP + `
in vec2 vUv;
uniform sampler2D uState;
uniform vec2 uTexel, uResolution;
uniform float uTime, uRefraction, uCaustics, uDepth, uSun, uGloss;
uniform int uMode;   // 0 shaded, 1 height, 2 normals
out vec4 fragColor;

// Mosaic pool floor: tile colour drifts per cell, grout lines darken the seams.
vec3 floorColor(vec2 uv){
  vec2 p = uv * vec2(uResolution.x / uResolution.y, 1.0) * 28.0;
  vec2 cell = floor(p);
  vec2 f = fract(p);
  vec2 g = smoothstep(0.0, 0.06, f) * smoothstep(0.0, 0.06, 1.0 - f);
  float grout = g.x * g.y;

  // Two hashes per cell: one picks the glaze, one breaks up the regularity.
  vec2 h = hash22(cell);
  vec3 base = mix(vec3(0.020, 0.088, 0.125), vec3(0.045, 0.185, 0.215), h.x);
  base = mix(base, vec3(0.085, 0.265, 0.235), smoothstep(0.82, 1.0, h.x));
  base = mix(base, vec3(0.015, 0.055, 0.105), smoothstep(0.88, 1.0, h.y));
  base *= 0.86 + 0.28 * noise2(p * 1.7);
  return mix(base * 0.22, base, grout);
}

void main(){
  vec2 t = uTexel;
  float h  = texture(uState, vUv).r;
  float hl = texture(uState, vUv - vec2(t.x, 0.0)).r;
  float hr = texture(uState, vUv + vec2(t.x, 0.0)).r;
  float hb = texture(uState, vUv - vec2(0.0, t.y)).r;
  float ht = texture(uState, vUv + vec2(0.0, t.y)).r;

  if (uMode == 1) {
    float v = h * 3.0;
    vec3 c = mix(vec3(0.04, 0.09, 0.16), vec3(0.18, 0.85, 0.85), clamp(v * 0.5 + 0.5, 0.0, 1.0));
    c = mix(c, vec3(1.0, 0.85, 0.45), clamp(v, 0.0, 1.0));
    fragColor = vec4(toSRGB(c), 1.0);
    return;
  }

  vec3 N = normalize(vec3(-(hr - hl) * 90.0, -(ht - hb) * 90.0, 1.0));
  if (uMode == 2) { fragColor = vec4(toSRGB(N * 0.5 + 0.5), 1.0); return; }

  // Refraction: bend the view ray at the surface, march it to the floor.
  vec2 refr = vUv + N.xy * uRefraction * uDepth * 0.06;
  vec3 floorCol = floorColor(refr);

  // Curvature focuses light — concave patches brighten the floor beneath.
  float lap = (hl + hr + hb + ht) - 4.0 * h;
  float caustic = 1.0 + clamp(-lap * 260.0, -0.8, 3.0) * uCaustics;
  floorCol *= caustic;

  // Water absorbs long wavelengths first; deeper water reads bluer.
  vec3 absorb = exp(-vec3(0.72, 0.24, 0.14) * uDepth * (1.0 + h * 2.0));
  vec3 col = floorCol * absorb;

  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 L = normalize(vec3(cos(uSun) * 0.75, sin(uSun) * 0.75, 0.72));
  vec3 Hv = normalize(L + V);
  float spec = pow(max(dot(N, Hv), 0.0), mix(28.0, 620.0, uGloss));
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);

  vec3 sky = mix(vec3(0.07, 0.13, 0.20), vec3(0.35, 0.55, 0.72), clamp(N.y * 0.5 + 0.55, 0.0, 1.0));
  col = mix(col, sky, clamp(fres * 1.6, 0.0, 0.75));
  col += vec3(1.0, 0.96, 0.88) * spec * (0.5 + uGloss * 2.2);

  // Sub-pixel sparkle on the steepest slopes.
  float steep = smoothstep(0.35, 0.9, length(N.xy));
  col += vec3(0.9, 0.98, 1.0) * steep * spec * 1.5;

  col *= 1.05;
  col = aces(col);
  col += (grain(vUv, uTime) - 0.5) * 0.014;
  fragColor = vec4(toSRGB(max(col, 0.0)), 1.0);
}`;

  /* ------------------------------------------------------------------- the rig */

  Bench.registerRig({
    id: 'water',
    name: 'Water',
    method: 'Wave equation',
    accent: '#2BC4C0',
    blurb: 'A finite-difference wave equation on a height texture. Each pixel keeps its height now and one step ago; the surface normal that falls out of it drives refraction, caustics and Fresnel reflection.',
    hint: 'Drag to disturb the surface',
    controls: [
      { id: 'mode', label: 'View', type: 'select', value: 'shaded', options: [['shaded', 'Shaded'], ['height', 'Height field'], ['normals', 'Normals']] },
      { id: 'speed', label: 'Wave speed', type: 'range', min: 0.05, max: 0.55, step: 0.01, value: 0.36 },
      { id: 'damping', label: 'Damping', type: 'range', min: 0.9, max: 1, step: 0.001, value: 0.996 },
      { id: 'edge', label: 'Shore absorption', type: 'range', min: 0, max: 0.06, step: 0.001, value: 0.012 },
      { id: 'refraction', label: 'Refraction', type: 'range', min: 0, max: 3, step: 0.01, value: 1.2 },
      { id: 'caustics', label: 'Caustics', type: 'range', min: 0, max: 2, step: 0.01, value: 0.85 },
      { id: 'depth', label: 'Depth', type: 'range', min: 0.2, max: 3, step: 0.01, value: 1.1 },
      { id: 'gloss', label: 'Gloss', type: 'range', min: 0, max: 1, step: 0.01, value: 0.55 },
      { id: 'sun', label: 'Sun azimuth', type: 'range', min: 0, max: 6.28, step: 0.01, value: 2.2 },
      { id: 'rain', label: 'Rain', type: 'range', min: 0, max: 40, step: 1, value: 4, unit: '/s' },
      { id: 'reset', label: 'Still water', type: 'button' }
    ],

    create(gl, ctx) {
      if (!ctx.caps.renderHalf) throw new Error('This rig needs float render targets (EXT_color_buffer_float).');

      const progs = { step: screenProgram(gl, STEP), drop: screenProgram(gl, DROP), shade: screenProgram(gl, SHADE) };
      let state = null, simW = 0, simH = 0, aspect = 1;
      let rainAcc = 0, accum = 0;
      const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3);

      function allocate(w, h) {
        aspect = w / h;
        // Fixed-ish grid: the wave speed is in cells/step, so a stable grid keeps
        // the physics identical across window sizes.
        const res = 512;
        simW = aspect > 1 ? Math.round(res * aspect) : res;
        simH = aspect > 1 ? res : Math.round(res / aspect);
        simW = Math.min(simW, 1400); simH = Math.min(simH, 1400);
        if (state) state.dispose();
        state = new Bench.PingPong(gl, simW, simH, { format: 'rg16f', filter: 'LINEAR' });
        clear();
      }
      function clear() { state.a.bind(true); state.b.bind(true); }

      function drop(x, y, radius, amount) {
        state.write.bind();
        progs.drop.use().tex('uState', state.read.tex)
          .v2('uPoint', x, y).f('uRadius', radius).f('uAmount', amount).f('uAspect', aspect);
        draw();
        state.swap();
      }

      allocate(ctx.width, ctx.height);

      return {
        resize(w, h) { allocate(w, h); },

        frame(dt, time) {
          const P = ctx.params, p = ctx.pointer;
          gl.disable(gl.BLEND);

          if (p.down) drop(p.x, p.y, 0.00035, -0.055);

          if (P.rain > 0) {
            rainAcc += dt * P.rain;
            while (rainAcc >= 1) {
              rainAcc -= 1;
              drop(Math.random(), Math.random(), 0.00004 + Math.random() * 0.00008, -0.05 - Math.random() * 0.08);
            }
          }

          // Fixed timestep: an explicit wave integrator is only conditionally
          // stable, so the step size must not follow the frame rate.
          const FIXED = 1 / 120;
          accum = Math.min(accum + dt, 0.1);
          let steps = 0;
          progs.step.use();
          while (accum >= FIXED && steps < 8) {
            accum -= FIXED; steps++;
            state.write.bind();
            progs.step.use().tex('uState', state.read.tex)
              .v2('uTexel', state.texelX, state.texelY)
              .f('uC2', P.speed).f('uDamping', P.damping).f('uEdge', P.edge);
            draw();
            state.swap();
          }

          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, ctx.width, ctx.height);
          const modes = { shaded: 0, height: 1, normals: 2 };
          progs.shade.use().tex('uState', state.read.tex)
            .v2('uTexel', state.texelX, state.texelY)
            .v2('uResolution', ctx.width, ctx.height)
            .f('uTime', time).f('uRefraction', P.refraction).f('uCaustics', P.caustics)
            .f('uDepth', P.depth).f('uSun', P.sun).f('uGloss', P.gloss)
            .i('uMode', modes[P.mode]);
          draw();
        },

        action(id) { if (id === 'reset') clear(); },

        stats() {
          return [
            ['grid', simW + '×' + simH],
            ['cells', ((simW * simH) / 1e6).toFixed(2) + ' M'],
            ['step', '1/120 s'],
            ['stencil', '9-point']
          ];
        },

        dispose() { Object.values(progs).forEach(p => p.dispose()); if (state) state.dispose(); }
      };
    }
  });
})(window.Bench);
