/**
 * Optimizer scoring functions.
 *
 * The legacy optimizer scored on `metrics()` which averages over EVERY
 * fluid cell, including boundary cells. Boundary cells are held at wall
 * temperature, so they dominate `mean(T)` and `std(T)` — the optimizer
 * ends up rewarding placements that "cool the wall", not the body of the
 * room or the people in it.
 *
 * This module provides comfort-aware scoring that:
 *   1. Excludes boundary cells from the volume mean/std
 *   2. Samples specifically at the 1.1 m comfort plane (head height)
 *   3. Adds a per-occupant penalty: the worst-case PPD across all
 *      `human` obstacles. One uncomfortable occupant ruins the score.
 *   4. Penalises hot zones in the room interior (away from walls).
 *
 * Used by the legacy collocated solver's optimizer (Phase 0b). The MAC
 * solver's optimizer in Phase 3 will use the same building blocks but
 * may add additional objectives (energy, draft, etc.).
 */

import { NX, NY, NZ, K, type GridFields, type RoomDims } from "@/lib/cfd/grid";
import type { Scene } from "@/lib/io/schema";
import { pmv, ppd as ppdFn, draftRisk } from "@/lib/comfort";

const COMFORT_HEIGHT_M = 1.1;        // head-height comfort plane

export interface ScoreBreakdown {
  /** Composite score; lower is better. */
  J: number;
  /** Pillar A — volume comfort, normalised. */
  pillarA: number;
  /** Pillar B — occupant comfort, normalised. */
  pillarB: number;
  /** Mean T at the 1.1 m comfort plane, °C — interior cells only */
  meanT: number;
  /** Std T at the 1.1 m comfort plane, °C — interior cells only */
  stdT: number;
  /** % of comfort-plane interior cells above setpoint+4 °C */
  hotPct: number;
  /** Vertical air-temperature difference (head 1.1 m − ankle 0.1 m), °C */
  verticalDeltaT: number;
  /** Worst-case PPD across all occupants. 0 if no occupants present. */
  worstPPD: number;
  /** Mean PPD across occupants (or volumetric proxy if no occupants). */
  meanPPD: number;
  /** Max draft risk across occupants. */
  worstDR: number;
  /** Number of occupants used in the per-person score. */
  occupantCount: number;
}

/**
 * Compute the optimizer score from a fully-relaxed CFD field.
 *
 * **Two-pillar weighted sum** — both pillars are always normalised into
 * [0, 1] (lower = better), then combined.
 *
 *   Pillar A — Volume comfort (always evaluated).
 *
 *     A = 0.30 · |meanT − Tset| / 5                         ← setpoint distance
 *       + 0.25 · hotPct / 100                                ← coverage
 *       + 0.25 · stdT / 4                                    ← uniformity
 *       + 0.20 · max(0, |verticalΔT| − 3) / 3                ← ISO 7730 §6.3
 *
 *   Pillar B — Occupant comfort (only when humans are present).
 *
 *     B = 0.50 · worstPPD / 100                              ← worst-case rule
 *       + 0.30 · meanPPD  / 100                              ← average
 *       + 0.20 · worstDR  / 100                              ← no draft on anyone
 *
 *   Combined:
 *     J = α · A + (1 − α) · B
 *     α = 1.0  if no occupants
 *     α = 0.5  if occupants present
 *
 * The 0.5 weight when occupants are present means **the entire room
 * volume still drives half the score** — placements that cool only the
 * occupants but leave the rest of the room sweltering get penalised.
 *
 * Volume metrics are sampled at the 1.1 m comfort plane EXCLUDING the
 * boundary cells, so the score reflects what real occupants experience,
 * not boundary forcing.
 */
