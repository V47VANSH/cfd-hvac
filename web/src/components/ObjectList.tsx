"use client";

import type { Selection } from "@/components/Room3D";
import type { Scene, Opening, Obstacle, ObstacleShape, OpeningType } from "@/lib/io/schema";

const AC_TAG = { bg: "#0a1820", fg: "#5cd0ff", label: "AC" };

interface Props {
  scene:        Scene;
  setScene:     (s: Scene) => void;
  selection:    Selection;
  setSelection: (s: Selection) => void;
}

const wallName: Record<"S"|"N"|"E"|"W", string> = { S:"South", N:"North", E:"East", W:"West" };

const TAG_COLOR: Record<OpeningType | ObstacleShape, { bg: string; fg: string; label: string }> = {
  win:       { bg:"#0a2040", fg:"#4888d8", label:"WIN" },
  door:      { bg:"#1e0e06", fg:"#c07030", label:"DOOR" },
  circ:      { bg:"#142008", fg:"#88b020", label:"CIRC" },
  arch:      { bg:"#1c1408", fg:"#c09838", label:"ARCH" },
  box:       { bg:"#161028", fg:"#8058c8", label:"BOX" },
  cyl:       { bg:"#061818", fg:"#28b080", label:"CYL" },
  shelf:     { bg:"#1c0e06", fg:"#c83818", label:"SHELF" },
  human:     { bg:"#180808", fg:"#e06040", label:"HUMAN" },
  appliance: { bg:"#100818", fg:"#9870e0", label:"APP" },
  cfan:      { bg:"#081828", fg:"#58a0d8", label:"CFAN" },
  tfan:      { bg:"#081828", fg:"#58a0d8", label:"TFAN" },
};

export function ObjectList({ scene, setScene, selection, setSelection }: Props) {
  const totalCount = scene.openings.length + scene.obstacles.length + scene.ac_units.length;
  if (totalCount === 0) {
    return (
      <p className="px-1 py-1.5 text-center text-[9.5px] italic text-[var(--color-ink-8)]">
        Nothing placed
      </p>
    );
  }

  const toggleFeat = (id: number) => {
    setScene({
      ...scene,
      openings: scene.openings.map((f) =>
        f.id === id ? { ...f, open: !(f.open !== false) } : f,
      ),
    });
  };
  const toggleObs = (id: number) => {
    setScene({
      ...scene,
      obstacles: scene.obstacles.map((o) =>
        o.id === id ? { ...o, on: !(o.on !== false) } : o,
      ),
    });
  };
  const delFeat = (id: number) => {
    setScene({ ...scene, openings: scene.openings.filter((f) => f.id !== id) });
    if (selection.id === id) setSelection({ id: null, type: null });
  };
  const delObs = (id: number) => {
    setScene({ ...scene, obstacles: scene.obstacles.filter((o) => o.id !== id) });
    if (selection.id === id) setSelection({ id: null, type: null });
  };
  const toggleAC = (id: number) => {
    setScene({
      ...scene,
      ac_units: scene.ac_units.map((a) =>
        a.id === id ? { ...a, on: !(a.on !== false) } : a),
    });
  };
  const delAC = (id: number) => {
    setScene({ ...scene, ac_units: scene.ac_units.filter((a) => a.id !== id) });
    if (selection.id === id) setSelection({ id: null, type: null });
  };

  return (
    <div className="flex flex-col gap-1 max-h-[170px] overflow-y-auto">
      {scene.ac_units.map((a) => (
        <Row
          key={`a-${a.id}`}
          tag={AC_TAG}
          desc={`${wallName[a.wall]} · ${a.kw.toFixed(1)}kW · ${(a.capacity_tr ?? a.kw/3.517).toFixed(2)} TR`}
          on={a.on !== false}
          selected={selection.type === "ac" && selection.id === a.id}
          onClick={() => setSelection({ id: a.id, type: "ac" })}
          onToggle={() => toggleAC(a.id)}
          onDelete={() => delAC(a.id)}
        />
      ))}
      {scene.openings.map((f) => (
        <Row
          key={`f-${f.id}`}
          tag={TAG_COLOR[f.type]}
          desc={`${wallName[f.wall]} · ${f.uw.toFixed(1)}×${f.vh.toFixed(1)}m`}
          on={f.open !== false}
          selected={selection.type === "feat" && selection.id === f.id}
          onClick={() => setSelection({ id: f.id, type: "feat" })}
          onToggle={() => toggleFeat(f.id)}
          onDelete={() => delFeat(f.id)}
        />
      ))}
      {scene.obstacles.map((o) => (
        <Row
          key={`o-${o.id}`}
          tag={TAG_COLOR[o.shape]}
          desc={describeObstacle(o)}
          on={o.shape === "human" || o.shape === "appliance" || o.shape === "cfan" || o.shape === "tfan"
            ? o.on !== false : undefined}
          selected={selection.type === "obs" && selection.id === o.id}
          onClick={() => setSelection({ id: o.id, type: "obs" })}
          onToggle={
            o.shape === "human" || o.shape === "appliance" ||
            o.shape === "cfan"  || o.shape === "tfan"
              ? () => toggleObs(o.id)
              : undefined
          }
          onDelete={() => delObs(o.id)}
        />
      ))}
    </div>
  );
}

function describeObstacle(o: Obstacle): string {
  if (o.shape === "human")     return `${o.H.toFixed(1)}m · 75W`;
  if (o.shape === "appliance") return `${o.W.toFixed(1)}×${(o.D ?? o.W).toFixed(1)}m · ${o.watts ?? 200}W`;
  if (o.shape === "cfan" || o.shape === "tfan") return `⌀${o.W.toFixed(1)}m · ${o.rpm ?? 120} rpm`;
  return `${o.W.toFixed(1)}×${(o.D ?? o.W).toFixed(1)}×${o.H.toFixed(1)}m`;
}

function Row({
  tag, desc, on, selected, onClick, onToggle, onDelete,
}: {
  tag: { bg: string; fg: string; label: string };
  desc: string;
  on?: boolean;
  selected: boolean;
  onClick: () => void;
  onToggle?: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`flex cursor-pointer items-center gap-1 rounded border px-1.5 py-1 transition-colors ${
        selected
          ? "border-[var(--color-accent-blue-3)] bg-[#07122a]"
          : "border-[var(--color-border-4)] bg-[var(--color-bg-row)] hover:border-[#1a304e]"
      }`}
    >
      <span
        className="rounded px-1 py-0.5 text-[8px] font-bold tracking-wider"
        style={{ background: tag.bg, color: tag.fg }}
      >
        {tag.label}
      </span>
      <span className="flex-1 text-[9.5px] leading-tight text-[var(--color-ink-5)]">
        {desc}
      </span>
      {onToggle && (
        <label
          className="tog flex flex-shrink-0 items-center"
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
        >
          <input type="checkbox" checked={!!on} readOnly />
          <span className="tslide" />
        </label>
      )}
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="flex-shrink-0 px-0.5 text-[11px] leading-none text-[#162030] hover:text-[#b02838]"
      >
        ✕
      </button>
    </div>
  );
}

// Forward types so consumers can keep the import surface clean
export type { Opening };
