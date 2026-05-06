# WebGL2 Compute Backend — Scaffold

This directory holds the Phase-2b WebGL2 compute backend for the MAC
solver. **Phase-2b is not yet complete** — the scaffolding here is in
place, the capability detector works, and the runtime selector (in
`workerClient.ts`) knows about WebGL2 — but no GLSL kernels have been
written yet. The full backend is the next dedicated session of work.

## What's in place (Phase 2b stage 1)

- `capability.ts` — feature detection (WebGL2, float-render, float-linear)
- This README documenting the architecture so the next session can
  pick up cleanly

## What's planned (Phase 2b stage 2 — next session)

The MAC solver has six computational kernels, all of which need GLSL
ports:

| Kernel | JS file | Output texture(s) |
|---|---|---|
| Semi-Lagrangian advection (u, v, w) | `advection.ts` | velocity (3) |
| Semi-Lagrangian advection (T, RH, CO₂) | `advection.ts` | scalar (3) |
| Smagorinsky LES eddy viscosity | `turbulence.ts` | ν_t (1) |
| Forward-Euler diffusion | `solver-mac.ts` (`diffuseScalar`) | scalar (3) |
| Boussinesq buoyancy | `solver-mac.ts` (inline) | v-velocity (1) |
| Multigrid Poisson V-cycle | `multigrid.ts` | pressure (1) |

### Texture layout

Each MAC field becomes a 2D texture atlas where each "z-slab" sits
horizontally. For the default 36 × 14 × 28 grid:

```
  ┌─────────┬─────────┬─────┬─────────┐
  │  z=0    │  z=1    │ ... │  z=27   │   ← 28 slabs
  │ 36×14   │ 36×14   │     │ 36×14   │
  └─────────┴─────────┴─────┴─────────┘
   atlas:  1008 × 14 = 14112 texels
```

For the high-accuracy grid (96 × 36 × 72), the atlas is 6912 × 36 — well
within `MAX_TEXTURE_SIZE` on every modern GPU.

### Multigrid hierarchy

The 3-level multigrid hierarchy (36/14/28 → 18/7/14 → 9/4/7) gets one
atlas per level. Restriction and prolongation kernels read from level
`l` and write to level `l+1` or `l-1`.

### Sample shader signature

```glsl
#version 300 es
precision highp float;
uniform sampler2D u_field;          // input scalar atlas
uniform sampler2D u_velX, u_velY, u_velZ;   // MAC velocities
uniform vec3      u_dxdydz;
uniform vec3      u_NxNyNz;
uniform float     u_dt;
out vec4 outColor;

vec3 atlasToCell(vec2 uv);    // texel → cell (ix, iy, iz)
vec3 cellToAtlas(vec3 cell);  // cell → atlas uv

void main() {
    vec3 cell = atlasToCell(gl_FragCoord.xy);
    vec3 pos  = cell + 0.5;          // cell-centre in cell coordinates
    vec3 V    = sampleVelocity(pos);
    vec3 back = pos - u_dt * V * u_dxdydz_inv;
    outColor.r = trilinearScalar(u_field, back);
}
```

### Runtime selection

The worker accepts a `backend` field in the init message:

- `"mac"` — JS Worker, current Phase-2 path (default)
- `"mac-webgl2"` — Phase-2b WebGL2 path (fills in from this scaffold)
- `"legacy"` — v6 collocated baseline (regression reference)

`detectWebGL2()` is consulted before switching to `"mac-webgl2"`. If
unavailable, fall through to `"mac"`.

### Estimated effort

- Set up framebuffer manager + atlas bookkeeping: 2 days
- Port advection kernels (velocity + scalar): 2 days
- Port Smagorinsky + diffusion: 1 day
- Port buoyancy + boundary BC: 1 day
- Port multigrid (restriction + prolongation + GS): 4 days
- Verify against JS reference within tolerance: 1–2 days
- **Total: ~10–12 working days**

This is why it's not in this session — properly porting six kernels
without breaking the JS reference path is a focused effort that needs
its own time.

## Why scaffold instead of full impl?

- Capability detection lets the UI display a "GPU acceleration
  available" indicator now
- The `workerClient.ts` backend enum is forward-compatible with `mac-webgl2`
- Other Phase-3 work (multi-AC optimizer, energy module) doesn't have
  to wait for Phase 2b
- The next session doesn't have to refactor anything to start the
  kernel work — just fill in this directory
