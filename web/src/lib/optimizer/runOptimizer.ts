/**
 * Tier-1 single-AC placement optimizer.
 *
 * Sweeps a coarse 4-walls × 5-positions grid (20 candidates), runs a
 * short CFD simulation per candidate, scores each, returns ranked
 * results. Phase 0b implementation runs synchronously on the main thread
 * with a small step budget — full Tier 2 multi-AC Bayesian search is
 * Phase 4.
 *
 * Score (lower is better, matching PLAN.md §5):
 *   J = 0.40·mean(PPD) + 0.30·max(DR) + 0.20·std(T) + 0.10·max(0, mean−Tset)
 *
 * Phase 0b doesn't yet have PMV/PPD/DR (Phase 1), so we use a v6-style
 * proxy until then:
 *   J = 0.55·std(T) + 0.30·max(0, mean−Tset) + 0.12·hot%
 */

import { makeFields } from "@/lib/cfd/grid";
import { T_AMB } from "@/lib/cfd/constants";
import { voxelizeObstacles, voxelizeBlocks, voxelizeSTL } from "@/lib/cfd/voxelize";
import {
  injectHeatSources, injectACJets, injectFans, injectInfiltration, setACCold,
} from "@/lib/cfd/sources";
import { step, metrics } from "@/lib/cfd/solver";
import type { Scene, Wall } from "@/lib/io/schema";

export interface ACCandidate {
  x: number; z: number; wall: Wall;
  rank: number;
  score: number;
  std: number; mean: number; hot: number;
  rejected?: string;
}

export interface OptimizerResult {
  ranked: ACCandidate[];
  best: ACCandidate | null;
}

export function runOptimizer(scene: Scene, opts?: { steps?: number }): OptimizerResult {
  const { L, W } = scene.geometry;
  const Tset = scene.environment.setpoint_C;
  const Tout = scene.environment.outdoor_temp_C;
  const stepsPerCandidate = opts?.steps ?? 50;
  const cands: { x: number; z: number; wall: Wall }[] = [];
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
    for (let i = 0; i < stepsPerCandidate; i++) {
      step({ fields, room: scene.geometry, openings: scene.openings, Tout, n: 1 });
      setACCold(fields, scene.geometry, [c]);
    }
    const m = metrics(fields, Tset);
    const J = 0.55 * m.std
            + 0.30 * Math.max(0, m.mean - Tset)
            + 0.12 * m.hot;
    ranked.push({
      ...c, rank: 0, score: J,
      std: m.std, mean: m.mean, hot: m.hot,
    });
  }

  ranked.sort((a, b) => a.score - b.score);
  ranked.forEach((c, i) => { c.rank = i; });
  const best = ranked.find((c) => Number.isFinite(c.score)) ?? null;
  return { ranked, best };
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
