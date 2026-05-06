"""ANSYS CFD-Post CSV importer + three-way comparison.

Locked CSV format (PLAN.md "ANSYS CSV format (locked)"):

    X[m], Y[m], Z[m], T[K], U[m/s], V[m/s], W[m/s], RH[%]

Header row required, units in brackets, single steady-state value per
(x, y, z). The comparison runs the same scene through OpenFOAM (via
``run_steady`` cached in CASE_ROOT) and reports RMSE / MAE / max-Δ
against both:
  * Tier-1 fast solver (ANSYS vs Tier-1)
  * OpenFOAM (ANSYS vs Tier-2)

Plus difference-map PNGs at the comfort plane (1.1 m).
"""

from __future__ import annotations

import csv
import io
import logging
import uuid
from typing import Optional

import numpy as np
from pydantic import BaseModel

from .schema import Scene
from .openfoam import run_steady, CASE_ROOT
from .results import parse_fields, render_difference_png

log = logging.getLogger(__name__)


REQUIRED_HEADERS = ["X[m]", "Y[m]", "Z[m]", "T[K]", "U[m/s]", "V[m/s]", "W[m/s]", "RH[%]"]


class FieldDelta(BaseModel):
    field: str
    rmse: float
    mae:  float
    max_abs_delta: float
    n_samples: int


class ANSYSComparison(BaseModel):
    csv_rows: int
    deltas_vs_tier1:    list[FieldDelta]
    deltas_vs_openfoam: list[FieldDelta]
    diff_map_pngs: dict[str, str]   # field → base64-encoded PNG
    notes: list[str] = []


async def compare(scene: Scene, csv_bytes: bytes) -> ANSYSComparison:
    rows = _parse_csv(csv_bytes)
    if not rows:
        raise ValueError("CSV is empty")
    log.info(f"ansys.compare: parsed {len(rows)} sample rows")

    pos = np.array([[r["X[m]"], r["Y[m]"], r["Z[m]"]] for r in rows], dtype=float)
    T_ans   = np.array([r["T[K]"]   for r in rows], dtype=float)
    U_ans   = np.array([r["U[m/s]"] for r in rows], dtype=float)
    V_ans   = np.array([r["V[m/s]"] for r in rows], dtype=float)
    W_ans   = np.array([r["W[m/s]"] for r in rows], dtype=float)
    speed_ans = np.sqrt(U_ans ** 2 + V_ans ** 2 + W_ans ** 2)

    notes: list[str] = []

    # ── OpenFOAM run ────────────────────────────────────────────────
    of_request_id = f"ansys-{uuid.uuid4().hex[:8]}"
    try:
        of_result = await run_steady(scene, of_request_id)
        grid = parse_fields(CASE_ROOT / of_request_id)
        T_of   = _sample_at_points(grid.cell_centres, grid.T,        pos)
        U_of   = _sample_at_points(grid.cell_centres, grid.U[:, 0],  pos)
        V_of   = _sample_at_points(grid.cell_centres, grid.U[:, 1],  pos)
        W_of   = _sample_at_points(grid.cell_centres, grid.U[:, 2],  pos)
        speed_of = np.sqrt(U_of ** 2 + V_of ** 2 + W_of ** 2)
        of_summary = of_result.field_summary
        _ = of_summary
    except Exception as e:
        log.warning(f"OpenFOAM run failed in /import-ansys: {e}")
        notes.append(f"OpenFOAM unavailable; ANSYS-vs-Tier-2 deltas skipped: {e}")
        T_of = U_of = V_of = W_of = speed_of = None     # type: ignore[assignment]

    # ── Tier-1 reference values ─────────────────────────────────────
    # Run the JS fast solver to get a reference field at (pos, ...).
    # In production we'd call the Tier-1 worker over a websocket; for now
    # we use a Python port that mirrors the legacy collocated solver.
    try:
        from .fast_solver import sample_tier1_at_points
        T_t1, V_t1 = sample_tier1_at_points(scene, pos)
    except Exception as e:
        log.warning(f"Tier-1 sample failed: {e}")
        notes.append(f"Tier-1 reference unavailable: {e}")
        T_t1 = V_t1 = None

    # ── Compute deltas ──────────────────────────────────────────────
    deltas_t1: list[FieldDelta] = []
    deltas_of: list[FieldDelta] = []
    if T_t1 is not None and V_t1 is not None:
        deltas_t1.append(_delta("T (K)", T_ans, T_t1))
        deltas_t1.append(_delta("V (m/s)", speed_ans, V_t1))
    if T_of is not None:
        deltas_of.append(_delta("T (K)", T_ans, T_of))
        deltas_of.append(_delta("V (m/s)", speed_ans, speed_of))   # type: ignore[arg-type]

    # ── Difference-map PNGs at the 1.1 m comfort plane ─────────────
    # Pick rows with Y near 1.1 m; project to (x, z) grid.
    y_target = 1.1
    near_mask = np.abs(pos[:, 1] - y_target) < 0.15
    diff_pngs: dict[str, str] = {}
    if near_mask.any() and T_of is not None:
        plane_pos = pos[near_mask]
        plane_T_ans = T_ans[near_mask]
        plane_T_of  = T_of[near_mask]
        try:
            png = render_difference_png(
                of_field=plane_T_of, t1_field=plane_T_ans,
                cell_centres=plane_pos, slice_y_m=y_target, label="T (K)",
            )
            import base64
            diff_pngs["T_at_1.1m"] = "data:image/png;base64," + base64.b64encode(png).decode()
        except Exception as e:
            notes.append(f"diff-map PNG render failed: {e}")

    return ANSYSComparison(
        csv_rows=len(rows),
        deltas_vs_tier1=deltas_t1,
        deltas_vs_openfoam=deltas_of,
        diff_map_pngs=diff_pngs,
        notes=notes,
    )


# ── Helpers ──────────────────────────────────────────────────────────────

def _parse_csv(b: bytes) -> list[dict]:
    rows = list(csv.reader(io.StringIO(b.decode("utf-8-sig"))))
    if not rows:
        return []
    header = [h.strip() for h in rows[0]]
    if header != REQUIRED_HEADERS:
        raise ValueError(
            f"Expected ANSYS CFD-Post header {REQUIRED_HEADERS!r}, got {header!r}. "
            "Re-export from ANSYS CFD-Post in tabular format with units in brackets."
        )
    out: list[dict] = []
    for r in rows[1:]:
        if not r or all(c.strip() == "" for c in r):
            continue
        try:
            out.append({k: float(v) for k, v in zip(header, r)})
        except ValueError:
            continue
    return out


def _sample_at_points(cell_centres: np.ndarray, field: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """Nearest-neighbour sample. ~Fine for ≲ 1k probe points; use cKDTree for more."""
    out = np.empty(len(pts), dtype=np.float64)
    if cell_centres.shape[0] == 0:
        out.fill(0); return out
    for i, p in enumerate(pts):
        d = np.linalg.norm(cell_centres - p[None, :], axis=1)
        out[i] = float(field[int(np.argmin(d))])
    return out


def _delta(label: str, ans: np.ndarray, other: np.ndarray) -> FieldDelta:
    """Compute RMSE / MAE / max-Δ between two same-shaped arrays."""
    err = ans - other
    return FieldDelta(
        field=label,
        rmse=float(np.sqrt(np.mean(err ** 2))),
        mae=float(np.mean(np.abs(err))),
        max_abs_delta=float(np.max(np.abs(err))),
        n_samples=int(len(err)),
    )
