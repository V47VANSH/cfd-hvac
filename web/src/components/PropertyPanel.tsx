"use client";

import type { Selection } from "@/components/Room3D";
import type { Scene, Opening, Obstacle, ACUnit, ObstacleShape, STLObject } from "@/lib/io/schema";

interface Props {
  scene:        Scene;
  setScene:     (s: Scene) => void;
  selection:    Selection;
  setSelection: (s: Selection) => void;
}

export function PropertyPanel({ scene, setScene, selection, setSelection }: Props) {
  if (selection.id === null || selection.type === null) return null;

  if (selection.type === "feat") {
    const f = scene.openings.find((x) => x.id === selection.id);
    if (!f) return null;
    return <FeatureProps f={f} scene={scene} setScene={setScene} setSelection={setSelection} />;
  }
  if (selection.type === "obs") {
    const o = scene.obstacles.find((x) => x.id === selection.id);
    if (!o) return null;
    return <ObstacleProps o={o} scene={scene} setScene={setScene} setSelection={setSelection} />;
  }
  if (selection.type === "ac") {
    const a = scene.ac_units.find((x) => x.id === selection.id);
    if (!a) return null;
    return <ACProps a={a} scene={scene} setScene={setScene} setSelection={setSelection} />;
  }
  if (selection.type === "stl") {
    const s = scene.geometry.stl.find((x) => x.id === selection.id);
    if (!s) return null;
    return <STLProps s={s} scene={scene} setScene={setScene} setSelection={setSelection} />;
  }
  return null;
}

/* ── STL transform props ─────────────────────────────────────────────── */
function STLProps({
  s, scene, setScene, setSelection,
}: {
  s: STLObject; scene: Scene; setScene: (s: Scene) => void;
  setSelection: (s: Selection) => void;
}) {
  const update = (patch: Partial<STLObject>) => {
    setScene({
      ...scene,
      geometry: {
        ...scene.geometry,
        stl: scene.geometry.stl.map((x) => x.id === s.id ? { ...x, ...patch } : x),
      },
    });
  };
  const del = () => {
    setScene({
      ...scene,
      geometry: {
        ...scene.geometry,
        stl: scene.geometry.stl.filter((x) => x.id !== s.id),
      },
    });
    setSelection({ id: null, type: null });
  };
  return (
    <PanelShell title={`STL · ${s.name || "imported mesh"}`} onDelete={del}>
      <p className="text-[8.5px] italic text-[var(--color-ink-7)]">
        {s.triCount.toLocaleString()} triangles
      </p>
      <Divider label="Position" />
      <Field label="X m"  step={0.1} min={-scene.geometry.L} max={scene.geometry.L}
             value={s.x} onChange={(v) => update({ x: v })} />
      <Field label="Y m"  step={0.1} min={0} max={scene.geometry.H}
             value={s.y} onChange={(v) => update({ y: v })} />
      <Field label="Z m"  step={0.1} min={-scene.geometry.W} max={scene.geometry.W}
             value={s.z} onChange={(v) => update({ z: v })} />
      <Divider label="Transform" />
      <Field label="Scale"   step={0.05} min={0.01} max={10}
             value={s.scale} onChange={(v) => update({ scale: v })} />
      <Field label="Rot Y °" step={5} min={-180} max={180}
             value={s.ry_deg ?? 0} onChange={(v) => update({ ry_deg: v })} />
      <Field label="Rot X °" step={5} min={-180} max={180}
             value={s.rx_deg ?? 0} onChange={(v) => update({ rx_deg: v })} />
      <Field label="Rot Z °" step={5} min={-180} max={180}
             value={s.rz_deg ?? 0} onChange={(v) => update({ rz_deg: v })} />
    </PanelShell>
  );
}

