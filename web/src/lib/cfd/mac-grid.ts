/**
 * MAC (Marker-and-Cell) staggered grid — Harlow & Welch 1965.
 *
 * Pressure, temperature, RH, CO₂, Tmrt, and the heat-source field live at
 * cell centres. Velocity components live on the **faces between** those
 * cells — `u` on x-faces, `v` on y-faces, `w` on z-faces. This eliminates
 * the checkerboard pressure mode that bites a collocated grid under
 * semi-Lagrangian advection.
 *
 * Sizing.
 *   NX × NY × NZ  =  36 × 14 × 28  cells   ≈ 14 k  (matches legacy backend
 *     so the existing visualization code can render either solver's output
 *     interchangeably; the WebGL2 / high-accuracy 96×36×72 path in Phase 2b
 *     will lift this).
 *   u-faces       = (NX+1) × NY × NZ
 *   v-faces       =  NX × (NY+1) × NZ
 *   w-faces       =  NX × NY × (NZ+1)
 *
 * Cell (ix,iy,iz) occupies the box  [ix·dx, (ix+1)·dx] × …
 * Cell centre is at  ((ix+0.5)·dx, (iy+0.5)·dy, (iz+0.5)·dz).
 *
 * u(ix,iy,iz) sits on the x-face between cells (ix-1,iy,iz) and (ix,iy,iz).
 * Its physical position is  (ix·dx, (iy+0.5)·dy, (iz+0.5)·dz).
 *
 * Similarly:
 *   v(ix,iy,iz) is at  ((ix+0.5)·dx,  iy·dy,        (iz+0.5)·dz)
 *   w(ix,iy,iz) is at  ((ix+0.5)·dx, (iy+0.5)·dy,    iz·dz)
 *
 * Boundary faces (ix=0, ix=NX for u, etc.) are no-penetration walls.
 */

export const NX = 36;
export const NY = 14;
export const NZ = 28;

export const NCELLS = NX * NY * NZ;
export const NU = (NX + 1) * NY * NZ;
export const NV = NX * (NY + 1) * NZ;
export const NW = NX * NY * (NZ + 1);

// Cell-centred index. (NX, NY, NZ).
export function CK(ix: number, iy: number, iz: number): number {
  return ix + NX * iy + NX * NY * iz;
}

// u-face index. (NX+1, NY, NZ).
export function UK(ix: number, iy: number, iz: number): number {
  return ix + (NX + 1) * iy + (NX + 1) * NY * iz;
}

// v-face index. (NX, NY+1, NZ).
export function VK(ix: number, iy: number, iz: number): number {
  return ix + NX * iy + NX * (NY + 1) * iz;
}

// w-face index. (NX, NY, NZ+1).
export function WK(ix: number, iy: number, iz: number): number {
  return ix + NX * iy + NX * NY * iz;
}

export interface MACFields {
  // Cell-centred scalars
  T:    Float32Array;   // temperature, °C
  p:    Float32Array;   // pressure (scaled), Pa
  RH:   Float32Array;   // relative humidity, fraction 0..1
  CO2:  Float32Array;   // CO₂ concentration, ppm
  Qs:   Float32Array;   // sensible heat source, °C/s
  Qrh:  Float32Array;   // moisture source, kg-water/(m³·s)
  Qco2: Float32Array;   // CO₂ source, ppm/s
  Tmrt: Float32Array;   // mean radiant T, °C (computed, not advected)
  wall: Uint8Array;     // 1 = solid cell, 0 = fluid

  // Face-centred velocity components (MAC layout)
  u:    Float32Array;   // (NX+1) × NY × NZ
  v:    Float32Array;   // NX × (NY+1) × NZ
  w:    Float32Array;   // NX × NY × (NZ+1)

  // Persistent forcing (AC jets) on the same MAC layout
  fu:   Float32Array;
  fv:   Float32Array;
  fw:   Float32Array;

  // Face-blocked masks (1 = closed face, e.g. inside a solid).
  // Used by advection (skip), pressure projection (Neumann), and viz.
  uwall: Uint8Array;
  vwall: Uint8Array;
  wwall: Uint8Array;
}

