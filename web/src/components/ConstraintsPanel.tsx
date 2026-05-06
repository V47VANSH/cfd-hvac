"use client";

import { useState } from "react";
import type { Scene, Wall } from "@/lib/io/schema";
import type { ToolKind } from "@/components/Room3D";

interface Props {
  scene: Scene;
  setScene: (s: Scene) => void;
  curTool: ToolKind;
  setCurTool: (t: ToolKind) => void;
}

/**
 * Sidebar UI for the optimizer's hard constraints.
 *
 * Lets the user:
 *   - toggle each wall as Allowed/Denied for AC placement
 *   - set the minimum clearance between an AC and any obstacle
 *   - draw forbidden floor zones with the polygon tool
 *   - mark restricted wall patches (e.g. switchboards) with the surface tool
 *
 * Constraints are pure scene-data; they're already honoured by the
 * single-AC optimizer (runOptimizer.ts) and the multi-AC NSGA-II (nsga2.ts).
 */
export function ConstraintsPanel({ scene, setScene, curTool, setCurTool }: Props) {
  const [open, setOpen] = useState(true);
  const cs = scene.constraints;

  const setWallRule = (w: Wall, rule: "allow" | "deny") => {
    setScene({
      ...scene,
      constraints: {
        ...cs,
        wall_rules: { ...cs.wall_rules, [w]: rule },
        allowed_walls: rule === "deny"
          ? (cs.allowed_walls || ["S","N","E","W"]).filter((x) => x !== w)
          : Array.from(new Set([...(cs.allowed_walls || []), w])) as Wall[],
      },
    });
  };

  const setMinClearance = (v: number) => {
    setScene({ ...scene, constraints: { ...cs, min_clearance_m: v } });
  };

  const removeZone = (idx: number) => {
    setScene({
      ...scene,
      constraints: {
        ...cs,
        forbidden_zones: cs.forbidden_zones.filter((_, i) => i !== idx),
      },
    });
  };

  const removeRestricted = (idx: number) => {
    setScene({
      ...scene,
      constraints: {
        ...cs,
        restricted_surfaces: cs.restricted_surfaces.filter((_, i) => i !== idx),
      },
    });
  };

  return (
    <div className="border-b border-[var(--color-border-3)] px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between text-[8.5px] font-bold uppercase tracking-[0.14em] text-[var(--color-ink-6)]">
        <span>Constraints (optimizer)</span>
        <span
          className="cursor-pointer px-1 text-[9px] text-[var(--color-ink-7)]"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "▾" : "▸"}
        </span>
      </div>
      {open && (
        <div className="flex flex-col gap-1.5">
          {/* Wall rules */}
          <div>
            <div className="mb-0.5 text-[8.5px] uppercase tracking-[0.1em] text-[var(--color-ink-7)]">
              Walls allowed for AC
            </div>
            <div className="grid grid-cols-4 gap-1">
              {(["S","N","E","W"] as Wall[]).map((w) => {
                const allowed = cs.wall_rules?.[w] !== "deny";
                return (
                  <button
                    key={w}
                    onClick={() => setWallRule(w, allowed ? "deny" : "allow")}
                    className={`rounded border px-1 py-0.5 text-[10px] font-semibold transition-colors ${
                      allowed
                        ? "border-[#166028] bg-[#0b3018] text-[var(--color-accent-green)] hover:bg-[#0f3820]"
                        : "border-[#3a1010] bg-[#180808] text-[var(--color-accent-red)] hover:bg-[#241010]"
                    }`}
                    title={allowed ? "Click to deny this wall for AC placement" : "Click to allow this wall"}
                  >
                    {w}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Min clearance */}
          <div className="flex items-center gap-1.5">
            <label className="w-[64px] flex-shrink-0 text-[9.5px] text-[var(--color-ink-5)]">
              Min clear m
            </label>
            <input
              type="range" min={0} max={2} step={0.05}
              value={cs.min_clearance_m ?? 0.5}
              onChange={(e) => setMinClearance(parseFloat(e.target.value))}
              className="flex-1 min-w-0"
            />
            <span className="w-[36px] text-right tabular-nums text-[9.5px] text-[var(--color-ink-3)]">
              {(cs.min_clearance_m ?? 0.5).toFixed(2)}
            </span>
          </div>

          {/* Forbidden floor zones */}
          <div>
            <div className="mb-0.5 flex items-center justify-between">
              <span className="text-[8.5px] uppercase tracking-[0.1em] text-[var(--color-ink-7)]">
                Forbidden floor zones
              </span>
              <button
                onClick={() => setCurTool(curTool === "polygon" ? "orbit" : "polygon")}
                className={`rounded border px-1.5 py-0.5 text-[9.5px] transition-colors ${
                  curTool === "polygon"
                    ? "border-[var(--color-accent-red)] bg-[#240808] text-[var(--color-accent-red)]"
                    : "border-[#3a1010] bg-[#180808] text-[#a04848] hover:bg-[#241010]"
                }`}
                title="Click on the floor to place vertices · double-click or Enter to close · Esc to cancel"
              >
                {curTool === "polygon" ? "✕ Cancel" : "+ Draw zone"}
              </button>
            </div>
            {cs.forbidden_zones.length === 0 ? (
              <p className="text-[9px] text-[var(--color-ink-7)]">None</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {cs.forbidden_zones.map((z, i) => (
                  <li key={i} className="flex items-center justify-between rounded border border-[#3a1010] bg-[#100404] px-1.5 py-0.5 text-[9px]">
                    <span className="text-[var(--color-accent-red)]">
                      ▥ {z.shape}{z.vertices ? ` · ${z.vertices.length} pts` : ""}
                      {z.reason ? ` · ${z.reason}` : ""}
                    </span>
                    <button
                      onClick={() => removeZone(i)}
                      className="text-[#804040] hover:text-[var(--color-accent-red)]"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Restricted wall surfaces */}
          <div>
            <div className="mb-0.5 flex items-center justify-between">
              <span className="text-[8.5px] uppercase tracking-[0.1em] text-[var(--color-ink-7)]">
                Restricted wall patches
              </span>
              <button
                onClick={() => setCurTool(curTool === "restrict" ? "orbit" : "restrict")}
                className={`rounded border px-1.5 py-0.5 text-[9.5px] transition-colors ${
                  curTool === "restrict"
                    ? "border-[var(--color-accent-red)] bg-[#240808] text-[var(--color-accent-red)]"
                    : "border-[#3a1010] bg-[#180808] text-[#a04848] hover:bg-[#241010]"
                }`}
                title="Click any wall to drop a restricted patch (e.g. switchboard, beam)"
              >
                {curTool === "restrict" ? "✕ Cancel" : "+ Add patch"}
              </button>
            </div>
            {cs.restricted_surfaces.length === 0 ? (
              <p className="text-[9px] text-[var(--color-ink-7)]">None</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {cs.restricted_surfaces.map((rs, i) => (
                  <li key={i} className="flex items-center justify-between rounded border border-[#3a1010] bg-[#100404] px-1.5 py-0.5 text-[9px]">
                    <span className="text-[var(--color-accent-red)]">
                      ▣ {rs.wall} · {rs.uw.toFixed(1)}×{rs.vh.toFixed(1)}m
                      {rs.reason ? ` · ${rs.reason}` : ""}
                    </span>
                    <button
                      onClick={() => removeRestricted(i)}
                      className="text-[#804040] hover:text-[var(--color-accent-red)]"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
