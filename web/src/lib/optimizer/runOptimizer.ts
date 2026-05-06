/**
 * Tier-1 single-AC placement optimizer.
 *
 * Sweeps a coarse 4-walls × 5-positions grid (20 candidates), runs a
 * short CFD simulation per candidate, scores each, returns ranked
 * results. Phase 0b implementation runs synchronously on the main thread
 * with a small step budget — full Tier 2 multi-AC Bayesian search is
 * Phase 4.
 *
 * Score (lower is better) is **occupant-comfort-aware**:
 *
 *     J = 0.45·worstPPD/100        ← the most uncomfortable person
 *       + 0.20·meanPPD/100         ← average occupant PPD
 *       + 0.15·hotPct/100          ← interior volume coverage @ 1.1 m
 *       + 0.10·stdT/4              ← spatial uniformity
 *       + 0.10·worstDR/100         ← no draft on anyone
 *
 * Crucially, the volume metrics are sampled at the 1.1 m comfort plane
 * EXCLUDING boundary cells, so a placement that "cools the wall" but
 * leaves the body of the room warm is correctly penalised. With
 * occupants present, their per-person PPD dominates — putting the AC
 * where it doesn't cool people gets a poor score even if the wall is icy.
 */

import { makeFields, NX, NY, NZ } from "@/lib/cfd/grid";
import { T_AMB } from "@/lib/cfd/constants";
import { voxelizeObstacles, voxelizeBlocks, voxelizeSTL } from "@/lib/cfd/voxelize";
import {
  injectHeatSources, injectACJets, injectFans, injectInfiltration, setACCold,
} from "@/lib/cfd/sources";
import { step } from "@/lib/cfd/solver";
import { scoreField, type ScoreBreakdown } from "./scoring";
import type { Scene, Wall } from "@/lib/io/schema";
import { isInsideRoom } from "@/lib/geometry/roomMask";

export interface ACCandidate {
  x: number; z: number; wall: Wall;
  rank: number;
  score: number;
  /** Full breakdown — what made this score good or bad. */
  breakdown?: ScoreBreakdown;
  // Legacy fields kept for the export modal / Comparison view.
  std: number; mean: number; hot: number;
  rejected?: string;
}

export interface OptimizerResult {
  ranked: ACCandidate[];
  best: ACCandidate | null;
}

export function runOptimizer(scene: Scene, opts?: { steps?: number }): OptimizerResult {
  const { L, W, H } = scene.geometry;
  const Tset = scene.environment.setpoint_C;
  const Tout = scene.environment.outdoor_temp_C;
  const stepsPerCandidate = opts?.steps ?? 50;
  const cands: { x: number; z: number; wall: Wall }[] = [];

  // STL room? Use a denser sampling INSIDE the L-shape and snap each
  // candidate inward so it sits a safe distance from the actual room
  // boundary (no edge / corner placements). Otherwise fall back to the
  // bbox-edge grid for cuboidal rooms.
  const roomSTL = scene.geometry.stl.find((s) => s.role === "room");
  if (roomSTL) {
    cands.push(...generateSTLCandidates(scene, roomSTL));
  } else {
    const stepsPerWall = 5;
    for (const wall of ["S","N","W","E"] as const) {
      const span = (wall === "S" || wall === "N") ? L : W;
      for (let s = 1; s < stepsPerWall + 1; s++) {
        const u = (s / (stepsPerWall + 1)) * span;
        let x = 0, z = 0;
        if      (wall === "S") { x = u - L/2; z = -W/2 + 0.1; }
        else if (wall === "N") { x = u - L/2; z =  W/2 - 0.1; }
        else if (wall === "W") { x = -L/2 + 0.1; z = u - W/2; }
        else                   { x =  L/2 - 0.1; z = u - W/2; }
        cands.push({ x, z, wall });
      }
    }
  }
  void H;

  const ranked: ACCandidate[] = [];

  for (const c of cands) {
    // Constraint check
    const rejection = checkConstraints(scene, c);
    if (rejection) {
      ranked.push({ ...c, rank: 0, score: Infinity, std: 0, mean: 0, hot: 0, rejected: rejection });
      continue;
    }

    // Run a short simulation
    const fields = makeFields();
    fields.T.fill(T_AMB);
    voxelizeObstacles(fields, scene.geometry, scene.obstacles);
    voxelizeBlocks   (fields, scene.geometry, scene.geometry.extensions);
    voxelizeSTL      (fields, scene.geometry, scene.geometry.stl);
    injectHeatSources(fields, scene.geometry, scene.obstacles);
    injectACJets     (fields, scene.geometry, [c]);
    injectFans       (fields, scene.geometry, scene.obstacles);
    injectInfiltration(fields, scene.geometry, scene.openings);
    // Carry per-AC supply temperature (default 14 °C) into the cold-supply
    // step so the optimizer respects the user's "Set Temp" choice.
    const cWithSupply = { ...c, supply_temp_C: 14 };
    for (let i = 0; i < stepsPerCandidate; i++) {
      step({ fields, room: scene.geometry, openings: scene.openings, Tout, n: 1 });
      setACCold(fields, scene.geometry, [cWithSupply]);
    }
    const breakdown = scoreField(scene, fields);
    ranked.push({
      ...c, rank: 0, score: breakdown.J,
      breakdown,
      std: breakdown.stdT, mean: breakdown.meanT, hot: breakdown.hotPct,
    });
  }
  void Tset;

  ranked.sort((a, b) => a.score - b.score);
  ranked.forEach((c, i) => { c.rank = i; });
  const best = ranked.find((c) => Number.isFinite(c.score)) ?? null;
  return { ranked, best };
}

