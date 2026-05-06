/**
 * Semi-Lagrangian advection — sanity tests.
 *
 * (1) Zero velocity field → scalar must be unchanged after advection.
 * (2) Uniform velocity field → a smooth Gaussian blob travels in the
 *     expected direction. We check the centroid shifts roughly by  v · dt.
 */

import { describe, it, expect } from "vitest";
import {
  NX, NY, NZ, NCELLS, CK, NU, NV, NW, makeMACFields, type RoomDims,
} from "../mac-grid";
import { advectScalar } from "../advection";

const room: RoomDims = { L: 4, W: 4, H: 4 };

function gaussianAt(cx: number, cy: number, cz: number, sigma = 2): Float32Array {
  const out = new Float32Array(NCELLS);
  for (let iz = 0; iz < NZ; iz++)
    for (let iy = 0; iy < NY; iy++)
      for (let ix = 0; ix < NX; ix++) {
        const r2 = (ix - cx) ** 2 + (iy - cy) ** 2 + (iz - cz) ** 2;
        out[CK(ix, iy, iz)] = Math.exp(-r2 / (2 * sigma * sigma));
      }
  return out;
}

function centroid(s: Float32Array): { x: number; y: number; z: number; mass: number } {
  let mx = 0, my = 0, mz = 0, m = 0;
  for (let iz = 0; iz < NZ; iz++)
    for (let iy = 0; iy < NY; iy++)
      for (let ix = 0; ix < NX; ix++) {
        const v = s[CK(ix, iy, iz)];
        mx += ix * v; my += iy * v; mz += iz * v; m += v;
      }
  return m > 0 ? { x: mx / m, y: my / m, z: mz / m, mass: m } : { x: 0, y: 0, z: 0, mass: 0 };
}

describe("Semi-Lagrangian advection", () => {
  it("preserves a scalar field when velocity is zero", () => {
    const f = makeMACFields();
    const s = gaussianAt(NX / 2, NY / 2, NZ / 2);
    const sCopy = new Float32Array(s);
    const out = new Float32Array(NCELLS);
    // u, v, w are all zero by default
    advectScalar(f, room, 0.05, s, out, -10, 100);
    // Each cell should match within numerical tolerance
    let maxDiff = 0;
    for (let i = 0; i < NCELLS; i++) {
      const d = Math.abs(sCopy[i] - out[i]);
      if (d > maxDiff) maxDiff = d;
    }
    expect(maxDiff).toBeLessThan(0.01);
  });

  it("transports a Gaussian blob with uniform x-velocity", () => {
    const f = makeMACFields();
    // Set u = 0.5 m/s everywhere (face-centred)
    f.u.fill(0.5);
    // Initial blob centred at (NX/2, NY/2, NZ/2)
    const cx = NX / 2, cy = NY / 2, cz = NZ / 2;
    const s = gaussianAt(cx, cy, cz, 2);
    const out = new Float32Array(NCELLS);
    const dt = 0.1;
    // Several substeps so the blob moves a measurable distance.
    // Hand-rolled ping-pong (TS strictness about Float32Array types makes
    // a generic swap awkward).
    const a = new Float32Array(s);
    const b = out;
    let useA = true;
    for (let step = 0; step < 8; step++) {
      if (useA) advectScalar(f, room, dt, a, b, -10, 100);
      else      advectScalar(f, room, dt, b, a, -10, 100);
      useA = !useA;
    }
    const cur = useA ? a : b;
    const cFinal = centroid(cur);
    const dx = room.L / NX;
    const expectedDX = (0.5 * dt * 8) / dx;     // cells moved
    // Allow generous tolerance — semi-Lagrangian on a coarse grid smears
    // the centroid; we just check direction and rough magnitude.
    expect(cFinal.x - cx).toBeGreaterThan(expectedDX * 0.4);
    expect(cFinal.x - cx).toBeLessThan(expectedDX * 1.6);
    // Y and Z centroids should barely shift
    expect(Math.abs(cFinal.y - cy)).toBeLessThan(1.0);
    expect(Math.abs(cFinal.z - cz)).toBeLessThan(1.0);
    // Mass is roughly conserved (semi-Lagrangian is not perfectly
    // conservative but should be within ~10 %)
    const m0 = centroid(s).mass;
    expect(cFinal.mass / m0).toBeGreaterThan(0.85);
    expect(cFinal.mass / m0).toBeLessThan(1.15);
    void NU; void NV; void NW;
  });
});
