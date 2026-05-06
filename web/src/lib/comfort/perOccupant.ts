/**
 * Per-occupant local PMV / PPD / DR.
 *
 * Each `human` obstacle in the scene gets its own comfort vote, sampled
 * from the cells immediately around it (a small box centred at head
 * height). This is what HVAC consultants actually want: "is the person
 * at desk 4 comfortable?", not "is the average PMV over the whole room
 * acceptable?"
 *
 * Plays nicely with the optimizer — per-occupant scores are aggregated as
 * the *worst-case* dissatisfaction (since one uncomfortable occupant
 * reading "complain to facilities" cancels everyone else being content).
 */

import type { Scene, Obstacle } from "@/lib/io/schema";
import { pmv } from "./pmv";
import { ppd } from "./ppd";
import { draftRisk } from "./draftRisk";

/** Sample an arbitrary cell-centred scalar at a world position. */
type Sampler = (x: number, y: number, z: number) => number;

export interface OccupantSample {
  /** matches Obstacle.id */
  id:     number;
  /** world-space position used to centre the sample window */
  x:      number;
  y:      number;
  z:      number;
  meanT:  number;
  meanV:  number;
  meanRH: number;
  meanCO2:number;
  meanTmrt: number;
  pmv:    number;
  ppd:    number;
  dr:     number;
}

export interface OccupantSamplers {
  /** cell-centre temperature, °C */
  T:    Sampler;
  /** velocity speed |V|, m/s */
  V:    Sampler;
  /** relative humidity, fraction 0..1 */
  RH:   Sampler;
  /** CO₂ concentration, ppm */
  CO2:  Sampler;
  /** mean radiant temperature, °C */
  Tmrt: Sampler;
}

/**
 * Compute one PMV/PPD/DR vote per `human` obstacle in the scene.
 *
 * The sampling window is a 3×3×3 cube of cells centred at head height
 * (~1.1 m + Yoff) above the human. Width = ~30 cm — lets the score react
 * to local jets without smearing across the whole room.
 */
export function sampleOccupants(
  scene: Scene,
  samplers: OccupantSamplers,
  windowM = 0.3,
): OccupantSample[] {
  const env = scene.environment;
  const out: OccupantSample[] = [];
  for (const ob of scene.obstacles) {
    if (ob.shape !== "human") continue;
    if (ob.on === false) continue;
    const sample = sampleAt(ob, samplers, windowM);
    const p = pmv({
      ta:  sample.meanT,
      tr:  sample.meanTmrt,
      vel: sample.meanV,
      rh:  sample.meanRH * 100,
      met: env.met,
      clo: env.clo,
    });
    out.push({
      id: ob.id,
      ...sample,
      pmv: p,
      ppd: ppd(p),
      dr:  draftRisk(sample.meanT, sample.meanV),
    });
  }
  return out;
}

interface RawSample {
  x: number; y: number; z: number;
  meanT: number; meanV: number; meanRH: number; meanCO2: number; meanTmrt: number;
}

function sampleAt(ob: Obstacle, s: OccupantSamplers, windowM: number): RawSample {
  // Head position: centred above the obstacle's footprint, at top-of-head
  // height (Yoff + 0.92·H, since the human mesh is ~1.7 m tall and we want
  // the breathing zone, ~95 % of full height).
  const yHead = (ob.Yoff || 0) + ob.H * 0.92;
  // Sample a small cube around the head
  const r = windowM / 2;
  const offsets = [-r, 0, r];
  let nT = 0, nV = 0, nRH = 0, nCO2 = 0, nMrt = 0, count = 0;
  for (const dx of offsets)
    for (const dy of offsets)
      for (const dz of offsets) {
        const sx = ob.x + dx;
        const sy = yHead + dy;
        const sz = ob.z + dz;
        nT   += s.T   (sx, sy, sz);
        nV   += s.V   (sx, sy, sz);
        nRH  += s.RH  (sx, sy, sz);
        nCO2 += s.CO2 (sx, sy, sz);
        nMrt += s.Tmrt(sx, sy, sz);
        count++;
      }
  return {
    x: ob.x, y: yHead, z: ob.z,
    meanT:    nT   / count,
    meanV:    nV   / count,
    meanRH:   nRH  / count,
    meanCO2:  nCO2 / count,
    meanTmrt: nMrt / count,
  };
}

/**
 * Aggregate per-occupant scores into single numbers for the optimizer.
 *
 * Worst-case: the maximum PPD across occupants (one upset person ruins it).
 * Average PPD is the polite "who, on average, is unhappy" number.
 */
export function aggregateOccupants(samples: OccupantSample[]): {
  worstPPD: number;
  meanPPD:  number;
  worstDR:  number;
  worstPMV: number;
  count:    number;
} {
  if (samples.length === 0) {
    return { worstPPD: 0, meanPPD: 0, worstDR: 0, worstPMV: 0, count: 0 };
  }
  let maxPPD = 0, sumPPD = 0, maxDR = 0, maxAbsPMV = 0, worstPMVSigned = 0;
  for (const s of samples) {
    if (s.ppd > maxPPD) maxPPD = s.ppd;
    sumPPD += s.ppd;
    if (s.dr > maxDR) maxDR = s.dr;
    if (Math.abs(s.pmv) > maxAbsPMV) {
      maxAbsPMV = Math.abs(s.pmv);
      worstPMVSigned = s.pmv;
    }
  }
  return {
    worstPPD: maxPPD,
    meanPPD:  sumPPD / samples.length,
    worstDR:  maxDR,
    worstPMV: worstPMVSigned,
    count:    samples.length,
  };
}
