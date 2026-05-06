"use client";

import { MAX_AC_UNITS, type ToolKind } from "@/components/Room3D";
import type { SimView } from "@/lib/geometry/buildOverlays";

interface Props {
  curTool:    ToolKind;
  setCurTool: (t: ToolKind) => void;
  acCount:    number;
  simRunning: boolean;
  simView:    SimView;
  setSimView: (v: SimView) => void;
  onRun:      () => void;
  onReset:    () => void;
  onOptimize: () => void;
  onExport:   () => void;
  optimizing: boolean;
}

export function Toolbar({
  curTool, setCurTool, acCount, simRunning, simView, setSimView,
  onRun, onReset, onOptimize, onExport, optimizing,
}: Props) {
  const acFull = acCount >= MAX_AC_UNITS;
  return (
    <div className="h-[44px] flex-shrink-0 flex items-center gap-1 overflow-x-auto border-b border-[var(--color-border-1)] bg-[var(--color-bg-panel)] px-2">
      <Group label="View">
        <ToolButton id="orbit" cur={curTool} set={setCurTool}>🖱 Orbit</ToolButton>
      </Group>

      <Group label="HVAC">
        <ToolButton
          id="ac" cur={curTool} set={setCurTool}
          disabled={acFull}
          title={acFull ? `Max ${MAX_AC_UNITS} AC units placed` : "Click any wall to mount an AC unit"}
        >
          ❄ AC Unit <span className="ml-1 text-[8.5px] text-[var(--color-ink-7)]">{acCount}/{MAX_AC_UNITS}</span>
        </ToolButton>
      </Group>

      <Group label="Openings">
        <ToolButton id="win"  cur={curTool} set={setCurTool}>🪟 Window</ToolButton>
        <ToolButton id="door" cur={curTool} set={setCurTool}>🚪 Door</ToolButton>
        <ToolButton id="circ" cur={curTool} set={setCurTool}>⭕ Round</ToolButton>
        <ToolButton id="arch" cur={curTool} set={setCurTool}>🌉 Arch</ToolButton>
      </Group>

      <Group label="Obstacles">
        <ToolButton id="box"   cur={curTool} set={setCurTool}>📦 Box</ToolButton>
        <ToolButton id="cyl"   cur={curTool} set={setCurTool}>🔵 Cylinder</ToolButton>
        <ToolButton id="shelf" cur={curTool} set={setCurTool}>📚 Shelf</ToolButton>
      </Group>

      <Group label="Heat Sources">
        <ToolButton id="human"     cur={curTool} set={setCurTool}>🧑 Human</ToolButton>
        <ToolButton id="appliance" cur={curTool} set={setCurTool}>⚡ Appliance</ToolButton>
      </Group>

      <Group label="Fans">
        <ToolButton id="cfan" cur={curTool} set={setCurTool}>💨 Ceiling Fan</ToolButton>
        <ToolButton id="tfan" cur={curTool} set={setCurTool}>🌀 Table Fan</ToolButton>
      </Group>

      <div className="ml-auto flex items-center gap-1.5 px-2">
        <ViewToggle simView={simView} setSimView={setSimView} />
        <button
          onClick={onReset}
          disabled={simRunning}
          className="rounded border border-[#182840] bg-[#0a1428] px-2.5 py-1 text-[10.5px] font-semibold text-[#407098] hover:bg-[#0e1c38] disabled:opacity-40"
        >
          ↺ Reset
        </button>
        <button
          onClick={onRun}
          className={`rounded border px-2.5 py-1 text-[10.5px] font-semibold ${
            simRunning
              ? "border-[#701808] bg-[#381008] text-[var(--color-accent-orange)] hover:bg-[#451206]"
              : "border-[#166028] bg-[#0b3018] text-[var(--color-accent-green)] hover:bg-[#0f3820]"
          }`}
        >
          {simRunning ? "⏹ Stop" : "▶ Run CFD"}
        </button>
        <button
          onClick={onOptimize}
          disabled={optimizing}
          className="rounded border border-[#284890] bg-[#121e4a] px-2.5 py-1 text-[10.5px] font-semibold text-[#5888e0] hover:bg-[#182660] disabled:opacity-40"
        >
          {optimizing ? "★ Optimizing…" : "★ Optimize AC"}
        </button>
        <button
          onClick={onExport}
          className="rounded border border-[#182840] bg-[#0a1428] px-2.5 py-1 text-[10.5px] font-semibold text-[#407098] hover:bg-[#0e1c38]"
        >
          ⚙ Export
        </button>
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-shrink-0 items-center gap-0.5 border-r border-[#0e1e32] px-1.5">
      <span className="px-0.5 text-[8.5px] uppercase tracking-[0.12em] text-[#1a304a]">
        {label}
      </span>
      {children}
    </div>
  );
}

function ToolButton({
  id, cur, set, children, disabled, title,
}: {
  id: ToolKind; cur: ToolKind; set: (t: ToolKind) => void;
  children: React.ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  const active = cur === id;
  return (
    <button
      onClick={() => { if (!disabled) set(active ? "orbit" : id); }}
      disabled={disabled}
      title={title}
      className={`flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded border px-2 py-0.5 text-[10.5px] transition-colors ${
        disabled
          ? "border-transparent text-[var(--color-ink-8)] cursor-not-allowed opacity-50"
          : active
          ? "border-[var(--color-accent-blue-2)] bg-[#0c2040] text-[var(--color-accent-blue)]"
          : "border-transparent text-[var(--color-ink-4)] hover:border-[#1a3858] hover:bg-[#0b1c30] hover:text-[var(--color-ink-2)]"
      }`}
    >
      {children}
    </button>
  );
}

function ViewToggle({
  simView, setSimView,
}: {
  simView: SimView; setSimView: (v: SimView) => void;
}) {
  const opts: { id: SimView; label: string }[] = [
    { id: "both",  label: "Both" },
    { id: "flow",  label: "Airflow" },
    { id: "therm", label: "Thermal" },
  ];
  return (
    <div className="mx-1 flex flex-shrink-0 overflow-hidden rounded border border-[#182840]">
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => setSimView(o.id)}
          className={`px-2.5 py-0.5 text-[10px] transition-colors ${
            simView === o.id
              ? "bg-[#0c2040] text-[var(--color-accent-blue)]"
              : "text-[var(--color-ink-4)] hover:bg-[#0e1e32] hover:text-[var(--color-ink-3)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
