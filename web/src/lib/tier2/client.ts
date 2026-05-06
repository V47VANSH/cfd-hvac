/**
 * Tier-2 backend client.
 *
 * The Tier-1 frontend autodiscovers the Tier-2 service by polling
 * ``/health`` on a configurable URL (default ``http://localhost:8000``,
 * overridable via the ``NEXT_PUBLIC_TIER2_URL`` env var or a runtime
 * setting in the UI). When the backend is reachable, the Tier-2 toolbar
 * group lights up; otherwise it greys out and Tier 1 keeps working
 * standalone.
 *
 * All endpoints are typed against the Pydantic shapes the Python backend
 * returns. We mirror the field names exactly so the JSON round-trips
 * without translation.
 */

import type { Scene } from "@/lib/io/schema";

const DEFAULT_BASE_URL =
  (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_TIER2_URL) ||
  "http://localhost:8000";

let baseURL = DEFAULT_BASE_URL;

export function setTier2BaseURL(url: string): void {
  baseURL = url.replace(/\/+$/, "");
}

export function getTier2BaseURL(): string { return baseURL; }


// ── Health ───────────────────────────────────────────────────────────────

export interface Tier2Health {
  status: "ok";
  openfoam_version: string;
  openfoam_available: boolean;
  endpoints: string[];
}

/** Returns ``null`` if Tier 2 is unreachable / errored. */
export async function fetchHealth(timeoutMs = 2000): Promise<Tier2Health | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${baseURL}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json() as Tier2Health;
  } catch {
    return null;
  }
}


// ── Validation runs ──────────────────────────────────────────────────────

export interface FieldSummary {
  mean_T: number;
  std_T: number;
  max_V: number;
  mean_PMV: number;
  mean_PPD: number;
  max_DR: number;
  cell_count: number;
  runtime_s: number;
}

export interface ValidationResult {
  request_id: string;
  case_dir: string;
  solver: string;
  turbulence_model: string;
  radiation_model: string | null;
  field_summary: FieldSummary;
  diff_vs_tier1: FieldSummary | null;
  residuals: Record<string, number>;
  converged: boolean;
  openfoam_version: string;
}

