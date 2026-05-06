/**
 * WebGL2 fragment-shader kernels for the MAC solver.
 *
 * One kernel = one fragment program. Each runs the shared fullscreen
 * triangle and reads/writes Float32 R-channel atlas textures (see
 * fields.ts + atlas.ts).
 *
 * Coordinate convention: gl_FragCoord.xy is the centre of the output
 * texel (0.5, 0.5)+integer. We cast that back to logical (ix, iy, iz)
 * via atlasToCell() (helper in ATLAS_GLSL).
 *
 * Kernels in this file:
 *
 *   FILL                — initialise a texture to a constant value
 *   COPY                — straight texture copy (utility)
 *   APPLY_FORCING       — u += relax · (fu − u); same for v, w
 *   ADVECT_VEL          — semi-Lagrangian advection for u / v / w faces
 *   ADVECT_SCALAR       — semi-Lagrangian advection for cell-centred scalar
 *   BUOYANCY            — Boussinesq body force on v-faces
 *   DIVERGENCE          — ∇·u into cell-centred rhs
 *   PRESSURE_JACOBI     — one Jacobi iteration of ∇²p = rhs
 *   GRADIENT_U/V/W      — subtract dt·∇p from each velocity component
 *   BOUNDARY_T          — blend boundary T toward wall target
 *   CLAMP_SCALAR        — clamp scalar into [min, max] (safety net)
 *
 * Skipped vs JS MAC solver (parked for stage-2):
 *   - Smagorinsky LES (relies on multi-component derivatives that need
 *     extra texture reads — easy to add)
 *   - Multigrid pressure (uses plain Jacobi here; needs ~40 iterations
 *     to converge on the default grid)
 *   - RH / CO₂ scalars (kept on CPU for the v1; one extra ADVECT_SCALAR
 *     pass per scalar adds them when needed)
 *   - View-factor Tmrt (CPU compute from snapshot)
 *   - Per-occupant PMV (CPU from snapshot)
 *
 * Even with these omissions the v1 produces a properly divergence-free
 * velocity field with semi-Lagrangian advection + buoyancy + boundary
 * blending — qualitatively the same physics as the JS MAC path, just
 * with Jacobi pressure instead of multigrid.
 */

import { ATLAS_GLSL } from "./atlas";

const HEAD = (nx: number, ny: number, nz: number, atlasW: number, atlasH: number) => `
#define NX ${nx}
#define NY ${ny}
#define NZ ${nz}
#define ATLAS_W ${atlasW}.0
#define ATLAS_H ${atlasH}.0
const float NX_F = float(NX);
const float NY_F = float(NY);
const float NZ_F = float(NZ);
${ATLAS_GLSL}
out vec4 outColor;
`;

// ── Utility ─────────────────────────────────────────────────────────

export const FILL = (n: number, ny: number, nz: number, w: number, h: number) => `
${HEAD(n, ny, nz, w, h)}
uniform float u_value;
void main() { outColor = vec4(u_value); }
`;

export const COPY = (n: number, ny: number, nz: number, w: number, h: number) => `
${HEAD(n, ny, nz, w, h)}
uniform sampler2D u_src;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  outColor = texelFetch(u_src, px, 0);
}
`;

export const CLAMP_SCALAR = (n: number, ny: number, nz: number, w: number, h: number) => `
${HEAD(n, ny, nz, w, h)}
uniform sampler2D u_src;
uniform float u_min;
uniform float u_max;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  float v = texelFetch(u_src, px, 0).r;
  outColor = vec4(clamp(v, u_min, u_max));
}
`;

// ── Persistent forcing relaxation ──────────────────────────────────

export const APPLY_FORCING = (n: number, ny: number, nz: number, w: number, h: number) => `
${HEAD(n, ny, nz, w, h)}
uniform sampler2D u_vel;        // current velocity component (face)
uniform sampler2D u_force;      // persistent forcing for that component
uniform float u_relax;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  float v = texelFetch(u_vel, px, 0).r;
  float f = texelFetch(u_force, px, 0).r;
  outColor = vec4(v + (f - v) * u_relax);
}
`;

