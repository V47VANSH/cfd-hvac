/**
 * ASHRAE-style cooling load calculator.
 * Ported from v6 lines 1411-1451 (calcHeatLoad).
 *
 * Uses simplified single-zone steady-state formulas. Per-window U-value
 * and SHGC are read from the JSON schema (Phase 0b extension); if a
 * window omits them, the v6 globals are used as defaults.
 */

import type { Scene } from "@/lib/io/schema";

const U_DEFAULT = { wall: 2.8, glass: 5.8, roof: 2.0 };  // W/m²K
const SHGC_DEFAULT = 0.65;
const I_SOLAR     = 620;       // W/m² direct solar irradiance
const RHO_CP      = 1200;      // J/m³K for air
const Q_SEN_PERSON = 75;       // W sensible per person (ASHRAE)
const Q_LAT_PERSON = 55;       // W latent per person
const ACH         = 0.5;       // air changes per hour (infiltration)
const TR_W        = 3517;      // 1 ton of refrigeration = 3517 W

export interface HeatLoad {
  Q_walls:    number;
  Q_glass:    number;
  Q_solar:    number;
  Q_roof:     number;
  Q_occ_sens: number;
  Q_occ_lat:  number;
  Q_app:      number;
  Q_infil:    number;
  Q_sens:     number;
  Q_lat:      number;
  Q_total:    number;
  TR:         number;
  n_persons:  number;
}

export function calcHeatLoad(scene: Scene): HeatLoad {
  const { L, W, H } = scene.geometry;
  const Tout = scene.environment.outdoor_temp_C;
  const Tset = scene.environment.setpoint_C;
  const dT   = Tout - Tset;

  // Glass area + solar gain
  let A_glass = 0, Q_solar = 0;
  for (const f of scene.openings) {
    if (f.type !== "win" && f.type !== "circ" && f.type !== "arch") continue;
    const ag = f.uw * f.vh;
    A_glass += ag;
    if (f.open !== false) {
      const shgc = f.solar_transmittance ?? SHGC_DEFAULT;
      Q_solar += shgc * I_SOLAR * ag;
    }
  }

  // Wall and glass conduction. If any opening provides a per-unit
  // U-value, treat it on its own term (subtract its area from glass).
  let Q_glass_explicit = 0;
  let A_glass_explicit = 0;
  for (const f of scene.openings) {
    if (f.u_value === undefined) continue;
    if (f.type !== "win" && f.type !== "circ" && f.type !== "arch") continue;
    const ag = f.uw * f.vh;
    Q_glass_explicit += f.u_value * ag * dT;
    A_glass_explicit += ag;
  }
  const A_glass_default = Math.max(0, A_glass - A_glass_explicit);
  const Q_glass = Q_glass_explicit + U_DEFAULT.glass * A_glass_default * dT;

  const A_walls = 2*(L*H) + 2*(W*H) - A_glass;
  const A_roof  = L * W;
  const Q_walls = U_DEFAULT.wall * A_walls * dT;
  const Q_roof  = U_DEFAULT.roof * A_roof * dT;

  // Occupants
  const occupants = scene.obstacles.filter(
    (o) => o.shape === "human" && o.on !== false,
  );
  const n_persons   = occupants.length;
  const Q_occ_sens  = n_persons * Q_SEN_PERSON;
  const Q_occ_lat   = n_persons * Q_LAT_PERSON;

  // Appliances
  const Q_app = scene.obstacles
    .filter((o) => o.shape === "appliance" && o.on !== false)
    .reduce((sum, o) => sum + (o.watts ?? 200), 0);

  // Infiltration via volumetric air change rate
  const Q_infil = (ACH / 3600) * L * W * H * RHO_CP * dT;

  const Q_sens  = Math.max(0, Q_walls + Q_glass + Q_solar + Q_roof + Q_occ_sens + Q_app + Q_infil);
  const Q_lat   = Math.max(0, Q_occ_lat);
  const Q_total = Q_sens + Q_lat;

  return {
    Q_walls, Q_glass, Q_solar, Q_roof,
    Q_occ_sens, Q_occ_lat, Q_app, Q_infil,
    Q_sens, Q_lat, Q_total,
    TR: Q_total / TR_W,
    n_persons,
  };
}
