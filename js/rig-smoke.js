/* rig-smoke.js — Stable Fluids on the GPU.
   Semi-Lagrangian advection, vorticity confinement, buoyancy, and a Jacobi
   pressure projection that makes the velocity field divergence-free.
   Everything lives in ping-ponged float textures; nothing round-trips to the CPU. */
(function (Bench) {
  'use strict';

  const { Program, PingPong, Target, screenProgram } = Bench;
  const { COLORMAP, TONEMAP } = Bench.glsl;

  /* ------------------------------------------------------------- solver passes */

  const ADVECT = `
in vec2 vUv;
uniform sampler2D uVelocity, uSource;
uniform vec2 uTexel;        // velocity grid texel — converts cells/s to uv/s
uniform float uDt, uDissipation;
out vec4 fragColor;
void main(){
  vec2 vel = texture(uVelocity, vUv).xy;
  vec2 coord = vUv - uDt * vel * uTexel;
  vec4 src = texture(uSource, coord);
  fragColor = src / (1.0 + uDissipation * uDt);
}`;

  const DIVERGENCE = `
in vec2 vUv;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
out vec4 fragColor;
void main(){
  float L = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
  float T = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).y;
  // Solid walls: mirror the normal component so no flow crosses the boundary.
  vec2 C = texture(uVelocity, vUv).xy;
  if (vUv.x - uTexel.x < 0.0) L = -C.x;
  if (vUv.x + uTexel.x > 1.0) R = -C.x;
  if (vUv.y - uTexel.y < 0.0) B = -C.y;
  if (vUv.y + uTexel.y > 1.0) T = -C.y;
  fragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`;

  const CURL = `
in vec2 vUv;
uniform sampler2D uVelocity;
uniform vec2 uTexel;
out vec4 fragColor;
void main(){
  float L = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).y;
  float R = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).y;
  float B = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).x;
  fragColor = vec4(0.5 * ((R - L) - (T - B)), 0.0, 0.0, 1.0);
}`;

  // Vorticity confinement (Fedkiw et al.) + thermal buoyancy, in one pass.
  const FORCES = `
in vec2 vUv;
uniform sampler2D uVelocity, uCurl, uDye;
uniform vec2 uTexel;
uniform float uDt, uVorticity, uBuoyancy, uWeight;
out vec4 fragColor;
void main(){
  float L = texture(uCurl, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uCurl, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uCurl, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uCurl, vUv + vec2(0.0, uTexel.y)).x;
  float C = texture(uCurl, vUv).x;

  vec2 grad = 0.5 * vec2(abs(R) - abs(L), abs(T) - abs(B));
  vec2 N = grad / (length(grad) + 1e-5);
  // F = eps * (N x omega); in 2D that is eps * omega * (N.y, -N.x).
  vec2 force = uVorticity * C * vec2(N.y, -N.x);

  vec3 dye = texture(uDye, vUv).rgb;
  float temp = max(max(dye.r, dye.g), dye.b);
  force.y += uBuoyancy * temp - uWeight * temp;

  vec2 vel = texture(uVelocity, vUv).xy + force * uDt;
  fragColor = vec4(clamp(vel, -1500.0, 1500.0), 0.0, 1.0);
}`;

  const PRESSURE = `
in vec2 vUv;
uniform sampler2D uPressure, uDivergence;
uniform vec2 uTexel;
out vec4 fragColor;
void main(){
  float L = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  float div = texture(uDivergence, vUv).x;
  fragColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
}`;

  const GRADIENT = `
in vec2 vUv;
uniform sampler2D uPressure, uVelocity;
uniform vec2 uTexel;
out vec4 fragColor;
void main(){
  float L = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  vec2 vel = texture(uVelocity, vUv).xy - 0.5 * vec2(R - L, T - B);
  // No flow through the walls.
  vel.x *= step(uTexel.x, vUv.x) * step(vUv.x, 1.0 - uTexel.x);
  vel.y *= step(uTexel.y, vUv.y) * step(vUv.y, 1.0 - uTexel.y);
  fragColor = vec4(vel, 0.0, 1.0);
}`;

  const SPLAT = `
in vec2 vUv;
uniform sampler2D uTarget;
uniform vec2 uPoint;
uniform vec3 uValue;
uniform float uRadius, uAspect;
out vec4 fragColor;
void main(){
  vec2 d = vUv - uPoint;
  d.x *= uAspect;
  float falloff = exp(-dot(d, d) / uRadius);
  fragColor = vec4(texture(uTarget, vUv).xyz + falloff * uValue, 1.0);
}`;

  const DISPLAY = COLORMAP + TONEMAP + `
in vec2 vUv;
uniform sampler2D uDye, uVelocity, uPressure, uDivergence;
uniform vec2 uTexelDye;
uniform int uMode;      // 0 dye, 1 velocity, 2 pressure, 3 divergence
uniform int uPalette;   // 0 ember, 1 ink, 2 spectrum
uniform float uExposure, uTime;
out vec4 fragColor;

void main(){
  vec3 col;
  if (uMode == 1) {
    vec2 v = texture(uVelocity, vUv).xy;
    float m = length(v) * 0.006;
    col = rampCool(m) * 1.15;
    // Streak the field along the flow direction so structure reads at a glance.
    float ang = atan(v.y, v.x);
    col *= 0.82 + 0.18 * sin(ang * 3.0 + m * 12.0);
  } else if (uMode == 2) {
    float p = texture(uPressure, vUv).x * 0.6;
    col = mix(vec3(0.05, 0.16, 0.30), vec3(1.0, 0.62, 0.22), clamp(p * 0.5 + 0.5, 0.0, 1.0));
  } else if (uMode == 3) {
    float d = texture(uDivergence, vUv).x * 8.0;
    col = mix(vec3(0.02, 0.03, 0.05), d > 0.0 ? vec3(1.0, 0.35, 0.45) : vec3(0.3, 0.75, 1.0), abs(d));
  } else {
    vec3 dye = texture(uDye, vUv).rgb;
    float d = max(max(dye.r, dye.g), dye.b);
    // Shade the density field with its own gradient — reads as volume, costs 2 taps.
    float dx = max(max(texture(uDye, vUv + vec2(uTexelDye.x, 0.0)).r, texture(uDye, vUv + vec2(uTexelDye.x, 0.0)).g), texture(uDye, vUv + vec2(uTexelDye.x, 0.0)).b);
    float dy = max(max(texture(uDye, vUv + vec2(0.0, uTexelDye.y)).r, texture(uDye, vUv + vec2(0.0, uTexelDye.y)).g), texture(uDye, vUv + vec2(0.0, uTexelDye.y)).b);
    float shade = clamp(1.0 - (dx - d) * 2.2 - (dy - d) * 3.0, 0.55, 1.6);
    // The ember ramp has a deliberately non-black floor; gate it on density so
    // empty cells stay black instead of tinting the whole frame.
    float gate = smoothstep(0.0, 0.045, d);
    if (uPalette == 0)      col = rampHot(d * 0.95) * shade * gate;
    else if (uPalette == 1) col = vec3(pow(d, 0.85)) * vec3(0.93, 0.95, 1.0) * shade;
    else                    col = dye * shade;
  }
  col *= uExposure;
  col = aces(col);
  col += (grain(vUv, uTime) - 0.5) * 0.016;
  fragColor = vec4(toSRGB(max(col, 0.0)), 1.0);
}`;

  /* ------------------------------------------------------------------- the rig */

  Bench.registerRig({
    id: 'smoke',
    name: 'Smoke',
    method: 'Navier–Stokes',
    accent: '#FF9E2C',
    blurb: 'A grid-based fluid solver. Every frame advects the velocity field through itself, adds vorticity and buoyancy, then projects the result divergence-free with a Jacobi pressure solve.',
    hint: 'Drag to push the fluid',
    controls: [
      { id: 'view', label: 'Field', type: 'select', value: 'dye', options: [['dye', 'Density'], ['velocity', 'Velocity'], ['pressure', 'Pressure'], ['divergence', 'Divergence']] },
      { id: 'palette', label: 'Palette', type: 'select', value: 'ember', options: [['ember', 'Ember'], ['ink', 'Ink'], ['spectrum', 'Spectrum']] },
      { id: 'iterations', label: 'Pressure iterations', type: 'range', min: 4, max: 60, step: 1, value: 24 },
      { id: 'vorticity', label: 'Vorticity', type: 'range', min: 0, max: 60, step: 0.5, value: 26 },
      { id: 'buoyancy', label: 'Buoyancy', type: 'range', min: 0, max: 400, step: 5, value: 160 },
      { id: 'dissipation', label: 'Density decay', type: 'range', min: 0, max: 3, step: 0.01, value: 0.42 },
      { id: 'velDamping', label: 'Viscous drag', type: 'range', min: 0, max: 2, step: 0.01, value: 0.18 },
      { id: 'radius', label: 'Splat size', type: 'range', min: 0.05, max: 1.2, step: 0.01, value: 0.35 },
      { id: 'grid', label: 'Grid', type: 'select', value: '192', options: [['128', 'Coarse · 128'], ['192', 'Medium · 192'], ['256', 'Fine · 256'], ['384', 'Very fine · 384']] },
      { id: 'emitter', label: 'Chimney', type: 'toggle', value: true },
      { id: 'reset', label: 'Clear field', type: 'button' }
    ],

    create(gl, ctx) {
      const caps = ctx.caps;
      if (!caps.renderHalf) throw new Error('This rig needs float render targets (EXT_color_buffer_float).');

      const progs = {
        advect: screenProgram(gl, ADVECT),
        divergence: screenProgram(gl, DIVERGENCE),
        curl: screenProgram(gl, CURL),
        forces: screenProgram(gl, FORCES),
        pressure: screenProgram(gl, PRESSURE),
        gradient: screenProgram(gl, GRADIENT),
        splat: screenProgram(gl, SPLAT),
        display: screenProgram(gl, DISPLAY)
      };

      let velocity, dye, pressure, divergence, curl;
      let simW = 0, simH = 0, dyeW = 0, dyeH = 0, aspect = 1;
      let hue = 0, emitPhase = 0;

      function dims(res, w, h) {
        const a = w / h;
        return a > 1 ? [Math.round(res * a), res] : [res, Math.round(res / a)];
      }

      function allocate(w, h) {
        aspect = w / h;
        const res = parseInt(ctx.params.grid, 10);
        [simW, simH] = dims(res, w, h);
        [dyeW, dyeH] = dims(Math.min(1024, res * 3), w, h);
        if (velocity) { velocity.dispose(); dye.dispose(); pressure.dispose(); divergence.dispose(); curl.dispose(); }
        velocity = new PingPong(gl, simW, simH, { format: 'rg16f', filter: 'LINEAR' });
        dye = new PingPong(gl, dyeW, dyeH, { format: 'rgba16f', filter: 'LINEAR' });
        pressure = new PingPong(gl, simW, simH, { format: 'r16f', filter: 'NEAREST' });
        divergence = new Target(gl, simW, simH, { format: 'r16f', filter: 'NEAREST' });
        curl = new Target(gl, simW, simH, { format: 'r16f', filter: 'NEAREST' });
        clear();
      }

      function clear() {
        [velocity.a, velocity.b, dye.a, dye.b, pressure.a, pressure.b, divergence, curl]
          .forEach(t => t.bind(true));
      }

      const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3);

      function splat(pp, x, y, vx, vy, vz, radius) {
        pp.write.bind();
        progs.splat.use()
          .tex('uTarget', pp.read.tex)
          .v2('uPoint', x, y).v3('uValue', vx, vy, vz)
          .f('uRadius', radius).f('uAspect', aspect);
        draw();
        pp.swap();
      }

      function paletteColor(intensity) {
        const p = ctx.params.palette;
        if (p === 'spectrum') {
          hue = (hue + 0.11) % 1;
          const h = hue * 6, c = intensity;
          const x = c * (1 - Math.abs((h % 2) - 1));
          if (h < 1) return [c, x, 0]; if (h < 2) return [x, c, 0]; if (h < 3) return [0, c, x];
          if (h < 4) return [0, x, c]; if (h < 5) return [x, 0, c]; return [c, 0, x];
        }
        return [intensity, intensity, intensity];
      }

      let lastGrid = ctx.params.grid;
      allocate(ctx.width, ctx.height);

      return {
        resize(w, h) { allocate(w, h); },

        frame(dt, time) {
          const P = ctx.params;
          if (P.grid !== lastGrid) { lastGrid = P.grid; allocate(ctx.width, ctx.height); }

          const p = ctx.pointer;
          const rad = P.radius * 0.00022 + 0.00002;

          // Pointer drag injects momentum and dye at the same spot.
          if (p.down && (p.dx || p.dy)) {
            const force = 900;
            splat(velocity, p.x, p.y, p.dx * force * aspect, p.dy * force, 0, rad);
            const c = paletteColor(P.palette === 'ember' ? 1.1 : 0.85);
            splat(dye, p.x, p.y, c[0], c[1], c[2], rad);
          }

          // The chimney: a wobbling continuous source along the floor.
          if (P.emitter) {
            emitPhase += dt;
            const x = 0.5 + Math.sin(emitPhase * 0.53) * 0.07 + Math.sin(emitPhase * 1.31) * 0.02;
            const c = paletteColor(P.palette === 'ember' ? 1.6 : 1.1);
            splat(dye, x, 0.06, c[0] * dt * 12, c[1] * dt * 12, c[2] * dt * 12, rad * 0.7);
            splat(velocity, x, 0.06, Math.sin(emitPhase * 0.9) * 40, 320 * dt * 30, 0, rad * 0.7);
          }

          gl.disable(gl.BLEND);

          // --- advect velocity through itself
          velocity.write.bind();
          progs.advect.use()
            .tex('uVelocity', velocity.read.tex).tex('uSource', velocity.read.tex)
            .v2('uTexel', velocity.texelX, velocity.texelY)
            .f('uDt', dt).f('uDissipation', P.velDamping);
          draw(); velocity.swap();

          // --- vorticity confinement + buoyancy
          curl.bind();
          progs.curl.use().tex('uVelocity', velocity.read.tex).v2('uTexel', velocity.texelX, velocity.texelY);
          draw();

          velocity.write.bind();
          progs.forces.use()
            .tex('uVelocity', velocity.read.tex).tex('uCurl', curl.tex).tex('uDye', dye.read.tex)
            .v2('uTexel', velocity.texelX, velocity.texelY)
            .f('uDt', dt).f('uVorticity', P.vorticity)
            .f('uBuoyancy', P.buoyancy).f('uWeight', P.buoyancy * 0.12);
          draw(); velocity.swap();

          // --- pressure projection
          divergence.bind();
          progs.divergence.use().tex('uVelocity', velocity.read.tex).v2('uTexel', velocity.texelX, velocity.texelY);
          draw();

          // Warm-start from the previous frame's solution, slightly decayed.
          pressure.write.bind();
          progs.advect.use()
            .tex('uVelocity', velocity.read.tex).tex('uSource', pressure.read.tex)
            .v2('uTexel', 0, 0).f('uDt', 0).f('uDissipation', 0.6);
          draw(); pressure.swap();

          const iters = P.iterations | 0;
          progs.pressure.use().v2('uTexel', pressure.texelX, pressure.texelY);
          for (let i = 0; i < iters; i++) {
            pressure.write.bind();
            progs.pressure.use()
              .tex('uPressure', pressure.read.tex).tex('uDivergence', divergence.tex)
              .v2('uTexel', pressure.texelX, pressure.texelY);
            draw(); pressure.swap();
          }

          velocity.write.bind();
          progs.gradient.use()
            .tex('uPressure', pressure.read.tex).tex('uVelocity', velocity.read.tex)
            .v2('uTexel', velocity.texelX, velocity.texelY);
          draw(); velocity.swap();

          // --- carry the dye along the (now divergence-free) field
          dye.write.bind();
          progs.advect.use()
            .tex('uVelocity', velocity.read.tex).tex('uSource', dye.read.tex)
            .v2('uTexel', velocity.texelX, velocity.texelY)
            .f('uDt', dt).f('uDissipation', P.dissipation);
          draw(); dye.swap();

          // --- present
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, ctx.width, ctx.height);
          const modes = { dye: 0, velocity: 1, pressure: 2, divergence: 3 };
          const palettes = { ember: 0, ink: 1, spectrum: 2 };
          progs.display.use()
            .tex('uDye', dye.read.tex).tex('uVelocity', velocity.read.tex)
            .tex('uPressure', pressure.read.tex).tex('uDivergence', divergence.tex)
            .v2('uTexelDye', dye.texelX, dye.texelY)
            .i('uMode', modes[P.view]).i('uPalette', palettes[P.palette])
            .f('uExposure', P.view === 'dye' ? 1.25 : 1.0).f('uTime', time);
          draw();
        },

        action(id) { if (id === 'reset') clear(); },

        stats() {
          return [
            ['grid', simW + '×' + simH],
            ['dye', dyeW + '×' + dyeH],
            ['jacobi', (ctx.params.iterations | 0) + ' it'],
            ['passes', (9 + (ctx.params.iterations | 0)) + '/frame']
          ];
        },

        dispose() {
          Object.values(progs).forEach(p => p.dispose());
          [velocity, dye, pressure, divergence, curl].forEach(t => t && t.dispose());
        }
      };
    }
  });
})(window.Bench);