// ── Semi-Lagrangian advection ──────────────────────────────────────
//
// For a velocity component on face (ix, iy, iz):
//   1. world position of face centre: (px*dx, (py+0.5)*dy, (pz+0.5)*dz)
//      depending on which face kind
//   2. sample velocity vector at that position (trilinear in 3D)
//   3. trace backward dt seconds → world position 1
//   4. sample velocity component again at world position 1
//   5. that's the new value
//
// We pass dx, dy, dz, dt, plus all three velocity textures.

const SAMPLE_VELOCITY = `
vec3 sampleVelocity(vec3 cellCentre) {
  // cellCentre is in cell coordinates (i.e. (ix+0.5, iy+0.5, iz+0.5) for
  // a cell centre, but face positions are different — caller passes the
  // appropriate cell coordinates per kind).
  // u-face position is (ix, iy+0.5, iz+0.5), so cell.x for u-sample is just cellCentre.x
  // We sample u/v/w with their own samplers (which know their atlas geometry).
  float u = sampleU3D(u_uTex, cellCentre, NX_F, NY_F, NZ_F);
  float v = sampleV3D(u_vTex, cellCentre, NX_F, NY_F, NZ_F);
  float w = sampleW3D(u_wTex, cellCentre, NX_F, NY_F, NZ_F);
  return vec3(u, v, w);
}
`;

export const ADVECT_VEL = (
  n: number, ny: number, nz: number, atlasW: number, atlasH: number,
  faceKind: "u" | "v" | "w",
) => {
  // The atlas geometry differs per face — emit shader with atlas dims for
  // OUTPUT. The samplers for the input velocity textures use their own
  // atlas dims internally (sampleU3D/V3D/W3D).
  // Output of this kernel is the same face kind (we advect u → uOut, etc.).
  return `
${HEAD(n, ny, nz, atlasW, atlasH)}
uniform sampler2D u_uTex;
uniform sampler2D u_vTex;
uniform sampler2D u_wTex;
uniform float u_dt;
uniform float u_dx;
uniform float u_dy;
uniform float u_dz;
${SAMPLE_VELOCITY}

void main() {
  // Fragment coord → output face index
  ivec2 px = ivec2(gl_FragCoord.xy);
  // ATLAS_W / ATLAS_H here describe the OUTPUT atlas (this kind's atlas)
  // Decompose px → (ix, iy, iz). u: ix∈[0,NX], iy∈[0,NY-1], iz∈[0,NZ-1]
  // Reuse the standard atlasToCell which assumes scalar layout (NY rows
  // per slab); same trick works since we encode all three with NY rows.
  int ix = px.x;
  int iz = px.y / NY;
  int iy = px.y - iz * NY;

  // Position of THIS face in cell coordinates
  // u-face: (ix, iy+0.5, iz+0.5)
  // v-face: (ix+0.5, iy, iz+0.5)
  // w-face: (ix+0.5, iy+0.5, iz)
  ${faceKind === "u" ? "vec3 pos = vec3(float(ix),       float(iy)+0.5, float(iz)+0.5);" : ""}
  ${faceKind === "v" ? "vec3 pos = vec3(float(ix)+0.5, float(iy),       float(iz)+0.5);" : ""}
  ${faceKind === "w" ? "vec3 pos = vec3(float(ix)+0.5, float(iy)+0.5, float(iz)      );" : ""}

  vec3 V = sampleVelocity(pos);
  // Convert cell-velocity to cell-units / step
  vec3 step = vec3(V.x / u_dx, V.y / u_dy, V.z / u_dz);
  vec3 back = pos - u_dt * step;

  // Sample the right component at the back-traced position
  ${faceKind === "u" ? "outColor = vec4(sampleU3D(u_uTex, back, NX_F, NY_F, NZ_F));" : ""}
  ${faceKind === "v" ? "outColor = vec4(sampleV3D(u_vTex, back, NX_F, NY_F, NZ_F));" : ""}
  ${faceKind === "w" ? "outColor = vec4(sampleW3D(u_wTex, back, NX_F, NY_F, NZ_F));" : ""}
}
`;
};

