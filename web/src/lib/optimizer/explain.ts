/**
 * Template-based "why this layout" explanation for an NSGA-II individual.
 *
 * No LLM — just rule-based natural-language synthesis from the score
 * breakdown plus the gene values. Lives in the optimizer namespace
 * because it reads ScoreBreakdown shape directly.
 *
 * The output is meant for HVAC consultants reviewing the optimizer's
 * suggestion: a paragraph or two of why this configuration was chosen,
 * what tradeoff it makes, and what its weak spots are.
 */

import type { Individual } from "./nsga2";

export interface Explanation {
  /** One-line headline */
  summary: string;
  /** Bullet list of "what's good" */
  strengths: string[];
  /** Bullet list of "what's weak / where this trades off" */
  caveats: string[];
  /** Free-form prose paragraph explaining the placement reasoning. */
  reasoning: string;
}

export function explainIndividual(ind: Individual): Explanation {
  const b = ind.breakdown;
  const strengths: string[] = [];
  const caveats: string[] = [];

  // Headline
  let summary: string;
  if (ind.acs.length === 1) {
    const g = ind.acs[0];
    summary = `Single ${g.kw.toFixed(1)} kW unit on the ${wallName(g.wall)} wall, supplying ${g.supply_C.toFixed(0)} °C air with a ${g.throw_m.toFixed(1)} m throw.`;
  } else {
    const sumKW = ind.acs.reduce((s, g) => s + g.kw, 0);
    summary = `${ind.acs.length} units totalling ${sumKW.toFixed(1)} kW: ${ind.acs.map((g) => `${wallName(g.wall)} ${g.kw.toFixed(1)} kW`).join(", ")}.`;
  }

  // Strengths
  if (b) {
    if (b.worstPPD < 10) strengths.push(`worst-case occupant PPD only ${b.worstPPD.toFixed(0)}% — ISO 7730 Category A`);
    else if (b.worstPPD < 20) strengths.push(`worst-case occupant PPD ${b.worstPPD.toFixed(0)}% — ISO 7730 Category B`);
    if (b.hotPct < 15) strengths.push(`only ${b.hotPct.toFixed(0)}% of the comfort plane is above setpoint+4°C`);
    if (b.stdT < 1.5) strengths.push(`tight spatial uniformity (std ${b.stdT.toFixed(2)} °C)`);
    if (Math.abs(b.verticalDeltaT) < 2) strengths.push(`head-vs-ankle ΔT only ${Math.abs(b.verticalDeltaT).toFixed(1)} °C — well inside ISO 7730's 3 °C limit`);
    if (b.worstDR < 10) strengths.push(`max draft risk ${b.worstDR.toFixed(0)}% — comfortable air movement`);
  }
  if (ind.energy_kwh > 0 && ind.energy_kwh < 1500) {
    strengths.push(`annual energy under ${Math.round(ind.energy_kwh)} kWh — low operating cost`);
  }

  // Caveats
  if (b) {
    if (b.worstPPD >= 20) caveats.push(`worst-case PPD ${b.worstPPD.toFixed(0)}% — at least one occupant likely uncomfortable`);
    if (b.hotPct > 40) caveats.push(`${b.hotPct.toFixed(0)}% of the comfort plane is still above setpoint+4°C`);
    if (Math.abs(b.verticalDeltaT) > 3) caveats.push(`vertical ΔT ${Math.abs(b.verticalDeltaT).toFixed(1)} °C exceeds ISO 7730's 3 °C limit`);
    if (b.worstDR > 20) caveats.push(`draft risk ${b.worstDR.toFixed(0)}% — feels breezy near the supply`);
    if (b.stdT > 3) caveats.push(`temperature varies by std ${b.stdT.toFixed(1)} °C across the room`);
  }
  if (ind.energy_kwh > 3000) {
    caveats.push(`annual energy ${Math.round(ind.energy_kwh)} kWh — running cost is on the high side`);
  }

  // Reasoning paragraph
  const reasoning = buildReasoning(ind);

  return { summary, strengths, caveats, reasoning };
}

function buildReasoning(ind: Individual): string {
  const sentences: string[] = [];

  // Wall placement reasoning
  const walls = ind.acs.map((g) => g.wall);
  const uniqueWalls = Array.from(new Set(walls));
  if (ind.acs.length > 1 && uniqueWalls.length > 1) {
    sentences.push(
      `Using ${uniqueWalls.length} different walls (${uniqueWalls.map(wallName).join(" and ")}) creates cross-circulation — cold streams from opposite directions mix more uniformly than parallel jets, which keeps the spatial std low.`,
    );
  } else if (ind.acs.length > 1) {
    sentences.push(
      `Both units on the ${wallName(walls[0])} wall — this stacks throw distance, useful for long rooms where one unit can't reach the far corner.`,
    );
  } else {
    sentences.push(
      `The ${wallName(walls[0])} wall was picked because it gives the most direct line to the room's interior with the shortest unobstructed throw.`,
    );
  }

  // Throw distance reasoning
  const avgThrow = ind.acs.reduce((s, g) => s + g.throw_m, 0) / ind.acs.length;
  if (avgThrow > 5) {
    sentences.push(
      `Throw of ${avgThrow.toFixed(1)} m carries the cold front deep into the room before the jet decays — appropriate for a larger volume.`,
    );
  } else if (avgThrow < 3) {
    sentences.push(
      `A short ${avgThrow.toFixed(1)} m throw keeps the cold air close — works well in a compact space and avoids over-shooting.`,
    );
  }

  // Supply temperature reasoning
  const avgSupply = ind.acs.reduce((s, g) => s + g.supply_C, 0) / ind.acs.length;
  if (avgSupply < 12) {
    sentences.push(
      `Aggressive ${avgSupply.toFixed(0)} °C supply temperature drives strong cooling power — uses more energy but reaches setpoint quickly.`,
    );
  } else if (avgSupply > 16) {
    sentences.push(
      `Moderate ${avgSupply.toFixed(0)} °C supply trades a bit of cooling capacity for energy efficiency.`,
    );
  }

  // Capacity reasoning
  const totalKW = ind.acs.reduce((s, g) => s + g.kw, 0);
  sentences.push(
    `Total ${totalKW.toFixed(1)} kW capacity is ${totalKW > 4 ? "generously sized" : "matched closely"} to the room's heat load.`,
  );

  return sentences.join(" ");
}

function wallName(w: "S" | "N" | "E" | "W"): string {
  return { S: "South", N: "North", E: "East", W: "West" }[w];
}
