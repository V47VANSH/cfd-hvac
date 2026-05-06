/**
 * Draft Risk (DR) — ISO 7730 §6.2.
 *
 *   DR = (34 − ta) · (v − 0.05)^0.62 · (0.37·v·Tu + 3.143)
 *
 * Predicts the percentage of people dissatisfied due to draft.
 * Tu (turbulence intensity, %) defaults to 40, the ISO standard value
 * for mixing-ventilation indoor environments.
 *
 * The formula is only valid for ta ≤ 34 °C and 0.05 ≤ v ≤ 0.5 m/s; outside
 * that band we return 0 (no draft) or clamp to 100 (worst case).
 */
export function draftRisk(ta: number, vel: number, tu = 40): number {
  if (ta >= 34) return 0;
  if (vel <= 0.05) return 0;
  const v = Math.min(vel, 0.5);
  const dr = (34 - ta) * Math.pow(v - 0.05, 0.62) * (0.37 * v * tu + 3.143);
  return Math.max(0, Math.min(100, dr));
}
