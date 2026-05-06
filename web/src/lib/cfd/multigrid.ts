/**
 * Multigrid V-cycle Poisson solver for the pressure-projection step.
 *
 * Solves   ∇²p = ∇·u*    on the cell-centred grid, with Neumann BCs at
 * domain boundaries and inside solid cells (treated as Dirichlet p=0).
 *
 * Strategy.
 *   - Hierarchy of grids, each half the resolution of the previous.
 *   - At each level: red-black Gauss–Seidel smoothing pre and post.
 *   - Coarse-grid correction: restrict the residual, recurse, prolongate.
 *   - V-cycle from finest → coarsest → finest.
 *
 * For a 48×18×36 base grid we use 3 levels  (48→24→12,  18→9,  36→18→9).
 * Coarsest level is solved by extra GS iterations (cheap at that size).
 *
 * Reference: Brandt 1977. The implementation here is a classic Galerkin
 * multigrid with simple full-weighting restriction and trilinear
 * prolongation, no fancy adaptive cycles.
 */

import { NX, NY, NZ, CK, type MACFields, type RoomDims, cellSize } from "./mac-grid";

interface Level {
  nx: number; ny: number; nz: number;
  dx: number; dy: number; dz: number;
  p:    Float32Array;   // pressure
  rhs:  Float32Array;   // right-hand side ( = ∇·u* / dt at the finest level)
  res:  Float32Array;   // residual (rhs − Lp)
  wall: Uint8Array;     // 1 = solid (homogeneous Dirichlet)
}

function makeLevel(nx: number, ny: number, nz: number, dx: number, dy: number, dz: number): Level {
  const n = nx * ny * nz;
  return {
    nx, ny, nz, dx, dy, dz,
    p:    new Float32Array(n),
    rhs:  new Float32Array(n),
    res:  new Float32Array(n),
    wall: new Uint8Array(n),
  };
}

function idx(nx: number, ny: number, ix: number, iy: number, iz: number): number {
  return ix + nx * iy + nx * ny * iz;
}

/**
 * Reusable multigrid hierarchy. Construct once per session; the wall mask
 * is rebuilt each step from the live field.
 */
export class Multigrid {
  readonly levels: Level[];

  constructor(room: RoomDims, depth = 3) {
    const { dx, dy, dz } = cellSize(room);
    const lv: Level[] = [makeLevel(NX, NY, NZ, dx, dy, dz)];
    for (let l = 1; l < depth; l++) {
      const prev = lv[l - 1];
      // Coarsen by 2 in each dim, but never below 4 cells in any axis.
      const cx = Math.max(4, Math.floor(prev.nx / 2));
      const cy = Math.max(4, Math.floor(prev.ny / 2));
      const cz = Math.max(4, Math.floor(prev.nz / 2));
      lv.push(makeLevel(cx, cy, cz, prev.dx * 2, prev.dy * 2, prev.dz * 2));
    }
    this.levels = lv;
  }

  /**
   * Solve ∇²p = rhs at the finest level using a small number of V-cycles.
   * Writes the result into the supplied `pOut` array (length NCELLS).
   */
  solve(rhs: Float32Array, wall: Uint8Array, pOut: Float32Array, nCycles = 3): void {
    const fine = this.levels[0];
    fine.rhs.set(rhs);
    fine.wall.set(wall);
    fine.p.set(pOut);

    // Coarsen the wall mask down the hierarchy (a coarse cell is solid
    // iff a majority of its fine sub-cells are solid).
    for (let l = 1; l < this.levels.length; l++) {
      restrictWall(this.levels[l - 1], this.levels[l]);
      this.levels[l].p.fill(0);
    }

    for (let c = 0; c < nCycles; c++) {
      vcycle(this.levels, 0);
    }
    pOut.set(fine.p);
  }
}

// ── V-cycle ──────────────────────────────────────────────────────────────

const N_PRE  = 2;   // pre-smoothing iterations
const N_POST = 2;   // post-smoothing iterations
const N_COARSE = 32; // direct iterations at the coarsest level

