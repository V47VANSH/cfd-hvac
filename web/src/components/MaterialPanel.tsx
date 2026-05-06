"use client";

import { useState } from "react";
import type { Scene, Wall } from "@/lib/io/schema";
import { MATERIAL_PRESETS, applyPreset } from "@/lib/ashrae/materials";

interface Props {
  scene: Scene;
  setScene: (s: Scene) => void;
}

export function MaterialPanel({ scene, setScene }: Props) {
  const [open, setOpen] = useState(false);
  const m = scene.materials ?? {};
  const setMat = (next: typeof m) =>
    setScene({ ...scene, materials: { ...m, ...next } });
  const setWallU = (w: Wall, u: number) =>
    setMat({ wall_u_values: { ...m.wall_u_values, [w]: u } });

  return (
    <div className="border-b border-[var(--color-border-3)] px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between text-[8.5px] font-bold uppercase tracking-[0.14em] text-[var(--color-ink-6)]">
        <span>Materials (envelope)</span>
        <span
          className="cursor-pointer px-1 text-[9px] text-[var(--color-ink-7)]"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "▾" : "▸"}
        </span>
      </div>
      {open && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <label className="w-[64px] flex-shrink-0 text-[9.5px] text-[var(--color-ink-5)]">Preset</label>
            <select
              value={m.preset ?? ""}
              onChange={(e) => {
                if (e.target.value === "") return;
                setScene({ ...scene, materials: applyPreset(e.target.value) });
              }}
              className="flex-1 min-w-0 rounded border border-[#152438] bg-[var(--color-bg-row)] px-1 py-0.5 text-[10px] text-[#6090c0]"
            >
              <option value="">— pick preset —</option>
              {MATERIAL_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </div>
          {m.preset && (
            <p className="text-[8.5px] italic text-[var(--color-ink-7)]">
              {MATERIAL_PRESETS.find((p) => p.id === m.preset)?.description}
            </p>
          )}
          <div className="mt-0.5 text-[8.5px] uppercase tracking-[0.1em] text-[var(--color-ink-7)]">
            Per-wall U (W/m²K)
          </div>
          <div className="grid grid-cols-2 gap-1">
            {(["S","N","E","W"] as Wall[]).map((w) => (
              <UField
                key={w}
                label={w}
                value={m.wall_u_values?.[w] ?? 2.8}
                onChange={(v) => setWallU(w, v)}
              />
            ))}
          </div>
          <UField
            label="Roof"
            value={m.roof_u_value ?? 2.0}
            onChange={(v) => setMat({ roof_u_value: v })}
          />
          <UField
            label="Floor"
            value={m.floor_u_value ?? 1.5}
            onChange={(v) => setMat({ floor_u_value: v })}
          />
        </div>
      )}
    </div>
  );
}

function UField({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-1">
      <label className="w-[40px] flex-shrink-0 text-[9.5px] text-[var(--color-ink-5)]">{label}</label>
      <input
        type="number"
        step={0.05}
        min={0.05} max={10}
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
        className="flex-1 min-w-0 rounded border border-[#152438] bg-[var(--color-bg-row)] px-1 py-0.5 text-[10px] tabular-nums text-[#6090c0]"
      />
    </div>
  );
}
