/**
 * STL-mode room mask — HARDCODED hexagonal prism volume.
 *
 * The auto-detected wall/footprint algorithm was unreliable on the L6 STL
 * (short internal panels, missing ceiling triangles, etc.), so the CFD
 * domain for STL mode is now defined explicitly:
 *
 *   - Footprint: a 6-corner hexagon in the X–Z plane (metres). Derived
 *     from the L6 STL's tall vertical wall triangles.
 *   - Vertical extent: floor Y = 0, ceiling Y = 5.0 m.
 *
 * A cell (ix, iy, iz) is fluid (mask[k]=1) iff its centre lies inside the
 * hexagon AND iyFloor ≤ iy < iyCeiling. The STL argument is kept only for
 * cache-key compatibility with the previous API; its triangles are
 * ignored.
 *
 * Hexagon corners (clockwise as viewed from +Y):
 *   ( -4.656, +1.739 )   ( -3.970, -5.000 )   ( +3.970, -5.000 )
 *   ( +4.656, +1.739 )   ( +3.381, +4.999 )   ( -3.381, +4.999 )
 */

import type { STLObject } from "@/lib/io/schema";

export interface MaskGrid {
  NX: number; NY: number; NZ: number;
  L: number;  W: number;  H: number;
}

/**
 * Hardcoded hexagonal footprint of the L6 room (X-Z plane, metres).
 * Vertices are ordered counter-clockwise as expected by ray-casting PIP.
 */
const ROOM_HEX: ReadonlyArray<readonly [number, number]> = [
  [-4.656, +1.739],
  [-3.970, -5.000],
  [+3.970, -5.000],
  [+4.656, +1.739],
  [+3.381, +4.999],
  [-3.381, +4.999],
];

/** Floor and ceiling of the hardcoded volume (world-Y, metres). */
const ROOM_FLOOR_Y = 0;
const ROOM_CEILING_Y = 5.0;

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

function build(g: MaskGrid, _s: STLObject): Uint8Array {
  const N = g.NX * g.NY * g.NZ;
  const mask = new Uint8Array(N);
  const dx = g.L / g.NX, dy = g.H / g.NY, dz = g.W / g.NZ;

  // Vertical extent in grid indices.
  const iyFloor = Math.max(0, Math.floor(ROOM_FLOOR_Y / dy));
  const iyCeiling = Math.min(g.NY, Math.ceil(ROOM_CEILING_Y / dy));

  // 2D footprint via point-in-polygon at each cell centre.
  const foot2D = new Uint8Array(g.NX * g.NZ);
  for (let iz = 0; iz < g.NZ; iz++) {
    const zc = (iz + 0.5) * dz - g.W / 2;
    for (let ix = 0; ix < g.NX; ix++) {
      const xc = (ix + 0.5) * dx - g.L / 2;
      if (pointInHex(xc, zc)) foot2D[ix + g.NX * iz] = 1;
    }
  }

  for (let iz = 0; iz < g.NZ; iz++) {
    for (let ix = 0; ix < g.NX; ix++) {
      if (!foot2D[ix + g.NX * iz]) continue;
      for (let iy = iyFloor; iy < iyCeiling; iy++) {
        mask[ix + g.NX * iy + g.NX * g.NY * iz] = 1;
      }
    }
  }
  return mask;
}

/** Ray-casting point-in-polygon against the hardcoded hexagon. */
function pointInHex(x: number, z: number): boolean {
  let inside = false;
  const n = ROOM_HEX.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, zi] = ROOM_HEX[i];
    const [xj, zj] = ROOM_HEX[j];
    const intersect = ((zi > z) !== (zj > z)) &&
      (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Diagnostic: returns counts useful for confirming the mask is sane.
 * Safe to call from the browser console once you've imported the module.
 */
export function maskStats(g: MaskGrid, stl: STLObject): {
  inside: number; total: number; pct: number;
  floorY: number; ceilingY: number;
} {
  const mask = computeRoomMask(g, stl);
  let inside = 0;
  for (const v of mask) if (v) inside++;
  return {
    inside, total: mask.length,
    pct: (100 * inside) / mask.length,
    floorY: ROOM_FLOOR_Y, ceilingY: ROOM_CEILING_Y,
  };
}