/* ── AC unit props ───────────────────────────────────────────────────── */
function ACProps({
  a, scene, setScene, setSelection,
}: {
  a: ACUnit; scene: Scene; setScene: (s: Scene) => void;
  setSelection: (s: Selection) => void;
}) {
  const update = (patch: Partial<ACUnit>) => {
    setScene({
      ...scene,
      ac_units: scene.ac_units.map((x) => x.id === a.id ? { ...x, ...patch } : x),
    });
  };
  const del = () => {
    setScene({ ...scene, ac_units: scene.ac_units.filter((x) => x.id !== a.id) });
    setSelection({ id: null, type: null });
  };

  return (
    <PanelShell title={`AC Unit · ${a.wall} wall`} onDelete={del}>
      <SelectField
        label="Wall" value={a.wall}
        options={[
          { id: "S", label: "South" },
          { id: "N", label: "North" },
          { id: "E", label: "East"  },
          { id: "W", label: "West"  },
        ]}
        onChange={(v) => update({ wall: v as ACUnit["wall"] })}
      />
      <Field label="Pos along m" step={0.1}
        min={a.wall === "S" || a.wall === "N" ? -scene.geometry.L/2 + 0.4 : -scene.geometry.W/2 + 0.4}
        max={a.wall === "S" || a.wall === "N" ?  scene.geometry.L/2 - 0.4 :  scene.geometry.W/2 - 0.4}
        value={a.wall === "S" || a.wall === "N" ? a.x : a.z}
        onChange={(v) => update(a.wall === "S" || a.wall === "N" ? { x: v } : { z: v })}
      />
      <Field label="Mount Y m" step={0.1} min={0.5} max={Math.max(0.6, scene.geometry.H - 0.05)}
        value={a.mounting_height_m ?? +(scene.geometry.H * 0.88).toFixed(2)}
        onChange={(v) => update({ mounting_height_m: v })}
      />
      <Divider label="Capacity" />
      <Field label="kW" step={0.1} min={0.5} max={10}
             value={a.kw} onChange={(v) => update({ kw: v, capacity_tr: +(v / 3.517).toFixed(2) })} />
      <Field label="TR" step={0.05} min={0.15} max={3}
             value={a.capacity_tr ?? +(a.kw / 3.517).toFixed(2)}
             onChange={(v) => update({ capacity_tr: v, kw: +(v * 3.517).toFixed(2) })} />
      <SelectField
        label="Type" value={a.type ?? "split"}
        options={[
          { id: "split",    label: "Split"    },
          { id: "window",   label: "Window"   },
          { id: "cassette", label: "Cassette" },
        ]}
        onChange={(v) => update({ type: v as ACUnit["type"] })}
      />
      <Divider label="Airflow" />
      <Field label="Throw m" step={0.1} min={1} max={10}
             value={a.throw_distance_m ?? 4.0}
             onChange={(v) => update({ throw_distance_m: v })} />
      <Field label="Angle °" step={5} min={-45} max={45}
             value={a.airflow_angle_deg ?? 0}
             onChange={(v) => update({ airflow_angle_deg: v })} />
      <Field label="CFM" step={25} min={50} max={1500}
             value={a.flow_rate_cfm ?? 350}
             onChange={(v) => update({ flow_rate_cfm: v })} />
      <Divider label="Supply" />
      <Field label="Set Temp °C" step={0.5} min={8} max={26}
             value={a.supply_temp_C ?? 14}
             onChange={(v) => update({ supply_temp_C: v })} />
      <Field label="Pitch °" step={1} min={-30} max={20}
             value={a.vertical_angle_deg ?? -10}
             onChange={(v) => update({ vertical_angle_deg: v })} />
      <Divider label="Swing (oscillation)" />
      <SelectField
        label="H. swing" value={a.swing_horizontal ? "on" : "off"}
        options={[{ id: "off", label: "Off" }, { id: "on", label: "On" }]}
        onChange={(v) => update({ swing_horizontal: v === "on" })}
      />
      <SelectField
        label="V. swing" value={a.swing_vertical ? "on" : "off"}
        options={[{ id: "off", label: "Off" }, { id: "on", label: "On" }]}
        onChange={(v) => update({ swing_vertical: v === "on" })}
      />
      {(a.swing_horizontal || a.swing_vertical) && (
        <>
          <Field label="Period s" step={0.5} min={2} max={20}
                 value={a.swing_period_s ?? 6}
                 onChange={(v) => update({ swing_period_s: v })} />
          {a.swing_horizontal && (
            <Field label="H. amp °" step={5} min={5} max={60}
                   value={a.swing_h_amp_deg ?? 30}
                   onChange={(v) => update({ swing_h_amp_deg: v })} />
          )}
          {a.swing_vertical && (
            <Field label="V. amp °" step={5} min={5} max={45}
                   value={a.swing_v_amp_deg ?? 20}
                   onChange={(v) => update({ swing_v_amp_deg: v })} />
          )}
        </>
      )}
      <Divider label="State" />
      <SelectField
        label="On" value={a.on === false ? "off" : "on"}
        options={[
          { id: "on",  label: "Running" },
          { id: "off", label: "Off"     },
        ]}
        onChange={(v) => update({ on: v === "on" })}
      />
    </PanelShell>
  );
}

