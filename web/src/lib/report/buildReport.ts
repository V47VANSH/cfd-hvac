/**
 * Build the HTML payload for the one-click comfort PDF report.
 *
 * The HTML is a self-contained string with inline styles — no external
 * fonts, no external CSS, no scripts. html2pdf.js converts it to PDF
 * (the library is loaded lazily by the caller, so this file stays cheap).
 *
 * Sections (per PLAN.md §7):
 *   1. Scene render (PNG)
 *   2. Room and load summary
 *   3. Recommended AC: position, capacity, score
 *   4. Comfort summary at 0.1 / 0.6 / 1.1 m
 *   5. Energy + cost estimate (Phase 3 stub)
 *   6. Validation status (Tier 2 stub)
 */

import type { CapturedSnapshot } from "@/lib/comparison/captureSnapshot";

export interface ReportInputs {
  capture: CapturedSnapshot;
  /** SHA-256 of the canonicalized scene */
  sceneHash: string;
}

export function buildReportHTML({ capture, sceneHash }: ReportInputs): string {
  const { scene, comfort, heatLoad, metrics, canvasPNG, label, capturedAt, step } = capture;
  const env = scene.environment;
  const ac  = scene.ac_units;

  // CSS scoped to .cfd-report so it survives innerHTML stripping (which
  // discards doctype/html/head/body wrappers). Without this scoping the
  // PDF came out blank because the rules referenced `body` which the
  // wrapper-less DOM no longer matches.
  const css = `
    .cfd-report { font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; color: #1a1a1a; padding: 24px; font-size: 11px; background: #fff; box-sizing: border-box; }
    .cfd-report * { box-sizing: border-box; }
    .cfd-report h1 { font-size: 20px; margin: 0 0 4px 0; color: #1a3858; }
    .cfd-report h2 { font-size: 14px; margin: 18px 0 6px 0; color: #1a3858; border-bottom: 1px solid #c8d6e8; padding-bottom: 2px; }
    .cfd-report h3 { font-size: 12px; margin: 10px 0 4px 0; color: #305878; }
    .cfd-report p, .cfd-report td, .cfd-report th { font-size: 11px; line-height: 1.4; }
    .cfd-report .meta { color: #5878a0; font-size: 10px; margin-bottom: 12px; }
    .cfd-report .render { width: 100%; max-height: 280px; object-fit: contain; border: 1px solid #c8d6e8; background: #f0f4f8; border-radius: 4px; }
    .cfd-report table { width: 100%; border-collapse: collapse; margin-top: 4px; }
    .cfd-report th, .cfd-report td { padding: 4px 6px; text-align: left; border-bottom: 1px solid #e0e8f0; }
    .cfd-report th { background: #f0f4f8; color: #305878; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; }
    .cfd-report td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .cfd-report .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .cfd-report .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; }
    .cfd-report .b-good { background: #d8f0d8; color: #1a6020; }
    .cfd-report .b-warn { background: #ffe8c0; color: #8a4810; }
    .cfd-report .b-bad  { background: #f8d0d0; color: #8a1818; }
    .cfd-report .stub { color: #889; font-style: italic; font-size: 10px; }
    .cfd-report .footer { margin-top: 24px; padding-top: 8px; border-top: 1px solid #c8d6e8; font-size: 9px; color: #6080a0; }
    .cfd-report .small { font-size: 10px; color: #5878a0; }
  `;

  const ackleR = comfort.ankle, waistR = comfort.waist, headR = comfort.head;
  const maxDR = Math.max(ackleR.maxDR, waistR.maxDR, headR.maxDR);

  // Return a single root element wrapped in `.cfd-report` (no full
  // <html><body> document — those tags are stripped when the result is
  // assigned via innerHTML). The <style> tag remains valid as a child
  // of the wrapper and html2canvas honours its rules.
  return `
<style>${css}</style>
<div class="cfd-report">
  <h1>HVAC Comfort &amp; Placement Report</h1>
  <p class="meta">
    Scenario: <strong>${esc(label)}</strong> · Captured: ${esc(capturedAt.replace("T", " ").slice(0, 19))} UTC
    · Sim step: ${step}
  </p>

  ${canvasPNG ? `<img class="render" src="${canvasPNG}" alt="Room render"/>` : ""}

  <h2>1. Room &amp; Load Summary</h2>
  <div class="grid2">
    <table>
      <tr><th>Geometry</th><th></th></tr>
      <tr><td>Length × Width × Height</td><td class="num">${scene.geometry.L.toFixed(1)} × ${scene.geometry.W.toFixed(1)} × ${scene.geometry.H.toFixed(1)} m</td></tr>
      <tr><td>Floor area</td><td class="num">${(scene.geometry.L * scene.geometry.W).toFixed(1)} m²</td></tr>
      <tr><td>Volume</td><td class="num">${(scene.geometry.L * scene.geometry.W * scene.geometry.H).toFixed(1)} m³</td></tr>
      <tr><td>Outdoor / Setpoint</td><td class="num">${env.outdoor_temp_C} °C / ${env.setpoint_C} °C</td></tr>
      <tr><td>Outdoor RH</td><td class="num">${env.RH_outdoor_pct}%</td></tr>
      <tr><td>Met / Clo</td><td class="num">${env.met} / ${env.clo}</td></tr>
      <tr><td>Openings / Obstacles</td><td class="num">${scene.openings.length} / ${scene.obstacles.length}</td></tr>
    </table>
    <table>
      <tr><th>Cooling load (ASHRAE)</th><th></th></tr>
      <tr><td>Walls</td><td class="num">${Math.round(heatLoad.Q_walls)} W</td></tr>
      <tr><td>Glass / Windows</td><td class="num">${Math.round(heatLoad.Q_glass)} W</td></tr>
      <tr><td>Solar gain</td><td class="num">${Math.round(heatLoad.Q_solar)} W</td></tr>
      <tr><td>Roof / ceiling</td><td class="num">${Math.round(heatLoad.Q_roof)} W</td></tr>
      <tr><td>Occupants (sensible)</td><td class="num">${Math.round(heatLoad.Q_occ_sens)} W (${heatLoad.n_persons} pax)</td></tr>
      <tr><td>Appliances</td><td class="num">${Math.round(heatLoad.Q_app)} W</td></tr>
      <tr><td>Infiltration</td><td class="num">${Math.round(heatLoad.Q_infil)} W</td></tr>
      <tr><td>Latent</td><td class="num">${Math.round(heatLoad.Q_lat)} W</td></tr>
      <tr><td><strong>Total</strong></td><td class="num"><strong>${Math.round(heatLoad.Q_total)} W (${heatLoad.TR.toFixed(2)} TR)</strong></td></tr>
    </table>
  </div>

  <h2>2. Recommended AC Configuration</h2>
  ${ac.length === 0
    ? `<p class="stub">No AC units placed. Use the in-app <em>Optimize AC</em> button to generate a recommendation.</p>`
    : `<table>
        <tr><th>#</th><th>Wall</th><th>Position</th><th>Capacity</th><th>Type</th><th>Throw</th><th>Angle</th><th>State</th></tr>
        ${ac.map((a, i) => `<tr>
          <td>${i + 1}</td>
          <td>${a.wall}</td>
          <td class="num">x=${a.x.toFixed(2)}, z=${a.z.toFixed(2)}</td>
          <td class="num">${a.kw.toFixed(2)} kW (${(a.capacity_tr ?? a.kw / 3.517).toFixed(2)} TR)</td>
          <td>${a.type ?? "split"}</td>
          <td class="num">${(a.throw_distance_m ?? 4).toFixed(1)} m</td>
          <td class="num">${a.airflow_angle_deg ?? 0}°</td>
          <td>${a.on === false ? "off" : "on"}</td>
        </tr>`).join("")}
       </table>`
  }

  <h2>3. Comfort at ASHRAE 55 sampling heights</h2>
  <table>
    <tr><th>Height</th><th class="num" style="text-align:right">Mean T</th><th class="num" style="text-align:right">Mean V</th><th class="num" style="text-align:right">PMV</th><th class="num" style="text-align:right">PPD</th><th class="num" style="text-align:right">Op T</th><th class="num" style="text-align:right">Max DR</th></tr>
    ${comfortRow("0.1 m (ankle)", ackleR)}
    ${comfortRow("0.6 m (waist)", waistR)}
    ${comfortRow("1.1 m (head)", headR)}
  </table>
  <p class="small">
    Vertical air-temperature difference (head − ankle): <strong>${signed(comfort.verticalDeltaT, 2)} °C</strong>
    ${Math.abs(comfort.verticalDeltaT) > 3 ? `<span class="badge b-bad">exceeds ISO 7730 limit (3 °C)</span>` : `<span class="badge b-good">within ISO 7730 limit</span>`}
  </p>
  <p class="small">
    Mean radiant T (used in PMV / Op T): ${comfort.ctx.tRad.toFixed(2)} °C, RH ${comfort.ctx.rh}% · met ${comfort.ctx.met} · clo ${comfort.ctx.clo} · turbulence intensity ${comfort.ctx.tu}%.
  </p>
  <p class="small">
    Field aggregates: mean T ${metrics.mean.toFixed(1)} °C · std ${metrics.std.toFixed(2)} °C · hot zones ${metrics.hot.toFixed(1)}% · max V ${metrics.maxSpd.toFixed(2)} m/s · max DR ${Math.round(maxDR)}%.
  </p>

  <h2>4. Energy &amp; Cost</h2>
  <p class="stub">[Phase 3 — energy &amp; cost module not yet implemented. Tariff: ${env.tariff_per_kwh}, CO₂ factor: ${env.co2_per_kwh_kg} kg/kWh.]</p>

  <h2>5. Validation Status</h2>
  <p class="stub">[Tier 2 backend — no OpenFOAM / ANSYS run associated with this snapshot.]</p>

  <div class="footer">
    Generated by HVAC CFD Optimization &amp; Validation System (Tier 1) ·
    Scene hash: <code>${sceneHash.slice(0, 16)}…</code> ·
    Schema v${scene.schema_version} ·
    Tier 1 transient evolution is qualitative; quantitative validation requires Tier 2 (PLAN.md §2).
  </div>
</div>`;
}

