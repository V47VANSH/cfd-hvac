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
 *   1. Project the STL onto the X-Z floor plane: for every vertical
 *      triangle (|n.y| < 0.3) compute its (X, Z) bbox and stamp those
 *      cells into a 2D footprint mask.
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
  return `${s.id}|${s.scale}|${s.x},${s.y},${s.z}|${g.L},${g.W},${g.H}|${g.NX}x${g.NY}x${g.NZ}|${s.positions?.length ?? 0}`;
}

function build(g: MaskGrid, s: STLObject): Uint8Array {
  const N = g.NX * g.NY * g.NZ;
  const mask = new Uint8Array(N);
  if (!s.positions || s.positions.length === 0) {
    mask.fill(1);
    return mask;
  }
  const dx = g.L / g.NX, dy = g.H / g.NY, dz = g.W / g.NZ;
  const sc = s.scale || 1;
  const xOff = s.x || 0, yOff = s.y || 0, zOff = s.z || 0;
  const p = s.positions;
  const nTris = (p.length / 9) | 0;

  // ── Pass 1: 2D footprint stamp (X-Z plane) ────────────────────────────
  // Stamp cells where any VERTICAL wall triangle lives. Vertical = the
  // normal's |y| component is < 0.3 — these are the room walls.
  // We compute world-normal per triangle; axis-aligned walls have
  // ny ≈ 0 so the threshold easily separates them from floors / ceilings
  // (ny ≈ ±1) and most ramps / sloped roofs (ny ≈ ±0.7).
  const foot2D = new Uint8Array(g.NX * g.NZ);
  // Track Y range of the room from the STL itself.
  let stlMinY = +Infinity, stlMaxY = -Infinity;
  // Median-Y of down-facing triangles → ceiling height heuristic.
  const downFaceY: number[] = [];
  for (let t = 0; t < nTris; t++) {
    const o = t * 9;
    const ax = sc * p[o]     + xOff, ay = sc * p[o + 1] + yOff, az = sc * p[o + 2] + zOff;
    const bx = sc * p[o + 3] + xOff, by = sc * p[o + 4] + yOff, bz = sc * p[o + 5] + zOff;
    const cx = sc * p[o + 6] + xOff, cy = sc * p[o + 7] + yOff, cz = sc * p[o + 8] + zOff;
    if (ay < stlMinY) stlMinY = ay; if (ay > stlMaxY) stlMaxY = ay;
    if (by < stlMinY) stlMinY = by; if (by > stlMaxY) stlMaxY = by;
    if (cy < stlMinY) stlMinY = cy; if (cy > stlMaxY) stlMaxY = cy;
    // Compute world normal.
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    void nx; void nz;

    const tCY = (ay + by + cy) / 3;
    if (Math.abs(ny) > 0.85 && ny < 0) downFaceY.push(tCY);

    // Vertical wall? Stamp into the 2D footprint.
    if (Math.abs(ny) < 0.30) {
      const tMinX = Math.min(ax, bx, cx), tMaxX = Math.max(ax, bx, cx);
      const tMinZ = Math.min(az, bz, cz), tMaxZ = Math.max(az, bz, cz);
      const ix0 = Math.max(0,    Math.floor((tMinX + g.L / 2) / dx));
      const ix1 = Math.min(g.NX, Math.ceil ((tMaxX + g.L / 2) / dx));
      const iz0 = Math.max(0,    Math.floor((tMinZ + g.W / 2) / dz));
      const iz1 = Math.min(g.NZ, Math.ceil ((tMaxZ + g.W / 2) / dz));
      for (let iz = iz0; iz < iz1; iz++)
        for (let ix = ix0; ix < ix1; ix++)
          foot2D[ix + g.NX * iz] = 1;
    }
  }

  // ── Pass 2: 2D flood-fill from the 4 corners ──────────────────────────
  // For an L-shape that doesn't fill its bbox, at least one corner is
  // outside. We flood from all four to be robust to rooms that are
  // tucked into a single corner of their bbox.
  const out2D = new Uint8Array(g.NX * g.NZ);
  const seeds: [number, number][] = [
    [0, 0], [g.NX - 1, 0], [0, g.NZ - 1], [g.NX - 1, g.NZ - 1],
  ];
  const queue: number[] = [];
  for (const [sx, sz] of seeds) {
    const k0 = sx + g.NX * sz;
    if (foot2D[k0] || out2D[k0]) continue;
    out2D[k0] = 1;
    queue.push(sx, sz);
    while (queue.length) {
      const z = queue.pop()!;
      const x = queue.pop()!;
      // 4-connected
      if (x > 0)        flood2D(x - 1, z, foot2D, out2D, queue, g);
      if (x < g.NX - 1) flood2D(x + 1, z, foot2D, out2D, queue, g);
      if (z > 0)        flood2D(x, z - 1, foot2D, out2D, queue, g);
      if (z < g.NZ - 1) flood2D(x, z + 1, foot2D, out2D, queue, g);
    }
  }

  // ── Pass 3: floor / ceiling Y bounds ──────────────────────────────────
  const floorY = stlMinY;
  let ceilingY = stlMaxY;
  if (downFaceY.length > 0) {
    downFaceY.sort((a, b) => a - b);
    const med = downFaceY[downFaceY.length >> 1];
    // Sanity: ceiling must be ≥ floor + 1 m. If the median is lower than
    // that (heavy obstacle bottoms dragging the median down), use stlMaxY.
    if (med - floorY >= 1.0) ceilingY = med;
  }
  const iyFloor = Math.max(0, Math.floor(floorY / dy));
  const iyCeiling = Math.min(g.NY, Math.ceil(ceilingY / dy));

  // ── Pass 4: compose the 3D mask ──────────────────────────────────────
  // Cell (ix, iy, iz) is inside the room iff
  //   • iyFloor ≤ iy < iyCeiling     (within the room's vertical span)
  //   • foot2D[ix, iz] = 0           (not on a wall)
  //   • out2D[ix, iz] = 0            (not in the outside-flood region)
  for (let iz = 0; iz < g.NZ; iz++) {
    for (let ix = 0; ix < g.NX; ix++) {
      const k2 = ix + g.NX * iz;
      const insideXZ = !foot2D[k2] && !out2D[k2];
      if (!insideXZ) continue;
      for (let iy = iyFloor; iy < iyCeiling; iy++) {
        mask[ix + g.NX * iy + g.NX * g.NY * iz] = 1;
      }
    }
  }
  return mask;
}