export const ADVECT_SCALAR = (n: number, ny: number, nz: number, w: number, h: number) => `
${HEAD(n, ny, nz, w, h)}
uniform sampler2D u_uTex;
uniform sampler2D u_vTex;
uniform sampler2D u_wTex;
uniform sampler2D u_field;
uniform sampler2D u_wall;       // 1.0 = solid, 0.0 = fluid
uniform float u_dt;
uniform float u_dx;
uniform float u_dy;
uniform float u_dz;
uniform float u_clipMin;
uniform float u_clipMax;
${SAMPLE_VELOCITY}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec3 c  = atlasToCell(px);
  if (texelFetch(u_wall, px, 0).r > 0.5) {
    // Solid cell — keep its current value
    outColor = texelFetch(u_field, px, 0);
    return;
  }
  vec3 pos = vec3(float(c.x) + 0.5, float(c.y) + 0.5, float(c.z) + 0.5);
  vec3 V = sampleVelocity(pos);
  vec3 step = vec3(V.x / u_dx, V.y / u_dy, V.z / u_dz);
  vec3 back = pos - u_dt * step;
  float v = sampleScalar3D(u_field, back, NX_F, NY_F, NZ_F);
  outColor = vec4(clamp(v, u_clipMin, u_clipMax));
}
`;

// ── Boussinesq buoyancy on v-faces ─────────────────────────────────

export const BUOYANCY = (n: number, ny: number, nz: number, w: number, h: number) => `
${HEAD(n, ny, nz, w, h)}
uniform sampler2D u_v;
uniform sampler2D u_T;
uniform sampler2D u_vwall;
uniform float u_beta;
uniform float u_g;
uniform float u_dt;
uniform float u_Tamb;
uniform float u_damp;     // 0.985 typical
uniform float u_clamp;    // ±3.0 typical
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  // v-face index: ix∈[0,NX-1], iy∈[0,NY], iz∈[0,NZ-1]
  // Atlas has (NY+1) rows per slab → recompute decomposition manually.
  int ix = px.x;
  int iz = px.y / (NY + 1);
  int iy = px.y - iz * (NY + 1);

  if (texelFetch(u_vwall, px, 0).r > 0.5) { outColor = vec4(0.0); return; }
  if (iy == 0 || iy == NY) { outColor = vec4(0.0); return; }

  // Sample T from the two cells either side of this v-face
  // (cell (ix, iy-1, iz) and (ix, iy, iz))
  ivec2 pxA = cellToAtlas(ix, iy - 1, iz);
  ivec2 pxB = cellToAtlas(ix, iy,     iz);
  float TA = texelFetch(u_T, pxA, 0).r;
  float TB = texelFetch(u_T, pxB, 0).r;
  float Tavg = 0.5 * (TA + TB);
  float dT = Tavg - u_Tamb;
  float vOld = texelFetch(u_v, px, 0).r;
  float vNew = (vOld + u_beta * u_g * dT * u_dt) * u_damp;
  vNew = clamp(vNew, -u_clamp, u_clamp);
  outColor = vec4(vNew);
}
`;

// ── Divergence ─────────────────────────────────────────────────────

export const DIVERGENCE = (n: number, ny: number, nz: number, w: number, h: number) => `
${HEAD(n, ny, nz, w, h)}
uniform sampler2D u_uTex;
uniform sampler2D u_vTex;
uniform sampler2D u_wTex;
uniform sampler2D u_wall;
uniform float u_dx;
uniform float u_dy;
uniform float u_dz;
uniform float u_dt;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec3 c  = atlasToCell(px);
  if (texelFetch(u_wall, px, 0).r > 0.5) { outColor = vec4(0.0); return; }
  // u-faces (ix, iy, iz) and (ix+1, iy, iz)
  float u0 = texelFetch(u_uTex, ivec2(c.x,     c.z * NY + c.y), 0).r;
  float u1 = texelFetch(u_uTex, ivec2(c.x + 1, c.z * NY + c.y), 0).r;
  // v-faces (ix, iy, iz) and (ix, iy+1, iz)
  float v0 = texelFetch(u_vTex, ivec2(c.x, c.z * (NY + 1) + c.y    ), 0).r;
  float v1 = texelFetch(u_vTex, ivec2(c.x, c.z * (NY + 1) + c.y + 1), 0).r;
  // w-faces (ix, iy, iz) and (ix, iy, iz+1)
  float w0 = texelFetch(u_wTex, ivec2(c.x, c.z      * NY + c.y), 0).r;
  float w1 = texelFetch(u_wTex, ivec2(c.x, (c.z + 1) * NY + c.y), 0).r;
  float div = (u1 - u0) / u_dx + (v1 - v0) / u_dy + (w1 - w0) / u_dz;
  outColor = vec4(div / u_dt);
}
`;

