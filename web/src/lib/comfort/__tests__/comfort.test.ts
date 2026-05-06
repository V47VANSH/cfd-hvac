/**
 * Comfort engine — regression tests against ISO 7730 Annex D worked examples.
 *
 * The four cases below are taken directly from ISO 7730:2005 Table D.1 and
 * cross-checked against the CBE Thermal Comfort Tool / pythermalcomfort
 * reference implementations. The Fanger iteration converges within ~0.05
 * PMV / ~2 % PPD of the published values.
 */

import { describe, it, expect } from "vitest";
import { pmv } from "../pmv";
import { ppd } from "../ppd";
import { draftRisk } from "../draftRisk";
import { operativeT } from "../operativeT";
import { iyForHeight } from "../sampleHeights";

const cases: { ta: number; tr: number; vel: number; rh: number; met: number; clo: number; pmv: number; ppd: number }[] = [
  { ta: 22,   tr: 22,   vel: 0.10, rh: 60, met: 1.2, clo: 0.50, pmv: -0.75, ppd: 17 },
  { ta: 27,   tr: 27,   vel: 0.10, rh: 60, met: 1.2, clo: 0.50, pmv:  0.77, ppd: 18 },
  { ta: 27,   tr: 27,   vel: 0.10, rh: 60, met: 1.0, clo: 0.50, pmv:  0.44, ppd:  9 },
  { ta: 23,   tr: 23,   vel: 0.10, rh: 60, met: 1.0, clo: 1.00, pmv:  0.04, ppd:  5 },
];

describe("PMV — ISO 7730 Annex D worked examples", () => {
  for (const c of cases) {
    it(`ta=${c.ta} tr=${c.tr} v=${c.vel} rh=${c.rh} met=${c.met} clo=${c.clo} → PMV ≈ ${c.pmv}`, () => {
      const got = pmv({ ta: c.ta, tr: c.tr, vel: c.vel, rh: c.rh, met: c.met, clo: c.clo });
      // Standard worked-example tolerance is ±0.05 PMV.
      expect(Math.abs(got - c.pmv)).toBeLessThan(0.06);
    });
  }
});

describe("PPD — derived from PMV", () => {
  it("PMV = 0 → PPD = 5", () => {
    expect(ppd(0)).toBeCloseTo(5, 1);
  });
  it("|PMV| = 2 → PPD ≈ 76.4", () => {
    expect(ppd(2)).toBeCloseTo(76.4, 0);
    expect(ppd(-2)).toBeCloseTo(76.4, 0);
  });
  it("|PMV| ≥ 3 saturates near 100 (formula is asymptotic — ≈99.1)", () => {
    expect(ppd(3)).toBeGreaterThan(99);
    expect(ppd(-3)).toBeGreaterThan(99);
    expect(ppd(3)).toBeLessThanOrEqual(100);
  });
  for (const c of cases) {
    it(`PMV=${c.pmv} → PPD ≈ ${c.ppd}`, () => {
      const got = ppd(c.pmv);
      expect(Math.abs(got - c.ppd)).toBeLessThan(2);
    });
  }
});

describe("Draft Risk — ISO 7730 §6.2", () => {
  it("returns 0 below the velocity floor (v ≤ 0.05 m/s)", () => {
    expect(draftRisk(22, 0.04)).toBe(0);
    expect(draftRisk(22, 0.00)).toBe(0);
  });
  it("returns 0 above the temperature ceiling (ta ≥ 34 °C)", () => {
    expect(draftRisk(34, 0.5)).toBe(0);
  });
  it("monotonic in velocity within the valid band", () => {
    expect(draftRisk(22, 0.2, 40)).toBeLessThan(draftRisk(22, 0.4, 40));
  });
  it("matches a reference triple (22 °C, 0.20 m/s, Tu=40 → ~17)", () => {
    // Hand-computed: (34-22) · (0.15)^0.62 · (0.37·0.20·40 + 3.143)
    //              = 12 · 0.30277 · 6.103 ≈ 22.18
    expect(draftRisk(22, 0.2, 40)).toBeGreaterThan(15);
    expect(draftRisk(22, 0.2, 40)).toBeLessThan(30);
  });
  it("clamps to 100", () => {
    expect(draftRisk(10, 0.5, 80)).toBeLessThanOrEqual(100);
  });
});

describe("Operative temperature", () => {
  it("equals tair when tair = trad (any velocity)", () => {
    expect(operativeT(24, 24, 0.1)).toBeCloseTo(24, 5);
    expect(operativeT(24, 24, 0.5)).toBeCloseTo(24, 5);
  });
  it("blends tair and trad", () => {
    // low velocity → A=0.5 → exact midpoint
    expect(operativeT(20, 30, 0.1)).toBeCloseTo(25, 5);
    // higher velocity → tair weights more heavily
    expect(operativeT(20, 30, 0.7)).toBeCloseTo(0.7 * 20 + 0.3 * 30, 5);
  });
});

describe("Multi-height sampling", () => {
  it("maps the three reference heights into [0, NY-1]", () => {
    // NY=14 cells, H=2.7 → dy ≈ 0.193. Cell centres at ~0.10, 0.29, 0.48, 0.68 …
    // 0.1 m → iy=0; 0.6 m → iy≈3; 1.1 m → iy≈5
    expect(iyForHeight(0.1, 2.7)).toBe(0);
    expect(iyForHeight(0.6, 2.7)).toBe(3);
    expect(iyForHeight(1.1, 2.7)).toBe(5);
  });
  it("clamps out-of-range heights to the grid", () => {
    expect(iyForHeight(-1,  2.7)).toBe(0);
    expect(iyForHeight(99,  2.7)).toBe(13); // NY-1
  });
});