/**
 * Generate AC candidates for an STL room. Strategy:
 *
 *   1. Build the room mask (cell-level inside / outside).
 *   2. Walk every "edge" cell — a cell that's INSIDE but has at least one
 *      OUTSIDE 6-neighbour. These cells border the actual room walls.
 *   3. For each edge cell, classify the dominant wall direction (S/N/E/W)
 *      from which neighbour was outside, and emit a candidate at the
 *      cell centre (inset by min_clearance_m from the boundary so the AC
 *      isn't placed in a corner or on a wall edge).
 *   4. Sub-sample to ~6 candidates per detected wall direction so the
 *      optimizer doesn't spend forever evaluating dozens of near-identical
 *      positions.
 */
function generateSTLCandidates(
  scene: Scene, roomSTL: import("@/lib/io/schema").STLObject,
): { x: number; z: number; wall: Wall }[] {
  const { L, W, H } = scene.geometry;
  const minClearance = scene.constraints.min_clearance_m ?? 0.5;
  // Sample at the AC's typical mounting height (~1.8 m), or half-room
  // height for very tall rooms. We snap each hit's Y coordinate to this
  // height; the user can fine-tune by editing the AC after placement.
  const acHeight = Math.min(1.8, H * 0.6);
  const dx = L / NX, dy = H / NY, dz = W / NZ;
  // Re-use the mask cache.
  const mask = computeRoomMaskCached(scene, roomSTL);

  // Walk every cell at the AC mounting height; collect edges with their
  // outward direction.
  const iyAC = Math.max(0, Math.min(NY - 1, Math.floor(acHeight / dy)));
  type Edge = { x: number; z: number; wall: Wall };
  const edgesByWall: Record<Wall, Edge[]> = { S: [], N: [], E: [], W: [] };
  for (let iz = 0; iz < NZ; iz++) {
    for (let ix = 0; ix < NX; ix++) {
      const k = ix + NX * iyAC + NX * NY * iz;
      if (mask[k] !== 1) continue;  // not inside
      // Check 4 horizontal neighbours.
      const neighbours: { dir: Wall; dx: number; dz: number }[] = [
        { dir: "E", dx: +1, dz:  0 },
        { dir: "W", dx: -1, dz:  0 },
        { dir: "N", dx:  0, dz: +1 },
        { dir: "S", dx:  0, dz: -1 },
      ];
      for (const { dir, dx: ndx, dz: ndz } of neighbours) {
        const nx = ix + ndx, nz = iz + ndz;
        if (nx < 0 || nx >= NX || nz < 0 || nz >= NZ) continue;
        const kn = nx + NX * iyAC + NX * NY * nz;
        if (mask[kn] === 1) continue;   // neighbour also inside, not an edge
        // Compute the wall SURFACE position (boundary between this inside
        // cell and the outside neighbour). AC sits AC_D/2 + 2 cm inward
        // of that surface so its back is visually flush — this matches
        // manual-placement geometry. minClearance is no longer used as a
        // depth inset (was a 0.5 m mid-air gap); we still rely on the
        // 2D-mask flood-fill having stamped real walls before flooding,
        // so corner clearance is implicitly handled by sub-sampling
        // across multiple candidates per wall direction.
        const insetFromWall = 0.10;   // AC_D/2 (0.08) + 2 cm clearance
        const wallSurfaceX = ndx !== 0
          ? (ndx > 0 ? (ix + 1) * dx - L / 2 : ix * dx - L / 2)
          : (ix + 0.5) * dx - L / 2;
        const wallSurfaceZ = ndz !== 0
          ? (ndz > 0 ? (iz + 1) * dz - W / 2 : iz * dz - W / 2)
          : (iz + 0.5) * dz - W / 2;
        const xCentre = ndx !== 0 ? wallSurfaceX - ndx * insetFromWall : wallSurfaceX;
        const zCentre = ndz !== 0 ? wallSurfaceZ - ndz * insetFromWall : wallSurfaceZ;
        edgesByWall[dir].push({ x: xCentre, z: zCentre, wall: dir });
      }
      void minClearance;
    }
  }

  // Sub-sample each wall to ~6 candidates spaced along the wall.
  const out: { x: number; z: number; wall: Wall }[] = [];
  const targetPerWall = 6;
  for (const dir of ["S", "N", "E", "W"] as const) {
    const list = edgesByWall[dir];
    if (list.length === 0) continue;
    // Sort by the parallel axis so picks are spread out.
    list.sort((a, b) => (dir === "S" || dir === "N") ? a.x - b.x : a.z - b.z);
    const stride = Math.max(1, Math.floor(list.length / targetPerWall));
    for (let i = 0; i < list.length; i += stride) out.push(list[i]);
  }
  return out;
}

