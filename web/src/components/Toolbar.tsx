"use client";

import { useRef } from "react";
import { MAX_AC_UNITS, type ToolKind } from "@/components/Room3D";
import type { SimView } from "@/lib/geometry/buildOverlays";
import type { CFDBackend } from "@/lib/cfd/workerClient";

interface Props {
  curTool:    ToolKind;
  setCurTool: (t: ToolKind) => void;
  acCount:    number;
  simRunning: boolean;
  simView:    SimView;
  setSimView: (v: SimView) => void;
  backend:    CFDBackend;
  setBackend: (b: CFDBackend) => void;
  /** Target duration of the simulation, in seconds of *simulated* time. */
  durationS:    number;
  setDurationS: (d: number) => void;
  onRun:      () => void;
  onReset:    () => void;
  onOptimize: () => void;
  onMultiOptimize: () => void;
  onExport:   () => void;
  onCompare:  () => void;
  onReport:   () => void;
  /**
   * Pick + parse an STL file and add it to scene.geometry.stl.
   * `asRoom`: when true, the STL replaces the cuboidal default room
   * (becomes the simulation domain) instead of being added as an
   * interior obstacle.
   */
  onImportSTL: (file: File, asRoom?: boolean) => void;
  optimizing: boolean;
  reporting:  boolean;
  /** Disabled state for buttons that need a captured snapshot. */
  hasSnapshot: boolean;
  /** True when an STL with role==="room" exists in the scene; gates room-shell controls. */
  hasRoomSTL?: boolean;
  /** "Hide roof faces" toggle state (room STLs only). */
  hideRoof?: boolean;
  setHideRoof?: (v: boolean) => void;
  /** Y-height of the horizontal clip plane that peels the roof off (0 = floor, geo.H = ceiling). 0 disables the plane. */
  clipY?: number;
  setClipY?: (y: number) => void;
  /** Room height for the clip-plane slider's max value. */
  roomH?: number;
}

