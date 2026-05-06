"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Room3D, type Selection, type ToolKind } from "./Room3D";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";
import { ExportModal } from "./ExportModal";
import { ComparisonView } from "./ComparisonView";
import { MultiACOptimizerModal } from "./MultiACOptimizerModal";
import { OnboardingTour } from "./OnboardingTour";
import { defaultScene, type Scene, type Wall } from "@/lib/io/schema";
import { useCFDSim } from "@/lib/cfd/useCFDSim";
import type { CFDBackend } from "@/lib/cfd/workerClient";
import { calcHeatLoad } from "@/lib/ashrae/heatLoad";
import { runOptimizer } from "@/lib/optimizer/runOptimizer";
import type { SimView } from "@/lib/geometry/buildOverlays";
import { captureSnapshot, type CapturedSnapshot } from "@/lib/comparison/captureSnapshot";
import { exportComfortPDF } from "@/lib/report/exportPDF";
import { parseSTLFile } from "@/lib/geometry/stlImport";

export function AppShell() {
  const [scene, setScene]       = useState<Scene>(() => defaultScene());
  const [selection, setSelection] = useState<Selection>({ id: null, type: null });
  const [curTool, setCurTool]   = useState<ToolKind>("orbit");
  const [simView, setSimView]   = useState<SimView>("both");
  // Default backend: MAC, so the browser product starts on the honest
  // staggered-grid solver while Legacy remains available as a baseline.
  const [backend, setBackend]   = useState<CFDBackend>("mac");
  const [exportOpen, setExportOpen] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [multiOpen, setMultiOpen]     = useState(false);
  const [reporting, setReporting]     = useState(false);
  const [slotA, setSlotA] = useState<CapturedSnapshot | null>(null);
  const [slotB, setSlotB] = useState<CapturedSnapshot | null>(null);
  // STL-as-room view controls. Both apply only when an STL with role==="room"
  // exists in scene.geometry.stl; the Toolbar hides the controls otherwise.
  const [hideRoof, setHideRoof] = useState(false);
  const [clipY,    setClipY]    = useState(0);   // 0 = no clip, otherwise world-Y in metres
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hasRoomSTL = scene.geometry.stl.some((s) => s.role === "room");

  const sim = useCFDSim();
  const hl  = useMemo(() => calcHeatLoad(scene), [scene]);

  // Register the PWA service worker on first mount. Best-effort — if the
  // browser doesn't support SW or registration fails, the app still works.
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[pwa] service worker registration failed:", err);
    });
  }, []);

  // Effective AC list for the CFD worker. Empty when the user has placed
  // no AC units — the simulation then runs in passive mode (no jet
  // forcing, no cold-air supply), which is the correct baseline for
  // natural-convection / infiltration studies.
  const effectiveAc: { x: number; z: number; wall: Wall }[] = useMemo(
    () =>
      scene.ac_units
        .filter((a) => a.on !== false)
        .map((a) => ({ x: a.x, z: a.z, wall: a.wall })),
    [scene.ac_units],
  );

  const onRun = () => {
    if (sim.simRunning) sim.stop();
    else sim.start(scene, effectiveAc, backend, sim.durationS);
  };
  const onReset = () => sim.reset();

  const onCapture = (slot: "A" | "B", label: string): boolean => {
    const snap = sim.snapshotRef.current;
    if (!snap) return false;
    const cap = captureSnapshot(scene, snap, canvasRef.current, label);
    if (slot === "A") setSlotA(cap); else setSlotB(cap);
    return true;
  };
  const onClearSlot = (slot: "A" | "B") => {
    if (slot === "A") setSlotA(null); else setSlotB(null);
  };

  const onImportSTL = async (file: File, asRoom = false) => {
    try {
      const id = (Math.max(0, ...scene.openings.map((o) => o.id),
                              ...scene.obstacles.map((o) => o.id),
                              ...scene.geometry.stl.map((s) => s.id)) || 0) + 1;
      const stl = await parseSTLFile(file, id, { asRoom });

      // Only one "room" STL makes sense per scene — if the user imports
      // a new room, demote any existing room to "obstacle" so the new
      // one wins. (Don't drop them; the user might want the old one as
      // furniture.)
      let nextStl = scene.geometry.stl;
      if (asRoom) {
        nextStl = nextStl.map((s) =>
          s.role === "room" ? { ...s, role: "obstacle" as const } : s,
        );
      }

      // When the new STL is the room, auto-fit geometry.L/W/H to its
      // post-scale bounding-box footprint so the cuboidal world matches
      // the STL's extents (used by the existing voxelizer until day-3
      // brings the proper inside-test).
      let nextGeometry = { ...scene.geometry, stl: [...nextStl, stl] };
      if (asRoom && stl.bbox) {
        const s = stl.scale || 1;
        const Lnew = Math.max(0.5, s * (stl.bbox.maxX - stl.bbox.minX));
        const Wnew = Math.max(0.5, s * (stl.bbox.maxZ - stl.bbox.minZ));
        const Hnew = Math.max(0.5, s * (stl.bbox.maxY - stl.bbox.minY));
        nextGeometry = { ...nextGeometry, L: Lnew, W: Wnew, H: Hnew };
      }

      setScene({ ...scene, geometry: nextGeometry });
    } catch (err) {
      console.error("STL import failed:", err);
      alert(`STL import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const onReport = async () => {
    const snap = sim.snapshotRef.current;
    if (!snap) return;
    setReporting(true);
    try {
      const cap = captureSnapshot(scene, snap, canvasRef.current, "Current scene");
      await exportComfortPDF(cap);
    } catch (err) {
      console.error("PDF export failed:", err);
      alert("PDF export failed — see browser console.");
    } finally {
      setReporting(false);
    }
  };

  const onOptimize = async () => {
    setOptimizing(true);
    await new Promise((r) => setTimeout(r, 30));
    try {
      const res = runOptimizer(scene);
      if (res.best) {
        // Write optimizer result into scene.ac_units. If user has no AC,
        // create one. Otherwise reposition the first one to the optimum.
        let nextUnits = scene.ac_units;
        if (nextUnits.length === 0) {
          const id = (Math.max(0, ...scene.openings.map((o) => o.id),
                                ...scene.obstacles.map((o) => o.id)) || 0) + 1;
          // Use 1.8 m mounting for STL rooms (chimney-aware), 88%·H otherwise.
          const defaultMountY = hasRoomSTL
            ? Math.min(1.8, scene.geometry.H - 0.3)
            : undefined;
          nextUnits = [{
            id, wall: res.best.wall, x: res.best.x, z: res.best.z,
            mounting_height_m: defaultMountY,
            kw: 1.5, capacity_tr: 0.43, type: "split",
            throw_distance_m: 4.0, airflow_angle_deg: 0, vertical_angle_deg: -5, flow_rate_cfm: 350,
            supply_temp_C: 14,
            on: true,
          }];
        } else {
          nextUnits = nextUnits.map((a, i) =>
            i === 0 ? { ...a, wall: res.best!.wall, x: res.best!.x, z: res.best!.z } : a,
          );
        }
        const nextScene = { ...scene, ac_units: nextUnits };
        setScene(nextScene);
        const nextEff = nextUnits.filter((a) => a.on !== false)
          .map((a) => ({ x: a.x, z: a.z, wall: a.wall }));
        sim.start(nextScene, nextEff.length ? nextEff : effectiveAc, backend, sim.durationS);
      }
    } finally {
      setOptimizing(false);
    }
  };

  return (
    <div className="flex h-screen flex-col">
      <Toolbar
        curTool={curTool} setCurTool={setCurTool}
        acCount={scene.ac_units.length}
        simRunning={sim.simRunning}
        simView={simView} setSimView={setSimView}
        backend={backend} setBackend={setBackend}
        durationS={sim.durationS} setDurationS={sim.setDuration}
        onRun={onRun} onReset={onReset}
        onOptimize={onOptimize} optimizing={optimizing}
        onMultiOptimize={() => setMultiOpen(true)}
        onExport={() => setExportOpen(true)}
        onCompare={() => setCompareOpen(true)}
        onReport={onReport}
        onImportSTL={onImportSTL}
        reporting={reporting}
        hasSnapshot={!!sim.metrics}
        hasRoomSTL={hasRoomSTL}
        hideRoof={hideRoof} setHideRoof={setHideRoof}
        clipY={clipY} setClipY={setClipY} roomH={scene.geometry.H}
      />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          scene={scene} setScene={setScene}
          selection={selection} setSelection={setSelection}
          metrics={sim.metrics} simStep={sim.simStep}
          simRunning={sim.simRunning}
          simView={simView}
          elapsedS={sim.elapsedS} durationS={sim.durationS}
          hl={hl}
          subscribeSnapshot={sim.subscribe}
          curTool={curTool} setCurTool={setCurTool}
        />
        <main className="relative flex-1 overflow-hidden">
          <Room3D
            scene={scene} setScene={setScene}
            selection={selection} setSelection={setSelection}
            curTool={curTool} setCurTool={setCurTool}
            simView={simView} simRunning={sim.simRunning}
            ac={effectiveAc}
            subscribeSnapshot={sim.subscribe}
            onCanvasMount={(c) => { canvasRef.current = c; }}
            hideRoof={hideRoof} clipY={clipY}
          />
          <Hint curTool={curTool} acCount={scene.ac_units.length} />
        </main>
      </div>
      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        scene={scene}
        ac={effectiveAc}
        onLoadScene={(s) => {
          // Stop any running sim, clear cached snapshots, then swap in
          // the loaded scene wholesale.
          if (sim.simRunning) sim.stop();
          setScene(s);
          setSelection({ id: null, type: null });
          setSlotA(null); setSlotB(null);
        }}
      />
      <ComparisonView
        open={compareOpen}
        onClose={() => setCompareOpen(false)}
        slotA={slotA} slotB={slotB}
        onCapture={onCapture}
        onClear={onClearSlot}
        canCapture={!!sim.metrics}
      />
      <OnboardingTour />
      <MultiACOptimizerModal
        open={multiOpen}
        onClose={() => setMultiOpen(false)}
        scene={scene}
        onApply={(acs) => {
          setScene({ ...scene, ac_units: acs });
          // Restart the simulation with the chosen layout
          const eff = acs.filter((a) => a.on !== false)
            .map((a) => ({ x: a.x, z: a.z, wall: a.wall }));
          sim.start({ ...scene, ac_units: acs }, eff, backend, sim.durationS);
        }}
      />
    </div>
  );
}

const HINTS: Record<ToolKind, string> = {
  orbit:     "🖱 Drag orbit · Scroll zoom · Click select · Delete removes",
  ac:        "❄ Click any wall to mount an AC unit · Drag to slide along wall",
  win:       "🪟 Click inner wall face",
  door:      "🚪 Click inner wall face",
  circ:      "⭕ Click wall",
  arch:      "🌉 Click wall",
  box:       "📦 Click floor",
  cyl:       "🔵 Click floor",
  shelf:     "📚 Click floor",
  human:     "🧑 Click floor — adds 75W sensible heat source",
  appliance: "⚡ Click floor — set Watts in Props",
  cfan:      "💨 Click floor (mounts to ceiling) · Set season in Props",
  tfan:      "🌀 Click floor — set direction in Props",
  polygon:   "▥ Click floor to plant vertices · Double-click or Enter to close · Esc cancels",
  restrict:  "▣ Click any wall to drop a restricted-surface patch · Esc cancels",
  stl:       "📐 Click 'Import STL' in the toolbar to load a mesh file",
};

function Hint({ curTool, acCount }: { curTool: ToolKind; acCount: number }) {
  let text = HINTS[curTool];
  if (curTool === "ac" && acCount >= 3) {
    text = "❄ Max 3 AC units placed · Delete one before placing another";
  }
  const isActive = curTool !== "orbit";
  return (
    <div
      className={`pointer-events-none absolute left-1/2 top-2.5 -translate-x-1/2 whitespace-nowrap rounded-2xl border bg-[rgba(4,8,18,0.94)] px-3 py-1 text-[10px] ${
        isActive
          ? "border-[var(--color-accent-blue-2)] text-[var(--color-accent-blue)]"
          : "border-[#142238] text-[var(--color-ink-6)]"
      }`}
    >
      {text}
    </div>
  );
}