export function makeMACFields(): MACFields {
  return {
    T:    new Float32Array(NCELLS).fill(28),
    p:    new Float32Array(NCELLS),
    RH:   new Float32Array(NCELLS).fill(0.5),
    CO2:  new Float32Array(NCELLS).fill(420),
    Qs:   new Float32Array(NCELLS),
    Qrh:  new Float32Array(NCELLS),
    Qco2: new Float32Array(NCELLS),
    Tmrt: new Float32Array(NCELLS).fill(28),
    wall: new Uint8Array(NCELLS),

    u:  new Float32Array(NU),
    v:  new Float32Array(NV),
    w:  new Float32Array(NW),

    fu: new Float32Array(NU),
    fv: new Float32Array(NV),
    fw: new Float32Array(NW),

    uwall: new Uint8Array(NU),
    vwall: new Uint8Array(NV),
    wwall: new Uint8Array(NW),
  };
}

export interface RoomDims {
  L: number;  // x extent (length), m
  W: number;  // z extent (width),  m
  H: number;  // y extent (height), m
}

export function cellSize(room: RoomDims): { dx: number; dy: number; dz: number } {
  return { dx: room.L / NX, dy: room.H / NY, dz: room.W / NZ };
}

// ── Cell-centred velocity (for visualization / particle tracing) ─────────

/**
 * Average the four neighbouring face velocities to produce a cell-centred
 * velocity. Used only for output / visualization — the solver itself works
 * on the MAC layout throughout.
 */
export function cellCentredVelocity(
  f: MACFields, ix: number, iy: number, iz: number,
): { vx: number; vy: number; vz: number } {
  const u0 = f.u[UK(ix,     iy, iz)];
  const u1 = f.u[UK(ix + 1, iy, iz)];
  const v0 = f.v[VK(ix, iy,     iz)];
  const v1 = f.v[VK(ix, iy + 1, iz)];
  const w0 = f.w[WK(ix, iy, iz    )];
  const w1 = f.w[WK(ix, iy, iz + 1)];
  return { vx: 0.5 * (u0 + u1), vy: 0.5 * (v0 + v1), vz: 0.5 * (w0 + w1) };
}

/**
 * Sample the MAC velocity field at an arbitrary world-space position
 * `(x, y, z)` — used by the semi-Lagrangian advection back-trace and by the
 * particle tracer. Trilinear interpolation in the appropriate face layout
 * for each component.
 *
 * Coordinates are local to the room: `x ∈ [0, L]`, `y ∈ [0, H]`, `z ∈ [0, W]`.
 * Caller is responsible for mapping world → room coordinates.
 */
export function sampleVelocity(
  f: MACFields, room: RoomDims,
  x: number, y: number, z: number,
): { vx: number; vy: number; vz: number } {
  const { dx, dy, dz } = cellSize(room);
  return {
    vx: triU(f.u, x, y, z, dx, dy, dz),
    vy: triV(f.v, x, y, z, dx, dy, dz),
    vz: triW(f.w, x, y, z, dx, dy, dz),
  };
}

// Trilinear interpolation of u at world position. u(ix,iy,iz) is at
// physical position (ix·dx, (iy+0.5)·dy, (iz+0.5)·dz).
function triU(u: Float32Array, x: number, y: number, z: number, dx: number, dy: number, dz: number): number {
  const fx = x / dx;
  const fy = y / dy - 0.5;
  const fz = z / dz - 0.5;
  const ix = Math.max(0, Math.min(NX,     Math.floor(fx)));
  const iy = Math.max(0, Math.min(NY - 2, Math.floor(fy)));
  const iz = Math.max(0, Math.min(NZ - 2, Math.floor(fz)));
  const tx = clamp01(fx - ix);
  const ty = clamp01(fy - iy);
  const tz = clamp01(fz - iz);
  const c000 = u[UK(ix,     iy,     iz    )];
  const c100 = u[UK(ix + 1, iy,     iz    )];
  const c010 = u[UK(ix,     iy + 1, iz    )];
  const c110 = u[UK(ix + 1, iy + 1, iz    )];
  const c001 = u[UK(ix,     iy,     iz + 1)];
  const c101 = u[UK(ix + 1, iy,     iz + 1)];
  const c011 = u[UK(ix,     iy + 1, iz + 1)];
  const c111 = u[UK(ix + 1, iy + 1, iz + 1)];
  return tri(c000, c100, c010, c110, c001, c101, c011, c111, tx, ty, tz);
}

