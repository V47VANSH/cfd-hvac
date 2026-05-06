/**
 * Predicted Mean Vote (Fanger / ISO 7730).
 *
 * Iterative implementation following the standard's Annex D pseudocode.
 * Inputs are in SI (°C, m/s, %, met, clo). Output is a scalar on
 * the −3..+3 thermal sensation scale.
 *
 * Valid range per ISO 7730 §6: 10 < ta < 30 °C, 10 < tr < 40 °C,
 * 0 < va < 1 m/s, 30 < rh < 70 %, 0.8 < met < 4, 0 < clo < 2.
 * We clamp the output to [-3, +3] outside that range so heatmaps stay readable.
 */

export interface PMVInputs {
  ta:  number;  // air temperature, °C
  tr:  number;  // mean radiant temperature, °C
  vel: number;  // relative air velocity, m/s
  rh:  number;  // relative humidity, %
  met: number;  // metabolic rate, met (1 met = 58.15 W/m²)
  clo: number;  // clothing insulation, clo (1 clo = 0.155 m²K/W)
}

export function pmv({ ta, tr, vel, rh, met, clo }: PMVInputs): number {
  // Saturation vapor pressure (Pa) — Hyland & Wexler simplified form used by ISO.
  const pws_kPa = Math.exp(16.6536 - 4030.183 / (ta + 235));
  const pa = (rh / 100) * pws_kPa * 1000;

  const icl = 0.155 * clo;
  const m   = met * 58.15;
  const w   = 0;
  const mw  = m - w;
  const fcl = icl <= 0.078 ? 1 + 1.29 * icl : 1.05 + 0.645 * icl;

  const hcf = 12.1 * Math.sqrt(Math.max(0, vel));
  const taa = ta + 273;
  const tra = tr + 273;

  let tcla = taa + (35.5 - ta) / (3.5 * (6.45 * icl + 0.1));
  const p1 = icl * fcl;
  const p2 = p1 * 3.96;
  const p3 = p1 * 100;
  const p4 = p1 * taa;
  const p5 = 308.7 - 0.028 * mw + p2 * Math.pow(tra / 100, 4);

  let xn = tcla / 100;
  let xf = xn;
  let hc = hcf;
  let n  = 0;
  const eps = 1.5e-4;
  do {
    xf = (xf + xn) / 2;
    const hcn = 2.38 * Math.pow(Math.abs(100 * xf - taa), 0.25);
    hc = hcf > hcn ? hcf : hcn;
    xn = (p5 + p4 * hc - p2 * Math.pow(xf, 4)) / (100 + p3 * hc);
    n++;
    if (n > 150) break;
  } while (Math.abs(xn - xf) > eps);

  const tcl = 100 * xn - 273;

  const hl1 = 3.05e-3 * (5733 - 6.99 * mw - pa);
  const hl2 = mw > 58.15 ? 0.42 * (mw - 58.15) : 0;
  const hl3 = 1.7e-5 * m * (5867 - pa);
  const hl4 = 0.0014 * m * (34 - ta);
  const hl5 = 3.96 * fcl * (Math.pow(xn, 4) - Math.pow(tra / 100, 4));
  const hl6 = fcl * hc * (tcl - ta);

  const ts = 0.303 * Math.exp(-0.036 * m) + 0.028;
  const v  = ts * (mw - hl1 - hl2 - hl3 - hl4 - hl5 - hl6);

  if (!Number.isFinite(v)) return 0;
  return Math.max(-3, Math.min(3, v));
}
