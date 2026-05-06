"use client";

import { useEffect, useState } from "react";
import { sceneHash, type Scene } from "@/lib/io/schema";
import { calcHeatLoad } from "@/lib/ashrae/heatLoad";

interface Props {
  open: boolean;
  onClose: () => void;
  scene: Scene;
  ac: { x: number; z: number; wall: "S"|"N"|"E"|"W" }[];
}

export function ExportModal({ open, onClose, scene, ac }: Props) {
  const [json, setJson] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const hl = calcHeatLoad(scene);
      const hash = await sceneHash(scene);
      const cfg = {
        ...scene,
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
      <div className="w-[min(560px,94vw)] max-h-[88vh] overflow-y-auto rounded-lg border border-[#182840] bg-[var(--color-bg-panel)] p-4">
        <h3 className="mb-1 text-[13px] text-[var(--color-accent-blue)]">⚙ CFD Configuration Export</h3>
        <p className="mb-2 text-[10px] text-[var(--color-ink-6)]">
          Save the JSON below — it round-trips through the schema migration so future builds can re-load it.
        </p>
        <pre className="mb-2 max-h-[240px] overflow-y-auto rounded border border-[#0e1c30] bg-[var(--color-bg-deep)] p-2 text-[9.5px] leading-relaxed text-[#406880] whitespace-pre">
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
          <button
            onClick={onClose}
            className="flex-1 rounded border border-[#142234] bg-[#070f1e] px-1.5 py-1.5 text-[10.5px] font-medium text-[#4878a0] hover:bg-[#0b182e]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
