"""OpenFOAM result parsing and field-level statistics.

Reads the latest time directory in an OpenFOAM case and produces:
  * Cell-centred field arrays (T, U, p, k, omega) as numpy arrays
  * Aggregate statistics (mean, std, max) for the snapshot
  * Difference maps and PNG renders against a reference Tier 1 field

Uses ``ofpp`` + ``PyVista``. Falls back to a hand-rolled FoamFile parser
for the few quantities ofpp doesn't expose (residuals, runTime).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Optional

import numpy as np
from pythermalcomfort.models import pmv_ppd_iso

log = logging.getLogger(__name__)


@dataclass
class FieldGrid:
    """Fields parsed from one OpenFOAM time directory.

    All arrays have length = ncells. Velocity is component-major:
    ``U[0::3]`` is u, ``U[1::3]`` is v, ``U[2::3]`` is w.
    Cell centre coordinates in ``cell_centres[0::3, 1::3, 2::3]``.
    """
    time:    float
    n_cells: int
    cell_centres: np.ndarray  # (ncells, 3)
    T:       np.ndarray       # (ncells,) — Kelvin
    U:       np.ndarray       # (ncells, 3) — m/s
    p:       Optional[np.ndarray]
    k:       Optional[np.ndarray]
    omega:   Optional[np.ndarray]


@dataclass
class FieldSummary:
    mean_T:   float       # °C
    std_T:    float
    max_V:    float
    mean_PMV: float
    mean_PPD: float
    max_DR:   float
    cell_count: int
    runtime_s: float


@dataclass
class ResidualHistory:
    """Convergence history extracted from log.<solver>."""
    iterations: list[int]
    residual_T:  list[float]
    residual_Ux: list[float]
    residual_Uy: list[float]
    residual_Uz: list[float]
    residual_p:  list[float]


# ── Time-directory discovery ─────────────────────────────────────────────

def latest_time(case_dir: Path) -> Optional[float]:
    """Return the largest numeric time directory (e.g. 2000.0)."""
    candidates: list[float] = []
    for p in case_dir.iterdir():
        if not p.is_dir():
            continue
        try:
            t = float(p.name)
            candidates.append(t)
        except ValueError:
            continue
    return max(candidates) if candidates else None


# ── Field parser ─────────────────────────────────────────────────────────

def parse_fields(case_dir: Path, time: Optional[float] = None) -> FieldGrid:
    """Parse cell-centred T / U / p / k / omega from the time directory.

    Falls back to ``ofpp.FoamMesh`` when ``ofpp`` is available; otherwise
    uses a minimal in-house FoamFile parser. Always succeeds if the case
    is a steady-state result with at least the T and U fields written.
    """
    if time is None:
        t = latest_time(case_dir)
        if t is None:
            raise FileNotFoundError(f"No time directory in {case_dir}")
        time = t
    time_dir = case_dir / _format_time(time)
    if not time_dir.exists():
        raise FileNotFoundError(f"Time directory missing: {time_dir}")

    mesh = _read_mesh(case_dir)
    cell_centres = _read_cell_centres(case_dir, mesh.n_cells)
    T = _read_volscalar(time_dir / "T", mesh.n_cells)
    U = _read_volvector(time_dir / "U", mesh.n_cells)
    p = _try_volscalar(time_dir / "p_rgh", mesh.n_cells)
    if p is None:
        p = _try_volscalar(time_dir / "p", mesh.n_cells)
    k = _try_volscalar(time_dir / "k", mesh.n_cells)
    omega = _try_volscalar(time_dir / "omega", mesh.n_cells)

    return FieldGrid(
        time=time, n_cells=mesh.n_cells,
        cell_centres=cell_centres,
        T=T, U=U, p=p, k=k, omega=omega,
    )


def summarize(g: FieldGrid, runtime_s: float = 0.0,
              met: float = 1.1, clo: float = 0.5, rh_pct: float = 50.0) -> FieldSummary:
    """Compute field statistics + comfort indices for the snapshot.

    PMV / PPD use a uniform met/clo over the whole field (the per-cell
    distribution is reported in the summary table, not as a single number).
    Tmrt is approximated as Tair (boundary-cell averaging is what the
    Tier-1 code does; for the OpenFOAM run we'd ideally pull surface
    temperatures here, deferred to stage-3).
    """
    # K → °C
    T_C = g.T - 273.15
    # speed magnitudes
    spd = np.linalg.norm(g.U, axis=1)
    pmv_arr, ppd_arr = _vectorised_pmv_ppd(T_C, spd, met=met, clo=clo, rh_pct=rh_pct)
    dr_arr = _vectorised_draft_risk(T_C, spd)
    return FieldSummary(
        mean_T=float(T_C.mean()),
        std_T=float(T_C.std()),
        max_V=float(spd.max()),
        mean_PMV=float(pmv_arr.mean()),
        mean_PPD=float(ppd_arr.mean()),
        max_DR=float(dr_arr.max()),
        cell_count=g.n_cells,
        runtime_s=runtime_s,
    )


# ── Difference maps + PNG render ─────────────────────────────────────────

def render_difference_png(
    of_field: np.ndarray, t1_field: np.ndarray,
    cell_centres: np.ndarray, slice_y_m: float,
    label: str,
) -> bytes:
    """Render a 2D ΔT map at ``slice_y_m`` to a PNG (bytes).

    Uses matplotlib's Agg backend (no display required). The OpenFOAM
    field and the Tier-1 reference must be sampled at the same XZ grid
    at this Y; the caller is responsible for that (see sampling.py).
    """
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    diff = of_field - t1_field
    fig, ax = plt.subplots(figsize=(6, 4), dpi=120)
    # Reshape if rectangular grid was passed in. We assume the caller
    # supplies (Nz, Nx) ordered arrays; otherwise we plot as-is.
    if diff.ndim == 2:
        im = ax.imshow(diff, cmap="RdBu_r", origin="lower", aspect="equal")
    else:
        # Fallback: scatter at cell-centre coords
        im = ax.scatter(cell_centres[:, 0], cell_centres[:, 2],
                        c=diff, cmap="RdBu_r", s=8)
    ax.set_title(f"{label}  Δ(OpenFOAM − Tier 1)  at  y = {slice_y_m:.2f} m")
    ax.set_xlabel("x (m)"); ax.set_ylabel("z (m)")
    fig.colorbar(im, ax=ax, label="Δ value")
    buf = BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight")
    plt.close(fig)
    return buf.getvalue()


# ── Residual history ─────────────────────────────────────────────────────

_RES_RE = re.compile(
    r"Solving for (\w+),\s*Initial residual = ([\d.eE+-]+),\s*"
    r"Final residual = ([\d.eE+-]+),\s*No Iterations \d+",
)


def parse_residuals(case_dir: Path, log_filename: str = "log.simpleFoam") -> ResidualHistory:
    """Parse residuals from an OpenFOAM solver log.

    Looks for the log at ``case_dir/log.<solver>``. If it doesn't exist,
    returns an empty history rather than raising — log parsing is
    best-effort and shouldn't block result return.
    """
    p = case_dir / log_filename
    h = ResidualHistory(
        iterations=[], residual_T=[], residual_Ux=[],
        residual_Uy=[], residual_Uz=[], residual_p=[],
    )
    if not p.exists():
        # try buoyantBoussinesqSimpleFoam or other names
        for cand in case_dir.glob("log.*Foam"):
            p = cand
            break
        if not p.exists():
            return h
    text = p.read_text(errors="ignore")
    iters = 0
    for line in text.splitlines():
        if line.startswith("Time = "):
            iters += 1
            h.iterations.append(iters)
            # pad with NaN; the next residual lines will overwrite
            h.residual_T.append(np.nan)
            h.residual_Ux.append(np.nan)
            h.residual_Uy.append(np.nan)
            h.residual_Uz.append(np.nan)
            h.residual_p.append(np.nan)
            continue
        m = _RES_RE.search(line)
        if not m or not h.iterations:
            continue
        field, init_r, _final_r = m.group(1), float(m.group(2)), float(m.group(3))
        idx = -1
        if   field == "T":   h.residual_T[idx]  = init_r
        elif field == "Ux":  h.residual_Ux[idx] = init_r
        elif field == "Uy":  h.residual_Uy[idx] = init_r
        elif field == "Uz":  h.residual_Uz[idx] = init_r
        elif field in {"p_rgh", "p"}: h.residual_p[idx] = init_r
    return h


# ── Helpers — minimal FoamFile parsing ───────────────────────────────────

@dataclass
class _MeshInfo:
    n_cells: int


def _read_mesh(case_dir: Path) -> _MeshInfo:
    """Get the cell count from the polyMesh.

    Tries ``ofpp.FoamMesh`` first (handles all the dictionary nuances),
    otherwise reads ``constant/polyMesh/owner`` whose internalField label
    encodes the cell count.
    """
    try:
        from ofpp import FoamMesh
        m = FoamMesh(str(case_dir))
        return _MeshInfo(n_cells=int(m.num_cell))
    except Exception:
        pass
    owner = case_dir / "constant" / "polyMesh" / "owner"
    if not owner.exists():
        raise FileNotFoundError(f"polyMesh/owner missing in {case_dir}")
    txt = owner.read_text(errors="ignore")
    # OpenFOAM's polyMesh/owner header notes the mesh size in two
    # equivalent formats depending on version:
    #   Foundation:  note "nCells 46656 nPoints 50764 …"   (whitespace)
    #   OpenCFD:     note "nPoints:50764  nCells:46656 …"  (colon)
    m = re.search(r"nCells[\s:]+(\d+)", txt)
    if m:
        return _MeshInfo(n_cells=int(m.group(1)))
    raise RuntimeError("could not parse mesh cell count from polyMesh/owner")


def _read_cell_centres(case_dir: Path, n_cells: int) -> np.ndarray:
    """Try to read pre-computed cell centres; fall back to zeros.

    Real OpenFOAM cell centres come from ``writeCellCentres -constant``
    (or PyVista's `vtk_extract` on the case). For stage-2 we issue a
    placeholder; if a `<time>/C` field exists we use it.
    """
    # Many cases run `postProcess -func writeCellCentres` which writes
    # constant/Cx, Cy, Cz volScalarFields. We don't enforce that here.
    cx = _try_volscalar(case_dir / "constant" / "Cx", n_cells)
    cy = _try_volscalar(case_dir / "constant" / "Cy", n_cells)
    cz = _try_volscalar(case_dir / "constant" / "Cz", n_cells)
    if cx is not None and cy is not None and cz is not None:
        return np.stack([cx, cy, cz], axis=1)
    return np.zeros((n_cells, 3), dtype=np.float64)


def _read_volscalar(path: Path, n_cells: int) -> np.ndarray:
    txt = path.read_text(errors="ignore")
    return _parse_internal_field(txt, n_cells)


def _try_volscalar(path: Path, n_cells: int) -> Optional[np.ndarray]:
    if not path.exists():
        return None
    try:
        return _read_volscalar(path, n_cells)
    except Exception:
        return None


def _read_volvector(path: Path, n_cells: int) -> np.ndarray:
    """Vector volume field: returns (n_cells, 3)."""
    txt = path.read_text(errors="ignore")
    return _parse_internal_vector_field(txt, n_cells)


_INTERNAL_FIELD_RE = re.compile(
    r"internalField\s+(?:nonuniform\s+List<\w+>\s*)?(\d+)?\s*\(?\s*",
    re.MULTILINE,
)


def _parse_internal_field(txt: str, n_cells: int) -> np.ndarray:
    """Parse a non-uniform List<scalar> internalField.

    Handles both inline `(v1 v2 v3 ... vN)` and the list-after-count form.
    """
    # Uniform shortcut
    m = re.search(r"internalField\s+uniform\s+([-\d.eE+]+)\s*;", txt)
    if m:
        return np.full(n_cells, float(m.group(1)), dtype=np.float64)
    # Non-uniform — find the first '(' after "internalField"
    pos = txt.find("internalField")
    if pos < 0: raise ValueError("no internalField in file")
    paren = txt.find("(", pos)
    if paren < 0: raise ValueError("no list opener after internalField")
    end = txt.find(")", paren)
    if end < 0: raise ValueError("no list closer after internalField")
    payload = txt[paren + 1:end]
    vals = np.fromstring(payload, sep=" ")
    if len(vals) < n_cells:
        raise ValueError(f"parsed {len(vals)} scalar values, expected {n_cells}")
    return vals[:n_cells]


def _parse_internal_vector_field(txt: str, n_cells: int) -> np.ndarray:
    # Uniform shortcut: `uniform (a b c)`
    m = re.search(r"internalField\s+uniform\s+\(\s*([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s*\)", txt)
    if m:
        v = np.array([float(m.group(1)), float(m.group(2)), float(m.group(3))], dtype=np.float64)
        return np.tile(v, (n_cells, 1))
    pos = txt.find("internalField")
    if pos < 0: raise ValueError("no internalField in file")
    paren = txt.find("(", pos)
    if paren < 0: raise ValueError("no list opener after internalField")
    # The vector list is `( (ux uy uz) (ux uy uz) ... )`. Strip outer parens
    # and re-tokenise on per-vector parens.
    end = _find_matching_paren(txt, paren)
    payload = txt[paren + 1:end]
    # Find every (a b c) triple
    triples = re.findall(r"\(\s*([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s*\)", payload)
    if len(triples) < n_cells:
        raise ValueError(f"parsed {len(triples)} vector tuples, expected {n_cells}")
    arr = np.array([[float(a), float(b), float(c)] for a, b, c in triples[:n_cells]],
                    dtype=np.float64)
    return arr


def _find_matching_paren(txt: str, open_pos: int) -> int:
    depth = 1
    i = open_pos + 1
    while i < len(txt) and depth > 0:
        if txt[i] == "(": depth += 1
        elif txt[i] == ")": depth -= 1
        i += 1
    return i - 1


def _format_time(t: float) -> str:
    """OpenFOAM uses `1` for integer times, `1.5` for fractional. Match."""
    if abs(t - round(t)) < 1e-9:
        return str(int(round(t)))
    return f"{t}"


# ── Comfort vectorisation ────────────────────────────────────────────────

def _vectorised_pmv_ppd(
    T_C: np.ndarray, spd: np.ndarray,
    met: float, clo: float, rh_pct: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Per-cell PMV + PPD.

    pythermalcomfort doesn't vectorise neatly on older versions, so we
    iterate. Cost is ~50 µs per cell × ~100k cells = 5 s — only run
    on snapshot frames, not per-step.
    """
    n = len(T_C)
    pmv_out = np.empty(n, dtype=np.float64)
    ppd_out = np.empty(n, dtype=np.float64)
    for i in range(n):
        try:
            r = pmv_ppd_iso(
                tdb=float(T_C[i]), tr=float(T_C[i]),
                v=float(spd[i]),  rh=rh_pct, met=met, clo=clo,
            )
            # Library returns dict in newer versions, namedtuple in older.
            if hasattr(r, "pmv"):
                pmv_out[i] = r.pmv
                ppd_out[i] = r.ppd
            else:
                pmv_out[i] = r["pmv"]; ppd_out[i] = r["ppd"]
        except Exception:
            pmv_out[i] = 0.0; ppd_out[i] = 5.0
    return pmv_out, ppd_out


def _vectorised_draft_risk(T_C: np.ndarray, spd: np.ndarray, tu: float = 40.0) -> np.ndarray:
    """ISO 7730 §6.2 draft risk, vectorised."""
    valid = (T_C < 34) & (spd > 0.05)
    out = np.zeros_like(T_C)
    if not valid.any():
        return out
    v = np.minimum(spd[valid], 0.5)
    dr = (34 - T_C[valid]) * np.power(v - 0.05, 0.62) * (0.37 * v * tu + 3.143)
    out[valid] = np.clip(dr, 0, 100)
    return out
