"use client";

import type { Scene } from "@/lib/io/schema";
import type { FieldMetrics } from "@/lib/cfd/solver";
import type { Selection } from "@/components/Room3D";
import type { HeatLoad } from "@/lib/ashrae/heatLoad";
import { ObjectList } from "./ObjectList";
import { PropertyPanel } from "./PropertyPanel";
import { HeatLoadPanel } from "./HeatLoadPanel";

interface Props {
  scene: Scene;
  setScene: (s: Scene) => void;
  selection: Selection;
  setSelection: (s: Selection) => void;
  metrics: FieldMetrics | null;
  simStep: number;
  simRunning: boolean;
  hl: HeatLoad;
}

export function Sidebar({
  scene, setScene, selection, setSelection,
  metrics, simStep, simRunning, hl,
}: Props) {
  const setGeo = (k: "L" | "W" | "H", v: number) =>
    setScene({ ...scene, geometry: { ...scene.geometry, [k]: v } });
  const setEnv = (k: "outdoor_temp_C" | "setpoint_C", v: number) =>
    setScene({ ...scene, environment: { ...scene.environment, [k]: v } });

  return (
    <aside className="w-[260px] min-w-[260px] flex flex-col overflow-y-auto bg-[var(--color-bg-panel)] border-r border-[var(--color-border-2)]">
      <Section title="Main Room">
        <Slider label="Length"    value={scene.geometry.L} unit="m"   min={3} max={15} step={0.5}
                onChange={(v) => setGeo("L", v)} />
        <Slider label="Width"     value={scene.geometry.W} unit="m"   min={3} max={12} step={0.5}
                onChange={(v) => setGeo("W", v)} />
        <Slider label="Height"    value={scene.geometry.H} unit="m"   min={2} max={5}  step={0.1}
                onChange={(v) => setGeo("H", v)} />
        <Slider label="Outdoor"   value={scene.environment.outdoor_temp_C} unit="°C" min={25} max={48} step={1}
                onChange={(v) => setEnv("outdoor_temp_C", v)} />
        <Slider label="Set-point" value={scene.environment.setpoint_C}     unit="°C" min={18} max={28} step={1}
                onChange={(v) => setEnv("setpoint_C", v)} />
      </Section>

      <PropertyPanel
        scene={scene}
        setScene={setScene}
        selection={selection}
        setSelection={setSelection}
      />

      <Section title="Objects & Controls" grow>
        <ObjectList
          scene={scene}
          setScene={setScene}
          selection={selection}
          setSelection={setSelection}
        />
      </Section>

      <Section title="CFD Results">
        <ProgressBar step={simStep} max={500} />
        <Metric label="Mean Temp" value={metrics ? `${metrics.mean.toFixed(1)}°C` : "—"} />
        <Metric label="Std Dev"   value={metrics ? `${metrics.std.toFixed(2)}°C` : "—"} />
        <Metric label="Hot Zone"  value={metrics ? `${metrics.hot.toFixed(1)}%` : "—"}
                hot={!!metrics && metrics.hot > 20} />
        <Metric label="Max Flow"  value={metrics ? `${metrics.maxSpd.toFixed(2)} m/s` : "—"} />
        <ThermalLegend />
        <p className="mt-2 text-[9px] text-[var(--color-ink-7)]">
          {simRunning
            ? scene.ac_units.length === 0
              ? "Running passive (no AC) — natural convection only"
              : `Running with ${scene.ac_units.filter((a) => a.on !== false).length} AC unit${scene.ac_units.length === 1 ? "" : "s"}`
            : "Press Run CFD to start"}
        </p>
      </Section>

      <HeatLoadPanel hl={hl} />
    </aside>
  );
}

/* ── Shared building blocks ──────────────────────────────────────────── */

function Section({
  title, children, grow,
}: {
  title: string; children: React.ReactNode; grow?: boolean;
}) {
  return (
    <div className={`border-b border-[var(--color-border-3)] px-3 py-2 ${grow ? "flex-1" : ""}`}>
      <div className="mb-2 text-[8.5px] font-bold uppercase tracking-[0.14em] text-[var(--color-ink-6)]">
        {title}
      </div>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

function Slider({
  label, value, unit, min, max, step, onChange,
}: {
  label: string; value: number; unit: string;
  min: number; max: number; step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <label className="w-[52px] flex-shrink-0 text-[10px] text-[var(--color-ink-5)]">
        {label}
      </label>
      <input
        type="range"
        min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1"
      />
      <span className="w-[36px] text-right tabular-nums text-[9.5px] text-[var(--color-ink-3)]">
        {value.toFixed(unit === "°C" ? 0 : 1)}{unit}
      </span>
    </div>
  );
}

function ProgressBar({ step, max }: { step: number; max: number }) {
  const pct = Math.min(100, (step / max) * 100);
  return (
    <div className="my-1 h-0.5 rounded-sm bg-[#090e18]">
      <div
        className="h-full rounded-sm bg-[#305ab8] transition-[width] duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function Metric({ label, value, hot }: { label: string; value: string; hot?: boolean }) {
  return (
    <div className="flex justify-between border-b border-[#090e18] py-0.5 text-[10px]">
      <span className="text-[var(--color-ink-6)]">{label}</span>
      <span className={`tabular-nums font-medium ${hot ? "text-[var(--color-accent-red)]" : "text-[var(--color-accent-cyan)]"}`}>
        {value}
      </span>
    </div>
  );
}

function ThermalLegend() {
  return (
    <>
      <div className="my-1 flex h-1.5 overflow-hidden rounded-sm">
        <div className="flex-1 bg-[var(--color-therm-1)]" />
        <div className="flex-1 bg-[var(--color-therm-2)]" />
        <div className="flex-1 bg-[var(--color-therm-3)]" />
        <div className="flex-1 bg-[var(--color-therm-4)]" />
        <div className="flex-1 bg-[var(--color-therm-5)]" />
        <div className="flex-1 bg-[var(--color-therm-6)]" />
      </div>
      <div className="flex justify-between text-[8px] text-[var(--color-ink-6)]">
        <span>16°C</span><span>26°C</span><span>35°C</span><span>45°C</span>
      </div>
    </>
  );
}
