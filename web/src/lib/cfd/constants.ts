/**
 * CFD physical constants — ported verbatim from v6 (lines 1034-1037, 1158, 1322).
 * These are the calibration knobs the Tier 2 calibration script will tune.
 */

export const T_AMB    = 35;        // °C   — initial bulk temperature
export const T_AC     = 16;        // °C   — AC supply temperature
export const T_SOLAR  = 48;        // °C   — boundary T at sun-exposed openings
export const T_INFIL  = 37;        // °C   — boundary T at door infiltration
export const ALPHA    = 2.5e-5;    // m²/s — thermal diffusivity of air
export const BETA     = 3.4e-3;    // 1/K  — Boussinesq coefficient
export const G        = 9.81;      // m/s² — gravity

export const AC_SPEED  = 3.8;      // m/s — AC jet speed at outlet
export const DT        = 0.055;    // s   — sim time step
export const MAX_STEPS = 500;      // hard cap per simulation run
