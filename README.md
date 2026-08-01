# Simulation Tests

Five real-time simulations running on WebGL 2 in the browser. No dependencies, no
build step, no CDN — open `index.html` and it runs.

**Live:** <https://88world.github.io/simulation-tests/>

| Rig | Method | What it actually does |
| --- | --- | --- |
| **Fur** | Shell rendering | 64 concentric shells of one mesh, instanced. A baked strand field decides which texels survive at each shell height; wind and gravity bend each strand as a cantilever. |
| **Water** | Wave equation | Finite-difference wave equation on a height texture, stepped at a fixed 1/120 s. The surface normal drives refraction, curvature drives caustics. |
| **Particles** | GPGPU | Up to 1 M particles. Position and velocity live in float textures, integrated in two fragment passes, drawn with one attribute-less point call. |
| **VFX** | Composite | Burst emitters feeding sparks and smoke, an expanding shockwave that warps the frame, and a bloom pyramid. |
| **Smoke** | Navier–Stokes | Stable Fluids: semi-Lagrangian advection, vorticity confinement, buoyancy, and a Jacobi pressure projection that makes the field divergence-free. |

Every rig exposes its parameters live, plus debug views of the underlying fields
— velocity, pressure, divergence, height, shell height, strand direction.

## Running it

```sh
python3 -m http.server 8000    # or: npx http-server
```

Then open <http://localhost:8000>. Opening `index.html` straight off the
filesystem also works — the scripts are plain `<script>` tags rather than ES
modules specifically so that `file://` stays viable.

## Requirements

WebGL 2 plus `EXT_color_buffer_float`, since every solver keeps its state in
floating-point render targets. That is standard on desktop browsers and on iOS
15+. Where full-float rendering is unavailable, the particle rigs fall back to
half-float positions automatically.

## Layout

```
index.html          bench shell
css/style.css       instrument chrome, light + dark
js/core.js          WebGL2 plumbing: programs, render targets, ping-pong, orbit, pointer
js/glsl.js          shared GLSL: hashing, gradient noise, curl noise, tonemap, colormaps
js/rig-*.js         one file per simulation, each self-registering
js/main.js          rig switching, control panel, telemetry, frame loop
```

A rig registers itself with `Bench.registerRig({...})`, declares its controls as
data, and returns `{ frame, resize, stats, action, dispose }` from
`create(gl, ctx)`. `main.js` builds the parameter panel from the control list, so
adding a slider is one line in the rig that uses it.

## Notes on the implementations

- **Fullscreen passes use no vertex buffers.** WebGL 2 can synthesise a covering
  triangle from `gl_VertexID` alone, so every solver pass is a bare `drawArrays`.
- **The fluid solver stores velocity in grid cells per second.** The grid is
  allocated proportional to the viewport aspect, so cells stay square in screen
  space and the divergence and pressure stencils stay isotropic.
- **The wave integrator runs on a fixed timestep** behind an accumulator. An
  explicit scheme is only conditionally stable, so the step size must not follow
  the frame rate.
- **Curl noise drives the particle flow** because the curl of a vector field is
  divergence-free — the flow swirls without ever collapsing into sinks.
- **Fur draws in two passes.** Only the skin writes depth; the shells above it
  are ordered by draw order alone. Wind displaces shells tangentially, so an
  outer shell can land behind an inner one and depth-reject it.
- **Physics deltas are clamped to 1/30 s** so a backgrounded tab does not return
  a one-second delta and detonate the integrators. Telemetry deliberately uses
  the unclamped delta, so the frame-rate readout stays honest on slow hardware.

## Controls

Space pauses. Keys 1–5 switch rigs. Dragging on the canvas does whatever the
current rig responds to — pushing the fluid, disturbing the water, orbiting the
camera. Render scale drops the framebuffer resolution for slower hardware.