function vcycle(levels: Level[], l: number): void {
  const lv = levels[l];
  if (l === levels.length - 1) {
    // Coarsest: just hammer with GS until effectively converged.
    for (let i = 0; i < N_COARSE; i++) gsRedBlack(lv);
    return;
  }
  // Pre-smooth
  for (let i = 0; i < N_PRE; i++) gsRedBlack(lv);
  // Compute residual r = rhs − Lp
  computeResidual(lv);
  // Restrict residual to coarse rhs
  restrictResidual(lv, levels[l + 1]);
  // Coarse correction starts from zero
  levels[l + 1].p.fill(0);
  vcycle(levels, l + 1);
  // Prolongate correction and add
  prolongateAdd(levels[l + 1], lv);
  // Post-smooth
  for (let i = 0; i < N_POST; i++) gsRedBlack(lv);
}

// Red-black Gauss–Seidel relaxation.
//   p[k] = ( ax(p[+1] + p[-1]) + ay(…) + az(…) − rhs[k] ) / asum
function gsRedBlack(lv: Level): void {
  const { nx, ny, nz, dx, dy, dz, p, rhs, wall } = lv;
  const ax = 1 / (dx * dx);
  const ay = 1 / (dy * dy);
  const az = 1 / (dz * dz);
  const asum = 2 * (ax + ay + az);
  for (let phase = 0; phase < 2; phase++) {
    for (let iz = 1; iz < nz - 1; iz++)
      for (let iy = 1; iy < ny - 1; iy++)
        for (let ix = 1; ix < nx - 1; ix++) {
          if (((ix + iy + iz) & 1) !== phase) continue;
          const k = idx(nx, ny, ix, iy, iz);
          if (wall[k]) { p[k] = 0; continue; }
          // Neumann at solid neighbours: replace p[neighbour] with p[k] so
          // the gradient there is zero. Implemented as: drop that term and
          // reduce the diagonal coefficient.
          let sum = 0, diag = asum;
          let n;
          n = idx(nx, ny, ix + 1, iy, iz); if (wall[n]) diag -= ax; else sum += ax * p[n];
          n = idx(nx, ny, ix - 1, iy, iz); if (wall[n]) diag -= ax; else sum += ax * p[n];
          n = idx(nx, ny, ix, iy + 1, iz); if (wall[n]) diag -= ay; else sum += ay * p[n];
          n = idx(nx, ny, ix, iy - 1, iz); if (wall[n]) diag -= ay; else sum += ay * p[n];
          n = idx(nx, ny, ix, iy, iz + 1); if (wall[n]) diag -= az; else sum += az * p[n];
          n = idx(nx, ny, ix, iy, iz - 1); if (wall[n]) diag -= az; else sum += az * p[n];
          if (diag > 1e-9) p[k] = (sum - rhs[k]) / diag;
        }
  }
}

function computeResidual(lv: Level): void {
  const { nx, ny, nz, dx, dy, dz, p, rhs, res, wall } = lv;
  const ax = 1 / (dx * dx);
  const ay = 1 / (dy * dy);
  const az = 1 / (dz * dz);
  res.fill(0);
  for (let iz = 1; iz < nz - 1; iz++)
    for (let iy = 1; iy < ny - 1; iy++)
      for (let ix = 1; ix < nx - 1; ix++) {
        const k = idx(nx, ny, ix, iy, iz);
        if (wall[k]) continue;
        let lap = 0, diag = 2 * (ax + ay + az);
        let n;
        n = idx(nx, ny, ix + 1, iy, iz); if (wall[n]) diag -= ax; else lap += ax * p[n];
        n = idx(nx, ny, ix - 1, iy, iz); if (wall[n]) diag -= ax; else lap += ax * p[n];
        n = idx(nx, ny, ix, iy + 1, iz); if (wall[n]) diag -= ay; else lap += ay * p[n];
        n = idx(nx, ny, ix, iy - 1, iz); if (wall[n]) diag -= ay; else lap += ay * p[n];
        n = idx(nx, ny, ix, iy, iz + 1); if (wall[n]) diag -= az; else lap += az * p[n];
        n = idx(nx, ny, ix, iy, iz - 1); if (wall[n]) diag -= az; else lap += az * p[n];
        res[k] = rhs[k] - (lap - diag * p[k]);
      }
}