export function Toolbar({
  curTool, setCurTool, acCount, simRunning, simView, setSimView,
  backend, setBackend, durationS, setDurationS,
  onRun, onReset, onOptimize, onMultiOptimize, onExport, onCompare, onReport,
  onImportSTL,
  optimizing, reporting, hasSnapshot,
  hasRoomSTL = false,
  hideRoof = false, setHideRoof,
  clipY = 0, setClipY, roomH = 2.7,
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
        <STLImportButton onImport={onImportSTL} />
      </Group>

      {hasRoomSTL && (
        <Group label="Room view">
          <button
            onClick={() => setHideRoof?.(!hideRoof)}
            className={`flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded border px-2 py-0.5 text-[10.5px] ${
              hideRoof
                ? "border-[var(--color-accent-blue-2)] bg-[#0c2040] text-[var(--color-accent-blue)]"
                : "border-transparent text-[var(--color-ink-4)] hover:border-[#1a3858] hover:bg-[#0b1c30] hover:text-[var(--color-ink-2)]"
            }`}
            title="Hide topmost faces of the room STL so you can see inside from above"
          >
            🏠 {hideRoof ? "Roof hidden" : "Hide roof"}
          </button>
          <div
            className="flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded border border-transparent px-2 py-0.5 text-[10.5px] text-[var(--color-ink-4)]"
            title="Drag to peel a horizontal slice off the top of the room. Slider at max = full room visible."
          >
            <span>Clip</span>
            <input
              type="range"
              min={0} max={roomH} step={0.05}
              value={clipY > 0 ? clipY : roomH}
              onChange={(e) => {
                const v = parseFloat(e.currentTarget.value);
                setClipY?.(v >= roomH - 0.001 ? 0 : v);
              }}
              className="h-2 w-20"
            />
            <span className="w-7 text-right text-[9.5px] text-[var(--color-ink-7)]">
              {clipY > 0 ? clipY.toFixed(2) : "off"}
            </span>
          </div>
        </Group>
      )}

      <Group label="Heat Sources">
        <ToolButton id="human"     cur={curTool} set={setCurTool}>🧑 Human</ToolButton>
        <ToolButton id="appliance" cur={curTool} set={setCurTool}>⚡ Appliance</ToolButton>
      </Group>

      <Group label="Fans">
        <ToolButton id="cfan" cur={curTool} set={setCurTool}>💨 Ceiling Fan</ToolButton>
        <ToolButton id="tfan" cur={curTool} set={setCurTool}>🌀 Table Fan</ToolButton>
      </Group>

      <div className="ml-auto flex items-center gap-1.5 px-2">
        <DurationSelector durationS={durationS} setDurationS={setDurationS} simRunning={simRunning} />
        <BackendToggle backend={backend} setBackend={setBackend} simRunning={simRunning} />
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
          title="Single-AC sweep — fast, picks one position from the existing grid"
          className="rounded border border-[#284890] bg-[#121e4a] px-2.5 py-1 text-[10.5px] font-semibold text-[#5888e0] hover:bg-[#182660] disabled:opacity-40"
        >
          {optimizing ? "★ Optimizing…" : "★ Optimize AC"}
        </button>
        <button
          onClick={onMultiOptimize}
          title="Joint multi-AC NSGA-II — minimises comfort + energy simultaneously, returns a Pareto front"
          className="rounded border border-[#3a2870] bg-[#1a1238] px-2.5 py-1 text-[10.5px] font-semibold text-[#9078e0] hover:bg-[#221848]"
        >
          ⚙ Multi-AC
        </button>
        <button
          onClick={onCompare}
          className="rounded border border-[#3a2870] bg-[#1a1238] px-2.5 py-1 text-[10.5px] font-semibold text-[#9078e0] hover:bg-[#221848]"
        >
          📊 Compare
        </button>
        <button
          onClick={onReport}
          disabled={reporting || !hasSnapshot}
          title={hasSnapshot ? "" : "Run the CFD first to generate a comfort report"}
          className="rounded border border-[#603018] bg-[#2a1408] px-2.5 py-1 text-[10.5px] font-semibold text-[#e89060] hover:bg-[#3a1c0c] disabled:opacity-40"
        >
          {reporting ? "📄 Building…" : "📄 Report"}
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

function STLImportButton({ onImport }: { onImport: (f: File, asRoom?: boolean) => void }) {
  // Single hidden file input; the two visible buttons set a ref before
  // triggering it. Avoids the hydration mismatch we saw with two
  // <input>/<label> pairs (Turbopack's SSR + client bundles seem to
  // disagree on element ordering when the JSX has multiple sibling
  // <label htmlFor> pointing at sibling <input>s).
  const inputRef = useRef<HTMLInputElement | null>(null);
  const asRoomRef = useRef(false);
  const click = (asRoom: boolean) => {
    asRoomRef.current = asRoom;
    inputRef.current?.click();
  };
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".stl,model/stl,application/sla,application/octet-stream"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onImport(f, asRoomRef.current);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => click(false)}
        className="flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded border border-transparent px-2 py-0.5 text-[10.5px] text-[var(--color-ink-4)] hover:border-[#1a3858] hover:bg-[#0b1c30] hover:text-[var(--color-ink-2)] cursor-pointer"
        title="Import an STL as an interior obstacle (furniture, equipment)"
      >
        📐 Import STL
      </button>
      <button
        type="button"
        onClick={() => click(true)}
        className="flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded border border-transparent px-2 py-0.5 text-[10.5px] text-[var(--color-accent-blue)] hover:border-[var(--color-accent-blue-2)] hover:bg-[#0c2040] cursor-pointer"
        title="Import an STL as the room itself — replaces the cuboidal default. Cuboidal walls hide; the STL becomes the simulation domain."
      >
        🏠 Use STL as room
      </button>
    </>
  );
}

