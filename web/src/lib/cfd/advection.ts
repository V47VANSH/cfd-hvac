/**
 * Semi-Lagrangian advection (Stam 1999, "Stable Fluids") on the MAC grid.
 *
 * For each face / cell, trace its position back along the velocity field
 * by `-dt`, sample the field at that back-traced point via trilinear
 * interpolation, and copy the sampled value forward. Unconditionally
 * stable for any Δt — we only need to respect CFL for *accuracy*, not
 * stability.
 *
 * Velocity advection is done component-wise on the staggered faces.
 * Scalars (T, RH, CO₂) are advected on the cell-centred grid.
 */

import {
  NX, NY, NZ, CK,
  sampleVelocity, sampleScalar,
  type MACFields, type RoomDims, cellSize,
} from "./mac-grid";

/**
 * Advect each velocity component along the velocity field. Uses
 * out-of-place writes — caller supplies pre-allocated scratch buffers
 * `uOut`, `vOut`, `wOut` (same sizes as `f.u`, `f.v`, `f.w`).
 */
export function advectVelocity(
  f: MACFields, room: RoomDims, dt: number,
  uOut: Float32Array, vOut: Float32Array, wOut: Float32Array,
): void {
  const { L, W, H } = room;
  const { dx, dy, dz } = cellSize(room);

  // u-faces: position (ix·dx, (iy+0.5)·dy, (iz+0.5)·dz)
  for (let iz = 0; iz < NZ; iz++)
    for (let iy = 0; iy < NY; iy++)
      for (let ix = 0; ix <= NX; ix++) {
        const ku = ix + (NX + 1) * iy + (NX + 1) * NY * iz;
        if (f.uwall[ku]) { uOut[ku] = 0; continue; }
        const x = ix * dx;
        const y = (iy + 0.5) * dy;
        const z = (iz + 0.5) * dz;
        const v = sampleVelocity(f, room, x, y, z);
        const xb = clamp(x - dt * v.vx, 0, L);
        const yb = clamp(y - dt * v.vy, 0, H);
        const zb = clamp(z - dt * v.vz, 0, W);
        uOut[ku] = sampleVelocity(f, room, xb, yb, zb).vx;
      }

  // v-faces: position ((ix+0.5)·dx, iy·dy, (iz+0.5)·dz)
  for (let iz = 0; iz < NZ; iz++)
    for (let iy = 0; iy <= NY; iy++)
      for (let ix = 0; ix < NX; ix++) {
        const kv = ix + NX * iy + NX * (NY + 1) * iz;
        if (f.vwall[kv]) { vOut[kv] = 0; continue; }
        const x = (ix + 0.5) * dx;
        const y = iy * dy;
        const z = (iz + 0.5) * dz;
        const v = sampleVelocity(f, room, x, y, z);
        const xb = clamp(x - dt * v.vx, 0, L);
        const yb = clamp(y - dt * v.vy, 0, H);
        const zb = clamp(z - dt * v.vz, 0, W);
        vOut[kv] = sampleVelocity(f, room, xb, yb, zb).vy;
      }

  // w-faces: position ((ix+0.5)·dx, (iy+0.5)·dy, iz·dz)
  for (let iz = 0; iz <= NZ; iz++)
    for (let iy = 0; iy < NY; iy++)
      for (let ix = 0; ix < NX; ix++) {
        const kw = ix + NX * iy + NX * NY * iz;
        if (f.wwall[kw]) { wOut[kw] = 0; continue; }
        const x = (ix + 0.5) * dx;
        const y = (iy + 0.5) * dy;
        const z = iz * dz;
        const v = sampleVelocity(f, room, x, y, z);
        const xb = clamp(x - dt * v.vx, 0, L);
        const yb = clamp(y - dt * v.vy, 0, H);
        const zb = clamp(z - dt * v.vz, 0, W);
        wOut[kw] = sampleVelocity(f, room, xb, yb, zb).vz;
      }
}

/**
 * Advect a cell-centred scalar (T, RH, CO₂) along the velocity field.
 * `clipMin` / `clipMax` enforce monotonicity-ish bounds (e.g. T must stay
 * physically reasonable).
 */
export function advectScalar(
  f: MACFields, room: RoomDims, dt: number,
  s: Float32Array, sOut: Float32Array,
  clipMin: number, clipMax: number,
): void {
  const { L, W, H } = room;
  const { dx, dy, dz } = cellSize(room);
  for (let iz = 0; iz < NZ; iz++)
    for (let iy = 0; iy < NY; iy++)
      for (let ix = 0; ix < NX; ix++) {
        const k = CK(ix, iy, iz);
        if (f.wall[k]) { sOut[k] = s[k]; continue; }
        const x = (ix + 0.5) * dx;
        const y = (iy + 0.5) * dy;
        const z = (iz + 0.5) * dz;
        const v = sampleVelocity(f, room, x, y, z);
        const xb = clamp(x - dt * v.vx, 0, L);
        const yb = clamp(y - dt * v.vy, 0, H);
        const zb = clamp(z - dt * v.vz, 0, W);
        const sb = sampleScalar(s, room, xb, yb, zb);
        sOut[k] = clamp(sb, clipMin, clipMax);
      }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
