"use client";

import { useState } from "react";
import type { CapturedSnapshot } from "@/lib/comparison/captureSnapshot";

interface Props {
  open: boolean;
  onClose: () => void;
  slotA: CapturedSnapshot | null;
  slotB: CapturedSnapshot | null;
  /** Capture the current sim state into slot A or B. Returns true on success. */
  onCapture: (slot: "A" | "B", label: string) => boolean;
  /** Wipe a slot. */
  onClear: (slot: "A" | "B") => void;
  /** True iff there is a worker snapshot currently available to capture. */
  canCapture: boolean;
}

export function ComparisonView({ open, onClose, slotA, slotB, onCapture, onClear, canCapture }: Props) {
  const [labelA, setLabelA] = useState("Baseline");
  const [labelB, setLabelB] = useState("Optimized");

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[min(1100px,96vw)] max-h-[92vh] overflow-y-auto rounded-lg border border-[#182840] bg-[var(--color-bg-panel)] p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[13px] text-[var(--color-accent-blue)]">📊 Comparison View</h3>
          <button
            onClick={onClose}
            className="rounded border border-[#142234] bg-[#070f1e] px-2 py-1 text-[10px] text-[#4878a0] hover:bg-[#0b182e]"
          >
            Close
          </button>
        </div>
        <p className="mb-3 text-[10px] text-[var(--color-ink-6)]">
          Capture two simulation states (e.g. before vs after Optimize) and inspect the deltas side-by-side.
        </p>

        <div className="grid grid-cols-[1fr_1fr_120px] gap-2">
          <SlotCard
            slot="A" label={labelA} setLabel={setLabelA}
            captured={slotA} onCapture={onCapture} onClear={onClear} canCapture={canCapture}
          />
          <SlotCard
            slot="B" label={labelB} setLabel={setLabelB}
            captured={slotB} onCapture={onCapture} onClear={onClear} canCapture={canCapture}
          />
          <DeltaCard a={slotA} b={slotB} />
        </div>

        {(slotA || slotB) && (
          <details className="mt-3 rounded border border-[#0e1c30] bg-[var(--color-bg-deep)] p-2 text-[10px]" open>
            <summary className="cursor-pointer text-[10.5px] font-semibold text-[var(--color-ink-3)]">
              Comfort breakdown by sampling height
            </summary>
            <ComfortBreakdown a={slotA} b={slotB} />
          </details>
        )}
      </div>
    </div>
  );
}

function SlotCard({
  slot, label, setLabel, captured, onCapture, onClear, canCapture,
}: {
  slot: "A" | "B";
  label: string;
  setLabel: (s: string) => void;
  captured: CapturedSnapshot | null;
  onCapture: (slot: "A" | "B", label: string) => boolean;
  onClear: (slot: "A" | "B") => void;
  canCapture: boolean;
}) {
  return (
    <div className="rounded border border-[#142234] bg-[var(--color-bg-deep)] p-2">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="rounded bg-[#0c2040] px-1.5 py-0.5 text-[9px] font-bold text-[var(--color-accent-blue)]">
          Slot {slot}
        </span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="flex-1 rounded border border-[#0e1c30] bg-[#040810] px-1.5 py-0.5 text-[10px] text-[var(--color-ink-2)]"
          placeholder="Label"
        />
      </div>
      {captured ? (
        <>
          {captured.canvasPNG ? (
            <img
              src={captured.canvasPNG}
              alt={captured.label}
              className="mb-1.5 w-full rounded border border-[#0e1c30] bg-black"
            />
          ) : (
            <div className="mb-1.5 flex h-[140px] items-center justify-center rounded border border-[#0e1c30] bg-black text-[9px] text-[var(--color-ink-7)]">
              (no preview)
            </div>
          )}
          <SummaryGrid c={captured} />
          <div className="mt-1.5 flex gap-1">
            <button
              onClick={() => onCapture(slot, label)}
              disabled={!canCapture}
              className="flex-1 rounded border border-[#182e58] bg-[#0a203e] px-1.5 py-1 text-[9.5px] text-[#5890d8] hover:bg-[#102848] disabled:opacity-40"
            >
              ⟲ Recapture
            </button>
            <button
              onClick={() => onClear(slot)}
              className="rounded border border-[#3a1010] bg-[#180808] px-1.5 py-1 text-[9.5px] text-[#a04848] hover:bg-[#241010]"
            >
              ✕ Clear
            </button>
          </div>
          <p className="mt-1 text-[8.5px] text-[var(--color-ink-7)]">
            captured at step {captured.step} · {captured.capturedAt.replace("T", " ").slice(0, 19)}
          </p>
        </>
      ) : (
        <div className="flex flex-col items-stretch gap-1.5 py-2">
          <p className="text-center text-[9.5px] text-[var(--color-ink-7)]">Empty</p>
          <button
            onClick={() => onCapture(slot, label)}
            disabled={!canCapture}
            className="rounded border border-[#166028] bg-[#0b3018] px-2 py-1.5 text-[10px] font-semibold text-[var(--color-accent-green)] hover:bg-[#0f3820] disabled:opacity-40"
            title={canCapture ? "" : "Run the CFD first to capture a snapshot"}
          >
            ⤓ Capture current
          </button>
        </div>
      )}
    </div>
  );
}