/* ── Feature (opening) props ─────────────────────────────────────────── */
function FeatureProps({
  f, scene, setScene, setSelection,
}: {
  f: Opening; scene: Scene; setScene: (s: Scene) => void;
  setSelection: (s: Selection) => void;
}) {
  const { L, W, H } = scene.geometry;
  const span = (f.wall === "S" || f.wall === "N") ? L : W;
  const hasDoor = f.type === "door" || f.type === "arch";

  const update = (patch: Partial<Opening>) => {
    setScene({
      ...scene,
      openings: scene.openings.map((x) => x.id === f.id ? { ...x, ...patch } : x),
    });
  };
  const del = () => {
    setScene({ ...scene, openings: scene.openings.filter((x) => x.id !== f.id) });
    setSelection({ id: null, type: null });
  };

  return (
    <PanelShell title="Opening Properties" onDelete={del}>
      <Field label="Width m"  step={0.05} min={0.15} max={span - 0.1}
             value={f.uw} onChange={(v) => update({ uw: v })} />
      <Field label="Height m" step={0.05} min={0.15} max={H - 0.1}
             value={f.vh} onChange={(v) => update({ vh: v })} />
      <Field label="Pos along m" step={0.05} min={0.1} max={span}
             value={f.u}  onChange={(v) => update({ u: v })} />
      {!hasDoor && (
        <Field label="Height Y m" step={0.05} min={0.1} max={H - 0.1}
               value={f.v} onChange={(v) => update({ v: v })} />
      )}
      <Divider label="Physical" />
      <Field label="U-value W/m²K" step={0.1} min={0.1} max={10}
             value={f.u_value ?? 5.8}
             onChange={(v) => update({ u_value: v })} />
      <Field label="SHGC"       step={0.05} min={0} max={1}
             value={f.solar_transmittance ?? (f.type === "door" ? 0 : 0.65)}
             onChange={(v) => update({ solar_transmittance: v })} />
      <Field label="Air perm." step={0.1} min={0} max={50}
             value={f.air_permeability ?? (f.type === "door" ? 1 : 0)}
             onChange={(v) => update({ air_permeability: v })} />
    </PanelShell>
  );
}