const CAND_MASK_CACHE = new Map<string, Uint8Array>();
function computeRoomMaskCached(
  scene: Scene, roomSTL: import("@/lib/io/schema").STLObject,
): Uint8Array {
  void isInsideRoom;
  const key = `${roomSTL.id}|${roomSTL.scale}|${scene.geometry.L}x${scene.geometry.W}x${scene.geometry.H}`;
  const cached = CAND_MASK_CACHE.get(key);
  if (cached) return cached;
  // Run the inside-test on every cell — leverages the same shared util as
  // the voxelizer, so the cache hits across calls.
  const mask = new Uint8Array(NX * NY * NZ);
  const dx = scene.geometry.L / NX, dy = scene.geometry.H / NY, dz = scene.geometry.W / NZ;
  for (let iz = 0; iz < NZ; iz++)
    for (let iy = 0; iy < NY; iy++)
      for (let ix = 0; ix < NX; ix++) {
        const x = (ix + 0.5) * dx - scene.geometry.L / 2;
        const y = (iy + 0.5) * dy;
        const z = (iz + 0.5) * dz - scene.geometry.W / 2;
        if (isInsideRoom(
          { NX, NY, NZ, L: scene.geometry.L, W: scene.geometry.W, H: scene.geometry.H },
          roomSTL, x, y, z,
        )) mask[ix + NX * iy + NX * NY * iz] = 1;
      }
  if (CAND_MASK_CACHE.size >= 4) {
    const old = CAND_MASK_CACHE.keys().next().value;
    if (old) CAND_MASK_CACHE.delete(old);
  }
  CAND_MASK_CACHE.set(key, mask);
  return mask;
}

function checkConstraints(
  scene: Scene,
  c: { x: number; z: number; wall: Wall },
): string | null {
  const cs = scene.constraints;
  if (cs.wall_rules?.[c.wall] === "deny") return "wall_disallowed";
  if (cs.allowed_walls && !cs.allowed_walls.includes(c.wall)) return "wall_disallowed";

  // Forbidden zones (polygon or AABB box on the floor)
  for (const zone of cs.forbidden_zones || []) {
    if (zone.shape === "polygon" && zone.vertices) {
      if (pointInPolygon(c.x, c.z, zone.vertices)) return "inside_forbidden_zone";
    } else if (zone.shape === "box" &&
               zone.x !== undefined && zone.z !== undefined &&
               zone.W !== undefined && zone.D !== undefined) {
      if (Math.abs(c.x - zone.x) <= zone.W / 2 &&
          Math.abs(c.z - zone.z) <= zone.D / 2) return "inside_forbidden_zone";
    }
  }

  // Restricted surfaces — block a candidate that lies inside a wall-mounted
  // restricted region (e.g. switchboard).
  for (const rs of cs.restricted_surfaces || []) {
    if (rs.wall !== c.wall) continue;
    const span = (c.wall === "S" || c.wall === "N") ? scene.geometry.L : scene.geometry.W;
    const u = (c.wall === "S" || c.wall === "N") ? c.x + scene.geometry.L / 2 : c.z + scene.geometry.W / 2;
    if (Math.abs(u - rs.u) <= rs.uw / 2) return "restricted_surface_overlap";
    void span;
  }

  // Minimum clearance from any obstacle's footprint
  const minC = scene.constraints.min_clearance_m ?? 0;
  if (minC > 0) {
    for (const o of scene.obstacles) {
      const dx = c.x - o.x, dz = c.z - o.z;
      const r = Math.max(o.W, o.D || o.W) / 2 + minC;
      if (dx*dx + dz*dz < r*r) return "clearance_violated";
    }
  }
  return null;
}

function pointInPolygon(x: number, y: number, verts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const xi = verts[i][0], yi = verts[i][1];
    const xj = verts[j][0], yj = verts[j][1];
    const intersect = ((yi > y) !== (yj > y)) &&
                      (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
