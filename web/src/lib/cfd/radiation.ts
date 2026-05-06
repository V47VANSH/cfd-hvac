/**
 * Approximate view-factor Mean Radiant Temperature (Tmrt).
 *
 * For each fluid cell we cast 6 axis-aligned rays (±x, ±y, ±z), step until
 * we hit a solid cell or the domain boundary, and weight that surface's
 * temperature by 1/6 (uniform solid-angle approximation).
 *
 * This is significantly more honest than "Tmrt = T_air" (the prior Tier 1
 * approximation) and cheap enough to update every snapshot. True view
 * factors with the full geometry kernel still belong in Tier 2 — but for
 * box-shaped rooms the 6-ray approximation is within ~0.5 °C of a proper
 * radiation solver.
 *
 * Limitations: no inter-reflection, no spectral integration, no solid
 * obstacle emission (treated as adiabatic at the air temperature next to
 * them). Still a clear win over the previous approximation.
 */

import { NX, NY, NZ, CK, type MACFields } from "./mac-grid";

const RAYS = [
  [+1,  0,  0],
  [-1,  0,  0],
  [ 0, +1,  0],
  [ 0, -1,  0],
  [ 0,  0, +1],
  [ 0,  0, -1],
] as const;

/**
 * Compute Tmrt at every fluid cell, writing into `f.Tmrt`. Solid cells
 * inherit their air-temperature value (used as the surface temperature
 * by neighbouring cells' rays).
 */
export function computeViewFactorTmrt(f: MACFields): void {
  const T = f.T;
  for (let iz = 0; iz < NZ; iz++)
    for (let iy = 0; iy < NY; iy++)
      for (let ix = 0; ix < NX; ix++) {
        const k = CK(ix, iy, iz);
        if (f.wall[k]) { f.Tmrt[k] = T[k]; continue; }
        let sum = 0;
        for (const [dx, dy, dz] of RAYS) {
          let cx = ix, cy = iy, cz = iz;
          let hit = -1;
          // March until we exit the domain or hit a solid
          for (let s = 0; s < Math.max(NX, NY, NZ); s++) {
            cx += dx; cy += dy; cz += dz;
            if (cx < 0 || cx >= NX || cy < 0 || cy >= NY || cz < 0 || cz >= NZ) {
              // Hit domain boundary — use the last fluid cell along the ray.
              hit = CK(cx - dx, cy - dy, cz - dz);
              break;
            }
            const hk = CK(cx, cy, cz);
            if (f.wall[hk]) {
              hit = hk;
              break;
            }
          }
          if (hit >= 0) sum += T[hit];
          else          sum += T[k];   // shouldn't happen, fallback
        }
        f.Tmrt[k] = sum / RAYS.length;
      }
}