function flood2D(
  x: number, z: number,
  foot: Uint8Array, out: Uint8Array, queue: number[],
  g: MaskGrid,
): void {
  const k = x + g.NX * z;
  if (foot[k] || out[k]) return;
  out[k] = 1;
  queue.push(x, z);
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
  // Re-run to extract floorY/ceilingY (they're not on the cached mask).
  const sc = stl.scale || 1;
  const yOff = stl.y || 0;
  let stlMinY = +Infinity, stlMaxY = -Infinity;
  const downFaceY: number[] = [];
  if (stl.positions) {
    const p = stl.positions;
    const nTris = (p.length / 9) | 0;
    for (let t = 0; t < nTris; t++) {
      const o = t * 9;
      const ay = sc * p[o + 1] + yOff;
      const by = sc * p[o + 4] + yOff;
      const cy = sc * p[o + 7] + yOff;
      const ax = sc * p[o] + (stl.x || 0), bx = sc * p[o + 3] + (stl.x || 0), cx = sc * p[o + 6] + (stl.x || 0);
      const az = sc * p[o + 2] + (stl.z || 0), bz = sc * p[o + 5] + (stl.z || 0), cz = sc * p[o + 8] + (stl.z || 0);
      if (ay < stlMinY) stlMinY = ay; if (ay > stlMaxY) stlMaxY = ay;
      if (by < stlMinY) stlMinY = by; if (by > stlMaxY) stlMaxY = by;
      if (cy < stlMinY) stlMinY = cy; if (cy > stlMaxY) stlMaxY = cy;
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1; ny /= len; void nx; void nz;
      if (Math.abs(ny) > 0.85 && ny < 0) downFaceY.push((ay + by + cy) / 3);
    }
  }
  const floorY = stlMinY;
  let ceilingY = stlMaxY;
  if (downFaceY.length > 0) {
    downFaceY.sort((a, b) => a - b);
    const med = downFaceY[downFaceY.length >> 1];
    if (med - floorY >= 1.0) ceilingY = med;
  }
  return {
    inside, total: mask.length,
    pct: (100 * inside) / mask.length,
    floorY, ceilingY,
  };
}