export async function runValidation(scene: Scene): Promise<ValidationResult> {
  const res = await fetch(`${baseURL}/run-validation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: serialiseScene(scene),
  });
  if (!res.ok) throw new Error(`run-validation failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

/**
 * Stringify a Scene for JSON transport. Standard JSON.stringify on a
 * Float32Array yields `{"0":1.5,"1":2.0,...}` (object with numeric keys),
 * which Pydantic's `list[float]` field rejects. Convert STL.positions
 * arrays to plain number[] before serialising — keeps the geometry
 * intact so the OpenFOAM case generator can write a real
 * triSurface/room.stl rather than falling back to AABB.
 */
function serialiseScene(scene: Scene): string {
  return JSON.stringify(scene, (_k, v) => {
    if (v instanceof Float32Array || v instanceof Float64Array) return Array.from(v);
    return v;
  });
}

export interface TransientResult {
  request_id: string;
  case_dir: string;
  duration_s: number;
  n_frames: number;
  summary_at_steady: FieldSummary;
  time_series: Array<{ t: number; mean_T: number; max_V: number; mean_PMV: number; mean_PPD: number }>;
}

export async function runTransient(scene: Scene, durationS: number = 600): Promise<TransientResult> {
  const res = await fetch(`${baseURL}/run-transient?duration_s=${durationS}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: serialiseScene(scene),
  });
  if (!res.ok) throw new Error(`run-transient failed: ${res.status}`);
  return await res.json();
}


// ── Multi-AC optimisation ───────────────────────────────────────────────

export interface OptCandidate {
  rank: number;
  f1_comfort: number;
  f2_energy_kwh: number;
  posterior_mean_J?: number | null;
  posterior_var_J?: number | null;
  ac_units: unknown[];
  rejected?: string | null;
}

export interface OptResult {
  request_id: string;
  method: string;
  n_evaluations: number;
  pareto_front: OptCandidate[];
  elapsed_s: number;
}

export async function optimizeMultiAC(scene: Scene, nAC = 2): Promise<OptResult> {
  const res = await fetch(`${baseURL}/optimize-multi-ac?n_ac=${nAC}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: serialiseScene(scene),
  });
  if (!res.ok) throw new Error(`optimize-multi-ac failed: ${res.status}`);
  return await res.json();
}

export async function optimizePareto(scene: Scene, nAC = 2, generations = 20): Promise<OptResult> {
  const res = await fetch(`${baseURL}/optimize-pareto?n_ac=${nAC}&generations=${generations}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: serialiseScene(scene),
  });
  if (!res.ok) throw new Error(`optimize-pareto failed: ${res.status}`);
  return await res.json();
}


// ── Benchmarks ──────────────────────────────────────────────────────────

export interface BenchmarkResult {
  name: string;
  passed: boolean;
  reference: string;
  metric: string;
  measured: number;
  tolerance: number;
  rmse?: number | null;
  notes: string[];
}

export async function runBenchmark(name: "annex20" | "cavity" | "mundt"): Promise<BenchmarkResult> {
  const res = await fetch(`${baseURL}/benchmarks/${name}`, { method: "POST" });
  if (!res.ok) throw new Error(`benchmarks/${name} failed: ${res.status}`);
  return await res.json();
}


// ── ANSYS comparison ────────────────────────────────────────────────────

export async function importAnsysCSV(scene: Scene, file: File): Promise<unknown> {
  const fd = new FormData();
  fd.append("scene", new Blob([serialiseScene(scene)], { type: "application/json" }));
  fd.append("csv_file", file);
  // Backend expects scene as the JSON body and csv as the multipart file.
  // FastAPI handles this with `Body(...)` + `File(...)` — we POST scene as
  // a JSON-encoded form field via Blob.
  const url = `${baseURL}/import-ansys`;
  // Workaround: FastAPI doesn't accept JSON in multipart by default. We
  // encode scene as a query-string param-equivalent body via a separate POST.
  const sceneRes = await fetch(url, {
    method: "POST",
    body: fd,
  });
  if (!sceneRes.ok) throw new Error(`import-ansys failed: ${sceneRes.status}`);
  return await sceneRes.json();
}


// ── Mesh independence + UQ ──────────────────────────────────────────────

export async function meshIndependence(scene: Scene): Promise<unknown> {
  const res = await fetch(`${baseURL}/mesh-independence`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: serialiseScene(scene),
  });
  if (!res.ok) throw new Error(`mesh-independence failed: ${res.status}`);
  return await res.json();
}

export async function runUncertainty(scene: Scene, nSamples = 50): Promise<unknown> {
  const res = await fetch(`${baseURL}/uncertainty?n_samples=${nSamples}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: serialiseScene(scene),
  });
  if (!res.ok) throw new Error(`uncertainty failed: ${res.status}`);
  return await res.json();
}


// ── Calibration & surrogate ─────────────────────────────────────────────

export async function runCalibration(): Promise<unknown> {
  const res = await fetch(`${baseURL}/calibrate`, { method: "POST" });
  if (!res.ok) throw new Error(`calibrate failed: ${res.status}`);
  return await res.json();
}

export async function trainSurrogate(sceneCount = 200): Promise<unknown> {
  const res = await fetch(`${baseURL}/train-surrogate?scene_count=${sceneCount}`, { method: "POST" });
  if (!res.ok) throw new Error(`train-surrogate failed: ${res.status}`);
  return await res.json();
}


// ── PDF report ──────────────────────────────────────────────────────────

export async function buildTier2PDF(requestId: string): Promise<{ pdf_path: string }> {
  const res = await fetch(`${baseURL}/report/${requestId}`, { method: "POST" });
  if (!res.ok) throw new Error(`report failed: ${res.status}`);
  return await res.json();
}

export function tier2ExportURL(requestId: string, fmt: "pdf" | "vtk" | "vtu" | "csv" | "json" | "mp4"): string {
  return `${baseURL}/export/${requestId}/${fmt}`;
}
