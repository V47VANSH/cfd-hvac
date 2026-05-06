/**
 * Predicted Percentage of Dissatisfied (ISO 7730 / Fanger).
 *
 *   PPD = 100 − 95 · exp(−0.03353·PMV⁴ − 0.2179·PMV²)
 *
 * Returns 5..100 (PMV = 0 → PPD = 5; |PMV| ≥ 3 → PPD ≈ 100).
 */
export function ppd(pmv: number): number {
  const v = 100 - 95 * Math.exp(-0.03353 * pmv ** 4 - 0.2179 * pmv ** 2);
  return Math.max(0, Math.min(100, v));
}