function comfortRow(label: string, h: { meanT: number; meanV: number; meanPMV: number; meanPPD: number; meanOpT: number; maxDR: number }): string {
  const pmvBadge = comfortBadge("pmv", h.meanPMV);
  const ppdBadge = comfortBadge("ppd", h.meanPPD);
  const drBadge  = comfortBadge("dr",  h.maxDR);
  return `<tr>
    <td>${label}</td>
    <td class="num">${h.meanT.toFixed(1)} °C</td>
    <td class="num">${h.meanV.toFixed(2)} m/s</td>
    <td class="num">${signed(h.meanPMV, 2)} ${pmvBadge}</td>
    <td class="num">${Math.round(h.meanPPD)}% ${ppdBadge}</td>
    <td class="num">${h.meanOpT.toFixed(1)} °C</td>
    <td class="num">${Math.round(h.maxDR)}% ${drBadge}</td>
  </tr>`;
}

function comfortBadge(kind: "pmv" | "ppd" | "dr", v: number): string {
  if (kind === "pmv") {
    const a = Math.abs(v);
    if (a < 0.5) return `<span class="badge b-good">neutral</span>`;
    if (a < 1.0) return `<span class="badge b-warn">slight</span>`;
    return `<span class="badge b-bad">high</span>`;
  }
  if (kind === "ppd") {
    if (v < 10) return `<span class="badge b-good">cat A</span>`;
    if (v < 20) return `<span class="badge b-warn">cat B</span>`;
    return `<span class="badge b-bad">cat C+</span>`;
  }
  if (v < 10) return `<span class="badge b-good">low</span>`;
  if (v < 20) return `<span class="badge b-warn">mod</span>`;
  return `<span class="badge b-bad">high</span>`;
}

function signed(n: number, p: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(p);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]!);
}
