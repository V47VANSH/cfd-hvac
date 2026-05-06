/**
 * Joint multi-AC NSGA-II optimizer (Deb 2002).
 *
 * Decision variables (per AC unit):
 *   wall      ∈ {S, N, E, W}
 *   pos       ∈ [0.1, 0.9] · wall_span     — position along the wall
 *   throw_m   ∈ [2.0, 8.0] m
 *   angle_deg ∈ [-30, +30]
 *   kw        ∈ [1.0, 5.0]                 — capacity tier
 *   supply_C  ∈ [10, 18]                   — supply temperature
 *
 * Objectives (both minimised):
 *   f1 = J  (comfort score from scoring.ts — pillar A + B)
 *   f2 = annual_kwh  (from energy module, scaled by kW total)
 *
 * Result: a Pareto front of non-dominated configurations. The user
 * picks any point and applies that AC layout.
 *
 * Population is small (16) and generations are few (6) so this fits in
 * the 30 s Tier-1 budget on the JS solver. With the WebGL2 backend
 * (Phase 2b) the budget grows ~10× and population/generations can scale.
 */

import { makeFields } from "@/lib/cfd/grid";
import { T_AMB } from "@/lib/cfd/constants";
import { voxelizeObstacles, voxelizeBlocks, voxelizeSTL } from "@/lib/cfd/voxelize";
import {
  injectHeatSources, injectACJets, injectFans, injectInfiltration, setACCold,
} from "@/lib/cfd/sources";
import { step } from "@/lib/cfd/solver";
import { scoreField, type ScoreBreakdown } from "./scoring";
import { calcHeatLoad } from "@/lib/ashrae/heatLoad";
import { estimateEnergy } from "@/lib/energy/estimate";
import type { Scene, Wall, ACUnit } from "@/lib/io/schema";

const WALLS: Wall[] = ["S", "N", "E", "W"];

export interface ACGene {
  wall: Wall;
  /** 0–1 along the wall (0 = west/south corner, 1 = east/north corner). */
  pos: number;
  throw_m: number;
  angle_deg: number;
  kw: number;
  supply_C: number;
}

export interface Individual {
  acs: ACGene[];
  /** Comfort score (lower is better). */
  J: number;
  /** Annual cooling energy, kWh. */
  energy_kwh: number;
  /** Full breakdown for the comfort score. */
  breakdown?: ScoreBreakdown;
  /** Per-individual rejection from constraints; means the individual is
   *  dominated by everyone with valid scores. */
  rejected?: string;
  // NSGA-II bookkeeping
  rank: number;
  crowding: number;
}

export interface NSGA2Options {
  /** Number of AC units in each candidate. */
  nAC: number;
  /** Population size. Default 16. */
  population?: number;
  /** Generations. Default 6. */
  generations?: number;
  /** Per-individual sim steps. Default 35. */
  stepsPerEval?: number;
  /** RNG seed for repeatability. Default time-based. */
  seed?: number;
}

export interface NSGA2Result {
  paretoFront: Individual[];
  allEvaluated: Individual[];
  generations: number;
  evaluations: number;
}

export function runMultiACOptimizer(
  scene: Scene, opts: NSGA2Options,
): NSGA2Result {
  const { nAC } = opts;
  const popSize = opts.population ?? 16;
  const nGen    = opts.generations ?? 6;
  const stepsPerEval = opts.stepsPerEval ?? 35;
  const rng = makeRNG(opts.seed ?? Math.floor(Date.now() & 0x7fffffff));

  // Initialise population
  let pop: Individual[] = Array.from({ length: popSize }, () => randomIndividual(scene, nAC, rng));
  evaluateAll(pop, scene, stepsPerEval);
  let evaluations = pop.length;

  for (let g = 0; g < nGen; g++) {
    // Generate offspring via tournament + crossover + mutation
    const offspring: Individual[] = [];
    while (offspring.length < popSize) {
      const a = tournamentSelect(pop, rng);
      const b = tournamentSelect(pop, rng);
      const child = crossover(a, b, rng);
      mutate(child, scene, rng);
      offspring.push(child);
    }
    evaluateAll(offspring, scene, stepsPerEval);
    evaluations += offspring.length;

    // Combine and select via non-dominated sort + crowding
    const combined = pop.concat(offspring);
    pop = nsga2Survive(combined, popSize);
  }

  // Final ranking
  nondominatedSort(pop);
  const paretoFront = pop.filter((i) => i.rank === 0)
    .sort((a, b) => a.energy_kwh - b.energy_kwh);

  return {
    paretoFront,
    allEvaluated: pop,
    generations: nGen,
    evaluations,
  };
}