function SummaryGrid({ c }: { c: CapturedSnapshot }) {
  return (
    <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
      <SummaryRow label="Mean T"   value={`${c.metrics.mean.toFixed(1)} °C`} />
      <SummaryRow label="Std T"    value={`${c.metrics.std.toFixed(2)} °C`} />
      <SummaryRow label="Hot %"    value={`${c.metrics.hot.toFixed(1)}%`} />
      <SummaryRow label="Max V"    value={`${c.metrics.maxSpd.toFixed(2)} m/s`} />
      <SummaryRow label="PMV (head)" value={fmtSigned(c.comfort.head.meanPMV)} />
      <SummaryRow label="PPD (head)" value={`${Math.round(c.comfort.head.meanPPD)}%`} />
      <SummaryRow label="Max DR"   value={`${Math.round(Math.max(c.comfort.ankle.maxDR, c.comfort.waist.maxDR, c.comfort.head.maxDR))}%`} />
      <SummaryRow label="Vert ΔT"  value={`${fmtSigned(c.comfort.verticalDeltaT)} °C`} />
      <SummaryRow label="Load"     value={`${c.heatLoad.TR.toFixed(2)} TR`} />
      <SummaryRow label="AC units" value={String(c.scene.ac_units.length)} />
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-[var(--color-ink-6)]">{label}</span>
      <span className="text-right tabular-nums text-[var(--color-ink-2)]">{value}</span>
    </>
  );
}

function DeltaCard({ a, b }: { a: CapturedSnapshot | null; b: CapturedSnapshot | null }) {
  if (!a || !b) {
    return (
      <div className="flex items-center justify-center rounded border border-dashed border-[#182840] p-2 text-center text-[9px] text-[var(--color-ink-7)]">
        Capture both slots to see deltas (B − A).
      </div>
    );
  }
  const rows = [
    ["Mean T",     b.metrics.mean   - a.metrics.mean,                     "°C"],
    ["Std T",      b.metrics.std    - a.metrics.std,                      "°C"],
    ["Hot %",      b.metrics.hot    - a.metrics.hot,                      "%" ],
    ["Max V",      b.metrics.maxSpd - a.metrics.maxSpd,                   "m/s"],
    ["PMV head",   b.comfort.head.meanPMV - a.comfort.head.meanPMV,       ""  ],
    ["PPD head",   b.comfort.head.meanPPD - a.comfort.head.meanPPD,       "%" ],
    ["Vert ΔT",    b.comfort.verticalDeltaT - a.comfort.verticalDeltaT,   "°C"],
    ["Load",       b.heatLoad.TR    - a.heatLoad.TR,                      "TR"],
  ] as const;
  return (
    <div className="rounded border border-[#142234] bg-[var(--color-bg-deep)] p-2">
      <div className="mb-1 text-center text-[8.5px] uppercase tracking-[0.12em] text-[var(--color-ink-6)]">
        Δ (B − A)
      </div>
      {rows.map(([label, d, unit]) => (
        <div key={label} className="flex items-center justify-between border-b border-[#080e16] py-0.5 text-[9.5px]">
          <span className="text-[var(--color-ink-6)]">{label}</span>
          <span className={`tabular-nums ${deltaColor(label, d)}`}>
            {fmtSigned(d, label === "PMV head" ? 2 : 1)}{unit ? ` ${unit}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

function ComfortBreakdown({ a, b }: { a: CapturedSnapshot | null; b: CapturedSnapshot | null }) {
  return (
    <div className="mt-1 grid grid-cols-2 gap-2">
      {[a, b].map((c, idx) => (
        <div key={idx} className="rounded border border-[#0e1c30] bg-[var(--color-bg-panel)] p-2">
          <div className="mb-1 text-[10px] font-semibold text-[var(--color-ink-3)]">
            Slot {idx === 0 ? "A" : "B"}{c ? ` — ${c.label}` : ""}
          </div>
          {c ? (
            <table className="w-full text-[9.5px]">
              <thead>
                <tr className="text-[8.5px] uppercase tracking-[0.1em] text-[var(--color-ink-7)]">
                  <th className="text-left">h</th>
                  <th className="text-right">T</th>
                  <th className="text-right">V</th>
                  <th className="text-right">PMV</th>
                  <th className="text-right">PPD</th>
                  <th className="text-right">DR</th>
                </tr>
              </thead>
              <tbody>
                {(["ankle", "waist", "head"] as const).map((h) => (
                  <tr key={h}>
                    <td className="text-[var(--color-ink-5)]">{c.comfort[h].y.toFixed(2)}m</td>
                    <td className="text-right tabular-nums">{c.comfort[h].meanT.toFixed(1)}</td>
                    <td className="text-right tabular-nums">{c.comfort[h].meanV.toFixed(2)}</td>
                    <td className="text-right tabular-nums">{fmtSigned(c.comfort[h].meanPMV, 2)}</td>
                    <td className="text-right tabular-nums">{Math.round(c.comfort[h].meanPPD)}%</td>
                    <td className="text-right tabular-nums">{Math.round(c.comfort[h].maxDR)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-[9px] text-[var(--color-ink-7)]">Empty.</p>
          )}
        </div>
      ))}
    </div>
  );
}

function fmtSigned(n: number, p = 2): string {
  return (n >= 0 ? "+" : "") + n.toFixed(p);
}

function deltaColor(label: string, d: number): string {
  // Lower is better for: Hot %, PPD, Std, |Vert ΔT|, |PMV|, Max V (sometimes)
  // Higher is better: Mean T can go either way (closer to setpoint is the
  // real signal — not encoded here). Use a simple "negative=good" rule for
  // dissatisfaction-style metrics; everything else is neutral grey.
  const goodIfNegative = ["Hot %", "PPD head", "Std T"];
  if (goodIfNegative.includes(label)) {
    if (d < -0.05) return "text-[var(--color-accent-green-2)]";
    if (d >  0.05) return "text-[var(--color-accent-red)]";
  }
  return "text-[var(--color-ink-2)]";
}