// Full-weighting restriction: average a 2×2×2 block of fine residuals into
// one coarse rhs cell.
function restrictResidual(fine: Level, coarse: Level): void {
  const { nx: fnx, ny: fny, nz: fnz, res } = fine;
  const { nx: cnx, ny: cny, nz: cnz, rhs: crhs } = coarse;
  crhs.fill(0);
  for (let iz = 0; iz < cnz; iz++)
    for (let iy = 0; iy < cny; iy++)
      for (let ix = 0; ix < cnx; ix++) {
        const fx = Math.min(fnx - 1, ix * 2);
        const fy = Math.min(fny - 1, iy * 2);
        const fz = Math.min(fnz - 1, iz * 2);
        let s = 0, n = 0;
        for (let dz = 0; dz < 2; dz++)
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++) {
              const x = Math.min(fnx - 1, fx + dx);
              const y = Math.min(fny - 1, fy + dy);
              const z = Math.min(fnz - 1, fz + dz);
              s += res[idx(fnx, fny, x, y, z)];
              n++;
            }
        crhs[idx(cnx, cny, ix, iy, iz)] = n > 0 ? s / n : 0;
      }
}

// Restrict the wall mask: coarse cell solid iff majority of fine sub-cells solid.
function restrictWall(fine: Level, coarse: Level): void {
  const { nx: fnx, ny: fny, nz: fnz, wall: fwall } = fine;
  const { nx: cnx, ny: cny, nz: cnz, wall: cwall } = coarse;
  for (let iz = 0; iz < cnz; iz++)
    for (let iy = 0; iy < cny; iy++)
      for (let ix = 0; ix < cnx; ix++) {
        const fx = Math.min(fnx - 1, ix * 2);
        const fy = Math.min(fny - 1, iy * 2);
        const fz = Math.min(fnz - 1, iz * 2);
        let s = 0;
        for (let dz = 0; dz < 2; dz++)
          for (let dy = 0; dy < 2; dy++)
            for (let dx = 0; dx < 2; dx++) {
              const x = Math.min(fnx - 1, fx + dx);
              const y = Math.min(fny - 1, fy + dy);
              const z = Math.min(fnz - 1, fz + dz);
              s += fwall[idx(fnx, fny, x, y, z)];
            }
        cwall[idx(cnx, cny, ix, iy, iz)] = s >= 5 ? 1 : 0;
      }
}

// Trilinear-style prolongation: spread one coarse correction into a 2×2×2
// fine block (with simple constant injection — enough for correction).
function prolongateAdd(coarse: Level, fine: Level): void {
  const { nx: cnx, ny: cny, nz: cnz, p: cp } = coarse;
  const { nx: fnx, ny: fny, nz: fnz, p: fp, wall: fwall } = fine;
  for (let iz = 0; iz < fnz; iz++)
    for (let iy = 0; iy < fny; iy++)
      for (let ix = 0; ix < fnx; ix++) {
        const k = idx(fnx, fny, ix, iy, iz);
        if (fwall[k]) continue;
        const cx = Math.min(cnx - 1, ix >> 1);
        const cy = Math.min(cny - 1, iy >> 1);
        const cz = Math.min(cnz - 1, iz >> 1);
        fp[k] += cp[idx(cnx, cny, cx, cy, cz)];
      }
}

// ── Main-thread entry: pressure projection on the MAC velocity field ────

/**
 * Compute the divergence ∇·u of the (non-divergence-free) MAC velocity
 * field into `rhs` at cell centres. Multiplied by 1/dt so that subtracting
 * ∇p · dt below makes the field divergence-free in one shot.
 */
