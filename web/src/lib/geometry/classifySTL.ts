/**
 * Auto-classify STL triangles into room patches (floor / ceiling / S,N,E,W walls / other)
 * by inspecting per-triangle normal direction and centroid position.
 *
 * Used when an STL is imported as the room boundary (role==="room"). The
 * classification powers two things:
 *   1. **Patch-aware rendering** — each patch can be tinted, hidden, or
 *      replaced with picker hit-tests independently of the rest.
 *   2. **Tier-2 case generator (day-4)** — snappyHexMesh needs each patch
 *      as a separate triSurface region so OpenFOAM creates per-patch
 *      boundary conditions (`floor`, `ceiling`, `wall_S/N/E/W`, etc.).
 *
 * Heuristics (tuned for axis-aligned rooms exported from CAD tools — the
 * common case in HVAC consulting):
 *
 *   • Triangles whose normal is dominantly +Y AND whose centroid sits in
 *     the LOWEST `floorBandFrac` of the bbox height → `floor`.
 *   • Triangles whose normal is dominantly -Y AND whose centroid sits in
 *     the HIGHEST `roofBandFrac` of the bbox height → `roof`/`ceiling`.
 *   • Triangles whose normal is dominantly horizontal — split by which
 *     cardinal direction it faces (S = -Z, N = +Z, E = +X, W = -X).
 *     Further split into `exterior` (centroid on the bbox edge ± `edgeTol`)
 *     vs `interior` (inside the bbox — partition wall, alcove face).
 *   • Everything not in those buckets (sloped, low-up-facing surfaces in
 *     the middle of the room — i.e. stair treads, chimney sides, cabinetry
 *     tops) → `other` (treated as interior obstacle, NOT a room boundary).
 *
 * The classifier returns triangle indices, not vertex copies. The
 * caller can render per-patch by assembling a sub-Float32Array, or pass
 * indices into snappy's `surfaceMeshToSurfaceMeshDict` for Tier 2.
 */

import type { STLObject } from "@/lib/io/schema";

export type PatchKey =
  | "floor" | "roof"
  | "wall_S" | "wall_N" | "wall_E" | "wall_W"
  | "above_roof"   // chimney sides, dormer walls — vertical surfaces above the main ceiling Y
  | "obstacle";    // up/down-facing surfaces in the middle of the room (steps, cabinetry, …)

export interface PatchInfo {
  /** Triangle indices into the STL position array. Triangle i occupies
   *  positions[9*i .. 9*i+8]. Use {@link extractPatchTriangles} to
   *  materialise the geometry. */
  triangleIndices: number[];
  /** Average outward normal of the patch (useful for placing labels / arrows). */
  meanNormal: { x: number; y: number; z: number };
  /** Centroid of the patch in world space (post-scale, post-translate). */
  meanCentroid: { x: number; y: number; z: number };
}

export interface ClassifyOptions {
  /**
   * Vertical tolerance (world metres) around the auto-detected floor / ceiling
   * Y values. Up-facing triangles within `bandTolM` of the floor Y are floor;
   * down-facing within `bandTolM` of the ceiling Y are roof. Default 0.20 m
   * (handles slight surface relief — wood-grain, lintels, suspended-tile
   * frames — without over-grouping).
   */
  bandTolM?: number;
  /** Triangles steeper than this (|n.y| > axisThreshold) count as floor/ceiling. */
  axisThreshold?: number;
  /** Triangles flatter than (|n.y| < horizontalThreshold) AND with one
   *  horizontal component dominant count as walls. */
  horizontalThreshold?: number;
  /**
   * Override the auto-detected ceiling Y in world metres. Useful when the
   * STL has a chimney/dormer that confuses the median-Y detector — the
   * caller can read the user's `geometry.H` and pass it here.
   */
  ceilingYOverride?: number;
}

export interface ClassificationResult {
  /** Map from PatchKey to patch info. Missing keys = empty patches. */
  patches: Partial<Record<PatchKey, PatchInfo>>;
  /** Bounding box of the room in WORLD METRES (post-scale, post-translate). */
  bboxWorld: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  /** Total triangle count seen by the classifier. */
  triCount: number;
  /** Auto-detected floor / ceiling Y in world metres. */
  floorY:   number;
  ceilingY: number;
}

const DEFAULTS: Required<ClassifyOptions> = {
  bandTolM: 0.20,
  axisThreshold: 0.85,
  horizontalThreshold: 0.30,
  ceilingYOverride: NaN,
};

/** Median of a flat numeric array. Mutates the input. Empty → 0. */
function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  arr.sort((a, b) => a - b);
  const mid = arr.length >> 1;
  return arr.length % 2 ? arr[mid] : 0.5 * (arr[mid - 1] + arr[mid]);
}

