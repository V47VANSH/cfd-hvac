"use client";

import type { Scene } from "@/lib/io/schema";
import type { FieldMetrics } from "@/lib/cfd/solver";
import type { Selection } from "@/components/Room3D";
import type { HeatLoad } from "@/lib/ashrae/heatLoad";
import type { SimView } from "@/lib/geometry/buildOverlays";
import type { CFDSnapshot } from "@/lib/cfd/workerClient";
import type { ToolKind } from "@/components/Room3D";
import { ObjectList } from "./ObjectList";
import { PropertyPanel } from "./PropertyPanel";
import { HeatLoadPanel } from "./HeatLoadPanel";
import { ComfortPanel } from "./ComfortPanel";
import { EnergyPanel } from "./EnergyPanel";
import { ConstraintsPanel } from "./ConstraintsPanel";
import { MaterialPanel } from "./MaterialPanel";
import { Tier2Panel } from "./Tier2Panel";
import { useTier2 } from "@/lib/tier2/useTier2";
import { estimateEnergy } from "@/lib/energy/estimate";

interface Props {
  scene: Scene;
  setScene: (s: Scene) => void;
  selection: Selection;
  setSelection: (s: Selection) => void;
  metrics: FieldMetrics | null;
  simStep: number;
  simRunning: boolean;
  simView: SimView;
  /** Seconds of simulated time elapsed (NOT wall-clock). */
  elapsedS: number;
  /** Target duration in seconds. */
  durationS: number;
  hl: HeatLoad;
  subscribeSnapshot: (cb: (s: CFDSnapshot) => void) => () => void;
  curTool: ToolKind;
  setCurTool: (t: ToolKind) => void;
}

export function Sidebar({
  scene, setScene, selection, setSelection,
  metrics, simStep, simRunning, simView, elapsedS, durationS, hl, subscribeSnapshot,
  curTool, setCurTool,
}: Props) {
  void simStep;
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
        <SimClock elapsedS={elapsedS} durationS={durationS} simRunning={simRunning} />
        <Metric label="Mean Temp" value={metrics ? `${metrics.mean.toFixed(1)}°C` : "—"} />
        <Metric label="Std Dev"   value={metrics ? `${metrics.std.toFixed(2)}°C` : "—"} />
        <Metric label="Hot Zone"  value={metrics ? `${metrics.hot.toFixed(1)}%` : "—"}
                hot={!!metrics && metrics.hot > 20} />
        <Metric label="Max Flow"  value={metrics ? `${metrics.maxSpd.toFixed(2)} m/s` : "—"} />
        <ViewLegend view={simView} />
        <p className="mt-2 text-[9px] text-[var(--color-ink-7)]">
          {simRunning
            ? scene.ac_units.length === 0
              ? "Running passive (no AC) — natural convection only"
              : `Running with ${scene.ac_units.filter((a) => a.on !== false).length} AC unit${scene.ac_units.length === 1 ? "" : "s"}`
            : elapsedS > 0
              ? `Stopped at ${formatClock(elapsedS)} of simulated time`
              : "Press Run CFD to start"}
        </p>
      </Section>

      <ComfortPanel
        scene={scene}
        subscribeSnapshot={subscribeSnapshot}
        simRunning={simRunning}
      />

      <ConstraintsPanel
        scene={scene} setScene={setScene}
        curTool={curTool} setCurTool={setCurTool}
      />

      <MaterialPanel scene={scene} setScene={setScene} />
      <HeatLoadPanel hl={hl} />
      <EnergyPanel e={estimateEnergy(scene, hl)} scene={scene} setScene={setScene} />
      <Tier2Bridge scene={scene} />
    </aside>
  );
}

function Tier2Bridge({ scene }: { scene: Scene }) {
  const { status, health } = useTier2();
  return <Tier2Panel scene={scene} status={status} health={health} />;
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

function SimClock({
  elapsedS, durationS, simRunning,
}: {
  elapsedS: number; durationS: number; simRunning: boolean;
}) {
  const pct = durationS > 0 ? Math.min(100, (elapsedS / durationS) * 100) : 0;
  const labelColor = !simRunning && elapsedS >= durationS && durationS > 0
    ? "text-[var(--color-accent-green)]"
    : "text-[var(--color-accent-cyan)]";
  return (
    <div className="my-1">
      <div className="mb-0.5 flex items-baseline justify-between text-[9.5px]">
        <span className="text-[var(--color-ink-6)]">Sim time</span>
        <span className={`tabular-nums font-medium ${labelColor}`}>
          {formatClock(elapsedS)} / {formatClock(durationS)}
        </span>
      </div>
      <div className="h-1 rounded-sm bg-[#090e18]">
        <div
          className={`h-full rounded-sm transition-[width] duration-300 ${
            simRunning ? "bg-[#305ab8]" : "bg-[#1c5028]"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function formatClock(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const totalSec = Math.round(s);
  const m = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
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

function ViewLegend({ view }: { view: SimView }) {
  // Each entry: gradient (CSS), tick labels.
  const config = LEGENDS[view];
  return (
    <>
      <div className="my-1 h-1.5 overflow-hidden rounded-sm" style={{ background: config.gradient }} />
      <div className="flex justify-between text-[8px] text-[var(--color-ink-6)]">
        {config.ticks.map((t) => (
          <span key={t}>{t}</span>
        ))}
      </div>
    </>
  );
}

const LEGENDS: Record<SimView, { gradient: string; ticks: string[] }> = {
  both: {
    gradient: "linear-gradient(to right, var(--color-therm-1), var(--color-therm-2), var(--color-therm-3), var(--color-therm-4), var(--color-therm-5), var(--color-therm-6))",
    ticks: ["16°C", "26°C", "35°C", "45°C"],
  },
  therm: {
    gradient: "linear-gradient(to right, var(--color-therm-1), var(--color-therm-2), var(--color-therm-3), var(--color-therm-4), var(--color-therm-5), var(--color-therm-6))",
    ticks: ["16°C", "26°C", "35°C", "45°C"],
  },
  flow: {
    gradient: "linear-gradient(to right, rgb(0,20,60), rgb(0,80,180), rgb(0,190,255), rgb(200,240,255))",
    ticks: ["0", "1.5", "3.0", "4.5 m/s"],
  },
  pmv: {
    gradient: "linear-gradient(to right, rgb(32,72,200), rgb(96,168,232), rgb(220,232,232), rgb(240,168,88), rgb(216,32,32))",
    ticks: ["−3 cold", "0 neutral", "+3 hot"],
  },
  ppd: {
    gradient: "linear-gradient(to right, rgb(56,168,72), rgb(216,200,64), rgb(232,120,40), rgb(200,24,24))",
    ticks: ["0%", "30%", "60%", "100%"],
  },
  dr: {
    gradient: "linear-gradient(to right, rgb(24,88,144), rgb(80,196,232), rgb(232,168,72), rgb(216,56,144))",
    ticks: ["0%", "25%", "50%", "100%"],
  },
};