// ── Random init ─────────────────────────────────────────────────────

function randomIndividual(scene: Scene, nAC: number, rng: () => number): Individual {
  const acs: ACGene[] = [];
  const allowed = scene.constraints.allowed_walls?.length
    ? scene.constraints.allowed_walls
    : WALLS;
  for (let i = 0; i < nAC; i++) {
    acs.push({
      wall: allowed[Math.floor(rng() * allowed.length)],
      pos: 0.15 + rng() * 0.70,
      throw_m: 2.5 + rng() * 4.0,
      angle_deg: (rng() - 0.5) * 50,
      kw: 1.5 + rng() * 2.0,
      supply_C: 10 + rng() * 6,
    });
  }
  return { acs, J: Infinity, energy_kwh: Infinity, rank: -1, crowding: 0 };
}

// ── Crossover & mutation ────────────────────────────────────────────

function crossover(a: Individual, b: Individual, rng: () => number): Individual {
  const acs = a.acs.map((g, i) => {
    const o = b.acs[i] ?? g;
    return rng() < 0.5 ? { ...g } : { ...o };
  });
  // Blend continuous variables 50 % of the time
  for (const g of acs) {
    if (rng() < 0.5) {
      const idx = acs.indexOf(g);
      const ga = a.acs[idx], gb = b.acs[idx];
      if (ga && gb) {
        g.pos       = 0.5 * (ga.pos       + gb.pos);
        g.throw_m   = 0.5 * (ga.throw_m   + gb.throw_m);
        g.angle_deg = 0.5 * (ga.angle_deg + gb.angle_deg);
        g.kw        = 0.5 * (ga.kw        + gb.kw);
        g.supply_C  = 0.5 * (ga.supply_C  + gb.supply_C);
      }
    }
  }
  return { acs, J: Infinity, energy_kwh: Infinity, rank: -1, crowding: 0 };
}

function mutate(ind: Individual, scene: Scene, rng: () => number): void {
  const allowed = scene.constraints.allowed_walls?.length
    ? scene.constraints.allowed_walls
    : WALLS;
  for (const g of ind.acs) {
    if (rng() < 0.20) g.wall = allowed[Math.floor(rng() * allowed.length)];
    g.pos       = clamp(g.pos       + gauss(rng) * 0.10, 0.10, 0.90);
    g.throw_m   = clamp(g.throw_m   + gauss(rng) * 1.0,  2.0,  8.0);
    g.angle_deg = clamp(g.angle_deg + gauss(rng) * 8.0, -30,  30);
    g.kw        = clamp(g.kw        + gauss(rng) * 0.4,  1.0,  5.0);
    g.supply_C  = clamp(g.supply_C  + gauss(rng) * 1.0,  10,   18);
  }
}

// ── Evaluation ──────────────────────────────────────────────────────

function evaluateAll(pop: Individual[], scene: Scene, stepsPerEval: number): void {
  for (const ind of pop) {
    if (Number.isFinite(ind.J)) continue;
    const result = evaluate(ind, scene, stepsPerEval);
    ind.J = result.J;
    ind.energy_kwh = result.energy_kwh;
    ind.breakdown = result.breakdown;
    ind.rejected = result.rejected;
  }
}

