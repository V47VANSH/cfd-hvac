"use client";

import { useEffect, useRef, useState } from "react";
import { migrateScene, sceneHash, type Scene } from "@/lib/io/schema";
import { calcHeatLoad } from "@/lib/ashrae/heatLoad";

interface Props {
  open: boolean;
  onClose: () => void;
  scene: Scene;
  ac: { x: number; z: number; wall: "S"|"N"|"E"|"W" }[];
  /**
   * Called when the user loads a JSON file or pastes JSON. The
   * environment is fully restored — geometry, openings, obstacles,
   * STL positions (Float32Array re-hydrated), AC units, constraints,
   * environment, materials. All Tier-1 features carry across.
   */
  onLoadScene?: (s: Scene) => void;
}

/**
 * Convert all Float32Array values inside `s` (notably STL positions)
 * to plain number arrays so JSON.stringify yields a real array, not the
 * `{"0":x,"1":y,...}` object pattern. The reverse conversion happens in
 * `hydrateScene` on load.
 */
function serialiseSceneForSave(s: Scene): unknown {
  return JSON.parse(JSON.stringify(s, (_k, v) => {
    if (v instanceof Float32Array || v instanceof Float64Array) return Array.from(v);
    return v;
  }));
}

/**
 * Re-hydrate a freshly-loaded Scene: convert any STL `positions` from
 * a plain number array (or the legacy `{"0":..,"1":..}` object form)
 * back to a Float32Array so the renderer + voxelizer accept it.
 */
function hydrateScene(raw: unknown): Scene {
  const s = migrateScene(raw) as Scene & { geometry: { stl?: Array<{ positions?: unknown }> } };
  if (s.geometry?.stl) {
    s.geometry.stl = s.geometry.stl.map((stl) => {
      const p = stl.positions;
      if (Array.isArray(p)) {
        return { ...stl, positions: new Float32Array(p) };
      }
      if (p && typeof p === "object") {
        // Legacy `{"0": x, "1": y, ...}` form (from older exports).
        const obj = p as unknown as Record<string, number>;
        const arr: number[] = [];
        const keys = Object.keys(obj).map(Number).sort((a, b) => a - b);
        for (const k of keys) arr.push(obj[String(k)]);
        return { ...stl, positions: new Float32Array(arr) };
      }
      return stl as Scene["geometry"]["stl"][number];
    }) as Scene["geometry"]["stl"];
  }
  return s as Scene;
}

function normaliseLoadedScene(s: Scene): Scene {
  const hasRoomSTL = s.geometry?.stl?.some((stl) => stl.role === "room") ?? false;
  if (!hasRoomSTL || !Array.isArray(s.ac_units) || s.geometry.H <= 3.5) return s;

  const defaultSplitMount = Math.min(1.8, Math.max(0.6, s.geometry.H - 0.3));
  let changed = false;
  const acUnits = s.ac_units.map((ac) => {
    if ((ac.type ?? "split") !== "split") return ac;
    const y = ac.mounting_height_m;
    if (typeof y !== "number") return ac;
    if (y <= Math.max(3.0, s.geometry.H * 0.72)) return ac;
    changed = true;
    return { ...ac, mounting_height_m: defaultSplitMount };
  });

  return changed ? { ...s, ac_units: acUnits } : s;
}

