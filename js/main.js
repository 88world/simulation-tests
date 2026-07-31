/* main.js — the bench itself: context setup, rig switching, live controls,
   telemetry and the frame loop. Rigs register themselves; this file drives them. */
(function (Bench) {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const canvas = $('#gl');
  const stage = $('#stage');
  const tabsEl = $('#tabs');
  const panelEl = $('#panel-body');
  const panelTitle = $('#panel-title');
  const panelMethod = $('#panel-method');
  const panelBlurb = $('#panel-blurb');
  const hintEl = $('#hint');
  const statsEl = $('#stats');
  const overlay = $('#overlay');

  /* ------------------------------------------------------------------ context */

  const gl = canvas.getContext('webgl2', {
    alpha: false, antialias: false, depth: true, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer: false,
    powerPreference: 'high-performance', desynchronized: true
  });

  function fail(title, detail) {
    overlay.innerHTML = '';
    const box = el('div', 'overlay__box');
    box.appendChild(el('h2', 'overlay__title', title));
    box.appendChild(el('p', 'overlay__text', String(detail).slice(0, 300)));
    overlay.appendChild(box);
    overlay.hidden = false;
  }

  /** Logs the full diagnostic, shows the reader one readable line. */
  function report(title, err) {
    console.error(err);
    if (err && err.source) console.error(err.log + '\n' + err.source);
    fail(title, err && err.message ? err.message : err);
  }

  if (!gl) {
    fail('WebGL 2 unavailable',
      'Every rig here is written against WebGL 2 — float render targets, instancing and attribute-less draws. Chrome, Edge, Firefox and Safari 15+ all support it; if you are on one of those, check that hardware acceleration is enabled.');
    return;
  }

  const caps = Bench.floatCaps(gl);
  const emptyVAO = gl.createVertexArray();
  gl.bindVertexArray(emptyVAO);

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    running = false;
    fail('Graphics context lost', 'The browser reclaimed the GPU context — usually a driver reset or another tab demanding memory. Reload to restart the bench.');
  });

  /* -------------------------------------------------------------------- state */

  const rigs = Bench.rigs.slice();
  const pointer = new Bench.Pointer(canvas);
  const ctx = { canvas, gl, caps, pointer, params: {}, width: 1, height: 1, clock: 0 };

  let current = null, instance = null, running = true, scale = 1;
  let clock = 0, lastT = 0, fpsAcc = 0, fpsFrames = 0, fps = 0, frameMs = 0, statTimer = 0;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* -------------------------------------------------------------------- sizing */

  function resize() {
    const r = stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.round(r.width * dpr * scale));
    const h = Math.max(2, Math.round(r.height * dpr * scale));
    if (w === ctx.width && h === ctx.height) return;
    canvas.width = w; canvas.height = h;
    ctx.width = w; ctx.height = h;
    if (instance && instance.resize) instance.resize(w, h);
  }
  new ResizeObserver(resize).observe(stage);
  window.addEventListener('orientationchange', () => setTimeout(resize, 120));

  /* ------------------------------------------------------------------ controls */

  function buildControls(rig) {
    panelEl.innerHTML = '';
    ctx.params = {};

    for (const c of rig.controls) {
      if (c.type !== 'button') ctx.params[c.id] = c.value;
    }

    for (const c of rig.controls) {
      if (c.type === 'button') {
        const b = el('button', 'ctrl-button', c.label);
        b.type = 'button';
        b.addEventListener('click', () => instance && instance.action && instance.action(c.id));
        panelEl.appendChild(b);
        continue;
      }

      const row = el('div', 'ctrl ctrl--' + c.type);
      const head = el('div', 'ctrl__head');
      const label = el('label', 'ctrl__label', c.label);
      label.htmlFor = 'c-' + c.id;
      head.appendChild(label);

      if (c.type === 'range') {
        const val = el('output', 'ctrl__value');
        const fmt = (v) => {
          const n = Number(v);
          const dec = c.step >= 1 ? 0 : (c.step >= 0.1 ? 1 : (c.step >= 0.01 ? 2 : 3));
          return n.toFixed(dec) + (c.unit || '');
        };
        val.textContent = fmt(c.value);
        head.appendChild(val);
        row.appendChild(head);

        const input = el('input', 'ctrl__range');
        input.type = 'range'; input.id = 'c-' + c.id;
        input.min = c.min; input.max = c.max; input.step = c.step; input.value = c.value;
        input.addEventListener('input', () => {
          ctx.params[c.id] = parseFloat(input.value);
          val.textContent = fmt(input.value);
        });
        row.appendChild(input);
      } else if (c.type === 'select') {
        row.appendChild(head);
        const sel = el('select', 'ctrl__select');
        sel.id = 'c-' + c.id;
        for (const [v, name] of c.options) {
          const o = el('option', null, name);
          o.value = v;
          sel.appendChild(o);
        }
        sel.value = c.value;
        sel.addEventListener('change', () => { ctx.params[c.id] = sel.value; });
        row.appendChild(sel);
      } else if (c.type === 'toggle') {
        const sw = el('button', 'ctrl__switch');
        sw.type = 'button';
        sw.id = 'c-' + c.id;
        sw.setAttribute('role', 'switch');
        const sync = () => {
          sw.setAttribute('aria-checked', String(!!ctx.params[c.id]));
          sw.dataset.on = ctx.params[c.id] ? 'true' : 'false';
        };
        sync();
        sw.addEventListener('click', () => { ctx.params[c.id] = !ctx.params[c.id]; sync(); });
        head.appendChild(sw);
        row.appendChild(head);
      } else if (c.type === 'color') {
        const input = el('input', 'ctrl__color');
        input.type = 'color'; input.id = 'c-' + c.id; input.value = c.value;
        input.addEventListener('input', () => { ctx.params[c.id] = input.value; });
        head.appendChild(input);
        row.appendChild(head);
      }
      panelEl.appendChild(row);
    }

    const restore = el('button', 'ctrl-reset', 'Restore defaults');
    restore.type = 'button';
    restore.addEventListener('click', () => load(current.id, true));
    panelEl.appendChild(restore);
  }

  /* ---------------------------------------------------------------- rig switch */

  function load(id, force) {
    const rig = rigs.find(r => r.id === id) || rigs[0];
    if (current && current.id === rig.id && !force) return;

    if (instance && instance.dispose) { try { instance.dispose(); } catch (e) { /* teardown is best-effort */ } }
    instance = null;
    current = rig;

    document.documentElement.style.setProperty('--rig-accent', rig.accent);
    for (const b of tabsEl.children) b.setAttribute('aria-selected', String(b.dataset.id === rig.id));
    panelTitle.textContent = rig.name;
    panelMethod.textContent = rig.method;
    panelBlurb.textContent = rig.blurb;
    hintEl.textContent = rig.hint;
    document.title = rig.name + ' · Simulation Tests';

    buildControls(rig);
    resize();
    clock = 0;

    overlay.hidden = true;
    try {
      instance = rig.create(gl, ctx);
    } catch (err) {
      report('This rig could not start', err);
      return;
    }
    if (location.hash.slice(1) !== rig.id) history.replaceState(null, '', '#' + rig.id);
  }

  for (const rig of rigs) {
    const b = el('button', 'tab');
    b.type = 'button';
    b.dataset.id = rig.id;
    b.setAttribute('role', 'tab');
    b.style.setProperty('--tab-accent', rig.accent);
    b.appendChild(el('span', 'tab__dot'));
    b.appendChild(el('span', 'tab__name', rig.name));
    b.appendChild(el('span', 'tab__method', rig.method));
    b.addEventListener('click', () => load(rig.id));
    tabsEl.appendChild(b);
  }

  window.addEventListener('hashchange', () => load(location.hash.slice(1)));

  /* --------------------------------------------------------------- bench chrome */

  const playBtn = $('#play');
  const panelBtn = $('#panel-toggle');
  const fsBtn = $('#fullscreen');
  const scaleSel = $('#scale');
  const shell = $('#shell');

  function syncPlay() {
    playBtn.dataset.state = running ? 'running' : 'paused';
    playBtn.setAttribute('aria-label', running ? 'Pause simulation' : 'Resume simulation');
    playBtn.querySelector('.btn__label').textContent = running ? 'Pause' : 'Run';
  }
  playBtn.addEventListener('click', () => { running = !running; lastT = 0; syncPlay(); });

  panelBtn.addEventListener('click', () => {
    const open = shell.dataset.panel !== 'closed';
    shell.dataset.panel = open ? 'closed' : 'open';
    panelBtn.setAttribute('aria-expanded', String(!open));
  });

  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (shell.requestFullscreen) shell.requestFullscreen();
  });

  scaleSel.addEventListener('change', () => { scale = parseFloat(scaleSel.value); resize(); });

  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, button')) return;
    if (e.key === ' ') { e.preventDefault(); running = !running; lastT = 0; syncPlay(); }
    if (e.key >= '1' && e.key <= String(rigs.length)) load(rigs[parseInt(e.key, 10) - 1].id);
  });

  /* ---------------------------------------------------------------- telemetry */

  function renderStats() {
    const rows = [
      ['fps', fps ? fps.toFixed(0) : '—'],
      ['frame', frameMs ? frameMs.toFixed(1) + ' ms' : '—'],
      ['viewport', ctx.width + '×' + ctx.height]
    ];
    if (instance && instance.stats) {
      try { rows.push.apply(rows, instance.stats()); } catch (e) { /* stats are cosmetic */ }
    }
    statsEl.innerHTML = '';
    for (const [k, v] of rows) {
      const item = el('div', 'stat');
      item.appendChild(el('span', 'stat__key', k));
      item.appendChild(el('span', 'stat__val', v));
      statsEl.appendChild(item);
    }
  }

  /* --------------------------------------------------------------------- loop */

  function frame(t) {
    requestAnimationFrame(frame);
    if (!instance) return;

    const now = t * 0.001;
    if (!lastT) lastT = now;
    const rawDt = now - lastT;
    lastT = now;
    // A tab that was backgrounded returns a huge dt; feeding that to an
    // explicit integrator detonates it. Telemetry keeps the real delta —
    // clamping it there would report 30 fps on a machine doing 4.
    const dt = Math.min(rawDt, 1 / 30);

    if (running) {
      clock += dt;
      ctx.clock = clock;
      const t0 = performance.now();
      try {
        instance.frame(dt, clock);
      } catch (err) {
        report('This rig stopped', err);
        instance = null;
        return;
      }
      frameMs = frameMs ? frameMs * 0.9 + (performance.now() - t0) * 0.1 : performance.now() - t0;
      fpsAcc += rawDt; fpsFrames++;
      if (fpsAcc >= 0.25) { fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; }
    }
    pointer.endFrame();

    statTimer += rawDt;
    if (statTimer > 0.25) { statTimer = 0; renderStats(); }
  }

  /* --------------------------------------------------------------------- boot */

  if (!caps.renderHalf) {
    fail('Float render targets unavailable',
      'These rigs keep their state in floating-point textures, which needs EXT_color_buffer_float. The extension is standard on desktop and on iOS 15+; some older mobile GPUs do not expose it.');
  }

  syncPlay();
  resize();
  load(location.hash.slice(1) || rigs[0].id);
  if (reduceMotion) { running = false; syncPlay(); }
  renderStats();
  requestAnimationFrame(frame);
})(window.Bench);
