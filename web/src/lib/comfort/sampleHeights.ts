/**
 * Multi-height sampling: extract horizontal slabs from the 3D CFD field at
 * the three ASHRAE 55 reference heights — 0.1 m (ankle), 0.6 m (waist when
 * seated), 1.1 m (head when seated / waist when standing).
 *
 * The grid Y-axis runs from 0 (floor) to H (ceiling) over NY cells, so cell
 * iy has its centre at y = (iy + 0.5)·dy. We pick the iy whose centre is
 * closest to the requested height, clamped to [0, NY−1].
 */

import { NX, NY, NZ, K } from "@/lib/cfd/grid";

export const SAMPLE_HEIGHTS_M = [0.1, 0.6, 1.1] as const;
export type SampleHeight = (typeof SAMPLE_HEIGHTS_M)[number];

export function iyForHeight(h: number, roomH: number): number {
  const dy = roomH / NY;
  const iy = Math.round(h / dy - 0.5);
  return Math.max(0, Math.min(NY - 1, iy));
}

export interface Slab {
  /** y in metres (cell centre) */
  y:  number;
  /** ny rows × nx cols, row-major (iz outer, ix inner). length = NX·NZ */
  T:  Float32Array;
  Vx: Float32Array;
  Vy: Float32Array;
  Vz: Float32Array;
  /** speed |V| at each cell, precomputed once for callers that need it */
  V:  Float32Array;
}

/** Extract a slab at iy from the worker snapshot field arrays. */
export function extractSlab(
  T:  Float32Array,
  Vx: Float32Array,
  Vy: Float32Array,
  Vz: Float32Array,
  iy: number,
  roomH: number,
): Slab {
  const n = NX * NZ;
  const sT  = new Float32Array(n);
  const sVx = new Float32Array(n);
  const sVy = new Float32Array(n);
  const sVz = new Float32Array(n);
  const sV  = new Float32Array(n);
  let p = 0;
  for (let iz = 0; iz < NZ; iz++)
    for (let ix = 0; ix < NX; ix++) {
      const k = K(ix, iy, iz);
      const ux = Vx[k], uy = Vy[k], uz = Vz[k];
      sT[p]  = T[k];
      sVx[p] = ux;
      sVy[p] = uy;
      sVz[p] = uz;
      sV[p]  = Math.sqrt(ux * ux + uy * uy + uz * uz);
      p++;
    }
  const dy = roomH / NY;
  const y  = (iy + 0.5) * dy;
  return { y, T: sT, Vx: sVx, Vy: sVy, Vz: sVz, V: sV };
}
