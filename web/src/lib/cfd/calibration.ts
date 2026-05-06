/**
 * Calibrated solver constants — fitted by the Tier 2 OpenFOAM calibration
 * script and shipped as `web/public/calibration.json`. The MAC solver
 * loads them at startup; if no file is present, sane defaults are used.
 *
 * The calibration JSON is plain text and human-readable. Provenance fields
 * (gitSha, generatedAt, sourceCases) let the UI show exactly which Tier 2
 * run produced the active constants.
 */

export interface Calibration {
  /** Boussinesq buoyancy coefficient, 1/K */
  beta: number;
  /** Smagorinsky constant Cs */
  smagorinskyCs: number;
  /** Multigrid pre-smoothing iterations (Phase 2 default = 2) */
  mgPreSmooth: number;
  /** Multigrid post-smoothing iterations */
  mgPostSmooth: number;
  /** Multigrid V-cycles per pressure projection */
  mgCycles: number;
  /** Persistent forcing relaxation factor toward Fu/Fv/Fw */
  forceRelax: number;
  /** Buoyancy time-step multiplier (legacy) */
  buoyDtMult: number;
  /** Air thermal diffusivity, m²/s */
  alphaAir: number;
  /** Reference temperature for Boussinesq, °C */
  Tamb: number;
  /** Provenance — all optional */
  provenance?: {
    gitSha?: string;
    generatedAt?: string;
    sourceCases?: string[];
    rmseT?: number;
    rmseV?: number;
    rmsePMV?: number;
  };
}

export const DEFAULT_CALIBRATION: Calibration = {
  beta:           0.0034,
  smagorinskyCs:  0.17,
  mgPreSmooth:    2,
  mgPostSmooth:   2,
  mgCycles:       3,
  forceRelax:     0.10,   // jet pulls velocities toward fu/fv/fw fast enough to overcome advection drift
  buoyDtMult:     3,
  alphaAir:       2.0e-5,
  Tamb:           28,
};

// In-process cache so the worker doesn't refetch on every step
let cached: Calibration | null = null;

/**
 * Load calibration JSON from `/calibration.json`, falling back to defaults
 * if the fetch fails (404, parse error, no network in worker context).
 *
 * Safe to call from a Web Worker: uses `fetch()` and works against the
 * site origin's static assets in production builds.
 */
export async function loadCalibration(baseURL?: string): Promise<Calibration> {
  if (cached) return cached;
  try {
    const url = (baseURL ?? "") + "/calibration.json";
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as Partial<Calibration>;
    const merged: Calibration = { ...DEFAULT_CALIBRATION, ...json };
    cached = merged;
    return merged;
  } catch {
    cached = { ...DEFAULT_CALIBRATION };
    return cached;
  }
}

/** Synchronous accessor — only safe after loadCalibration has resolved. */
export function getCalibrationSync(): Calibration {
  return cached ?? DEFAULT_CALIBRATION;
}