export function divergence(
  f: MACFields, rhs: Float32Array, dt: number, room: RoomDims,
): void {
  const { dx, dy, dz } = cellSize(room);
  rhs.fill(0);
  for (let iz = 0; iz < NZ; iz++)
    for (let iy = 0; iy < NY; iy++)
      for (let ix = 0; ix < NX; ix++) {
        const k = CK(ix, iy, iz);
        if (f.wall[k]) continue;
        const u0 = f.u[ix     + (NX + 1) * iy + (NX + 1) * NY * iz];
        const u1 = f.u[ix + 1 + (NX + 1) * iy + (NX + 1) * NY * iz];
        const v0 = f.v[ix + NX * iy       + NX * (NY + 1) * iz];
        const v1 = f.v[ix + NX * (iy + 1) + NX * (NY + 1) * iz];
        const w0 = f.w[ix + NX * iy + NX * NY * iz      ];
        const w1 = f.w[ix + NX * iy + NX * NY * (iz + 1)];
        const div = (u1 - u0) / dx + (v1 - v0) / dy + (w1 - w0) / dz;
        rhs[k] = div / dt;
      }
}

/**
 * Subtract ∇p · dt from the MAC velocity field to make it divergence-free.
 * Applied face-by-face: u_new[i] -= dt · (p[i] − p[i-1]) / dx, etc.
 */
export function subtractPressureGradient(
  f: MACFields, p: Float32Array, dt: number, room: RoomDims,
): void {
  const { dx, dy, dz } = cellSize(room);
  // u-faces: interior only; boundary faces stay zero (no penetration)
  for (let iz = 0; iz < NZ; iz++)
    for (let iy = 0; iy < NY; iy++) {
      for (let ix = 1; ix < NX; ix++) {
        const ku = ix + (NX + 1) * iy + (NX + 1) * NY * iz;
        if (f.uwall[ku]) { f.u[ku] = 0; continue; }
        const kc1 = CK(ix - 1, iy, iz);
        const kc2 = CK(ix,     iy, iz);
        f.u[ku] -= dt * (p[kc2] - p[kc1]) / dx;
      }
    }
  for (let iz = 0; iz < NZ; iz++)
    for (let iy = 1; iy < NY; iy++)
      for (let ix = 0; ix < NX; ix++) {
        const kv = ix + NX * iy + NX * (NY + 1) * iz;
        if (f.vwall[kv]) { f.v[kv] = 0; continue; }
        const kc1 = CK(ix, iy - 1, iz);
        const kc2 = CK(ix, iy,     iz);
        f.v[kv] -= dt * (p[kc2] - p[kc1]) / dy;
      }
  for (let iz = 1; iz < NZ; iz++)
    for (let iy = 0; iy < NY; iy++)
      for (let ix = 0; ix < NX; ix++) {
        const kw = ix + NX * iy + NX * NY * iz;
        if (f.wwall[kw]) { f.w[kw] = 0; continue; }
        const kc1 = CK(ix, iy, iz - 1);
        const kc2 = CK(ix, iy, iz    );
        f.w[kw] -= dt * (p[kc2] - p[kc1]) / dz;
      }
  // Domain boundary faces are no-penetration — already zero on first step,
  // but enforce again here in case anything reset them.
  for (let iz = 0; iz < NZ; iz++)
    for (let iy = 0; iy < NY; iy++) {
      f.u[0      + (NX + 1) * iy + (NX + 1) * NY * iz] = 0;
      f.u[NX     + (NX + 1) * iy + (NX + 1) * NY * iz] = 0;
    }
  for (let iz = 0; iz < NZ; iz++)
    for (let ix = 0; ix < NX; ix++) {
      f.v[ix + NX * 0      + NX * (NY + 1) * iz] = 0;
      f.v[ix + NX * NY     + NX * (NY + 1) * iz] = 0;
    }
  for (let iy = 0; iy < NY; iy++)
    for (let ix = 0; ix < NX; ix++) {
      f.w[ix + NX * iy + NX * NY * 0     ] = 0;
      f.w[ix + NX * iy + NX * NY * NZ    ] = 0;
    }
}