function DurationSelector({
  durationS, setDurationS, simRunning,
}: {
  durationS: number; setDurationS: (d: number) => void; simRunning: boolean;
}) {
  const presets: { s: number; label: string }[] = [
    { s:    60, label: "1 min" },
    { s:   300, label: "5 min" },
    { s:   600, label: "10 min" },
    { s:  1200, label: "20 min" },
    { s:  1800, label: "30 min" },
    { s:  3600, label: "1 hr" },
  ];
  return (
    <div
      className="mx-1 flex flex-shrink-0 items-center gap-1 rounded border border-[#1c3a44] px-1.5 py-0.5"
      title="How long the simulation runs (in simulated time, not wall-clock). Auto-stops at this duration."
    >
      <span className="text-[8.5px] uppercase tracking-[0.1em] text-[#3a607a]">⏱ Run for</span>
      <select
        value={durationS}
        onChange={(e) => setDurationS(parseInt(e.target.value, 10))}
        className="rounded border border-[#152438] bg-[var(--color-bg-row)] px-1 py-0 text-[10px] text-[#6cc0d8] outline-none focus:border-[#305090]"
      >
        {presets.map((p) => (
          <option key={p.s} value={p.s}>{p.label}</option>
        ))}
        {!presets.some((p) => p.s === durationS) && (
          <option value={durationS}>{formatDuration(durationS)}</option>
        )}
      </select>
      {simRunning && (
        <span className="text-[8.5px] text-[#3a607a]">(applied next run)</span>
      )}
    </div>
  );
}

function formatDuration(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h} hr` : `${h}h ${r}m`;
}

function BackendToggle({
  backend, setBackend, simRunning,
}: {
  backend: CFDBackend; setBackend: (b: CFDBackend) => void; simRunning: boolean;
}) {
  const opts: { id: CFDBackend; label: string; title: string }[] = [
    { id: "mac",         label: "MAC",       title: "Phase 2 solver: MAC + multigrid + semi-Lagrangian + Smagorinsky LES (CPU)" },
    { id: "mac-webgl2",  label: "GPU",       title: "Phase 2b: same MAC numerics on the GPU via WebGL2 (Jacobi pressure for v1; falls back to CPU MAC if unavailable)" },
    { id: "legacy",      label: "Legacy",    title: "v6-derived collocated solver (regression baseline)" },
  ];
  return (
    <div className="mx-1 flex flex-shrink-0 overflow-hidden rounded border border-[#3a2870]" title="Solver backend (takes effect on next Run)">
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => { if (!simRunning) setBackend(o.id); }}
          disabled={simRunning}
          title={o.title}
          className={`px-2 py-0.5 text-[10px] transition-colors disabled:opacity-50 ${
            backend === o.id
              ? "bg-[#1a1238] text-[#9078e0]"
              : "text-[var(--color-ink-4)] hover:bg-[#0e1e32] hover:text-[var(--color-ink-3)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ViewToggle({
  simView, setSimView,
}: {
  simView: SimView; setSimView: (v: SimView) => void;
}) {
  const opts: { id: SimView; label: string; title?: string }[] = [
    { id: "both",  label: "Both",    title: "Thermal + airflow" },
    { id: "flow",  label: "Airflow", title: "Speed map + arrows + particles" },
    { id: "therm", label: "Thermal", title: "Temperature map" },
    { id: "pmv",   label: "PMV",     title: "Predicted Mean Vote (Fanger)" },
    { id: "ppd",   label: "PPD",     title: "% Dissatisfied" },
    { id: "dr",    label: "Draft",   title: "Draft Risk (ISO 7730)" },
  ];
  return (
    <div className="mx-1 flex flex-shrink-0 overflow-hidden rounded border border-[#182840]">
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => setSimView(o.id)}
          title={o.title}
          className={`px-2 py-0.5 text-[10px] transition-colors ${
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
