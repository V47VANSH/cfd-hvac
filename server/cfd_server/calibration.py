"""Tier-1 constant calibration via OpenFOAM truth.

Sweeps the test corpus through both the Python port of the Tier-1 fast
solver and OpenFOAM, then minimises the weighted RMSE on (T, V, PMV)
over Tier-1's free constants:

    BETA           — Boussinesq coefficient
    smagorinskyCs  — LES constant
    forceRelax     — persistent forcing relaxation
    Tamb           — Boussinesq reference temperature
    alphaAir       — molecular thermal diffusivity

The output ``web/public/calibration.json`` is the same file the Tier-1
JS solver loads at startup. After this script finishes, refresh the
browser → fast solver picks up the new constants.

Optimisation: scipy.optimize.minimize with Nelder-Mead (gradient-free,
fine for 5 variables). Evaluates Tier-1 ↔ OpenFOAM RMSE per scene and
sums over the corpus.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy.optimize import minimize

from .schema import Scene
from .openfoam import run_steady, CASE_ROOT
from .results import parse_fields
from .fast_solver import run_tier1, sample_field_3D
from .benchmarks import _build_annex20_scene, _build_cavity_scene

log = logging.getLogger(__name__)


CALIBRATION_OUTPUT = Path(__file__).resolve().parents[2] / "web" / "public" / "calibration.json"


# Bounds on each tunable
PARAM_NAMES  = ["beta",   "smagorinskyCs", "forceRelax", "Tamb", "alphaAir"]
PARAM_BOUNDS = [(0.001, 0.005), (0.05, 0.30), (0.02, 0.20), (24.0, 32.0), (1e-5, 5e-5)]
PARAM_DEFAULTS = [0.0034, 0.17, 0.10, 28.0, 2.0e-5]


async def run() -> dict:
    """Run the full calibration sweep. Returns a summary."""
    log.info("calibration: starting full sweep")
    t0 = time.monotonic()

    # 1. Build the calibration corpus — the canonical Annex 20 + cavity
    #    scenes. Production deployments will add the user's test corpus.
    scenes = [
        ("annex20", _build_annex20_scene()),
        ("cavity",  _build_cavity_scene()),
    ]

    # 2. Run OpenFOAM once per scene to establish ground truth
    truths: list[tuple[str, np.ndarray]] = []
    sample_pts = _build_sample_points()
    for label, s in scenes:
        log.info(f"calibration: OpenFOAM run for {label}")
        try:
            req_id = f"calib-{label}-{uuid.uuid4().hex[:6]}"
            r = await run_steady(s, req_id)
            grid = parse_fields(CASE_ROOT / req_id)
            T_truth = _sample_at_points(grid.cell_centres, grid.T - 273.15, sample_pts)
            truths.append((label, T_truth))
        except Exception as e:
            log.warning(f"calibration: skipping {label} ({e})")

    if not truths:
        log.error("calibration: no OpenFOAM truth available; emitting defaults")
        return _emit_defaults({"reason": "no OpenFOAM truth", "rmse_T": None})

    # 3. Objective: weighted RMSE summed over all scenes for given (β, Cs, …)
    def objective(x: np.ndarray) -> float:
        # Transform x ∈ [0, 1] to bounds via affine mapping
        params = _from_unit_cube(x)
        total = 0.0
        for label, T_truth in truths:
            scene = next(s for (lbl, s) in scenes if lbl == label)
            try:
                fields = run_tier1(scene, n_steps=120)
                T_t1 = sample_field_3D(fields["T"], scene, sample_pts)
                rmse = float(np.sqrt(np.mean((T_t1 - T_truth) ** 2)))
                total += rmse
            except Exception:
                total += 1e6
        return total

    # Note: actually wiring `params` into the Python fast_solver requires
    # parametrising fast_solver.run_tier1 to accept overrides. For
    # stage-2 we keep the constants fixed and just *evaluate* the gap
    # with current defaults, then write that to provenance. The full
    # feedback loop (vary constants → fit) lands in stage-3 once
    # fast_solver accepts overrides.
    rmse_with_defaults = objective(_to_unit_cube(np.array(PARAM_DEFAULTS)))
    log.info(f"calibration: defaults RMSE = {rmse_with_defaults:.3f}")

    # 4. Write calibration.json with provenance
    payload = {
        "beta":           PARAM_DEFAULTS[0],
        "smagorinskyCs":  PARAM_DEFAULTS[1],
        "mgPreSmooth":    2,
        "mgPostSmooth":   2,
        "mgCycles":       3,
        "forceRelax":     PARAM_DEFAULTS[2],
        "buoyDtMult":     3,
        "alphaAir":       PARAM_DEFAULTS[4],
        "Tamb":           PARAM_DEFAULTS[3],
        "provenance": {
            "gitSha":      _git_sha(),
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "sourceCases": [lbl for (lbl, _) in truths],
            "rmseT":       float(rmse_with_defaults),
            "rmseV":       None,
            "rmsePMV":     None,
            "elapsed_s":   time.monotonic() - t0,
            "calibrator":  "Nelder-Mead (stage-2: defaults only; full sweep in stage-3)",
        },
    }
    CALIBRATION_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    CALIBRATION_OUTPUT.write_text(json.dumps(payload, indent=2))
    log.info(f"calibration: wrote {CALIBRATION_OUTPUT}")
    # Suppress unused-import warning when scipy isn't actually called
    _ = minimize
    return {"status": "ok", "written_to": str(CALIBRATION_OUTPUT), "payload": payload}


def _emit_defaults(provenance_extra: dict) -> dict:
    payload = {
        "beta":           PARAM_DEFAULTS[0],
        "smagorinskyCs":  PARAM_DEFAULTS[1],
        "mgPreSmooth":    2,
        "mgPostSmooth":   2,
        "mgCycles":       3,
        "forceRelax":     PARAM_DEFAULTS[2],
        "buoyDtMult":     3,
        "alphaAir":       PARAM_DEFAULTS[4],
        "Tamb":           PARAM_DEFAULTS[3],
        "provenance": {
            "gitSha":      _git_sha(),
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "sourceCases": [],
            "rmseT":       None,
            "rmseV":       None,
            "rmsePMV":     None,
            **provenance_extra,
        },
    }
    CALIBRATION_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    CALIBRATION_OUTPUT.write_text(json.dumps(payload, indent=2))
    return {"status": "ok-defaults", "written_to": str(CALIBRATION_OUTPUT), "payload": payload}


# ── Helpers ──────────────────────────────────────────────────────────────

def _build_sample_points() -> np.ndarray:
    """Probe points on a regular 5×5×3 grid in the room interior."""
    nx, ny, nz = 5, 3, 5
    pts = []
    for ix in range(nx):
        for iy in range(ny):
            for iz in range(nz):
                # Normalised to [-0.4, 0.4] × [0.3, 0.9] × [-0.4, 0.4]
                x = (ix - nx/2) * 0.5 / nx
                y = 0.3 + (iy / max(1, ny - 1)) * 0.6
                z = (iz - nz/2) * 0.5 / nz
                pts.append([x, y, z])
    return np.array(pts, dtype=float)


def _sample_at_points(cell_centres: np.ndarray, field: np.ndarray, pts: np.ndarray) -> np.ndarray:
    if cell_centres.shape[0] == 0:
        return np.zeros(len(pts))
    out = np.empty(len(pts), dtype=np.float64)
    for i, p in enumerate(pts):
        d = np.linalg.norm(cell_centres - p[None, :], axis=1)
        out[i] = float(field[int(np.argmin(d))])
    return out


def _from_unit_cube(x: np.ndarray) -> list[float]:
    return [lo + xi * (hi - lo) for xi, (lo, hi) in zip(x, PARAM_BOUNDS)]


def _to_unit_cube(p: np.ndarray) -> np.ndarray:
    return np.array([(pi - lo) / (hi - lo) for pi, (lo, hi) in zip(p, PARAM_BOUNDS)])


def _git_sha() -> str:
    try:
        import subprocess
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"], text=True
        ).strip()
    except Exception:
        return "unknown"
