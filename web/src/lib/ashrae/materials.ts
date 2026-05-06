/**
 * Wall material presets — typical U-values from ASHRAE Handbook of
 * Fundamentals (2021 ed.) and Indian-context references (BEE, ECBC 2017).
 *
 * U-values are in W/m²K. Lower = better insulator.
 */

import type { MaterialLibrary } from "@/lib/io/schema";

export interface MaterialPreset {
  id: string;
  label: string;
  description: string;
  /** Composite "average wall" U-value, applied to all four walls. */
  wall_u: number;
  /** Roof / ceiling U-value. */
  roof_u: number;
  /** Floor U-value (slab on ground is typically very low). */
  floor_u: number;
}

export const MATERIAL_PRESETS: MaterialPreset[] = [
  {
    id: "default",
    label: "Default (v6 baseline)",
    description: "Brick wall, RCC roof, concrete slab — uninsulated",
    wall_u: 2.80, roof_u: 2.00, floor_u: 1.50,
  },
  {
    id: "uninsulated_brick",
    label: "230 mm brick (uninsulated)",
    description: "Standard Indian construction, no insulation",
    wall_u: 2.50, roof_u: 2.20, floor_u: 1.80,
  },
  {
    id: "ecbc_residential",
    label: "ECBC 2017 — Residential",
    description: "Energy Conservation Building Code minimum (warm/humid)",
    wall_u: 0.85, roof_u: 0.40, floor_u: 1.20,
  },
  {
    id: "ecbc_commercial",
    label: "ECBC 2017 — Commercial",
    description: "Stricter envelope for offices / hotels",
    wall_u: 0.55, roof_u: 0.33, floor_u: 0.90,
  },
  {
    id: "ashrae_temperate",
    label: "ASHRAE 90.1 — Climate Zone 4 (mixed)",
    description: "Insulated wood/metal stud wall, attic-vented roof",
    wall_u: 0.45, roof_u: 0.20, floor_u: 0.50,
  },
  {
    id: "passive_house",
    label: "Passive House",
    description: "Heavily insulated envelope, triple-glazed everywhere",
    wall_u: 0.15, roof_u: 0.12, floor_u: 0.15,
  },
  {
    id: "tin_shed",
    label: "Tin / metal shed (worst case)",
    description: "Uninsulated metal cladding — kitchens, factories",
    wall_u: 5.00, roof_u: 5.50, floor_u: 1.50,
  },
];

/**
 * Apply a preset to a MaterialLibrary, overwriting any per-wall overrides.
 * The result is fully serialisable / round-trips through the JSON export.
 */
export function applyPreset(presetId: string): MaterialLibrary {
  const p = MATERIAL_PRESETS.find((x) => x.id === presetId)
         ?? MATERIAL_PRESETS[0];
  return {
    preset: p.id,
    wall_u_values: { S: p.wall_u, N: p.wall_u, E: p.wall_u, W: p.wall_u },
    roof_u_value: p.roof_u,
    floor_u_value: p.floor_u,
  };
}