/* ── Obstacle props ──────────────────────────────────────────────────── */
function ObstacleProps({
  o, scene, setScene, setSelection,
}: {
  o: Obstacle; scene: Scene; setScene: (s: Scene) => void;
  setSelection: (s: Selection) => void;
}) {
  const { L, W, H } = scene.geometry;
  const isFan   = o.shape === "cfan" || o.shape === "tfan";
  const isCyl   = o.shape === "cyl";
  const isHuman = o.shape === "human";
  const isApp   = o.shape === "appliance";

  const update = (patch: Partial<Obstacle>) => {
    setScene({
      ...scene,
      obstacles: scene.obstacles.map((x) => x.id === o.id ? { ...x, ...patch } : x),
    });
  };
  const del = () => {
    setScene({ ...scene, obstacles: scene.obstacles.filter((x) => x.id !== o.id) });
    setSelection({ id: null, type: null });
  };

  const title = capitalize(o.shape) + " Properties";

  return (
    <PanelShell title={title} onDelete={del}>
      {isHuman && (
        <Field label="Height m" step={0.05} min={0.5} max={2.2}
               value={o.H} onChange={(v) => update({ H: v })} />
      )}
      {isApp && (
        <>
          <Field label="Width m" step={0.05} min={0.1} max={3}
                 value={o.W} onChange={(v) => update({ W: v })} />
          <Field label="Depth m" step={0.05} min={0.1} max={3}
                 value={o.D ?? o.W} onChange={(v) => update({ D: v })} />
          <Field label="Height m" step={0.05} min={0.1} max={2}
                 value={o.H} onChange={(v) => update({ H: v })} />
          <Field label="Watts" step={50} min={10} max={5000}
                 value={o.watts ?? 200} onChange={(v) => update({ watts: v })} />
        </>
      )}
      {!isFan && !isHuman && !isApp && (
        <>
          <Field
            label={isCyl ? "Diameter m" : "Width m"}
            step={0.05} min={0.1} max={5}
            value={o.W} onChange={(v) => update({ W: v })}
          />
          {!isCyl && (
            <Field label="Depth m" step={0.05} min={0.1} max={5}
                   value={o.D ?? o.W} onChange={(v) => update({ D: v })} />
          )}
          <Field label="Height m" step={0.05} min={0.1} max={H}
                 value={o.H} onChange={(v) => update({ H: v })} />
        </>
      )}
      {o.shape === "cfan" && (
        <>
          <Field label="Blade span m" step={0.1} min={0.4} max={2}
                 value={o.W} onChange={(v) => update({ W: v })} />
          <Field label="RPM" step={10} min={20} max={300}
                 value={o.rpm ?? 120} onChange={(v) => update({ rpm: v })} />
          <SelectField
            label="Season" value={o.season ?? "summer"}
            options={[
              { id: "summer", label: "☀ Summer (downwash)" },
              { id: "winter", label: "❄ Winter (upwash)"  },
            ]}
            onChange={(v) => update({ season: v as "summer" | "winter" })}
          />
        </>
      )}
      {o.shape === "tfan" && (
        <>
          <Field label="Stand H m" step={0.05} min={0.2} max={1.2}
                 value={o.H} onChange={(v) => update({ H: v })} />
          <Field label="RPM" step={20} min={40} max={600}
                 value={o.rpm ?? 300} onChange={(v) => update({ rpm: v })} />
          <Field label="Direction °" step={5} min={0} max={360}
                 value={o.dir ?? 0} onChange={(v) => update({ dir: v })} />
        </>
      )}
      <Field label="Y offset m" step={0.05} min={0} max={Math.max(0, H - o.H - 0.01)}
             value={o.Yoff ?? 0} onChange={(v) => update({ Yoff: v })} />
      <Field label="Pos X m" step={0.1} min={-L/2 + 0.2} max={L/2 - 0.2}
             value={o.x} onChange={(v) => update({ x: v })} />
      <Field label="Pos Z m" step={0.1} min={-W/2 + 0.2} max={W/2 - 0.2}
             value={o.z} onChange={(v) => update({ z: v })} />
    </PanelShell>
  );
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/* ── Building blocks ─────────────────────────────────────────────────── */
function PanelShell({
  title, children, onDelete,
}: {
  title: string; children: React.ReactNode; onDelete: () => void;
}) {
  return (
    <div className="border-b border-[var(--color-border-3)] bg-[var(--color-bg-row-2)] px-3 py-2">
      <div className="mb-2 text-[8.5px] font-bold uppercase tracking-[0.14em] text-[var(--color-ink-6)]">
        {title}
      </div>
      <div className="flex flex-col gap-1">{children}</div>
      <button
        onClick={onDelete}
        className="mt-1 w-full rounded border border-[#300c08] bg-[#180604] py-1 text-[9.5px] text-[var(--color-accent-red)] hover:bg-[#200a06]"
      >
        Delete ✗
      </button>
    </div>
  );
}

function Field({
  label, value, step, min, max, onChange,
}: {
  label: string; value: number;
  step?: number; min?: number; max?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <label className="w-[64px] flex-shrink-0 text-[9.5px] text-[var(--color-ink-5)]">
        {label}
      </label>
      <input
        type="number" step={step} min={min} max={max} value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v)) onChange(v);
        }}
        className="flex-1 min-w-0 rounded border border-[#152438] bg-[var(--color-bg-row)] px-1 py-0.5 text-[10px] text-[#6090c0] outline-none focus:border-[#305090]"
      />
    </div>
  );
}

function SelectField<T extends string>({
  label, value, options, onChange,
}: {
  label: string; value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <label className="w-[64px] flex-shrink-0 text-[9.5px] text-[var(--color-ink-5)]">
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="flex-1 min-w-0 rounded border border-[#152438] bg-[var(--color-bg-row)] px-1 py-0.5 text-[10px] text-[#6090c0] outline-none focus:border-[#305090]"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <div className="mt-1 mb-0.5 text-[8.5px] uppercase tracking-[0.1em] text-[var(--color-ink-7)]">
      {label}
    </div>
  );
}

// Used only by callers to type-narrow ObstacleShape — exporting keeps tree-shaking simple.
export type { ObstacleShape };
