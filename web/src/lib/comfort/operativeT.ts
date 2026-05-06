/**
 * Operative temperature.
 *
 *   T_op = (h_c · T_air + h_r · T_rad) / (h_c + h_r)
 *
 * For typical indoor velocities the simplification T_op ≈ 0.5·(T_air + T_rad)
 * is used (ISO 7726). Tier 1 has no radiative solver, so the caller passes
 * T_rad ≈ T_air or an estimate from boundary surface temperatures.
 */
export function operativeT(tAir: number, tRad: number, vel: number): number {
  // Heat transfer coefficient blends per ISO 7726 §G.3 — light office activity.
  const A = vel < 0.2 ? 0.5
          : vel < 0.6 ? 0.6
          :             0.7;
  return A * tAir + (1 - A) * tRad;
}