// ── Pressure Jacobi relaxation ─────────────────────────────────────

export const PRESSURE_JACOBI = (n: number, ny: number, nz: number, w: number, h: number) => `
${HEAD(n, ny, nz, w, h)}
uniform sampler2D u_p;
uniform sampler2D u_rhs;
uniform sampler2D u_wall;
uniform float u_dx;
uniform float u_dy;
uniform float u_dz;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec3 c  = atlasToCell(px);
  if (texelFetch(u_wall, px, 0).r > 0.5) { outColor = vec4(0.0); return; }
  if (c.x == 0 || c.x == NX - 1 ||
      c.y == 0 || c.y == NY - 1 ||
      c.z == 0 || c.z == NZ - 1) { outColor = vec4(0.0); return; }

  float ax = 1.0 / (u_dx * u_dx);
  float ay = 1.0 / (u_dy * u_dy);
  float az = 1.0 / (u_dz * u_dz);
  float asum = 2.0 * (ax + ay + az);

  float sum = 0.0;
  float diag = asum;

  ivec2 nx_p = cellToAtlas(c.x + 1, c.y, c.z);
  ivec2 nx_m = cellToAtlas(c.x - 1, c.y, c.z);
  ivec2 ny_p = cellToAtlas(c.x, c.y + 1, c.z);
  ivec2 ny_m = cellToAtlas(c.x, c.y - 1, c.z);
  ivec2 nz_p = cellToAtlas(c.x, c.y, c.z + 1);
  ivec2 nz_m = cellToAtlas(c.x, c.y, c.z - 1);

  if (texelFetch(u_wall, nx_p, 0).r > 0.5) diag -= ax; else sum += ax * texelFetch(u_p, nx_p, 0).r;
  if (texelFetch(u_wall, nx_m, 0).r > 0.5) diag -= ax; else sum += ax * texelFetch(u_p, nx_m, 0).r;
  if (texelFetch(u_wall, ny_p, 0).r > 0.5) diag -= ay; else sum += ay * texelFetch(u_p, ny_p, 0).r;
  if (texelFetch(u_wall, ny_m, 0).r > 0.5) diag -= ay; else sum += ay * texelFetch(u_p, ny_m, 0).r;
  if (texelFetch(u_wall, nz_p, 0).r > 0.5) diag -= az; else sum += az * texelFetch(u_p, nz_p, 0).r;
  if (texelFetch(u_wall, nz_m, 0).r > 0.5) diag -= az; else sum += az * texelFetch(u_p, nz_m, 0).r;

  float rhs = texelFetch(u_rhs, px, 0).r;
  float p = (diag > 1e-9) ? ((sum - rhs) / diag) : 0.0;
  outColor = vec4(p);
}
`;

// ── Gradient subtraction (one program per face direction) ──────────
//
// u-faces: u_new = u_old − dt · (p[ix, iy, iz] − p[ix-1, iy, iz]) / dx
// v-faces:                         (p[ix, iy, iz] − p[ix, iy-1, iz]) / dy
// w-faces:                         (p[ix, iy, iz] − p[ix, iy, iz-1]) / dz

