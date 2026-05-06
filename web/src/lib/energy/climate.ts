/**
 * Climate presets — annual cooling-degree-hours (CDH) above 24 °C base
 * for major Indian + global cities.
 *
 * CDH ≈ Σ over the year of max(0, T_outdoor − 24 °C) in hours.
 * Source: NSRDB / NREL TMY3 averages for representative cities.
 *
 * The user picks one of these (or supplies their own number) in the
 * Energy panel, and the energy module uses it instead of the default 2500.
 */

export interface ClimatePreset {
  id: string;
  label: string;
  cdh: number;       // °C·h above 24 °C
  notes?: string;
}

export const CLIMATE_PRESETS: ClimatePreset[] = [
  // India
  { id: "delhi",      label: "Delhi (composite)",       cdh: 5800, notes: "Hot summers, cool winters; long cooling season" },
  { id: "mumbai",     label: "Mumbai (warm humid)",     cdh: 4200, notes: "Coastal, year-round high humidity" },
  { id: "bangalore",  label: "Bangalore (temperate)",   cdh: 1100, notes: "Mild — minimal cooling needed" },
  { id: "chennai",    label: "Chennai (hot humid)",     cdh: 6200, notes: "Coastal tropical, longest cooling season" },
  { id: "hyderabad",  label: "Hyderabad (composite)",   cdh: 3800, notes: "Inland, long but moderate" },
  { id: "kolkata",    label: "Kolkata (warm humid)",    cdh: 4800, notes: "Eastern coastal, high humidity" },
  { id: "ahmedabad",  label: "Ahmedabad (hot dry)",     cdh: 5400, notes: "Inland, very hot summers" },
  { id: "jaipur",     label: "Jaipur (hot dry)",        cdh: 4900, notes: "Desert-like summers" },
  { id: "pune",       label: "Pune (warm temperate)",   cdh: 1800, notes: "Inland plateau, moderate" },

  // Global reference
  { id: "phoenix",    label: "Phoenix, USA (hot dry)",   cdh: 5500 },
  { id: "singapore",  label: "Singapore (eq. tropical)", cdh: 8500 },
  { id: "dubai",      label: "Dubai (desert)",           cdh: 7800 },
  { id: "london",     label: "London (cool temperate)",  cdh:  120, notes: "Cooling not really needed" },
  { id: "tokyo",      label: "Tokyo (humid subtropical)",cdh: 1900 },

  { id: "default",    label: "Generic moderate",         cdh: 2500, notes: "Tier-1 default" },
];

export function climateById(id: string): ClimatePreset | undefined {
  return CLIMATE_PRESETS.find((c) => c.id === id);
}
