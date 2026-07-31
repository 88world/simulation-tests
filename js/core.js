/* core.js — WebGL2 plumbing shared by every rig on the bench.
   No dependencies, no build step: plain scripts, globals under `Bench`. */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- registry */

  const rigs = [];
  function registerRig(def) { rigs.push(def); }

  /* ------------------------------------------------------------------ shaders */

  const HEAD = '#version 300 es\nprecision highp float;\nprecision highp int;\n';
  const HEAD_FS = HEAD + 'precision highp sampler2D;\n';

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = (gl.getShaderInfoLog(sh) || '').trim();
      const err = new Error('Shader compile failed — ' + log.split('\n')[0]);
      // Full listing rides along for the console; it must never reach the UI.
      err.source = src.split('\n').map((l, i) => String(i + 1).padStart(4) + ' | ' + l).join('\n');
      err.log = log;
      throw err;
    }
    return sh;
  }

  /** A linked program with cached uniform lookups and typed setters. */
  class Program {
    constructor(gl, vsSrc, fsSrc) {
      this.gl = gl;
      const vs = compile(gl, gl.VERTEX_SHADER, vsSrc.startsWith('#version') ? vsSrc : HEAD + vsSrc);
      const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc.startsWith('#version') ? fsSrc : HEAD_FS + fsSrc);
      const p = gl.createProgram();
      gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link failed: ' + gl.getProgramInfoLog(p));
      gl.deleteShader(vs); gl.deleteShader(fs);
      this.handle = p;
      this._loc = new Map();
      this._unit = 0;
    }
    loc(name) {
      if (!this._loc.has(name)) this._loc.set(name, this.gl.getUniformLocation(this.handle, name));
      return this._loc.get(name);
    }
    use() { this.gl.useProgram(this.handle); this._unit = 0; return this; }
    f(n, v) { this.gl.uniform1f(this.loc(n), v); return this; }
    i(n, v) { this.gl.uniform1i(this.loc(n), v); return this; }
    v2(n, x, y) { this.gl.uniform2f(this.loc(n), x, y); return this; }
    v3(n, x, y, z) { this.gl.uniform3f(this.loc(n), x, y, z); return this; }
    v4(n, x, y, z, w) { this.gl.uniform4f(this.loc(n), x, y, z, w); return this; }
    fv(n, arr) { this.gl.uniform1fv(this.loc(n), arr); return this; }
    v2v(n, arr) { this.gl.uniform2fv(this.loc(n), arr); return this; }
    v4v(n, arr) { this.gl.uniform4fv(this.loc(n), arr); return this; }
    mat4(n, m) { this.gl.uniformMatrix4fv(this.loc(n), false, m); return this; }
    mat3(n, m) { this.gl.uniformMatrix3fv(this.loc(n), false, m); return this; }
    /** Binds `tex` to the next free unit and points sampler `n` at it. */
    tex(n, tex) {
      const gl = this.gl, unit = this._unit++;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(this.loc(n), unit);
      return this;
    }
    dispose() { this.gl.deleteProgram(this.handle); }
  }

  /* ------------------------------------------------------------- render targets */

  /** Picks the widest float format the driver will actually render to. */
  function floatCaps(gl) {
    const colorFloat = gl.getExtension('EXT_color_buffer_float');
    const halfOnly = !colorFloat && gl.getExtension('EXT_color_buffer_half_float');
    const linearFloat = !!gl.getExtension('OES_texture_float_linear');
    return {
      renderFloat: !!colorFloat,
      renderHalf: !!colorFloat || !!halfOnly,
      linearFloat,
      // 16F is filterable in core WebGL2; 32F needs the extension.
      best: colorFloat ? 'float' : (halfOnly ? 'half' : null)
    };
  }

  const FORMATS = {
    r16f: ['R16F', 'RED', 'HALF_FLOAT'],
    rg16f: ['RG16F', 'RG', 'HALF_FLOAT'],
    rgba16f: ['RGBA16F', 'RGBA', 'HALF_FLOAT'],
    r32f: ['R32F', 'RED', 'FLOAT'],
    rgba32f: ['RGBA32F', 'RGBA', 'FLOAT'],
    rgba8: ['RGBA8', 'RGBA', 'UNSIGNED_BYTE']
  };

  function createTexture(gl, w, h, opts) {
    opts = opts || {};
    const fmt = FORMATS[opts.format || 'rgba16f'];
    const filter = gl[opts.filter || 'LINEAR'];
    const wrap = gl[opts.wrap || 'CLAMP_TO_EDGE'];
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl[fmt[0]], w, h, 0, gl[fmt[1]], gl[fmt[2]], opts.data || null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    return tex;
  }

  /** Texture + framebuffer pair, with the texel size the shaders need. */
  class Target {
    constructor(gl, w, h, opts) {
      this.gl = gl; this.w = w; this.h = h;
      this.texelX = 1 / w; this.texelY = 1 / h;
      this.tex = createTexture(gl, w, h, opts);
      this.fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    bind(clear) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, this.w, this.h);
      if (clear) { gl.clearColor(0, 0, 0, clear === true ? 1 : 0); gl.clear(gl.COLOR_BUFFER_BIT); }
      return this;
    }
    dispose() { this.gl.deleteTexture(this.tex); this.gl.deleteFramebuffer(this.fbo); }
  }

  /** Two targets that trade places — the backbone of every iterative solver here. */
  class PingPong {
    constructor(gl, w, h, opts) {
      this.a = new Target(gl, w, h, opts);
      this.b = new Target(gl, w, h, opts);
      this.w = w; this.h = h; this.texelX = 1 / w; this.texelY = 1 / h;
    }
    get read() { return this.a; }
    get write() { return this.b; }
    swap() { const t = this.a; this.a = this.b; this.b = t; }
    dispose() { this.a.dispose(); this.b.dispose(); }
  }

  /* --------------------------------------------------------------- screen quad */

  // WebGL2 can synthesise a fullscreen triangle from gl_VertexID alone, so there
  // are no vertex buffers anywhere in the post/solver passes.
  const SCREEN_VS = HEAD + `
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  function screenProgram(gl, fsSrc) { return new Program(gl, SCREEN_VS, fsSrc); }

  /* ------------------------------------------------------------------- mat4 */

  const M4 = {
    create() { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); },
    perspective(out, fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
      out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
      out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
      out[8] = 0; out[9] = 0; out[10] = (far + near) * nf; out[11] = -1;
      out[12] = 0; out[13] = 0; out[14] = 2 * far * near * nf; out[15] = 0;
      return out;
    },
    lookAt(out, eye, center, up) {
      let z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
      let len = 1 / Math.hypot(z0, z1, z2); z0 *= len; z1 *= len; z2 *= len;
      let x0 = up[1] * z2 - up[2] * z1, x1 = up[2] * z0 - up[0] * z2, x2 = up[0] * z1 - up[1] * z0;
      len = Math.hypot(x0, x1, x2);
      if (len) { len = 1 / len; x0 *= len; x1 *= len; x2 *= len; } else { x0 = x1 = x2 = 0; }
      const y0 = z1 * x2 - z2 * x1, y1 = z2 * x0 - z0 * x2, y2 = z0 * x1 - z1 * x0;
      out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
      out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
      out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
      out[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
      out[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
      out[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
      out[15] = 1;
      return out;
    },
    multiply(out, a, b) {
      for (let c = 0; c < 4; c++) {
        const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
        out[c * 4] = b0 * a[0] + b1 * a[4] + b2 * a[8] + b3 * a[12];
        out[c * 4 + 1] = b0 * a[1] + b1 * a[5] + b2 * a[9] + b3 * a[13];
        out[c * 4 + 2] = b0 * a[2] + b1 * a[6] + b2 * a[10] + b3 * a[14];
        out[c * 4 + 3] = b0 * a[3] + b1 * a[7] + b2 * a[11] + b3 * a[15];
      }
      return out;
    }
  };

  /** Spherical camera: drag to orbit, wheel to dolly, optional idle spin. */
  class Orbit {
    constructor(el, opts) {
      opts = opts || {};
      this.theta = opts.theta != null ? opts.theta : 0.6;
      this.phi = opts.phi != null ? opts.phi : 1.25;
      this.dist = opts.dist != null ? opts.dist : 4;
      this.minDist = opts.minDist || 1.6;
      this.maxDist = opts.maxDist || 16;
      this.spin = opts.spin != null ? opts.spin : 0.06;
      this.target = opts.target || [0, 0, 0];
      this.view = M4.create(); this.proj = M4.create(); this.viewProj = M4.create();
      this.eye = [0, 0, 0];
      this._drag = false; this._px = 0; this._py = 0; this._idle = 0;
      const down = (e) => {
        if (e.button != null && e.button !== 0) return;
        this._drag = true; this._idle = 0;
        this._px = e.clientX; this._py = e.clientY;
        el.setPointerCapture && e.pointerId != null && el.setPointerCapture(e.pointerId);
      };
      const move = (e) => {
        if (!this._drag) return;
        const dx = e.clientX - this._px, dy = e.clientY - this._py;
        this._px = e.clientX; this._py = e.clientY;
        this.theta -= dx * 0.006;
        this.phi = Math.min(Math.PI - 0.08, Math.max(0.08, this.phi - dy * 0.006));
      };
      const up = () => { this._drag = false; };
      const wheel = (e) => {
        e.preventDefault();
        this.dist = Math.min(this.maxDist, Math.max(this.minDist, this.dist * Math.exp(e.deltaY * 0.0012)));
      };
      el.addEventListener('pointerdown', down);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      el.addEventListener('wheel', wheel, { passive: false });
      this.dispose = () => {
        el.removeEventListener('pointerdown', down);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        el.removeEventListener('wheel', wheel);
      };
    }
    update(dt, aspect, fov) {
      if (!this._drag) { this._idle += dt; if (this._idle > 1.2) this.theta += this.spin * dt; }
      const sp = Math.sin(this.phi), cp = Math.cos(this.phi);
      this.eye[0] = this.target[0] + this.dist * sp * Math.sin(this.theta);
      this.eye[1] = this.target[1] + this.dist * cp;
      this.eye[2] = this.target[2] + this.dist * sp * Math.cos(this.theta);
      M4.perspective(this.proj, fov || 0.9, aspect, 0.05, 100);
      M4.lookAt(this.view, this.eye, this.target, [0, 1, 0]);
      M4.multiply(this.viewProj, this.proj, this.view);
      return this.viewProj;
    }
  }

  /* ---------------------------------------------------------------- pointer */

  /** Normalised pointer state in 0..1 texture space plus per-frame delta. */
  class Pointer {
    constructor(el) {
      this.x = 0.5; this.y = 0.5; this.dx = 0; this.dy = 0;
      this.down = false; this.moved = false; this.everMoved = false;
      this.clicks = [];
      const pos = (e) => {
        const r = el.getBoundingClientRect();
        const nx = (e.clientX - r.left) / r.width;
        const ny = 1 - (e.clientY - r.top) / r.height;
        this.dx += nx - this.x; this.dy += ny - this.y;
        this.x = nx; this.y = ny;
        this.moved = true; this.everMoved = true;
      };
      this._down = (e) => {
        if (e.button != null && e.button !== 0) return;
        const r = el.getBoundingClientRect();
        this.x = (e.clientX - r.left) / r.width;
        this.y = 1 - (e.clientY - r.top) / r.height;
        this.dx = this.dy = 0;
        this.down = true; this.everMoved = true;
        this.clicks.push([this.x, this.y]);
      };
      this._move = (e) => { if (e.pointerType === 'touch' && !this.down) return; pos(e); };
      this._up = () => { this.down = false; };
      el.addEventListener('pointerdown', this._down);
      window.addEventListener('pointermove', this._move);
      window.addEventListener('pointerup', this._up);
      window.addEventListener('pointercancel', this._up);
      this.el = el;
    }
    /** Call once per frame after consuming: deltas are per-frame, not cumulative. */
    endFrame() { this.dx = 0; this.dy = 0; this.moved = false; this.clicks.length = 0; }
    dispose() {
      this.el.removeEventListener('pointerdown', this._down);
      window.removeEventListener('pointermove', this._move);
      window.removeEventListener('pointerup', this._up);
      window.removeEventListener('pointercancel', this._up);
    }
  }

  /* -------------------------------------------------------------------- misc */

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  /** Deterministic value noise for CPU-side texture baking. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  global.Bench = {
    rigs, registerRig,
    Program, Target, PingPong, Pointer, Orbit, M4,
    screenProgram, createTexture, floatCaps, compile,
    HEAD, HEAD_FS, SCREEN_VS,
    clamp, hexToRgb, mulberry32
  };
})(window);