export const GRADIENT_U = (n: number, ny: number, nz: number, w: number, h: number) => `
${HEAD(n, ny, nz, w, h)}
uniform sampler2D u_u;
uniform sampler2D u_p;
uniform sampler2D u_uwall;
uniform float u_dx;
uniform float u_dt;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  // u-face decomposition
  int ix = px.x;
  int iz = px.y / NY;
  int iy = px.y - iz * NY;
  if (texelFetch(u_uwall, px, 0).r > 0.5) { outColor = vec4(0.0); return; }
  if (ix == 0 || ix == NX) { outColor = vec4(0.0); return; }
  ivec2 pA = cellToAtlas(ix - 1, iy, iz);
  ivec2 pB = cellToAtlas(ix,     iy, iz);
  float pa = texelFetch(u_p, pA, 0).r;
  float pb = texelFetch(u_p, pB, 0).r;
  float u0 = texelFetch(u_u, px, 0).r;
  outColor = vec4(u0 - u_dt * (pb - pa) / u_dx);
}
`;

export const GRADIENT_V = (n: number, ny: number, nz: number, w: number, h: number) => `
${HEAD(n, ny, nz, w, h)}
uniform sampler2D u_v;
uniform sampler2D u_p;
uniform sampler2D u_vwall;
uniform float u_dy;
uniform float u_dt;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int ix = px.x;
  int iz = px.y / (NY + 1);
  int iy = px.y - iz * (NY + 1);
  if (texelFetch(u_vwall, px, 0).r > 0.5) { outColor = vec4(0.0); return; }
  if (iy == 0 || iy == NY) { outColor = vec4(0.0); return; }
  ivec2 pA = cellToAtlas(ix, iy - 1, iz);
  ivec2 pB = cellToAtlas(ix, iy,     iz);
  float pa = texelFetch(u_p, pA, 0).r;
  float pb = texelFetch(u_p, pB, 0).r;
  float v0 = texelFetch(u_v, px, 0).r;
  outColor = vec4(v0 - u_dt * (pb - pa) / u_dy);
}
`;

export const GRADIENT_W = (n: number, ny: number, nz: number, w: number, h: number) => `
${HEAD(n, ny, nz, w, h)}
uniform sampler2D u_w;
uniform sampler2D u_p;
uniform sampler2D u_wwall;
uniform float u_dz;
uniform float u_dt;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int ix = px.x;
  int iz = px.y / NY;
  int iy = px.y - iz * NY;
  if (texelFetch(u_wwall, px, 0).r > 0.5) { outColor = vec4(0.0); return; }
  if (iz == 0 || iz == NZ) { outColor = vec4(0.0); return; }
  ivec2 pA = cellToAtlas(ix, iy, iz - 1);
  ivec2 pB = cellToAtlas(ix, iy, iz    );
  float pa = texelFetch(u_p, pA, 0).r;
  float pb = texelFetch(u_p, pB, 0).r;
  float w0 = texelFetch(u_w, px, 0).r;
  outColor = vec4(w0 - u_dt * (pb - pa) / u_dz);
}
`;

// ── Boundary T blend ───────────────────────────────────────────────
// Single kernel that blends boundary cells toward a per-face uniform
// target temperature. Kernel runs over the whole T atlas; only cells
// whose (ix, iy, iz) is on the domain boundary do anything.

export const BOUNDARY_T = (n: number, ny: number, nz: number, w: number, h: number) => `
${HEAD(n, ny, nz, w, h)}
uniform sampler2D u_T;
uniform float u_Tfloor;
uniform float u_Tceiling;
uniform float u_Twall;       // generic wall T (same target on S/N/E/W for v1)
uniform float u_kWall;       // per-step blend factor
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec3 c  = atlasToCell(px);
  float T = texelFetch(u_T, px, 0).r;
  bool boundary = false;
  float target = T;
  if (c.y == 0)        { boundary = true; target = u_Tfloor;  }
  if (c.y == NY - 1)   { boundary = true; target = u_Tceiling; }
  if (c.z == 0 || c.z == NZ - 1 ||
      c.x == 0 || c.x == NX - 1) { boundary = true; target = u_Twall; }
  if (boundary) {
    T = T * (1.0 - u_kWall) + target * u_kWall;
  }
  outColor = vec4(T);
}
`;