/** Run the classifier. Returns per-patch triangle indices. */
export function classifySTL(stl: STLObject, opts: ClassifyOptions = {}): ClassificationResult {
  const o = { ...DEFAULTS, ...opts };
  const positions = stl.positions;
  if (!positions || positions.length < 9) {
    return { patches: {}, bboxWorld: zeroBox(), triCount: 0, floorY: 0, ceilingY: 0 };
  }
  const nTris = Math.floor(positions.length / 9);
  const s = stl.scale || 1;
  const xOff = stl.x, yOff = stl.y, zOff = stl.z;
  const toWorld = (x: number, y: number, z: number) => ({
    x: s * x + xOff, y: s * y + yOff, z: s * z + zOff,
  });

  // First pass: bbox + per-triangle centroid + world normal.
  // We cache so the second pass (after we've inferred floorY / ceilingY)
  // doesn't recompute everything.
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  // Per-tri caches — flat for memory locality.
  const cxs = new Float32Array(nTris);
  const cys = new Float32Array(nTris);
  const czs = new Float32Array(nTris);
  const nxs = new Float32Array(nTris);
  const nys = new Float32Array(nTris);
  const nzs = new Float32Array(nTris);
  // Y range per triangle — needed to decide which walls span [floor, ceiling].
  const yMins = new Float32Array(nTris);
  const yMaxs = new Float32Array(nTris);

  // Running collections for ceiling-Y inference.
  const downFacingY: number[] = [];
  const upFacingY: number[] = [];

  for (let t = 0; t < nTris; t++) {
    const i = t * 9;
    const a = toWorld(positions[i],   positions[i+1], positions[i+2]);
    const b = toWorld(positions[i+3], positions[i+4], positions[i+5]);
    const c = toWorld(positions[i+6], positions[i+7], positions[i+8]);
    if (a.x < minX) minX = a.x; if (a.x > maxX) maxX = a.x;
    if (b.x < minX) minX = b.x; if (b.x > maxX) maxX = b.x;
    if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x;
    if (a.y < minY) minY = a.y; if (a.y > maxY) maxY = a.y;
    if (b.y < minY) minY = b.y; if (b.y > maxY) maxY = b.y;
    if (c.y < minY) minY = c.y; if (c.y > maxY) maxY = c.y;
    if (a.z < minZ) minZ = a.z; if (a.z > maxZ) maxZ = a.z;
    if (b.z < minZ) minZ = b.z; if (b.z > maxZ) maxZ = b.z;
    if (c.z < minZ) minZ = c.z; if (c.z > maxZ) maxZ = c.z;

    const cy = (a.y + b.y + c.y) / 3;
    cxs[t] = (a.x + b.x + c.x) / 3;
    cys[t] = cy;
    czs[t] = (a.z + b.z + c.z) / 3;
    yMins[t] = Math.min(a.y, b.y, c.y);
    yMaxs[t] = Math.max(a.y, b.y, c.y);

    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    nxs[t] = nx; nys[t] = ny; nzs[t] = nz;

    if (Math.abs(ny) > o.axisThreshold) {
      if (ny < 0) downFacingY.push(cy);
      else        upFacingY.push(cy);
    }
  }

  // Floor Y — almost always min Y of the bbox in practice. We cross-check
  // against the median of up-facing centroids: if the median is much higher
  // (e.g. the user authored with the floor sunk into a slab of negative Y),
  // we trust the median.
  let floorY = minY;
  if (upFacingY.length > 0) {
    const medUp = median([...upFacingY]);
    // Tolerate up to 0.5 m of floor relief / sub-floor before overriding.
    if (medUp - minY > 0.5) floorY = medUp;
  }

  // Ceiling Y — robust median of down-facing centroids. This handles
  // chimneys / dormers correctly: the chimney's down-facing top accounts
  // for at most a few triangles, so the median tracks the dominant
  // ceiling plane (~2.7 m) instead of being dragged up to the chimney peak.
  let ceilingY: number;
  if (!Number.isNaN(o.ceilingYOverride)) {
    ceilingY = o.ceilingYOverride;
  } else if (downFacingY.length > 0) {
    ceilingY = median([...downFacingY]);
  } else {
    // No down-facing surfaces at all (open-top STL) — fall back to bbox top.
    ceilingY = maxY;
  }
  // Sanity: ceiling must be at least 1 m above floor; if median collapsed
  // to a low value (rare; happens if the model has many low overhangs),
  // fall back to the highest tight cluster. For now use a simple guard.
  if (ceilingY - floorY < 1.0) ceilingY = Math.max(floorY + 1.0, maxY * 0.6);

  // Working buckets
  type Bucket = { idx: number[]; nx: number; ny: number; nz: number; cx: number; cy: number; cz: number };
  const mk = (): Bucket => ({ idx: [], nx: 0, ny: 0, nz: 0, cx: 0, cy: 0, cz: 0 });
  const buckets: Record<PatchKey, Bucket> = {
    floor: mk(), roof: mk(),
    wall_S: mk(), wall_N: mk(), wall_E: mk(), wall_W: mk(),
    above_roof: mk(), obstacle: mk(),
  };

  for (let t = 0; t < nTris; t++) {
    const cx = cxs[t], cy = cys[t], cz = czs[t];
    const nx = nxs[t], ny = nys[t], nz = nzs[t];
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);

    let key: PatchKey = "obstacle";
    if (ay > o.axisThreshold) {
      // Up-or-down-facing
      if (ny > 0 && Math.abs(cy - floorY) < o.bandTolM)        key = "floor";
      else if (ny < 0 && Math.abs(cy - ceilingY) < o.bandTolM) key = "roof";
      else key = "obstacle"; // step top, cabinet bottom, chimney cap
    } else if (ay < o.horizontalThreshold) {
      // Wall-facing — classify into S/N/E/W only if the triangle sits
      // wholly within the room envelope [floorY, ceilingY] (plus tol).
      // Vertical surfaces above the ceiling = chimney / dormer.
      const aboveRoof = yMins[t] > ceilingY + o.bandTolM;
      if (aboveRoof) {
        key = "above_roof";
      } else if (ax > az) {
        key = nx > 0 ? "wall_E" : "wall_W";
      } else {
        // Project compass: S = -Z, N = +Z
        key = nz > 0 ? "wall_N" : "wall_S";
      }
    }

    const bk = buckets[key];
    bk.idx.push(t);
    bk.nx += nx; bk.ny += ny; bk.nz += nz;
    bk.cx += cx; bk.cy += cy; bk.cz += cz;
  }

  const patches: Partial<Record<PatchKey, PatchInfo>> = {};
  for (const [k, bk] of Object.entries(buckets) as [PatchKey, Bucket][]) {
    if (bk.idx.length === 0) continue;
    const n = bk.idx.length;
    patches[k] = {
      triangleIndices: bk.idx,
      meanNormal:   { x: bk.nx / n, y: bk.ny / n, z: bk.nz / n },
      meanCentroid: { x: bk.cx / n, y: bk.cy / n, z: bk.cz / n },
    };
  }

  return {
    patches,
    bboxWorld: { minX, maxX, minY, maxY, minZ, maxZ },
    triCount: nTris,
    floorY, ceilingY,
  };
}