function triV(v: Float32Array, x: number, y: number, z: number, dx: number, dy: number, dz: number): number {
  const fx = x / dx - 0.5;
  const fy = y / dy;
  const fz = z / dz - 0.5;
  const ix = Math.max(0, Math.min(NX - 2, Math.floor(fx)));
  const iy = Math.max(0, Math.min(NY,     Math.floor(fy)));
  const iz = Math.max(0, Math.min(NZ - 2, Math.floor(fz)));
  const tx = clamp01(fx - ix);
  const ty = clamp01(fy - iy);
  const tz = clamp01(fz - iz);
  const c000 = v[VK(ix,     iy,     iz    )];
  const c100 = v[VK(ix + 1, iy,     iz    )];
  const c010 = v[VK(ix,     iy + 1, iz    )];
  const c110 = v[VK(ix + 1, iy + 1, iz    )];
  const c001 = v[VK(ix,     iy,     iz + 1)];
  const c101 = v[VK(ix + 1, iy,     iz + 1)];
  const c011 = v[VK(ix,     iy + 1, iz + 1)];
  const c111 = v[VK(ix + 1, iy + 1, iz + 1)];
  return tri(c000, c100, c010, c110, c001, c101, c011, c111, tx, ty, tz);
}

function triW(w: Float32Array, x: number, y: number, z: number, dx: number, dy: number, dz: number): number {
  const fx = x / dx - 0.5;
  const fy = y / dy - 0.5;
  const fz = z / dz;
  const ix = Math.max(0, Math.min(NX - 2, Math.floor(fx)));
  const iy = Math.max(0, Math.min(NY - 2, Math.floor(fy)));
  const iz = Math.max(0, Math.min(NZ,     Math.floor(fz)));
  const tx = clamp01(fx - ix);
  const ty = clamp01(fy - iy);
  const tz = clamp01(fz - iz);
  const c000 = w[WK(ix,     iy,     iz    )];
  const c100 = w[WK(ix + 1, iy,     iz    )];
  const c010 = w[WK(ix,     iy + 1, iz    )];
  const c110 = w[WK(ix + 1, iy + 1, iz    )];
  const c001 = w[WK(ix,     iy,     iz + 1)];
  const c101 = w[WK(ix + 1, iy,     iz + 1)];
  const c011 = w[WK(ix,     iy + 1, iz + 1)];
  const c111 = w[WK(ix + 1, iy + 1, iz + 1)];
  return tri(c000, c100, c010, c110, c001, c101, c011, c111, tx, ty, tz);
}

/**
 * Sample any cell-centred scalar (T, RH, CO₂, …) at world position via
 * trilinear interpolation. Cell centre is at ((ix+0.5)·dx, …).
 */
export function sampleScalar(
  s: Float32Array, room: RoomDims,
  x: number, y: number, z: number,
): number {
  const { dx, dy, dz } = cellSize(room);
  const fx = x / dx - 0.5;
  const fy = y / dy - 0.5;
  const fz = z / dz - 0.5;
  const ix = Math.max(0, Math.min(NX - 2, Math.floor(fx)));
  const iy = Math.max(0, Math.min(NY - 2, Math.floor(fy)));
  const iz = Math.max(0, Math.min(NZ - 2, Math.floor(fz)));
  const tx = clamp01(fx - ix);
  const ty = clamp01(fy - iy);
  const tz = clamp01(fz - iz);
  const c000 = s[CK(ix,     iy,     iz    )];
  const c100 = s[CK(ix + 1, iy,     iz    )];
  const c010 = s[CK(ix,     iy + 1, iz    )];
  const c110 = s[CK(ix + 1, iy + 1, iz    )];
  const c001 = s[CK(ix,     iy,     iz + 1)];
  const c101 = s[CK(ix + 1, iy,     iz + 1)];
  const c011 = s[CK(ix,     iy + 1, iz + 1)];
  const c111 = s[CK(ix + 1, iy + 1, iz + 1)];
  return tri(c000, c100, c010, c110, c001, c101, c011, c111, tx, ty, tz);
}

function tri(
  c000: number, c100: number, c010: number, c110: number,
  c001: number, c101: number, c011: number, c111: number,
  tx: number, ty: number, tz: number,
): number {
  const c00 = c000 * (1 - tx) + c100 * tx;
  const c10 = c010 * (1 - tx) + c110 * tx;
  const c01 = c001 * (1 - tx) + c101 * tx;
  const c11 = c011 * (1 - tx) + c111 * tx;
  const c0 = c00 * (1 - ty) + c10 * ty;
  const c1 = c01 * (1 - ty) + c11 * ty;
  return c0 * (1 - tz) + c1 * tz;
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
