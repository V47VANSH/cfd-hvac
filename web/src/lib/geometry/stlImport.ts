/**
 * STL import — parse the file, extract triangle positions, convert to a
 * scene-ready `STLObject`.
 *
 * Tier-1 voxelization is AABB-based, so the actual triangle list is only
 * needed for visualization. We still keep the full positions array on the
 * STLObject so that a future Tier-2 backend (or a more careful Tier-1
 * voxelizer) can use the geometry.
 *
 * Supports both ASCII and binary STL via three.js's `STLLoader`. We don't
 * import the loader at module top-level so it stays out of the initial
 * bundle — it's lazy-loaded the first time the user opens the file picker.
 */

import type { STLObject } from "@/lib/io/schema";

export interface ParseSTLOptions {
  /**
   * If true, treat the STL as the room boundary (not an interior object).
   * Disables the auto-shrink-to-1m heuristic — rooms must stay at their
   * authored real-world scale — and places the mesh with min-Y on the
   * floor (Y=0) and (X,Z) midpoint at the world origin.
   */
  asRoom?: boolean;
}

/** Returns one STLObject populated with parsed triangle vertices. */
export async function parseSTLFile(
  file: File, idHint = 1, opts: ParseSTLOptions = {},
): Promise<STLObject> {
  const buf = await file.arrayBuffer();
  // Lazy-load the STL parser
  const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
  const loader = new STLLoader();
  const geo = loader.parse(buf);

  const positions = geo.attributes.position?.array;
  if (!positions) throw new Error("STL: no position attribute parsed");
  const arr = positions instanceof Float32Array
    ? new Float32Array(positions)
    : Float32Array.from(positions as ArrayLike<number>);
  const triCount = Math.floor(arr.length / 9);

  const bbox = computeBBox(arr);
  const sx = bbox.maxX - bbox.minX;
  const sy = bbox.maxY - bbox.minY;
  const sz = bbox.maxZ - bbox.minZ;
  const longest = Math.max(sx, sy, sz);

  let scale: number;
  let cx = 0, cy = 0, cz = 0;
  if (opts.asRoom) {
    // Rooms stay at authored real-world scale. We do NOT fit to 1 m. If the
    // STL was authored in mm, the user will dial in scale=0.001 in the
    // sidebar; we can't guess that without inspecting the raw vertex range.
    // For sanity we still flag wildly-out-of-bounds rooms (>50 m) by
    // scaling them down to a 10 m envelope and letting the user notice.
    scale = longest > 50 ? 10.0 / longest : 1.0;
    // Centre on origin (X,Z) and rest the floor of the bbox on Y=0.
    // World position offsets are post-scale (mesh.position is applied
    // after mesh.scale in three.js), so we multiply by `scale` here.
    cx = -scale * 0.5 * (bbox.minX + bbox.maxX);
    cy = -scale * bbox.minY;
    cz = -scale * 0.5 * (bbox.minZ + bbox.maxZ);
  } else {
    // Obstacle: fit the longest side to ≈1 m if the source is huge or tiny.
    scale = longest > 0 ? Math.min(2.0, Math.max(0.05, 1.0 / longest)) : 1.0;
  }

  return {
    id: idHint,
    name: file.name.replace(/\.stl$/i, ""),
    x: cx, y: cy, z: cz,
    scale,
    ry_deg: 0, rx_deg: 0, rz_deg: 0,
    triCount,
    positions: arr,
    role: opts.asRoom ? "room" : "obstacle",
    bbox,
  };
}

interface BBox { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number; }

function computeBBox(arr: Float32Array): BBox {
  let minX = +Infinity, maxX = -Infinity;
  let minY = +Infinity, maxY = -Infinity;
  let minZ = +Infinity, maxZ = -Infinity;
  for (let i = 0; i < arr.length; i += 3) {
    const x = arr[i], y = arr[i + 1], z = arr[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}
