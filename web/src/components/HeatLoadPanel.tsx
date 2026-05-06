"use client";

import { useState } from "react";
import type { HeatLoad } from "@/lib/ashrae/heatLoad";

export function HeatLoadPanel({ hl }: { hl: HeatLoad }) {
  const [open, setOpen] = useState(true);
  const fmt = (v: number) => `${Math.round(v)}W`;
  return (
    <div className="border-b border-[var(--color-border-3)] px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between text-[8.5px] font-bold uppercase tracking-[0.14em] text-[var(--color-ink-6)]">
        <span>Heat Load (ASHRAE)</span>
        <span
          className="cursor-pointer px-1 text-[9px] text-[var(--color-ink-7)]"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "▾" : "▸"}
        </span>
      </div>
      {open && (
        <div className="flex flex-col">
          <Row label="Walls"            value={fmt(hl.Q_walls)} />
          <Row label="Glass/Windows"    value={fmt(hl.Q_glass)} />
          <Row label="Solar Gain"       value={fmt(hl.Q_solar)} />
          <Row label="Roof/Ceiling"     value={fmt(hl.Q_roof)} />
          <Row label="Occupants (sens)" value={`${fmt(hl.Q_occ_sens)} (${hl.n_persons} pax)`} />
          <Row label="Appliances"       value={fmt(hl.Q_app)} />
          <Row label="Infiltration"     value={fmt(hl.Q_infil)} />
          <Row label="Latent Load"      value={fmt(hl.Q_lat)} last />
          <div className="mt-1 flex items-center justify-between rounded border border-[#164020] bg-[#0a1e10] px-1.5 py-1">
            <div>
              <div className="text-[8.5px] text-[#1e4028]">Cooling Load</div>
              <div className="text-[13px] font-bold text-[var(--color-accent-green-2)]">
                {hl.TR.toFixed(2)} TR
              </div>
            </div>
            <div className="text-right">
              <div className="text-[8.5px] text-[#1e4028]">Total W</div>
              <div className="rounded border border-[#152840] bg-[#071424] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-accent-cyan)]">
                {Math.round(hl.Q_total)} W
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div
      className={`flex justify-between py-[1.5px] text-[9px] ${
        last ? "" : "border-b border-[#080e16]"
      }`}
    >
      <span className="text-[var(--color-ink-6)]">{label}</span>
      <span className="tabular-nums text-[var(--color-ink-2)]">{value}</span>
    </div>
  );
}