export function ExportModal({ open, onClose, scene, ac, onLoadScene }: Props) {
  const [json, setJson] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState<string>("");
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const hl = calcHeatLoad(scene);
      const hash = await sceneHash(scene);
      const cfg = {
        ...(serialiseSceneForSave(scene) as object),
        results_cache_key: hash,
        optimal_ac_positions: ac,
        ashrae_heat_load: {
          Q_walls_W:        Math.round(hl.Q_walls),
          Q_glass_W:        Math.round(hl.Q_glass),
          Q_solar_W:        Math.round(hl.Q_solar),
          Q_roof_W:         Math.round(hl.Q_roof),
          Q_occupants_sens_W: Math.round(hl.Q_occ_sens),
          Q_appliances_W:   Math.round(hl.Q_app),
          Q_infiltration_W: Math.round(hl.Q_infil),
          Q_latent_W:       Math.round(hl.Q_lat),
          Q_total_W:        Math.round(hl.Q_total),
          required_TR:      +hl.TR.toFixed(2),
        },
      };
      if (!cancelled) setJson(JSON.stringify(cfg, null, 2));
    })();
    return () => { cancelled = true; };
  }, [open, scene, ac]);

  const tryLoad = (raw: string) => {
    setLoadError(null);
    try {
      const parsed = JSON.parse(raw);
      // Strip the export-only fields (results_cache_key, optimal_ac_positions, ashrae_heat_load)
      // before re-hydrating, in case they confuse the schema.
      delete parsed.optimal_ac_positions;
      delete parsed.ashrae_heat_load;
      const s = hydrateScene(parsed);
      if (!s.geometry || typeof s.geometry.L !== "number") {
        throw new Error("Missing geometry.L — file doesn't look like a saved scene.");
      }
      onLoadScene?.(s);
      onClose();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  };
  const onLoadFile = (file: File) => {
    file.text().then(tryLoad).catch((e) => setLoadError(String(e)));
  };
  const onPasteLoad = () => {
    if (!pasteText.trim()) { setLoadError("Paste JSON first."); return; }
    tryLoad(pasteText);
  };

  if (!open) return null;

  const onCopy = async () => {
    await navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const onDownload = () => {
    const blob = new Blob([json], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "cfd_room_config.json"; a.click();
    URL.revokeObjectURL(url);
    setDownloaded(true);
    setTimeout(() => setDownloaded(false), 1500);
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/85"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[min(620px,94vw)] max-h-[92vh] overflow-y-auto rounded-lg border border-[#182840] bg-[var(--color-bg-panel)] p-4">
        <h3 className="mb-1 text-[13px] text-[var(--color-accent-blue)]">⚙ CFD Environment — Save / Load</h3>
        <p className="mb-2 text-[10px] text-[var(--color-ink-6)]">
          Includes the complete room: geometry, openings, obstacles, STL meshes (full triangle stream), AC units, constraints, environment, materials. Round-trips through the schema migration so future builds can re-load it.
        </p>

        {/* SAVE section */}
        <div className="mb-3">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--color-ink-7)]">Save current environment</div>
          <pre className="mb-1.5 max-h-[200px] overflow-y-auto rounded border border-[#0e1c30] bg-[var(--color-bg-deep)] p-2 text-[9.5px] leading-relaxed text-[#406880] whitespace-pre">
            {json || "Computing…"}
          </pre>
          <div className="flex gap-1.5">
            <button
              onClick={onCopy}
              className="flex-1 rounded border border-[#182e58] bg-[#0a203e] px-1.5 py-1.5 text-[10.5px] font-medium text-[#5890d8] hover:bg-[#102848]"
            >
              {copied ? "✓ Copied!" : "📋 Copy JSON"}
            </button>
            <button
              onClick={onDownload}
              className="flex-1 rounded border border-[#204018] bg-[#102010] px-1.5 py-1.5 text-[10.5px] font-medium text-[#38b048] hover:bg-[#142818]"
            >
              {downloaded ? "✓ Downloaded!" : "💾 Download"}
            </button>
          </div>
        </div>

        {/* LOAD section */}
        <div className="mb-3 border-t border-[#0e1c30] pt-3">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--color-ink-7)]">Load saved environment</div>
          <p className="mb-1.5 text-[9.5px] text-[var(--color-ink-6)]">
            Pick a previously-saved JSON file, or paste it below. Replaces the current scene entirely (current state is lost).
          </p>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onLoadFile(f);
              e.target.value = "";
            }}
          />
          <div className="mb-1.5 flex gap-1.5">
            <button
              onClick={() => fileRef.current?.click()}
              className="flex-1 rounded border border-[#3a2a18] bg-[#1c1408] px-1.5 py-1.5 text-[10.5px] font-medium text-[#d8a058] hover:bg-[#28180c]"
            >
              📁 Pick JSON file…
            </button>
            <button
              onClick={onPasteLoad}
              className="flex-1 rounded border border-[#3a2a18] bg-[#1c1408] px-1.5 py-1.5 text-[10.5px] font-medium text-[#d8a058] hover:bg-[#28180c]"
            >
              ↥ Load pasted JSON
            </button>
          </div>
          <textarea
            placeholder="…or paste JSON here, then click Load"
            value={pasteText}
            onChange={(e) => setPasteText(e.currentTarget.value)}
            className="h-[80px] w-full rounded border border-[#0e1c30] bg-[var(--color-bg-deep)] p-1.5 text-[9.5px] text-[#a0c0e0] placeholder:text-[var(--color-ink-8)]"
          />
          {loadError && (
            <p className="mt-1 rounded border border-[#3a1010] bg-[#180808] px-1.5 py-0.5 text-[9.5px] text-[var(--color-accent-red)]">
              ✗ {loadError}
            </p>
          )}
        </div>

        <div className="flex gap-1.5">
          <button
            onClick={onClose}
            className="ml-auto rounded border border-[#142234] bg-[#070f1e] px-3 py-1.5 text-[10.5px] font-medium text-[#4878a0] hover:bg-[#0b182e]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
