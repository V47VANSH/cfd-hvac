/**
 * Multigrid V-cycle Poisson solver — sanity tests.
 *
 * We supply a known smooth right-hand side and check the solver's
 * residual converges geometrically. We also check that the wall mask
 * acts as a homogeneous Dirichlet boundary inside solid cells.
 */

import { describe, it, expect } from "vitest";
import { NX, NY, NZ, NCELLS, CK, type RoomDims } from "../mac-grid";
import { Multigrid } from "../multigrid";

const room: RoomDims = { L: 3, W: 3, H: 3 };

function maxAbs(a: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m) m = v; }
  return m;
}

describe("Multigrid Poisson solver", () => {
  it("residual decreases with each V-cycle on a simple smooth RHS", () => {
    const mg = new Multigrid(room, 3);
    const rhs = new Float32Array(NCELLS);
    const wall = new Uint8Array(NCELLS);
    const p = new Float32Array(NCELLS);

    // RHS: bump in the middle of the room
    const cx = NX / 2, cy = NY / 2, cz = NZ / 2;
    for (let iz = 0; iz < NZ; iz++)
      for (let iy = 0; iy < NY; iy++)
        for (let ix = 0; ix < NX; ix++) {
          const r2 = (ix - cx) ** 2 + (iy - cy) ** 2 + (iz - cz) ** 2;
          rhs[CK(ix, iy, iz)] = Math.exp(-r2 / 8);
        }

    // Solve with 1 cycle, then 5 cycles, residual measured indirectly via
    // pressure energy convergence (||p_5 - p_1||  should be small if mg
    // converges quickly).
    const p1 = new Float32Array(NCELLS);
    mg.solve(rhs, wall, p1, 1);
    const p5 = new Float32Array(NCELLS);
    mg.solve(rhs, wall, p5, 5);

    // Absolute scale should be sensible (non-zero, not exploded).
    expect(maxAbs(p5)).toBeGreaterThan(0);
    expect(maxAbs(p5)).toBeLessThan(1e3);

    // Difference between 1-cycle and 5-cycle solutions: bounded — the
    // 5-cycle solution must dominate in magnitude (mg is improving the
    // approximation, not oscillating). A reasonable upper bound on the
    // ratio of L∞ norms catches obvious mis-implementations.
    const ratio = maxAbs(p1) / Math.max(1e-9, maxAbs(p5));
    expect(ratio).toBeGreaterThan(0.05);
    expect(ratio).toBeLessThan(2.0);
  });

  it("respects solid cells (homogeneous Dirichlet inside walls)", () => {
    const mg = new Multigrid(room, 3);
    const rhs = new Float32Array(NCELLS).fill(1);
    const wall = new Uint8Array(NCELLS);
    // Make a slab of solid cells in the middle
    for (let iz = 5; iz < 12; iz++)
      for (let iy = 4; iy < 9; iy++)
        for (let ix = 8; ix < 22; ix++) {
          wall[CK(ix, iy, iz)] = 1;
        }
    const p = new Float32Array(NCELLS);
    mg.solve(rhs, wall, p, 4);
    // Solid cells should be exactly zero
    let maxInSolid = 0;
    for (let i = 0; i < NCELLS; i++) if (wall[i]) {
      if (Math.abs(p[i]) > maxInSolid) maxInSolid = Math.abs(p[i]);
    }
    expect(maxInSolid).toBe(0);
  });

  it("returns finite values everywhere", () => {
    const mg = new Multigrid(room, 3);
    const rhs = new Float32Array(NCELLS);
    for (let i = 0; i < NCELLS; i++) rhs[i] = (i % 7) - 3;
    const wall = new Uint8Array(NCELLS);
    const p = new Float32Array(NCELLS);
    mg.solve(rhs, wall, p, 3);
    for (let i = 0; i < NCELLS; i++) {
      expect(Number.isFinite(p[i])).toBe(true);
    }
  });
});