function evaluate(
  ind: Individual, scene: Scene, stepsPerEval: number,
): { J: number; energy_kwh: number; breakdown?: ScoreBreakdown; rejected?: string } {
  // Convert genes to AC units in the scene
  const acUnits: ACUnit[] = [];
  let nextId = (Math.max(0, ...scene.openings.map((o) => o.id),
                              ...scene.obstacles.map((o) => o.id)) || 0) + 1;
  for (const g of ind.acs) {
    const { L, W } = scene.geometry;
    const span = (g.wall === "S" || g.wall === "N") ? L : W;
    const u = (0.10 + g.pos * 0.80) * span;
    let x = 0, z = 0;
    if      (g.wall === "S") { x = u - L/2; z = -W/2 + 0.1; }
    else if (g.wall === "N") { x = u - L/2; z =  W/2 - 0.1; }
    else if (g.wall === "W") { x = -L/2 + 0.1; z = u - W/2; }
    else                     { x =  L/2 - 0.1; z = u - W/2; }
    acUnits.push({
      id: nextId++, wall: g.wall, x, z,
      kw: g.kw, capacity_tr: +(g.kw / 3.517).toFixed(2),
      type: "split",
      throw_distance_m: g.throw_m,
      airflow_angle_deg: g.angle_deg,
      vertical_angle_deg: -5,
      flow_rate_cfm: Math.round(g.kw * 175),
      supply_temp_C: g.supply_C,
      on: true,
    });
  }

  const scoredScene: Scene = { ...scene, ac_units: acUnits };

  // Run a short legacy CFD simulation
  const fields = makeFields();
  fields.T.fill(T_AMB);
  voxelizeObstacles(fields, scene.geometry, scene.obstacles);
  voxelizeBlocks   (fields, scene.geometry, scene.geometry.extensions);
  voxelizeSTL      (fields, scene.geometry, scene.geometry.stl);
  injectHeatSources(fields, scene.geometry, scene.obstacles);
  injectACJets     (fields, scene.geometry, acUnits);
  injectFans       (fields, scene.geometry, scene.obstacles);
  injectInfiltration(fields, scene.geometry, scene.openings);
  for (let i = 0; i < stepsPerEval; i++) {
    step({ fields, room: scene.geometry, openings: scene.openings,
           Tout: scene.environment.outdoor_temp_C, n: 1 });
    setACCold(fields, scene.geometry, acUnits);
  }
  const breakdown = scoreField(scoredScene, fields);

  // Energy: sum the AC power × runtime, scaled by load fraction
  const hl = calcHeatLoad(scoredScene);
  const e = estimateEnergy(scoredScene, hl);
  // Penalty if AC capacity is below required load (oversizing has small
  // efficiency penalty, undersizing is a hard miss)
  const totalKW = ind.acs.reduce((s, g) => s + g.kw, 0);
  const requiredKW = hl.Q_total / 1000;
  const undersized = totalKW < requiredKW * 0.9;
  const J = breakdown.J + (undersized ? 0.5 : 0);     // 0.5 penalty if too small
  return {
    J,
    energy_kwh: e.annual_kwh,
    breakdown,
    rejected: undersized ? "undersized_for_load" : undefined,
  };
}

// ── NSGA-II selection ───────────────────────────────────────────────

