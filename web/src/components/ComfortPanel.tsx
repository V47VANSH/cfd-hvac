"use client";

import { useEffect, useState } from "react";
import type { Scene } from "@/lib/io/schema";
import type { CFDSnapshot } from "@/lib/cfd/workerClient";
import { buildComfortReport, makeComfortContext, type ComfortReport } from "@/lib/comfort";

interface Props {
  scene: Scene;
  subscribeSnapshot: (cb: (s: CFDSnapshot) => void) => () => void;
  simRunning: boolean;
}

export function ComfortPanel({ scene, subscribeSnapshot, simRunning }: Props) {
  const [report, setReport] = useState<ComfortReport | null>(null);

  useEffect(() => {
    const env = scene.environment;
    return subscribeSnapshot((snap) => {
      const ctx = makeComfortContext(snap.T, env.RH_outdoor_pct, env.met, env.clo);
      setReport(buildComfortReport(snap.T, snap.Vx, snap.Vy, snap.Vz, scene.geometry.H, ctx));
    });
  }, [subscribeSnapshot, scene.environment, scene.geometry.H]);

  return (
    <div className="border-b border-[var(--color-border-3)] px-3 py-2">
      <div className="mb-1.5 text-[8.5px] font-bold uppercase tracking-[0.14em] text-[var(--color-ink-6)]">
        Comfort (ISO 7730)
      </div>
      {!report ? (
        <p className="text-[9px] text-[var(--color-ink-7)]">
          {simRunning ? "Awaiting first snapshot…" : "Run CFD to compute comfort metrics."}
        </p>
      ) : (
        <>
          <table className="w-full border-separate" style={{ borderSpacing: "0 1px" }}>
            <thead>
              <tr className="text-[8px] uppercase tracking-[0.1em] text-[var(--color-ink-7)]">
                <th className="text-left">h</th>
                <th className="text-right">T</th>
                <th className="text-right">V</th>
                <th className="text-right">PMV</th>
                <th className="text-right">PPD</th>
                <th className="text-right">DR</th>
              </tr>
            </thead>
            <tbody>
              <Row label="0.1 m" h={report.ankle} />
              <Row label="0.6 m" h={report.waist} />
              <Row label="1.1 m" h={report.head} />
            </tbody>
          </table>
          <div className="mt-1.5 flex items-center justify-between rounded border border-[#1c2c1a] bg-[#0a140a] px-1.5 py-1">
            <span className="text-[8.5px] text-[#1e4028]">
              ΔT (head − ankle)
            </span>
            <span
              className={`tabular-nums text-[10px] font-semibold ${
                Math.abs(report.verticalDeltaT) > 3
                  ? "text-[var(--color-accent-red)]"
                  : "text-[var(--color-accent-green-2)]"
              }`}
              title={
                Math.abs(report.verticalDeltaT) > 3
                  ? "ISO 7730 threshold (3 °C) exceeded"
                  : "Within ISO 7730 limit"
              }
            >
              {report.verticalDeltaT >= 0 ? "+" : ""}
              {report.verticalDeltaT.toFixed(2)} °C
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function Row({
  label, h,
}: {
  label: string;
  h: { meanT: number; meanV: number; meanPMV: number; meanPPD: number; maxDR: number };
}) {
  return (
    <tr className="text-[9.5px]">
      <td className="text-[var(--color-ink-5)]">{label}</td>
      <td className="text-right tabular-nums text-[var(--color-ink-2)]">{h.meanT.toFixed(1)}°C</td>
      <td className="text-right tabular-nums text-[var(--color-ink-3)]">{h.meanV.toFixed(2)}</td>
      <td className={`text-right tabular-nums ${pmvColor(h.meanPMV)}`}>{fmt(h.meanPMV, 2)}</td>
      <td className={`text-right tabular-nums ${ppdColor(h.meanPPD)}`}>{Math.round(h.meanPPD)}%</td>
      <td className={`text-right tabular-nums ${drColor(h.maxDR)}`}>{Math.round(h.maxDR)}%</td>
    </tr>
  );
}

function fmt(n: number, p: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(p);
}

function pmvColor(pmv: number): string {
  const a = Math.abs(pmv);
  if (a < 0.5) return "text-[var(--color-accent-green-2)]";
  if (a < 1.0) return "text-[var(--color-accent-cyan)]";
  if (a < 2.0) return "text-[var(--color-accent-orange)]";
  return "text-[var(--color-accent-red)]";
}
function ppdColor(p: number): string {
  if (p < 10)  return "text-[var(--color-accent-green-2)]";
  if (p < 20)  return "text-[var(--color-accent-cyan)]";
  if (p < 50)  return "text-[var(--color-accent-orange)]";
  return "text-[var(--color-accent-red)]";
}
function drColor(d: number): string {
  if (d < 10)  return "text-[var(--color-accent-green-2)]";
  if (d < 20)  return "text-[var(--color-accent-cyan)]";
  if (d < 35)  return "text-[var(--color-accent-orange)]";
  return "text-[var(--color-accent-red)]";
}
