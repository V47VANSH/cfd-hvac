"use client";

import { useState } from "react";
import type { Scene } from "@/lib/io/schema";
import {
  runValidation, optimizeMultiAC, runBenchmark,
  meshIndependence, runUncertainty, runCalibration, trainSurrogate,
  importAnsysCSV, buildTier2PDF, tier2ExportURL,
  type Tier2Health, type ValidationResult, type OptResult, type BenchmarkResult,
} from "@/lib/tier2/client";

interface Props {
  scene: Scene;
  status: "checking" | "available" | "unavailable";
  health: Tier2Health | null;
  /** Optional — drop a Tier-2 result into the Comparison view's slot B. */
  onValidationResult?: (r: ValidationResult) => void;
}

/**
 * Tier-2 control panel. Greys out as a whole when the backend is
 * unreachable; individual buttons grey when their endpoint isn't in
 * the health response's ``endpoints`` list.
 */
export function Tier2Panel({ scene, status, health, onValidationResult }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  const available = status === "available";
  const has = (ep: string) => health?.endpoints?.includes(ep) ?? false;

  const runWith = async <T,>(label: string, fn: () => Promise<T>) => {
    setBusy(label); setError(null); setResult(null);
    try {
      const r = await fn();
      setResult(r);
      return r;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="border-b border-[var(--color-border-3)] px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between text-[8.5px] font-bold uppercase tracking-[0.14em] text-[var(--color-ink-6)]">
        <span>Tier 2 (OpenFOAM)</span>
        <StatusDot status={status} />
      </div>
      {!available && (
        <p className="mb-1 text-[9px] text-[var(--color-ink-7)]">
          {status === "checking"
            ? "Checking…"
            : "Backend unreachable. Start it with `cd server && docker compose up`."}
        </p>
      )}
      {health && (
        <p className="mb-1 text-[8.5px] text-[var(--color-ink-7)]">
          OpenFOAM: {health.openfoam_available ? health.openfoam_version : "missing"}
        </p>
      )}

      <div className="grid grid-cols-2 gap-1">
        <Tier2Button label="Validate" disabled={!available || !has("/run-validation") || !!busy}
          onClick={async () => {
            const r = await runWith("validate", () => runValidation(scene));
            if (r && onValidationResult) onValidationResult(r as ValidationResult);
          }}
          busyKey="validate" busy={busy} />
        <Tier2Button label="Multi-AC GP" disabled={!available || !has("/optimize-multi-ac") || !!busy}
          onClick={() => runWith("opt-bayes", () => optimizeMultiAC(scene, 2))}
          busyKey="opt-bayes" busy={busy} />
        <Tier2Button label="Mesh GCI" disabled={!available || !has("/mesh-independence") || !!busy}
          onClick={() => runWith("mesh-gci", () => meshIndependence(scene))}
          busyKey="mesh-gci" busy={busy} />
        <Tier2Button label="UQ (MC)" disabled={!available || !has("/uncertainty") || !!busy}
          onClick={() => runWith("uq", () => runUncertainty(scene, 30))}
          busyKey="uq" busy={busy} />
        <Tier2Button label="Annex 20" disabled={!available || !!busy}
          onClick={() => runWith("annex20", () => runBenchmark("annex20"))}
          busyKey="annex20" busy={busy} />
        <Tier2Button label="Cavity" disabled={!available || !!busy}
          onClick={() => runWith("cavity", () => runBenchmark("cavity"))}
          busyKey="cavity" busy={busy} />
        <Tier2Button label="Calibrate" disabled={!available || !has("/calibrate") || !!busy}
          onClick={() => runWith("calib", () => runCalibration())}
          busyKey="calib" busy={busy} />
        <Tier2Button label="Train surrogate" disabled={!available || !has("/train-surrogate") || !!busy}
          onClick={() => runWith("surr", () => trainSurrogate(50))}
          busyKey="surr" busy={busy} />
      </div>

      <ANSYSImporter scene={scene} disabled={!available || !!busy}
                     onResult={(r) => setResult(r)}
                     onError={(e) => setError(e)} />

      {error && (
        <p className="mt-1 rounded border border-[#3a1010] bg-[#180808] px-1.5 py-0.5 text-[9px] text-[var(--color-accent-red)]">
          {error}
        </p>
      )}

      {result !== null && <ResultPreview result={result} />}
    </div>
  );
}

function Tier2Button({
  label, disabled, onClick, busy, busyKey,
}: {
  label: string; disabled: boolean; onClick: () => void;
  busy: string | null; busyKey: string;
}) {
  const isBusy = busy === busyKey;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={disabled ? "Tier 2 unavailable" : ""}
      className={`rounded border px-1.5 py-0.5 text-[9.5px] transition-colors ${
        disabled
          ? "border-transparent text-[var(--color-ink-8)] cursor-not-allowed opacity-40"
          : isBusy
          ? "border-[var(--color-accent-orange)] bg-[#2a1408] text-[var(--color-accent-orange)]"
          : "border-[#284890] bg-[#0a1428] text-[#5888e0] hover:bg-[#0e1c38]"
      }`}
    >
      {isBusy ? "…" : label}
    </button>
  );
}