function nondominatedSort(pop: Individual[]): Individual[][] {
  const fronts: Individual[][] = [[]];
  // Compute domination counts and sets
  const dominates = (a: Individual, b: Individual): boolean =>
    (a.J <= b.J && a.energy_kwh <= b.energy_kwh) &&
    (a.J <  b.J || a.energy_kwh <  b.energy_kwh);
  const dominatedBy: number[] = pop.map(() => 0);
  const dominates_set: number[][] = pop.map(() => []);
  for (let i = 0; i < pop.length; i++)
    for (let j = 0; j < pop.length; j++) {
      if (i === j) continue;
      if (dominates(pop[i], pop[j])) dominates_set[i].push(j);
      else if (dominates(pop[j], pop[i])) dominatedBy[i]++;
    }
  // Find front 0
  for (let i = 0; i < pop.length; i++) {
    if (dominatedBy[i] === 0) { pop[i].rank = 0; fronts[0].push(pop[i]); }
  }
  let cur = 0;
  while (fronts[cur].length > 0) {
    const next: Individual[] = [];
    for (const ind of fronts[cur]) {
      const i = pop.indexOf(ind);
      for (const j of dominates_set[i]) {
        dominatedBy[j]--;
        if (dominatedBy[j] === 0) {
          pop[j].rank = cur + 1;
          next.push(pop[j]);
        }
      }
    }
    cur++;
    fronts.push(next);
  }
  return fronts;
}

function crowdingDistance(front: Individual[]): void {
  if (front.length === 0) return;
  for (const ind of front) ind.crowding = 0;
  for (const obj of ["J", "energy_kwh"] as const) {
    front.sort((a, b) => a[obj] - b[obj]);
    front[0].crowding = front[front.length - 1].crowding = Infinity;
    const range = front[front.length - 1][obj] - front[0][obj] + 1e-12;
    for (let i = 1; i < front.length - 1; i++) {
      front[i].crowding += (front[i + 1][obj] - front[i - 1][obj]) / range;
    }
  }
}

function nsga2Survive(pop: Individual[], n: number): Individual[] {
  const fronts = nondominatedSort(pop);
  const survivors: Individual[] = [];
  for (const front of fronts) {
    if (front.length === 0) continue;
    if (survivors.length + front.length <= n) {
      crowdingDistance(front);
      survivors.push(...front);
    } else {
      crowdingDistance(front);
      front.sort((a, b) => b.crowding - a.crowding);
      const need = n - survivors.length;
      survivors.push(...front.slice(0, need));
      break;
    }
  }
  return survivors;
}

function tournamentSelect(pop: Individual[], rng: () => number, k = 2): Individual {
  let best = pop[Math.floor(rng() * pop.length)];
  for (let i = 1; i < k; i++) {
    const c = pop[Math.floor(rng() * pop.length)];
    if (c.rank < best.rank ||
        (c.rank === best.rank && c.crowding > best.crowding)) best = c;
  }
  return best;
}

// ── Utilities ───────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function gauss(rng: () => number): number {
  // Box-Muller
  const u1 = rng() || 1e-9;
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Mulberry32 — small fast deterministic RNG for reproducibility. */
function makeRNG(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convert a Pareto-front individual into a list of ACUnits ready to write
 *  back into a Scene. Used by the UI when the user picks a point. */
export function individualToACUnits(ind: Individual, scene: Scene, startId = 1): ACUnit[] {
  const out: ACUnit[] = [];
  let id = startId;
  for (const g of ind.acs) {
    const { L, W } = scene.geometry;
    const span = (g.wall === "S" || g.wall === "N") ? L : W;
    const u = (0.10 + g.pos * 0.80) * span;
    let x = 0, z = 0;
    if      (g.wall === "S") { x = u - L/2; z = -W/2 + 0.1; }
    else if (g.wall === "N") { x = u - L/2; z =  W/2 - 0.1; }
    else if (g.wall === "W") { x = -L/2 + 0.1; z = u - W/2; }
    else                     { x =  L/2 - 0.1; z = u - W/2; }
    out.push({
      id: id++, wall: g.wall, x, z,
      kw: +g.kw.toFixed(2), capacity_tr: +(g.kw / 3.517).toFixed(2),
      type: "split",
      throw_distance_m: +g.throw_m.toFixed(1),
      airflow_angle_deg: Math.round(g.angle_deg),
      vertical_angle_deg: -5,
      flow_rate_cfm: Math.round(g.kw * 175),
      supply_temp_C: +g.supply_C.toFixed(1),
      on: true,
    });
  }
  return out;
}