export function scoreField(scene: Scene, fields: GridFields): ScoreBreakdown {
  const env = scene.environment;
  const Tset = env.setpoint_C;
  const planeStats = comfortPlaneStats(fields, scene.geometry, Tset);
  const verticalDeltaT = computeVerticalDeltaT(fields, scene.geometry);

  // Pillar A — volume comfort (always)
  const A_setpoint = clamp01(Math.abs(planeStats.meanT - Tset) / 5);
  const A_coverage = clamp01(planeStats.hotPct / 100);
  const A_uniformity = clamp01(planeStats.stdT / 4);
  const A_stratification = clamp01(Math.max(0, Math.abs(verticalDeltaT) - 3) / 3);
  const A =
      0.30 * A_setpoint
    + 0.25 * A_coverage
    + 0.25 * A_uniformity
    + 0.20 * A_stratification;

  // Pillar B — occupant comfort (when humans present)
  const humans = scene.obstacles.filter((o) => o.shape === "human" && o.on !== false);
  let worstPPD = 0;
  let meanPPD  = 0;
  let worstDR  = 0;
  if (humans.length > 0) {
    let sumPPD = 0;
    for (const h of humans) {
      const sample = sampleAtOccupant(fields, scene, h);
      const p = pmv({
        ta: sample.T, tr: sample.T, vel: sample.V,
        rh: env.RH_outdoor_pct, met: env.met, clo: env.clo,
      });
      const pp = ppdFn(p);
      const dr = draftRisk(sample.T, sample.V);
      if (pp > worstPPD) worstPPD = pp;
      if (dr > worstDR)  worstDR  = dr;
      sumPPD += pp;
    }
    meanPPD = sumPPD / humans.length;
  } else {
    // No occupants: still report a plane-derived proxy for telemetry,
    // but Pillar B is dropped from the combined J via α=1.0.
    const avgPMV = pmv({
      ta: planeStats.meanT, tr: planeStats.meanT, vel: planeStats.meanV,
      rh: env.RH_outdoor_pct, met: env.met, clo: env.clo,
    });
    worstPPD = meanPPD = ppdFn(avgPMV);
    worstDR  = draftRisk(planeStats.meanT, planeStats.meanV);
  }
  const B =
      0.50 * (worstPPD / 100)
    + 0.30 * (meanPPD  / 100)
    + 0.20 * (worstDR  / 100);

  const alpha = humans.length > 0 ? 0.5 : 1.0;
  const J = alpha * A + (1 - alpha) * B;

  return {
    J,
    meanT: planeStats.meanT,
    stdT:  planeStats.stdT,
    hotPct: planeStats.hotPct,
    verticalDeltaT,
    worstPPD, meanPPD, worstDR,
    pillarA: A, pillarB: B,
    occupantCount: humans.length,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Stats over the 1.1 m comfort plane, **excluding** the cells immediately
 * adjacent to walls/floor/ceiling. Those cells are dominated by boundary
 * conditions and don't reflect what real occupants experience.
 */
function comfortPlaneStats(
  fields: GridFields, room: RoomDims, Tset: number,
): { meanT: number; meanV: number; stdT: number; hotPct: number } {
  const dy = room.H / NY;
  const iy = Math.max(1, Math.min(NY - 2, Math.round(COMFORT_HEIGHT_M / dy - 0.5)));
  // Inset by one cell on every side to skip the boundary layer
  let sumT = 0, sumT2 = 0, sumV = 0, n = 0, hot = 0;
  for (let iz = 1; iz < NZ - 1; iz++)
    for (let ix = 1; ix < NX - 1; ix++) {
      const k = K(ix, iy, iz);
      if (fields.wall[k]) continue;
      const T = fields.T[k];
      const Vx = fields.Vx[k], Vy = fields.Vy[k], Vz = fields.Vz[k];
      const V = Math.sqrt(Vx * Vx + Vy * Vy + Vz * Vz);
      sumT += T; sumT2 += T * T; sumV += V; n++;
      if (T > Tset + 4) hot++;
    }
  const meanT = n > 0 ? sumT / n : Tset;
  const meanV = n > 0 ? sumV / n : 0;
  const std   = n > 0 ? Math.sqrt(Math.max(0, sumT2 / n - meanT * meanT)) : 0;
  return { meanT, meanV, stdT: std, hotPct: n > 0 ? (hot / n) * 100 : 0 };
}

/** ISO 7730 §6.3 stratification: head (1.1 m) − ankle (0.1 m) plane mean. */
function computeVerticalDeltaT(fields: GridFields, room: RoomDims): number {
  const dy = room.H / NY;
  const iyAnkle = Math.max(0, Math.min(NY - 1, Math.round(0.1 / dy - 0.5)));
  const iyHead  = Math.max(0, Math.min(NY - 1, Math.round(1.1 / dy - 0.5)));
  let sumA = 0, sumH = 0, n = 0;
  for (let iz = 1; iz < NZ - 1; iz++)
    for (let ix = 1; ix < NX - 1; ix++) {
      const ka = K(ix, iyAnkle, iz);
      const kh = K(ix, iyHead,  iz);
      if (fields.wall[ka] || fields.wall[kh]) continue;
      sumA += fields.T[ka]; sumH += fields.T[kh]; n++;
    }
  return n > 0 ? (sumH - sumA) / n : 0;
}

interface OccupantSample { T: number; V: number; }

/** Sample T and |V| in the 3×3×3 cube around an occupant's head. */
function sampleAtOccupant(
  fields: GridFields, scene: Scene, occ: { x: number; z: number; H: number; Yoff?: number },
): OccupantSample {
  const { L, W, H } = scene.geometry;
  const dx = L / NX, dy = H / NY, dz = W / NZ;
  const ox = Math.round((occ.x + L / 2) / dx);
  const yHead = (occ.Yoff || 0) + occ.H * 0.92;
  const oy = Math.max(1, Math.min(NY - 2, Math.round(yHead / dy)));
  const oz = Math.round((occ.z + W / 2) / dz);
  let sumT = 0, sumV = 0, n = 0;
  for (let dxi = -1; dxi <= 1; dxi++)
    for (let dyi = -1; dyi <= 1; dyi++)
      for (let dzi = -1; dzi <= 1; dzi++) {
        const ix = ox + dxi, iy = oy + dyi, iz = oz + dzi;
        if (ix < 0 || ix >= NX || iy < 0 || iy >= NY || iz < 0 || iz >= NZ) continue;
        const k = K(ix, iy, iz);
        if (fields.wall[k]) continue;
        const T = fields.T[k];
        const Vx = fields.Vx[k], Vy = fields.Vy[k], Vz = fields.Vz[k];
        const V = Math.sqrt(Vx * Vx + Vy * Vy + Vz * Vz);
        sumT += T; sumV += V; n++;
      }
  return n > 0 ? { T: sumT / n, V: sumV / n } : { T: 30, V: 0 };
}
