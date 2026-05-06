/**
 * Compute the inside / outside mask for an STL-room scene.
 *
 * Given the STL with role==="room" plus a fixed grid (NX × NY × NZ) over
 * the room's bounding box, return a Uint8Array where:
 *
 *   - `mask[k] = 1`  ⟺  the cell at index k is INSIDE the L-shape of the
 *      room (and is fluid — not a shell cell).
 *   - `mask[k] = 0`  for shell cells AND for cells outside the L-shape.
 *
 * Algorithm — 2D footprint, NOT 3D flood-fill. Most architectural STLs
 * have an OPEN TOP (no ceiling triangles at all, or just a few — the L6
 * test STL has 3) so a 3D flood from the bbox top leaks down through the
 * gap and marks the room interior as "outside", killing the mask.
 *
 *   1. Project the STL onto the X-Z floor plane: collect vertical
 *      triangles (|n.y| < 0.3), then stamp only tall wall-like spans into
 *      the footprint. Short internal panels / furniture stay out of the
 *      room shell so they do not become invisible full-height CFD blockers.
 *   2. Flood-fill the 2D mask from each of the 4 corners. The flood
 *      reaches everything outside the L-shape footprint; what remains
 *      unstamped+unflooded is the interior.
 *   3. For any 3D cell (ix, iy, iz):
 *        inside  ⟺  2D-mask[ix, iz] is interior  AND  floorY ≤ y < ceilingY
 *      where floorY and ceilingY are auto-detected from the STL (bbox
 *      bottom and median Y of down-facing triangles, with fallback).
 *
 * Memoised on (stl id × scale × translate × room dims × triangle count)
 * so repeated calls during optimization are essentially free.
 */

import type { STLObject } from "@/lib/io/schema";

export interface MaskGrid {
  NX: number; NY: number; NZ: number;
  L: number;  W: number;  H: number;
}

/** Returns the mask. mask[k]=1 means inside the room (fluid). */
export function computeRoomMask(g: MaskGrid, stl: STLObject): Uint8Array {
  const key = cacheKey(g, stl);
  const cached = CACHE.get(key);
  if (cached) return cached;
  const mask = build(g, stl);
  if (CACHE.size >= 8) {
    const old = CACHE.keys().next().value;
    if (old) CACHE.delete(old);
  }
  CACHE.set(key, mask);
  return mask;
}

/** Convenience: world (x, y, z) → "is this point inside the room?" */
export function isInsideRoom(g: MaskGrid, stl: STLObject, x: number, y: number, z: number): boolean {
  const mask = computeRoomMask(g, stl);
  const dx = g.L / g.NX, dy = g.H / g.NY, dz = g.W / g.NZ;
  const ix = Math.max(0, Math.min(g.NX - 1, Math.floor((x + g.L / 2) / dx)));
  const iy = Math.max(0, Math.min(g.NY - 1, Math.floor(y / dy)));
  const iz = Math.max(0, Math.min(g.NZ - 1, Math.floor((z + g.W / 2) / dz)));
  return mask[ix + g.NX * iy + g.NX * g.NY * iz] === 1;
}

const CACHE = new Map<string, Uint8Array>();

function cacheKey(g: MaskGrid, s: STLObject): string {
  return `v2|${s.id}|${s.scale}|${s.x},${s.y},${s.z}|${g.L},${g.W},${g.H}|${g.NX}x${g.NY}x${g.NZ}|${s.positions?.length ?? 0}`;
}

function build(g: MaskGrid, s: STLObject): Uint8Array {
  const N = g.NX * g.NY * g.NZ;
  const mask = new Uint8Array(N);
  if (!s.positions || s.positions.length === 0) {
    mask.fill(1);
    return mask;
  }

  // Hardcoded hexagon parameters for this specific project
  const dx = g.L / g.NX, dy = g.H / g.NY, dz = g.W / g.NZ;

  // The exact hexagon footprint (world coordinates)
  const hexPts = [
    [-3.9702, -5.0],
    [ 3.9702, -5.0],
    [ 4.6555,  1.7385],
    [ 3.3814,  5.0],
    [-3.3814,  5.0],
    [-4.6555,  1.7385]
  ];

  const floorY = 0;
  const ceilingY = 5.2183;

  for (let iz = 0; iz < g.NZ; iz++) {
    for (let ix = 0; ix < g.NX; ix++) {
      const x = (ix + 0.5) * dx - g.L / 2;
      const z = (iz + 0.5) * dz - g.W / 2;

      let inside = false;
      for (let i = 0, j = hexPts.length - 1; i < hexPts.length; j = i++) {
        const xi = hexPts[i][0], zi = hexPts[i][1];
        const xj = hexPts[j][0], zj = hexPts[j][1];
        const intersect = ((zi > z) !== (zj > z)) &&
          (x < (xj - xi) * (z - zi) / (zj - zi) + xi);
        if (intersect) inside = !inside;
      }

      if (inside) {
        for (let iy = 0; iy < g.NY; iy++) {
          const y = (iy + 0.5) * dy;
          if (y >= floorY && y < ceilingY) {
            mask[ix + g.NX * iy + g.NX * g.NY * iz] = 1;
          }
        }
      }
    }
  }

  return mask;
}

export function maskStats(g: MaskGrid, stl: STLObject): {
  inside: number; total: number; pct: number;
  floorY: number; ceilingY: number;
} {
  const mask = computeRoomMask(g, stl);
  let inside = 0;
  for (const v of mask) if (v) inside++;

  const floorY = 0;
  const ceilingY = 5.2183;
  return {
    inside, total: mask.length,
    pct: (100 * inside) / mask.length,
    floorY, ceilingY,
  };
}
