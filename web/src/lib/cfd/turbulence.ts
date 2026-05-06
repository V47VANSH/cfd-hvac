/**
 * Smagorinsky LES eddy viscosity (Smagorinsky 1963).
 *
 *   ν_t = (Cs · Δ)² · |S|
 *
 * where |S| = √(2 S_ij S_ij) is the strain-rate magnitude and
 * Δ = (dx · dy · dz)^(1/3) is the local filter width.
 *
 * Computed per cell from the MAC velocity field (we average face values
 * to cell centres for the strain rate, since the Smagorinsky term is a
 * cell-centred scalar). Returned as a per-cell array that the diffusion
 * step then adds to the molecular viscosity.
 */

import { NX, NY, NZ, CK, type MACFields, type RoomDims, cellSize } from "./mac-grid";

export const DEFAULT_CS = 0.17;     // Lilly's value; calibration may override

/**
 * Adaptive cap on the eddy viscosity, m²/s.
 *
 * Forward-Euler explicit diffusion stability requires
 *   D · dt · (1/dx² + 1/dy² + 1/dz²) ≤ 0.5
 *
 * That bound depends on dt and grid spacing, so we compute the cap from
 * the actual numbers each call. Capped at 0.40 of the stability bound to
 * leave headroom for thermal diffusivity to be added on top, and clamped
 * to a hard ceiling so high-strain jet zones can mix realistically
 * without the diffusion step exploding even on small grids.
 *
 * Symptom of the cap firing: "smeared turbulence" near the jet — never
 * a NaN cascade.
 */
const NUT_HARD_CEILING = 0.10;   // 0.10 m²/s — physical for high-Re indoor jets

/**
 * Compute the per-cell eddy viscosity ν_t into the supplied output array
 * (length = NCELLS). Caller chooses Cs (calibration.json may set it).
 *
 * `dt` is required so the stability cap follows the active timestep —
 * larger dt → smaller ν_t cap to keep explicit diffusion stable.
 */
export function smagorinskyViscosity(
  f: MACFields, room: RoomDims, cs: number, dt: number, out: Float32Array,
): void {
  const { dx, dy, dz } = cellSize(room);
  const delta = Math.cbrt(dx * dy * dz);
  const csDel2 = (cs * delta) * (cs * delta);
  // Stability-derived cap, then min'd with the physical hard ceiling.
  const stabilityCap = 0.40 / Math.max(1e-6, dt * (1 / (dx * dx) + 1 / (dy * dy) + 1 / (dz * dz)));
  const NUT_MAX = Math.min(NUT_HARD_CEILING, stabilityCap);
  for (let iz = 1; iz < NZ - 1; iz++)
    for (let iy = 1; iy < NY - 1; iy++)
      for (let ix = 1; ix < NX - 1; ix++) {
        const k = CK(ix, iy, iz);
        if (f.wall[k]) { out[k] = 0; continue; }
        // Strain rate from face velocities. Centred differences using
        // face values directly avoids the staggered-to-collocated detour.
        const u_xp = f.u[(ix + 1) + (NX + 1) * iy + (NX + 1) * NY * iz];
        const u_xm = f.u[(ix    ) + (NX + 1) * iy + (NX + 1) * NY * iz];
        const v_yp = f.v[ix + NX * (iy + 1) + NX * (NY + 1) * iz];
        const v_ym = f.v[ix + NX * (iy    ) + NX * (NY + 1) * iz];
        const w_zp = f.w[ix + NX * iy + NX * NY * (iz + 1)];
        const w_zm = f.w[ix + NX * iy + NX * NY * (iz    )];
        const dudx = (u_xp - u_xm) / dx;
        const dvdy = (v_yp - v_ym) / dy;
        const dwdz = (w_zp - w_zm) / dz;

        // Cross derivatives via averaging face neighbours
        const u_yp = avg4u(f.u, ix, iy + 1, iz);
        const u_ym = avg4u(f.u, ix, iy - 1, iz);
        const u_zp = avg4u(f.u, ix, iy, iz + 1);
        const u_zm = avg4u(f.u, ix, iy, iz - 1);
        const v_xp = avg4v(f.v, ix + 1, iy, iz);
        const v_xm = avg4v(f.v, ix - 1, iy, iz);
        const v_zp = avg4v(f.v, ix, iy, iz + 1);
        const v_zm = avg4v(f.v, ix, iy, iz - 1);
        const w_xp = avg4w(f.w, ix + 1, iy, iz);
        const w_xm = avg4w(f.w, ix - 1, iy, iz);
        const w_yp = avg4w(f.w, ix, iy + 1, iz);
        const w_ym = avg4w(f.w, ix, iy - 1, iz);

        const dudy = (u_yp - u_ym) / (2 * dy);
        const dudz = (u_zp - u_zm) / (2 * dz);
        const dvdx = (v_xp - v_xm) / (2 * dx);
        const dvdz = (v_zp - v_zm) / (2 * dz);
        const dwdx = (w_xp - w_xm) / (2 * dx);
        const dwdy = (w_yp - w_ym) / (2 * dy);

        const Sxx = dudx;
        const Syy = dvdy;
        const Szz = dwdz;
        const Sxy = 0.5 * (dudy + dvdx);
        const Sxz = 0.5 * (dudz + dwdx);
        const Syz = 0.5 * (dvdz + dwdy);
        const SmagSq =
          2 * (Sxx * Sxx + Syy * Syy + Szz * Szz) +
          4 * (Sxy * Sxy + Sxz * Sxz + Syz * Syz);
        const nu = csDel2 * Math.sqrt(SmagSq);
        out[k] = nu > NUT_MAX ? NUT_MAX : nu;
      }
}

// Average a u-face value at cell-centre level (4-neighbour mean of the
// surrounding u-faces). Used to estimate u at non-native positions for
// the cross-derivative terms above.
function avg4u(u: Float32Array, ix: number, iy: number, iz: number): number {
  const ixc = Math.max(0, Math.min(NX, ix));
  const iyc = Math.max(0, Math.min(NY - 1, iy));
  const izc = Math.max(0, Math.min(NZ - 1, iz));
  return 0.5 * (
    u[ixc     + (NX + 1) * iyc + (NX + 1) * NY * izc] +
    u[ixc + 1 + (NX + 1) * iyc + (NX + 1) * NY * izc]
  );
}
function avg4v(v: Float32Array, ix: number, iy: number, iz: number): number {
  const ixc = Math.max(0, Math.min(NX - 1, ix));
  const iyc = Math.max(0, Math.min(NY, iy));
  const izc = Math.max(0, Math.min(NZ - 1, iz));
  return 0.5 * (
    v[ixc + NX *  iyc      + NX * (NY + 1) * izc] +
    v[ixc + NX * (iyc + 1) + NX * (NY + 1) * izc]
  );
}
function avg4w(w: Float32Array, ix: number, iy: number, iz: number): number {
  const ixc = Math.max(0, Math.min(NX - 1, ix));
  const iyc = Math.max(0, Math.min(NY - 1, iy));
  const izc = Math.max(0, Math.min(NZ, iz));
  return 0.5 * (
    w[ixc + NX * iyc + NX * NY *  izc     ] +
    w[ixc + NX * iyc + NX * NY * (izc + 1)]
  );
}