/** Materialise a single patch's geometry into a fresh Float32Array of vertex
 *  coordinates (3 verts × 3 coords per triangle). Vertices are in MODEL space
 *  (the same space stl.positions uses), so the caller can apply the same
 *  scale + transform as the parent STL mesh. */
export function extractPatchTriangles(stl: STLObject, indices: number[]): Float32Array {
  if (!stl.positions) return new Float32Array(0);
  const out = new Float32Array(indices.length * 9);
  for (let k = 0; k < indices.length; k++) {
    const src = indices[k] * 9;
    const dst = k * 9;
    for (let j = 0; j < 9; j++) out[dst + j] = stl.positions[src + j];
  }
  return out;
}

function zeroBox() {
  return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
}

/** Pretty-print a patch summary table (text). Useful for debugging /
 *  for the sidebar's "STL Patches" panel. */
export function summarizePatches(r: ClassificationResult): string {
  const lines: string[] = [];
  lines.push(`triangles: ${r.triCount}`);
  lines.push(`bbox (m): X[${r.bboxWorld.minX.toFixed(2)}, ${r.bboxWorld.maxX.toFixed(2)}] ` +
             `Y[${r.bboxWorld.minY.toFixed(2)}, ${r.bboxWorld.maxY.toFixed(2)}] ` +
             `Z[${r.bboxWorld.minZ.toFixed(2)}, ${r.bboxWorld.maxZ.toFixed(2)}]`);
  lines.push("patch        | tris | mean normal");
  for (const k of [
    "floor", "roof",
    "wall_S", "wall_N", "wall_E", "wall_W",
    "wall_S_int", "wall_N_int", "wall_E_int", "wall_W_int",
    "other",
  ] as PatchKey[]) {
    const p = r.patches[k]; if (!p) continue;
    const n = p.meanNormal;
    lines.push(`${k.padEnd(12)} | ${String(p.triangleIndices.length).padStart(4)} | ` +
               `(${n.x.toFixed(2)}, ${n.y.toFixed(2)}, ${n.z.toFixed(2)})`);
  }
  return lines.join("\n");
}
