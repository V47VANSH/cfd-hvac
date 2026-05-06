"use client";

import { useState } from "react";
import type { EnergyEstimate } from "@/lib/energy/estimate";
import type { Scene } from "@/lib/io/schema";
import { CLIMATE_PRESETS } from "@/lib/energy/climate";

interface Props {
  e: EnergyEstimate;
  scene: Scene;
  setScene: (s: Scene) => void;
}

export function EnergyPanel({ e, scene, setScene }: Props) {
  const [open, setOpen] = useState(true);
  const env = scene.environment;
  const setEnv = (patch: Partial<typeof env>) =>
    setScene({ ...scene, environment: { ...env, ...patch } });
  const climate = (env as { climate_preset?: string }).climate_preset ?? "default";

  return (
    <div className="border-b border-[var(--color-border-3)] px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between text-[8.5px] font-bold uppercase tracking-[0.14em] text-[var(--color-ink-6)]">
        <span>Energy &amp; Cost (annual)</span>
        <span
          className="cursor-pointer px-1 text-[9px] text-[var(--color-ink-7)]"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "▾" : "▸"}
        </span>
      </div>
      {open && (
        <div className="flex flex-col gap-1">
          {/* Climate picker */}
          <div className="flex items-center gap-1.5">
            <label className="w-[40px] flex-shrink-0 text-[9.5px] text-[var(--color-ink-5)]">City</label>
            <select
              value={climate}
              onChange={(e) => {
                const p = CLIMATE_PRESETS.find((c) => c.id === e.target.value);
                if (!p) return;
                setEnv({
                  climate_preset: p.id,
                  cooling_degree_hours: p.cdh,
                });
              }}
              className="flex-1 min-w-0 rounded border border-[#152438] bg-[var(--color-bg-row)] px-1 py-0.5 text-[10px] text-[#6090c0]"
            >
              {CLIMATE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <label className="w-[40px] flex-shrink-0 text-[9.5px] text-[var(--color-ink-5)]">COP</label>
            <input
              type="number" step={0.1} min={1.5} max={6}
              value={(env as { cop?: number }).cop ?? 3.0}
              onChange={(ev) => setEnv({ cop: parseFloat(ev.target.value) || 3.0 } as Partial<typeof env>)}
              className="flex-1 min-w-0 rounded border border-[#152438] bg-[var(--color-bg-row)] px-1 py-0.5 text-[10px] tabular-nums text-[#6090c0]"
            />
          </div>
          <Row label="Required AC"     value={`${e.required_TR.toFixed(2)} TR`} />
          <Row label="Run hours / yr"  value={`${Math.round(e.annual_runhours)} h`} />
          <Row label="CDH used"        value={`${Math.round(e.cdh)}`} />
          <Row label="COP assumed"     value={`${e.cop.toFixed(1)}`} />
          <Row label="Energy / yr"     value={`${Math.round(e.annual_kwh)} kWh`} />
          <Row label="Cost / yr"       value={`${Math.round(e.annual_cost)} ₹`} />
          <Row label="CO₂ / yr"        value={`${Math.round(e.annual_co2_kg)} kg`} last />
        </div>
      )}
    </div>
  );
}

function Row({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div
      className={`flex justify-between py-[1.5px] text-[9.5px] ${
        last ? "" : "border-b border-[#080e16]"
      }`}
    >
      <span className="text-[var(--color-ink-6)]">{label}</span>
      <span className="tabular-nums text-[var(--color-ink-2)]">{value}</span>
    </div>
  );
}
