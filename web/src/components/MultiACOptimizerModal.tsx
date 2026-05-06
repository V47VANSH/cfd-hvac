"use client";

import { useState } from "react";
import type { Scene, ACUnit } from "@/lib/io/schema";
import { runMultiACOptimizer, individualToACUnits, type Individual } from "@/lib/optimizer/nsga2";
import { explainIndividual } from "@/lib/optimizer/explain";

interface Props {
  open: boolean;
  onClose: () => void;
  scene: Scene;
  /** Apply a chosen Pareto-front configuration back into the live scene. */
  onApply: (acs: ACUnit[]) => void;
}

export function MultiACOptimizerModal({ open, onClose, scene, onApply }: Props) {
  const [nAC, setNAC] = useState(2);
  const [running, setRunning] = useState(false);
  const [front, setFront] = useState<Individual[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [stats, setStats] = useState<{ generations: number; evaluations: number; ms: number } | null>(null);

  if (!open) return null;

  const run = async () => {
    setRunning(true);
    setFront([]); setSelectedIdx(null); setStats(null);
    // Yield once so the UI can paint "Running..."
    await new Promise((r) => setTimeout(r, 30));
    const t0 = performance.now();
    const result = runMultiACOptimizer(scene, {
      nAC, population: 14, generations: 6, stepsPerEval: 35,
    });
    const ms = performance.now() - t0;
    setFront(result.paretoFront);
    setStats({ generations: result.generations, evaluations: result.evaluations, ms });
    setRunning(false);
  };

  const apply = () => {
    if (selectedIdx === null) return;
    const ind = front[selectedIdx];
    if (!ind) return;
    const acs = individualToACUnits(ind, scene);
    onApply(acs);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[min(820px,96vw)] max-h-[92vh] overflow-y-auto rounded-lg border border-[#3a2870] bg-[var(--color-bg-panel)] p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[13px] text-[#9078e0]">⚙ Joint Multi-AC Optimizer (NSGA-II)</h3>
          <button
            onClick={onClose}
            className="rounded border border-[#142234] bg-[#070f1e] px-2 py-1 text-[10px] text-[#4878a0] hover:bg-[#0b182e]"
          >
            Close
          </button>
        </div>

        <p className="mb-3 text-[10px] text-[var(--color-ink-6)]">
          Multi-objective optimisation: minimise <strong>discomfort score</strong>{" "}
          AND <strong>annual energy</strong> simultaneously across joint placement,
          throw, angle, capacity and supply temperature for {nAC} AC units. Returns
          a Pareto front — pick the tradeoff you want.
        </p>

        <div className="mb-3 flex flex-wrap items-center gap-3 rounded border border-[#142238] bg-[#070f1e] p-2">
          <label className="flex items-center gap-1.5 text-[10px] text-[var(--color-ink-5)]">
            AC count
            <select
              value={nAC}
              onChange={(e) => setNAC(parseInt(e.target.value, 10))}
              disabled={running}
              className="rounded border border-[#152438] bg-[var(--color-bg-row)] px-1 py-0.5 text-[10px] text-[#6cc0d8]"
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </label>
          <button
            onClick={run}
            disabled={running}
            className="rounded border border-[#3a2870] bg-[#1a1238] px-3 py-1 text-[10.5px] font-semibold text-[#9078e0] hover:bg-[#221848] disabled:opacity-40"
          >
            {running ? "Running NSGA-II…" : "▶ Run Optimization"}
          </button>
          {stats && (
            <span className="text-[9px] text-[var(--color-ink-7)]">
              {stats.generations} gens · {stats.evaluations} evals · {(stats.ms / 1000).toFixed(1)}s
            </span>
          )}
        </div>

        {front.length > 0 && (
          <>
            <ParetoChart
              front={front}
              selectedIdx={selectedIdx}
              onSelect={setSelectedIdx}
            />
            <ParetoTable
              front={front}
              selectedIdx={selectedIdx}
              onSelect={setSelectedIdx}
            />
            {selectedIdx !== null && front[selectedIdx] && (
              <ExplanationPanel ind={front[selectedIdx]} />
            )}
            <div className="mt-3 flex items-center justify-between gap-2">
              <p className="text-[9.5px] text-[var(--color-ink-6)]">
                {selectedIdx !== null
                  ? `Selected: candidate #${selectedIdx + 1} — ${front[selectedIdx].acs.length} AC unit(s)`
                  : "Click a Pareto point or row to select."}
              </p>
              <button
                onClick={apply}
                disabled={selectedIdx === null}
                className="rounded border border-[#166028] bg-[#0b3018] px-3 py-1 text-[10.5px] font-semibold text-[var(--color-accent-green)] hover:bg-[#0f3820] disabled:opacity-40"
              >
                Apply selected layout
              </button>
            </div>
          </>
        )}

        {!running && front.length === 0 && (
          <p className="rounded border border-dashed border-[#142234] bg-[#040810] p-4 text-center text-[10px] text-[var(--color-ink-7)]">
            Pick the AC count and hit <strong>Run Optimization</strong>. NSGA-II will
            evaluate ~80 candidate configurations and return the Pareto front of
            non-dominated tradeoffs.
          </p>
        )}
      </div>
    </div>
  );
}

/* ─── Pareto chart (energy vs comfort score) ─────────────────────── */
function ParetoChart({
  front, selectedIdx, onSelect,
}: {
  front: Individual[];
  selectedIdx: number | null;
  onSelect: (i: number) => void;
}) {
  const w = 760, h = 220;
  const pad = 28;
  const xs = front.map((f) => f.J);
  const ys = front.map((f) => f.energy_kwh);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;
  const fx = (v: number) => pad + ((v - xMin) / xRange) * (w - 2 * pad);
  const fy = (v: number) => h - pad - ((v - yMin) / yRange) * (h - 2 * pad);
  return (
    <div className="mb-2 rounded border border-[#142234] bg-[#040810] p-2">
      <svg width={w} height={h} className="block">
        {/* axes */}
        <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="#1a304a" />
        <line x1={pad} y1={pad}     x2={pad}     y2={h - pad} stroke="#1a304a" />
        <text x={w / 2} y={h - 6} textAnchor="middle" fontSize="9" fill="#5078a0">
          Comfort score J  (lower = better) →
        </text>
        <text
          x={10} y={h / 2}
          fontSize="9" fill="#5078a0"
          transform={`rotate(-90 10 ${h / 2})`}
          textAnchor="middle"
        >
          ↓ Annual energy (kWh)
        </text>
        {/* points */}
        {front.map((f, i) => {
          const cx = fx(f.J), cy = fy(f.energy_kwh);
          const isSel = i === selectedIdx;
          return (
            <g key={i} style={{ cursor: "pointer" }} onClick={() => onSelect(i)}>
              <circle
                cx={cx} cy={cy}
                r={isSel ? 7 : 5}
                fill={isSel ? "#9078e0" : "#5890d8"}
                stroke={isSel ? "#fff" : "transparent"}
                strokeWidth={1.5}
              />
              <text x={cx + 8} y={cy + 3} fontSize="9" fill="#7898c8">
                #{i + 1}
              </text>
            </g>
          );
        })}
        {/* connect Pareto points with a line */}
        <polyline
          points={front
            .slice()
            .sort((a, b) => a.J - b.J)
            .map((f) => `${fx(f.J)},${fy(f.energy_kwh)}`)
            .join(" ")}
          fill="none"
          stroke="#3a2870"
          strokeWidth={1}
          strokeDasharray="3 2"
        />
      </svg>
    </div>
  );
}

/* ─── "Why this layout" explanation panel ────────────────────────── */
function ExplanationPanel({ ind }: { ind: Individual }) {
  const exp = explainIndividual(ind);
  return (
    <div className="mt-3 rounded border border-[#3a2870] bg-[#0a0810] p-2.5">
      <div className="mb-1 flex items-center gap-2">
        <span className="rounded bg-[#1a1238] px-1.5 py-0.5 text-[9px] font-bold text-[#9078e0]">
          ✨ Why this layout
        </span>
      </div>
      <p className="mb-1.5 text-[10.5px] font-medium text-[var(--color-ink-2)]">
        {exp.summary}
      </p>
      <p className="mb-1.5 text-[10px] leading-relaxed text-[var(--color-ink-4)]">
        {exp.reasoning}
      </p>
      {exp.strengths.length > 0 && (
        <div className="mb-1">
          <div className="text-[8.5px] uppercase tracking-[0.1em] text-[var(--color-accent-green-2)]">
            Strengths
          </div>
          <ul className="ml-3 list-disc text-[9.5px] text-[var(--color-ink-3)]">
            {exp.strengths.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}
      {exp.caveats.length > 0 && (
        <div>
          <div className="text-[8.5px] uppercase tracking-[0.1em] text-[var(--color-accent-orange)]">
            Caveats
          </div>
          <ul className="ml-3 list-disc text-[9.5px] text-[var(--color-ink-3)]">
            {exp.caveats.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ─── Pareto-front table ─────────────────────────────────────────── */
function ParetoTable({
  front, selectedIdx, onSelect,
}: {
  front: Individual[];
  selectedIdx: number | null;
  onSelect: (i: number) => void;
}) {
  return (
    <div className="rounded border border-[#142234] bg-[#040810] p-2">
      <table className="w-full text-[9.5px]">
        <thead>
          <tr className="text-[8.5px] uppercase tracking-[0.1em] text-[var(--color-ink-7)]">
            <th className="text-left">#</th>
            <th className="text-right">J</th>
            <th className="text-right">Energy</th>
            <th className="text-right">PPD worst</th>
            <th className="text-right">Mean T</th>
            <th className="text-right">Hot %</th>
            <th className="text-left pl-2">Layout</th>
          </tr>
        </thead>
        <tbody>
          {front.map((f, i) => (
            <tr
              key={i}
              onClick={() => onSelect(i)}
              className={`cursor-pointer hover:bg-[#0a1428] ${
                i === selectedIdx ? "bg-[#1a1238] text-[#9078e0]" : "text-[var(--color-ink-3)]"
              }`}
            >
              <td>#{i + 1}</td>
              <td className="text-right tabular-nums">{f.J.toFixed(3)}</td>
              <td className="text-right tabular-nums">{Math.round(f.energy_kwh)} kWh</td>
              <td className="text-right tabular-nums">
                {f.breakdown ? Math.round(f.breakdown.worstPPD) + "%" : "—"}
              </td>
              <td className="text-right tabular-nums">
                {f.breakdown ? f.breakdown.meanT.toFixed(1) + "°C" : "—"}
              </td>
              <td className="text-right tabular-nums">
                {f.breakdown ? f.breakdown.hotPct.toFixed(0) + "%" : "—"}
              </td>
              <td className="pl-2 text-[8.5px] text-[var(--color-ink-5)]">
                {f.acs.map((g, j) => (
                  <span key={j}>
                    {j > 0 && " · "}
                    {g.wall} {g.kw.toFixed(1)}kW@{g.supply_C.toFixed(0)}°C
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