function StatusDot({ status }: { status: "checking" | "available" | "unavailable" }) {
  const color = status === "available"  ? "#3da050"
              : status === "checking"   ? "#a0a050"
              :                            "#c04848";
  return (
    <span title={`Tier 2: ${status}`}
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: color }} />
  );
}

function ANSYSImporter({
  scene, disabled, onResult, onError,
}: {
  scene: Scene; disabled: boolean;
  onResult: (r: unknown) => void; onError: (e: string) => void;
}) {
  const id = "tier2-ansys-input";
  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      <input
        id={id} type="file" accept=".csv,text/csv"
        className="hidden"
        disabled={disabled}
        onChange={async (ev) => {
          const f = ev.target.files?.[0];
          if (!f) return;
          ev.target.value = "";
          try {
            const r = await importAnsysCSV(scene, f);
            onResult(r);
          } catch (e) {
            onError(e instanceof Error ? e.message : String(e));
          }
        }}
      />
      <label
        htmlFor={id}
        className={`flex-1 cursor-pointer rounded border px-1.5 py-0.5 text-center text-[9.5px] transition-colors ${
          disabled
            ? "border-transparent text-[var(--color-ink-8)] cursor-not-allowed opacity-40"
            : "border-[#284890] bg-[#0a1428] text-[#5888e0] hover:bg-[#0e1c38]"
        }`}
      >
        ↥ Import ANSYS CSV
      </label>
    </div>
  );
}

function ResultPreview({ result }: { result: unknown }) {
  let summary: string;
  if (result && typeof result === "object" && "field_summary" in result) {
    const r = result as { request_id?: string; field_summary: { mean_T: number; max_V: number; mean_PMV: number } };
    summary = `Validate · meanT=${r.field_summary.mean_T.toFixed(1)}°C · maxV=${r.field_summary.max_V.toFixed(2)}m/s · PMV=${r.field_summary.mean_PMV.toFixed(2)}`;
    return (
      <div className="mt-1 rounded border border-[#142234] bg-[#040810] p-1.5 text-[9px]">
        <p className="text-[var(--color-accent-cyan)]">{summary}</p>
        {r.request_id && (
          <a href={tier2ExportURL(r.request_id, "vtu")} target="_blank" rel="noreferrer"
             className="text-[#5890d8] hover:underline">↥ Download VTK/VTU</a>
        )}
      </div>
    );
  }
  if (result && typeof result === "object" && "passed" in result) {
    const r = result as BenchmarkResult;
    return (
      <div className="mt-1 rounded border border-[#142234] bg-[#040810] p-1.5 text-[9px]">
        <p className={r.passed ? "text-[var(--color-accent-green-2)]" : "text-[var(--color-accent-red)]"}>
          {r.passed ? "✓ PASS" : "✗ FAIL"} {r.name} — {r.metric}: {r.measured.toFixed(3)} (tol {r.tolerance})
        </p>
      </div>
    );
  }
  if (result && typeof result === "object" && "pareto_front" in result) {
    const r = result as OptResult;
    return (
      <div className="mt-1 rounded border border-[#142234] bg-[#040810] p-1.5 text-[9px]">
        <p className="text-[#9078e0]">{r.method}: {r.n_evaluations} evals, {r.pareto_front.length} on Pareto front</p>
      </div>
    );
  }
  return (
    <pre className="mt-1 max-h-[80px] overflow-auto rounded border border-[#142234] bg-[#040810] p-1 text-[8.5px] text-[var(--color-ink-5)]">
      {JSON.stringify(result, null, 2)}
    </pre>
  );
}
