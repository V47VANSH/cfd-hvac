/**
 * Per-cell comfort scalars and aggregate summaries.
 *
 * These are pure functions over the snapshot fields plus a "comfort context"
 * (RH, met, clo, mean radiant T). They are reused by:
 *   - the wall/floor/ceiling overlay renderer (PMV/PPD/DR view modes)
 *   - the sidebar comfort panel
 *   - the PDF report (3-height summaries)
 *   - the comparison view (delta metrics)
 */

import { NX, NY, NZ, K } from "@/lib/cfd/grid";
import { pmv } from "./pmv";
import { ppd } from "./ppd";
import { draftRisk } from "./draftRisk";
import { operativeT } from "./operativeT";
import { iyForHeight, SAMPLE_HEIGHTS_M } from "./sampleHeights";

export interface ComfortContext {
  /** ambient indoor relative humidity, %. (Tier 1 uses outdoor RH as proxy.) */
  rh:  number;
  met: number;
  clo: number;
  /**
   * Mean radiant temperature, °C. Tier 1 has no radiative solver so we
   * approximate Trad as the spatial mean of all boundary cells; the caller
   * computes it once per snapshot.
   */
  tRad: number;
  /** turbulence intensity, % — ISO 7730 default 40 for mixing ventilation */
  tu?: number;
}

/** Build a ComfortContext from a Scene + a worker snapshot. */
export function makeComfortContext(
  T: Float32Array,
  rh: number,
  met: number,
  clo: number,
): ComfortContext {
  // Trad ≈ mean temperature of all boundary cells (walls/floor/ceiling).
  let s = 0, n = 0;
  // floor + ceiling
  for (let iz = 0; iz < NZ; iz++)
    for (let ix = 0; ix < NX; ix++) {
      s += T[K(ix, 0,      iz)]; n++;
      s += T[K(ix, NY - 1, iz)]; n++;
    }
  // S/N walls
  for (let iy = 0; iy < NY; iy++)
    for (let ix = 0; ix < NX; ix++) {
      s += T[K(ix, iy, 0)];      n++;
      s += T[K(ix, iy, NZ - 1)]; n++;
    }
  // W/E walls
  for (let iy = 0; iy < NY; iy++)
    for (let iz = 0; iz < NZ; iz++) {
      s += T[K(0,      iy, iz)]; n++;
      s += T[K(NX - 1, iy, iz)]; n++;
    }
  return { rh, met, clo, tRad: n > 0 ? s / n : 24, tu: 40 };
}

/** Per-cell PMV given Tair and |V| at that cell. */
export function pmvAt(ta: number, vel: number, ctx: ComfortContext): number {
  return pmv({ ta, tr: ctx.tRad, vel, rh: ctx.rh, met: ctx.met, clo: ctx.clo });
}

export function ppdAt(ta: number, vel: number, ctx: ComfortContext): number {
  return ppd(pmvAt(ta, vel, ctx));
}

export function drAt(ta: number, vel: number, ctx: ComfortContext): number {
  return draftRisk(ta, vel, ctx.tu ?? 40);
}

export function operativeTAt(ta: number, vel: number, ctx: ComfortContext): number {
  return operativeT(ta, ctx.tRad, vel);
}

// ── Aggregate summaries ──────────────────────────────────────────────────

export interface HeightSummary {
  /** y in metres */
  y:        number;
  meanT:    number;
  meanV:    number;
  meanPMV:  number;
  meanPPD:  number;
  maxDR:    number;
  meanOpT:  number;
}

/** Summary at one height plane (averages over all cells in that slab). */
export function summarizeHeight(
  T:  Float32Array,
  Vx: Float32Array,
  Vy: Float32Array,
  Vz: Float32Array,
  roomH: number,
  height: number,
  ctx: ComfortContext,
): HeightSummary {
  const iy = iyForHeight(height, roomH);
  let nT = 0, nV = 0, nPMV = 0, nPPD = 0, nOp = 0, maxDR = 0;
  let count = 0;
  for (let iz = 0; iz < NZ; iz++)
    for (let ix = 0; ix < NX; ix++) {
      const k = K(ix, iy, iz);
      const ta = T[k];
      const v  = Math.sqrt(Vx[k] * Vx[k] + Vy[k] * Vy[k] + Vz[k] * Vz[k]);
      nT += ta; nV += v;
      const p  = pmvAt(ta, v, ctx);
      nPMV += p;
      nPPD += ppd(p);
      nOp  += operativeTAt(ta, v, ctx);
      const dr = drAt(ta, v, ctx);
      if (dr > maxDR) maxDR = dr;
      count++;
    }
  const dy = roomH / NY;
  return {
    y:       (iy + 0.5) * dy,
    meanT:   nT   / count,
    meanV:   nV   / count,
    meanPMV: nPMV / count,
    meanPPD: nPPD / count,
    maxDR,
    meanOpT: nOp  / count,
  };
}

/** Vertical air-temperature difference between head (1.1 m) and ankle (0.1 m). */
export function verticalDeltaT(
  T:  Float32Array,
  roomH: number,
): number {
  const iyAnkle = iyForHeight(0.1, roomH);
  const iyHead  = iyForHeight(1.1, roomH);
  let sa = 0, sh = 0;
  const cells = NX * NZ;
  for (let iz = 0; iz < NZ; iz++)
    for (let ix = 0; ix < NX; ix++) {
      sa += T[K(ix, iyAnkle, iz)];
      sh += T[K(ix, iyHead,  iz)];
    }
  return (sh - sa) / cells;
}

export interface ComfortReport {
  ankle: HeightSummary;  // 0.1 m
  waist: HeightSummary;  // 0.6 m
  head:  HeightSummary;  // 1.1 m
  /** °C between head and ankle (positive = warmer at head — ISO 7730 ≤ 3 °C) */
  verticalDeltaT: number;
  ctx: ComfortContext;
}

export function buildComfortReport(
  T:  Float32Array,
  Vx: Float32Array,
  Vy: Float32Array,
  Vz: Float32Array,
  roomH: number,
  ctx: ComfortContext,
): ComfortReport {
  const [hAnkle, hWaist, hHead] = SAMPLE_HEIGHTS_M;
  return {
    ankle: summarizeHeight(T, Vx, Vy, Vz, roomH, hAnkle, ctx),
    waist: summarizeHeight(T, Vx, Vy, Vz, roomH, hWaist, ctx),
    head:  summarizeHeight(T, Vx, Vy, Vz, roomH, hHead,  ctx),
    verticalDeltaT: verticalDeltaT(T, roomH),
    ctx,
  };
}
