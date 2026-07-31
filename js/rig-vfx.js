/* rig-vfx.js — Effects composite.
   A burst emitter feeding GPU sparks and smoke, an expanding shockwave that
   warps the frame, and a proper bloom chain: threshold, a downsample pyramid,
   then tent-filtered upsampling back up. This is the post stack, not one shader. */
(function (Bench) {
  'use strict';

  const { Program, PingPong, Target, screenProgram } = Bench;
  const { HASH, NOISE, CURL, TONEMAP, COLORMAP } = Bench.glsl;

  const SLOTS = 8;            // ring of burst slots; a new burst recycles the oldest
  const SIDE = 512;           // 262 144 particles, 32 768 per burst

  const SIM_COMMON = HASH + `
in vec2 vUv;
uniform sampler2D uPos, uVel;
uniform vec4 uSlots[${SLOTS}];   // xyz = origin, w = generation counter
uniform float uDt, uTime, uEnergy, uSmokeRatio;
int slotOf(vec2 uv){
  float idx = floor(uv.y * ${SIDE}.0) * ${SIDE}.0 + floor(uv.x * ${SIDE}.0);
  return int(mod(floor(idx / ${SIDE * SIDE / SLOTS}.0), ${SLOTS}.0));
}
bool isSmoke(vec2 uv){ return hash22(uv * 331.0).y < uSmokeRatio; }`;

  const VEL_PASS = SIM_COMMON + NOISE + CURL + `
uniform float uGravity, uDrag, uTurbulence, uSwirl;
out vec4 fragColor;
void main(){
  int s = slotOf(vUv);
  vec4 slot = uSlots[s];
  vec4 V = texture(uVel, vUv);

  if (V.w != slot.w) {
    // Fresh generation in this slot: throw the particle outward.
    vec3 rnd = hash33(vec3(vUv * 977.0, slot.w));
    vec3 dir = normalize(hash33(vec3(vUv * 311.0, slot.w + 7.0)) * 2.0 - 1.0 + 1e-4);
    // Bimodal speed: a slow dense core plus a fifth of the particles thrown
    // hard outward. A single distribution just gives an expanding ball.
    float fast = step(0.80, rnd.y);
    float sp = uEnergy * mix(pow(rnd.x, 2.2) * 0.85, 0.85 + rnd.x * 1.7, fast);
    sp *= isSmoke(vUv) ? 0.26 : 1.0;
    fragColor = vec4(dir * sp + vec3(0.0, sp * 0.2, 0.0), slot.w);
    return;
  }

  vec3 p = texture(uPos, vUv).xyz;
  vec3 v = V.xyz;
  bool smoke = isSmoke(vUv);

  vec3 acc = vec3(0.0, smoke ? uGravity * 0.25 : -uGravity, 0.0);
  acc += curlNoise(p * uSwirl, uTime * 0.5) * uTurbulence * (smoke ? 1.6 : 0.7);
  v += acc * uDt;
  v *= exp(-(smoke ? uDrag * 2.4 : uDrag) * uDt);
  fragColor = vec4(v, V.w);
}`;

  const POS_PASS = SIM_COMMON + `
uniform sampler2D uVelNew;
uniform float uLifespan;
out vec4 fragColor;
void main(){
  int s = slotOf(vUv);
  vec4 slot = uSlots[s];
  vec4 V = texture(uVel, vUv);
  if (V.w != slot.w) {
    fragColor = vec4(slot.xyz + (hash33(vec3(vUv * 53.0, slot.w)) - 0.5) * 0.02, 1.0);
    return;
  }
  vec4 P = texture(uPos, vUv);
  float life = P.w - uDt / max(uLifespan, 0.1) * mix(0.7, 1.3, hash22(vUv * 17.0).x);
  fragColor = vec4(P.xyz + texture(uVelNew, vUv).xyz * uDt, max(life, 0.0));
}`;

  const DRAW_VS = HASH + COLORMAP + `
uniform sampler2D uPos, uVel;
uniform float uSize, uViewHeight, uAspect, uSmokeRatio;
uniform int uPalette;
out vec3 vColor;
out float vAlpha;
void main(){
  ivec2 ij = ivec2(gl_VertexID % ${SIDE}, gl_VertexID / ${SIDE});
  vec2 uv = (vec2(ij) + 0.5) / ${SIDE}.0;
  vec4 P = texelFetch(uPos, ij, 0);
  vec3 v = texelFetch(uVel, ij, 0).xyz;

  gl_Position = vec4(P.x / uAspect, P.y, 0.0, 1.0);
  bool smoke = hash22(uv * 331.0).y < uSmokeRatio;

  float life = P.w;
  float grow = smoke ? (1.0 + (1.0 - life) * 6.0) : (0.35 + life * 0.9);
  gl_PointSize = clamp(uSize * uViewHeight * 0.004 * grow, 1.0, 128.0);

  float speed = length(v);
  if (smoke) {
    vColor = mix(vec3(0.30, 0.19, 0.15), vec3(0.05, 0.05, 0.06), 1.0 - life) * 0.9;
    vAlpha = life * life * 0.10;
  } else {
    float heat = clamp(life * 0.75 + speed * 0.05, 0.0, 1.0);
    vColor = (uPalette == 0 ? rampHot(heat) : rampCool(heat)) * (1.2 + speed * 0.15);
    vAlpha = smoothstep(0.0, 0.15, life) * mix(0.35, 1.0, life);
  }
  if (life <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }
}`;

  const DRAW_FS = `
in vec3 vColor;
in float vAlpha;
uniform float uIntensity;
out vec4 fragColor;
void main(){
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 2.6) * vAlpha * uIntensity;
  fragColor = vec4(vColor * a, a);
}`;

  const FADE = `
in vec2 vUv;
uniform sampler2D uPrev;
uniform float uFade;
out vec4 fragColor;
void main(){ fragColor = texture(uPrev, vUv) * uFade; }`;

  const BRIGHT = `
in vec2 vUv;
uniform sampler2D uScene;
uniform float uThreshold, uKnee;
out vec4 fragColor;
void main(){
  vec3 c = texture(uScene, vUv).rgb;
  float b = max(max(c.r, c.g), c.b);
  // Soft knee so the bloom ramps in instead of switching on at the threshold.
  float soft = clamp(b - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float w = max(soft, b - uThreshold) / max(b, 1e-4);
  fragColor = vec4(c * w, 1.0);
}`;

  const DOWN = `
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
out vec4 fragColor;
void main(){
  // 13-tap "dual filter" downsample — stable under motion, unlike a plain box.
  vec3 a = texture(uSrc, vUv + uTexel * vec2(-2.0,  2.0)).rgb;
  vec3 b = texture(uSrc, vUv + uTexel * vec2( 0.0,  2.0)).rgb;
  vec3 c = texture(uSrc, vUv + uTexel * vec2( 2.0,  2.0)).rgb;
  vec3 d = texture(uSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  vec3 e = texture(uSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  vec3 f = texture(uSrc, vUv + uTexel * vec2(-2.0,  0.0)).rgb;
  vec3 g = texture(uSrc, vUv).rgb;
  vec3 h = texture(uSrc, vUv + uTexel * vec2( 2.0,  0.0)).rgb;
  vec3 i = texture(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  vec3 j = texture(uSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  vec3 k = texture(uSrc, vUv + uTexel * vec2(-2.0, -2.0)).rgb;
  vec3 l = texture(uSrc, vUv + uTexel * vec2( 0.0, -2.0)).rgb;
  vec3 m = texture(uSrc, vUv + uTexel * vec2( 2.0, -2.0)).rgb;
  vec3 o = (d + e + i + j) * 0.5 + (a + b + g + f) * 0.125 + (b + c + h + g) * 0.125
         + (f + g + l + k) * 0.125 + (g + h + m + l) * 0.125;
  fragColor = vec4(o * 0.25, 1.0);
}`;

  const UP = `
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uRadius;
out vec4 fragColor;
void main(){
  vec2 t = uTexel * uRadius;
  vec3 s = texture(uSrc, vUv + vec2(-t.x,  t.y)).rgb + texture(uSrc, vUv + vec2(0.0,  t.y)).rgb * 2.0 + texture(uSrc, vUv + vec2(t.x,  t.y)).rgb
         + texture(uSrc, vUv + vec2(-t.x, 0.0)).rgb * 2.0 + texture(uSrc, vUv).rgb * 4.0 + texture(uSrc, vUv + vec2(t.x, 0.0)).rgb * 2.0
         + texture(uSrc, vUv + vec2(-t.x, -t.y)).rgb + texture(uSrc, vUv + vec2(0.0, -t.y)).rgb * 2.0 + texture(uSrc, vUv + vec2(t.x, -t.y)).rgb;
  fragColor = vec4(s * (1.0 / 16.0), 1.0);
}`;

  const PRESENT = TONEMAP + `
in vec2 vUv;
uniform sampler2D uScene, uBloom;
uniform vec4 uWaves[${SLOTS}];   // xy centre, z birth time, w strength
uniform float uTime, uAspect, uBloomAmount, uAberration, uWaveSpeed, uExposure;
out vec4 fragColor;

vec2 shockOffset(vec2 uv, out float rim){
  vec2 off = vec2(0.0);
  rim = 0.0;
  for (int i = 0; i < ${SLOTS}; i++) {
    vec4 w = uWaves[i];
    float age = uTime - w.z;
    if (w.w <= 0.0 || age < 0.0 || age > 1.4) continue;
    vec2 d = (uv - w.xy) * vec2(uAspect, 1.0);
    float dist = length(d);
    float r = age * uWaveSpeed;
    // Thin gaussian ring that widens and weakens as the front expands.
    float ring = exp(-pow((dist - r) / (0.02 + age * 0.05), 2.0));
    float decay = pow(1.0 - age / 1.4, 2.0);
    off += normalize(d + 1e-5) * ring * decay * w.w * 0.05;
    rim += ring * decay * w.w;
  }
  return off;
}

void main(){
  float rim;
  vec2 off = shockOffset(vUv, rim);
  float ab = uAberration * 0.004 * (1.0 + rim * 6.0);
  vec2 dir = normalize(vUv - 0.5 + 1e-5);

  vec3 scene;
  scene.r = texture(uScene, vUv - off * 1.0 - dir * ab).r;
  scene.g = texture(uScene, vUv - off * 1.06).g;
  scene.b = texture(uScene, vUv - off * 1.12 + dir * ab).b;

  vec3 bloom = texture(uBloom, vUv - off).rgb;
  vec3 col = scene + bloom * uBloomAmount;
  col += vec3(1.0, 0.75, 0.45) * rim * 0.12;      // the front glows as it passes

  col *= uExposure;
  col = aces(col);
  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q, q) * 0.7;
  col += (grain(vUv, uTime) - 0.5) * 0.022;
  fragColor = vec4(toSRGB(max(col, 0.0)), 1.0);
}`;

  /* ------------------------------------------------------------------ the rig */

  Bench.registerRig({
    id: 'vfx',
    name: 'VFX',
    method: 'Composite',
    accent: '#FF4D8D',
    blurb: 'The full effects stack in one frame: a ring of burst emitters driving sparks and smoke, an expanding shockwave that refracts everything behind it, and a bloom pyramid that gives the hot core its bleed.',
    hint: 'Click anywhere to detonate',
    controls: [
      { id: 'energy', label: 'Burst energy', type: 'range', min: 0.2, max: 4, step: 0.05, value: 2.1 },
      { id: 'lifespan', label: 'Lifespan', type: 'range', min: 0.3, max: 5, step: 0.05, value: 2.1, unit: ' s' },
      { id: 'gravity', label: 'Gravity', type: 'range', min: 0, max: 3, step: 0.02, value: 0.9 },
      { id: 'drag', label: 'Drag', type: 'range', min: 0, max: 6, step: 0.05, value: 0.85 },
      { id: 'turbulence', label: 'Turbulence', type: 'range', min: 0, max: 4, step: 0.05, value: 1.1 },
      { id: 'swirl', label: 'Turbulence scale', type: 'range', min: 0.5, max: 8, step: 0.1, value: 3.2 },
      { id: 'smoke', label: 'Smoke fraction', type: 'range', min: 0, max: 0.9, step: 0.01, value: 0.42 },
      { id: 'size', label: 'Sprite size', type: 'range', min: 0.2, max: 6, step: 0.05, value: 1.15 },
      { id: 'intensity', label: 'Intensity', type: 'range', min: 0.01, max: 1, step: 0.01, value: 0.1 },
      { id: 'bloom', label: 'Bloom', type: 'range', min: 0, max: 3, step: 0.02, value: 1.1 },
      { id: 'threshold', label: 'Bloom threshold', type: 'range', min: 0, max: 2, step: 0.01, value: 0.62 },
      { id: 'shock', label: 'Shockwave', type: 'range', min: 0, max: 3, step: 0.02, value: 1.0 },
      { id: 'aberration', label: 'Chromatic aberration', type: 'range', min: 0, max: 4, step: 0.02, value: 1.0 },
      { id: 'trails', label: 'Trails', type: 'range', min: 0, max: 0.96, step: 0.01, value: 0.76 },
      { id: 'palette', label: 'Spark colour', type: 'select', value: 'hot', options: [['hot', 'Ember'], ['cool', 'Plasma']] },
      { id: 'auto', label: 'Auto-fire', type: 'toggle', value: true },
      { id: 'fire', label: 'Detonate', type: 'button' }
    ],

    create(gl, ctx) {
      const caps = ctx.caps;
      if (!caps.renderHalf) throw new Error('This rig needs float render targets (EXT_color_buffer_float).');
      const fmt = caps.renderFloat ? 'rgba32f' : 'rgba16f';

      const progs = {
        vel: screenProgram(gl, VEL_PASS),
        pos: screenProgram(gl, POS_PASS),
        draw: new Program(gl, Bench.HEAD + DRAW_VS, DRAW_FS),
        fade: screenProgram(gl, FADE),
        bright: screenProgram(gl, BRIGHT),
        down: screenProgram(gl, DOWN),
        up: screenProgram(gl, UP),
        present: screenProgram(gl, PRESENT)
      };

      const pos = new PingPong(gl, SIDE, SIDE, { format: fmt, filter: 'NEAREST' });
      const vel = new PingPong(gl, SIDE, SIDE, { format: fmt, filter: 'NEAREST' });
      // Dead on arrival: generation -1 matches no slot, so nothing draws until fired.
      (function initDead() {
        const p = new Float32Array(SIDE * SIDE * 4);
        for (let i = 0; i < SIDE * SIDE; i++) p[i * 4 + 3] = 0;
        [pos.a, pos.b].forEach(t => {
          gl.bindTexture(gl.TEXTURE_2D, t.tex);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SIDE, SIDE, gl.RGBA, gl.FLOAT, p);
        });
        const v = new Float32Array(SIDE * SIDE * 4);
        for (let i = 0; i < SIDE * SIDE; i++) v[i * 4 + 3] = -1;
        [vel.a, vel.b].forEach(t => {
          gl.bindTexture(gl.TEXTURE_2D, t.tex);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SIDE, SIDE, gl.RGBA, gl.FLOAT, v);
        });
      })();

      const slots = new Float32Array(SLOTS * 4);
      for (let i = 0; i < SLOTS; i++) slots[i * 4 + 3] = -1;
      const waves = new Float32Array(SLOTS * 4);
      let nextSlot = 0, generation = 0, autoTimer = 0.4;

      let scene = null, bloom = [], sceneW = 0, sceneH = 0;
      const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3);

      function allocTargets(w, h) {
        if (scene) scene.dispose();
        bloom.forEach(t => t.dispose());
        bloom = [];
        sceneW = w; sceneH = h;
        scene = new PingPong(gl, w, h, { format: 'rgba16f', filter: 'LINEAR' });
        scene.a.bind(true); scene.b.bind(true);
        let bw = Math.max(2, w >> 1), bh = Math.max(2, h >> 1);
        for (let i = 0; i < 5 && bw > 8 && bh > 8; i++) {
          bloom.push(new Target(gl, bw, bh, { format: 'rgba16f', filter: 'LINEAR' }));
          bw = Math.max(2, bw >> 1); bh = Math.max(2, bh >> 1);
        }
      }
      allocTargets(ctx.width, ctx.height);

      function detonate(x, y, time) {
        const aspect = ctx.width / ctx.height;
        // Clip space, aspect-corrected so a burst is round on any window.
        const cx = (x * 2 - 1) * aspect, cy = y * 2 - 1;
        generation++;
        const s = nextSlot;
        slots[s * 4] = cx; slots[s * 4 + 1] = cy; slots[s * 4 + 2] = 0; slots[s * 4 + 3] = generation;
        waves[s * 4] = x; waves[s * 4 + 1] = y; waves[s * 4 + 2] = time; waves[s * 4 + 3] = ctx.params.shock;
        nextSlot = (nextSlot + 1) % SLOTS;
      }

      return {
        resize(w, h) { allocTargets(w, h); },

        frame(dt, time) {
          const P = ctx.params, p = ctx.pointer;
          const aspect = ctx.width / ctx.height;

          for (const c of p.clicks) detonate(c[0], c[1], time);
          if (P.auto) {
            autoTimer -= dt;
            if (autoTimer <= 0) {
              autoTimer = 0.55 + Math.random() * 1.4;
              detonate(0.18 + Math.random() * 0.64, 0.22 + Math.random() * 0.56, time);
            }
          }

          gl.disable(gl.BLEND);
          gl.disable(gl.DEPTH_TEST);

          vel.write.bind();
          progs.vel.use()
            .tex('uPos', pos.read.tex).tex('uVel', vel.read.tex)
            .v4v('uSlots', slots)
            .f('uDt', dt).f('uTime', time).f('uEnergy', P.energy).f('uSmokeRatio', P.smoke)
            .f('uGravity', P.gravity).f('uDrag', P.drag)
            .f('uTurbulence', P.turbulence).f('uSwirl', P.swirl);
          draw();

          // The velocity swap waits: the position pass compares against the
          // *previous* generation counter to know a burst just recycled this slot.
          pos.write.bind();
          progs.pos.use()
            .tex('uPos', pos.read.tex).tex('uVel', vel.read.tex).tex('uVelNew', vel.write.tex)
            .v4v('uSlots', slots)
            .f('uDt', dt).f('uTime', time).f('uEnergy', P.energy).f('uSmokeRatio', P.smoke)
            .f('uLifespan', P.lifespan);
          draw();
          pos.swap(); vel.swap();

          // --- sparks into the accumulation buffer
          scene.write.bind();
          progs.fade.use().tex('uPrev', scene.read.tex).f('uFade', P.trails);
          draw();

          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE);
          progs.draw.use()
            .tex('uPos', pos.read.tex).tex('uVel', vel.read.tex)
            .f('uSize', P.size).f('uViewHeight', ctx.height)
            .f('uAspect', aspect).f('uSmokeRatio', P.smoke)
            .f('uIntensity', P.intensity).i('uPalette', P.palette === 'hot' ? 0 : 1);
          gl.drawArrays(gl.POINTS, 0, SIDE * SIDE);
          gl.disable(gl.BLEND);
          scene.swap();

          // --- bloom pyramid: threshold, down, then tent-filtered up
          bloom[0].bind();
          progs.bright.use().tex('uScene', scene.read.tex)
            .f('uThreshold', P.threshold).f('uKnee', 0.35);
          draw();

          for (let i = 1; i < bloom.length; i++) {
            bloom[i].bind();
            progs.down.use().tex('uSrc', bloom[i - 1].tex)
              .v2('uTexel', bloom[i - 1].texelX, bloom[i - 1].texelY);
            draw();
          }
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE);
          for (let i = bloom.length - 2; i >= 0; i--) {
            bloom[i].bind();
            progs.up.use().tex('uSrc', bloom[i + 1].tex)
              .v2('uTexel', bloom[i + 1].texelX, bloom[i + 1].texelY).f('uRadius', 1.0);
            draw();
          }
          gl.disable(gl.BLEND);

          // --- present
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, ctx.width, ctx.height);
          progs.present.use()
            .tex('uScene', scene.read.tex).tex('uBloom', bloom[0].tex)
            .v4v('uWaves', waves)
            .f('uTime', time).f('uAspect', aspect)
            .f('uBloomAmount', P.bloom).f('uAberration', P.aberration)
            .f('uWaveSpeed', 0.62).f('uExposure', 1.0);
          draw();
        },

        action(id) {
          if (id === 'fire') detonate(0.5, 0.5, ctx.clock);
        },

        stats() {
          const live = Math.min(SLOTS, generation);
          return [
            ['sprites', (SIDE * SIDE / 1000).toFixed(0) + ' K'],
            ['bursts', live + '/' + SLOTS],
            ['bloom', bloom.length + ' levels'],
            ['buffer', sceneW + '×' + sceneH]
          ];
        },

        dispose() {
          Object.values(progs).forEach(p => p.dispose());
          pos.dispose(); vel.dispose();
          if (scene) scene.dispose();
          bloom.forEach(t => t.dispose());
        }
      };
    }
  });
})(window.Bench);
