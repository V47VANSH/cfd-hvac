"use client";

import { useMemo, useState } from "react";
import { Room3D, type Selection, type ToolKind } from "./Room3D";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";
import { ExportModal } from "./ExportModal";
import { defaultScene, type Scene, type Wall } from "@/lib/io/schema";
import { useCFDSim } from "@/lib/cfd/useCFDSim";
import { calcHeatLoad } from "@/lib/ashrae/heatLoad";
import { runOptimizer } from "@/lib/optimizer/runOptimizer";
import type { SimView } from "@/lib/geometry/buildOverlays";

export function AppShell() {
  const [scene, setScene]       = useState<Scene>(() => defaultScene());
  const [selection, setSelection] = useState<Selection>({ id: null, type: null });
  const [curTool, setCurTool]   = useState<ToolKind>("orbit");
  const [simView, setSimView]   = useState<SimView>("both");
  const [exportOpen, setExportOpen] = useState(false);
  const [optimizing, setOptimizing] = useState(false);

  const sim = useCFDSim();
  const hl  = useMemo(() => calcHeatLoad(scene), [scene]);

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
    else sim.start(scene, effectiveAc);
  };
  const onReset = () => sim.reset();

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
          nextUnits = [{
            id, wall: res.best.wall, x: res.best.x, z: res.best.z,
            kw: 1.5, capacity_tr: 0.43, type: "split",
            throw_distance_m: 4.0, airflow_angle_deg: 0, flow_rate_cfm: 350,
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
        sim.start(nextScene, nextEff.length ? nextEff : effectiveAc);
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
        onRun={onRun} onReset={onReset}
        onOptimize={onOptimize} optimizing={optimizing}
        onExport={() => setExportOpen(true)}
      />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          scene={scene} setScene={setScene}
          selection={selection} setSelection={setSelection}
          metrics={sim.metrics} simStep={sim.simStep}
          simRunning={sim.simRunning}
          hl={hl}
        />
        <main className="relative flex-1 overflow-hidden">
          <Room3D
            scene={scene} setScene={setScene}
            selection={selection} setSelection={setSelection}
            curTool={curTool} setCurTool={setCurTool}
            simView={simView} simRunning={sim.simRunning}
            ac={effectiveAc}
            subscribeSnapshot={sim.subscribe}
          />
          <Hint curTool={curTool} acCount={scene.ac_units.length} />
        </main>
      </div>
      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        scene={scene}
        ac={effectiveAc}
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
