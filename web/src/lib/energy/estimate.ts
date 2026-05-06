/**
 * Annual energy & cost estimate for an HVAC scene.
 *
 * Method (PLAN.md §6):
 *
 *   annual_cooling_kWh = (Q_total × CDH) / (COP × 1000)
 *   annual_cost        = annual_kWh × tariff_per_kWh
 *   annual_CO2_kg      = annual_kWh × CO2_per_kWh
 *
 * where:
 *   Q_total — peak cooling load in W (from the ASHRAE module)
 *   CDH     — cooling-degree-hours per year (climate-dependent)
 *   COP     — coefficient of performance of the AC (cooling out / electricity in)
 *
 * For Tier 1 we use a flat default CDH unless the scene specifies one.
 * Realistic ranges: ~1500 (mild temperate) to ~5000 (hot climate, e.g.
 * Delhi, Chennai). India weighted average ≈ 2500.
 *
 * Tier 2's energy module will integrate hourly weather data instead.
 */

import type { Scene } from "@/lib/io/schema";
import type { HeatLoad } from "@/lib/ashrae/heatLoad";

export interface EnergyEstimate {
  /** Cooling-degree-hours used in the calc. */
  cdh: number;
  /** Coefficient of performance assumed. */
  cop: number;
  /** Total annual electricity consumed by the AC, kWh. */
  annual_kwh: number;
  /** Annual electricity cost in the user's currency. */
  annual_cost: number;
  /** Annual CO₂ emissions due to AC operation, kg. */
  annual_co2_kg: number;
  /** Implied AC sizing in TR for the design load. */
  required_TR: number;
  /** Total operating hours estimated per year. */
  annual_runhours: number;
}

const DEFAULT_CDH = 2500;     // hours/year — moderate climate default
const DEFAULT_COP = 3.0;      // typical 5★ split AC (BEE 2023)
const TR_W        = 3517;

export function estimateEnergy(scene: Scene, hl: HeatLoad): EnergyEstimate {
  const env = scene.environment;
  const envExtra = env as unknown as { cooling_degree_hours?: number; cop?: number };
  const cdh = envExtra.cooling_degree_hours ?? DEFAULT_CDH;
  const cop = envExtra.cop ?? DEFAULT_COP;
  const tariff = env.tariff_per_kwh ?? 8.0;
  const co2    = env.co2_per_kwh_kg ?? 0.7;

  // Peak load in W; effective average load assumed at 60 % of peak across
  // the cooling season (sky load doesn't equal peak design load every hour).
  const avg_load_W = hl.Q_total * 0.60;
  const annual_kwh = (avg_load_W * cdh) / (cop * 1000);
  const annual_cost = annual_kwh * tariff;
  const annual_co2  = annual_kwh * co2;
  const annual_runhours = avg_load_W > 0 ? cdh : 0;

  return {
    cdh, cop,
    annual_kwh,
    annual_cost,
    annual_co2_kg: annual_co2,
    required_TR: hl.Q_total / TR_W,
    annual_runhours,
  };
}

/**
 * Compare two AC option's effective annual cost for the same load.
 * Useful when the user wants to see the energy-cost penalty of a worse
 * COP unit, or the savings from a higher-COP one.
 */
export function compareAC(
  scene: Scene, hl: HeatLoad,
  optionA: { cop: number; tariff?: number },
  optionB: { cop: number; tariff?: number },
): {
  a: EnergyEstimate; b: EnergyEstimate;
  delta_kwh: number; delta_cost: number; delta_co2_kg: number;
  payback_period_years?: number;
  /** If a price difference is supplied, return implied payback. */
} {
  const sceneA = withCop(scene, optionA.cop, optionA.tariff);
  const sceneB = withCop(scene, optionB.cop, optionB.tariff);
  const a = estimateEnergy(sceneA, hl);
  const b = estimateEnergy(sceneB, hl);
  return {
    a, b,
    delta_kwh: b.annual_kwh - a.annual_kwh,
    delta_cost: b.annual_cost - a.annual_cost,
    delta_co2_kg: b.annual_co2_kg - a.annual_co2_kg,
  };
}

function withCop(scene: Scene, cop: number, tariff?: number): Scene {
  return {
    ...scene,
    environment: {
      ...scene.environment,
      ...(tariff !== undefined ? { tariff_per_kwh: tariff } : {}),
      // Stash on the env using the same shape estimateEnergy reads
      ...({ cop } as object),
    },
  };
}
