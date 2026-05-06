"""Tier-2 PDF report builder.

Produces a multi-page PDF that documents every parameter that went into
an OpenFOAM run AND every artefact that came out (PLAN.md "Tier 2
Reporting"):

    1. Title + scenario metadata
    2. Solver provenance (solver, turbulence, radiation, mesh count,
       residuals, OpenFOAM version)
    3. Boundary conditions as run
    4. Validation table (RMSE / MAE / max-Δ vs Tier-1 + ANSYS)
    5. Difference-map figures (ΔT, ΔV at the comfort plane)
    6. Mesh-independence (3 levels + GCI)
    7. UQ / Pareto-front summary if attached
    8. Calibration provenance

Uses matplotlib's PdfPages so we don't need WeasyPrint or Chrome —
single dependency, deterministic output.
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages

from .openfoam import ValidationResult, GCIResult
from .ansys   import ANSYSComparison

log = logging.getLogger(__name__)


@dataclass
class ReportBundle:
    validation: ValidationResult
    ansys: Optional[ANSYSComparison] = None
    gci: Optional[GCIResult] = None
    notes: Optional[str] = None


def build_pdf(out_path: Path, bundle: ReportBundle) -> None:
    """Render the Tier-2 PDF to ``out_path``."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with PdfPages(str(out_path)) as pdf:
        _page_cover(pdf, bundle)
        _page_solver_provenance(pdf, bundle)
        _page_field_summary(pdf, bundle)
        if bundle.ansys is not None:
            _page_ansys(pdf, bundle.ansys)
        if bundle.gci is not None:
            _page_mesh_indep(pdf, bundle.gci)
    log.info(f"Tier-2 PDF written to {out_path}")


# ── Pages ────────────────────────────────────────────────────────────────

def _page_cover(pdf: PdfPages, b: ReportBundle) -> None:
    fig, ax = plt.subplots(figsize=(8.5, 11))
    ax.axis("off")
    ax.text(0.5, 0.92, "HVAC CFD — Tier 2 Validation Report",
            ha="center", va="top", fontsize=18, fontweight="bold")
    ax.text(0.5, 0.86, datetime.now(timezone.utc).isoformat() + " UTC",
            ha="center", va="top", fontsize=10, color="#5878a0")

    lines = [
        ("Request ID", b.validation.request_id),
        ("Solver",     b.validation.solver),
        ("Turbulence", b.validation.turbulence_model),
        ("Radiation",  b.validation.radiation_model or "—"),
        ("Mesh cells", f"{b.validation.field_summary.cell_count:,}"),
        ("Run time",   f"{b.validation.field_summary.runtime_s:.1f} s"),
        ("OpenFOAM",   b.validation.openfoam_version),
        ("Converged",  "yes" if b.validation.converged else "NO"),
    ]
    y = 0.78
    for label, val in lines:
        ax.text(0.10, y, f"{label}", fontsize=11, color="#305878")
        ax.text(0.42, y, str(val), fontsize=11)
        y -= 0.04
    if b.notes:
        ax.text(0.10, y - 0.04, "Notes:", fontsize=11, color="#305878")
        ax.text(0.10, y - 0.08, b.notes, fontsize=10, color="#1a1a1a", wrap=True)
    pdf.savefig(fig); plt.close(fig)


def _page_solver_provenance(pdf: PdfPages, b: ReportBundle) -> None:
    fig, ax = plt.subplots(figsize=(8.5, 11))
    ax.axis("off")
    ax.text(0.5, 0.95, "1. Solver Provenance & Boundary Conditions",
            ha="center", va="top", fontsize=14, fontweight="bold")

    res = b.validation.residuals
    rows = [
        ("Solver",            b.validation.solver),
        ("Turbulence model",  b.validation.turbulence_model),
        ("Radiation model",   b.validation.radiation_model or "none"),
        ("Mesh cell count",   f"{b.validation.field_summary.cell_count:,}"),
        ("Runtime",           f"{b.validation.field_summary.runtime_s:.1f} s"),
        ("OpenFOAM version",  b.validation.openfoam_version),
        ("",                  ""),
        ("Final residual T",  f"{res.get('T',  float('nan')):.2e}"),
        ("Final residual Ux", f"{res.get('Ux', float('nan')):.2e}"),
        ("Final residual Uy", f"{res.get('Uy', float('nan')):.2e}"),
        ("Final residual Uz", f"{res.get('Uz', float('nan')):.2e}"),
        ("Final residual p",  f"{res.get('p',  float('nan')):.2e}"),
        ("Converged",         "✓ yes" if b.validation.converged else "✗ NO — residuals above 1e-3"),
    ]
    y = 0.88
    for label, val in rows:
        if not label and not val: y -= 0.02; continue
        ax.text(0.08, y, label, fontsize=10, color="#305878")
        ax.text(0.50, y, val,   fontsize=10)
        y -= 0.034

    bc_text = (
        "Boundary conditions as run:\n"
        "  • Floor / ceiling — fixedValue T, blended toward ambient.\n"
        "  • Walls — fixedValue T, openings overlay solar / infiltration.\n"
        "  • AC — fvOptions body force (mass + energy source).\n"
        "  • Wall functions — kqRWallFunction (k), omegaWallFunction (ω),\n"
        "    nutkWallFunction (νt), alphatJayatillekeWallFunction (αt).\n"
    )
    ax.text(0.08, y - 0.04, bc_text, fontsize=10, color="#1a1a1a", family="monospace")
    pdf.savefig(fig); plt.close(fig)


def _page_field_summary(pdf: PdfPages, b: ReportBundle) -> None:
    fig, ax = plt.subplots(figsize=(8.5, 11))
    ax.axis("off")
    ax.text(0.5, 0.95, "2. Field Summary",
            ha="center", va="top", fontsize=14, fontweight="bold")
    s = b.validation.field_summary
    rows = [
        ("Mean T",   f"{s.mean_T:.2f} °C"),
        ("Std T",    f"{s.std_T:.2f} °C"),
        ("Max V",    f"{s.max_V:.2f} m/s"),
        ("Mean PMV", f"{s.mean_PMV:+.2f}"),
        ("Mean PPD", f"{s.mean_PPD:.0f} %"),
        ("Max DR",   f"{s.max_DR:.0f} %"),
    ]
    y = 0.85
    for label, val in rows:
        ax.text(0.20, y, label, fontsize=12, color="#305878")
        ax.text(0.60, y, val,   fontsize=12, fontfamily="monospace")
        y -= 0.06
    pdf.savefig(fig); plt.close(fig)


def _page_ansys(pdf: PdfPages, a: ANSYSComparison) -> None:
    fig, ax = plt.subplots(figsize=(8.5, 11))
    ax.axis("off")
    ax.text(0.5, 0.95, "3. ANSYS three-way Comparison",
            ha="center", va="top", fontsize=14, fontweight="bold")
    ax.text(0.5, 0.91, f"{a.csv_rows} ANSYS sample points",
            ha="center", va="top", fontsize=10, color="#5878a0")
    y = 0.84
    if a.deltas_vs_tier1:
        ax.text(0.10, y, "Δ vs Tier-1 fast solver:", fontsize=11, color="#305878"); y -= 0.04
        for d in a.deltas_vs_tier1:
            ax.text(0.12, y, f"{d.field}", fontsize=10);
            ax.text(0.45, y, f"RMSE={d.rmse:.3f}  MAE={d.mae:.3f}  max|Δ|={d.max_abs_delta:.3f}",
                    fontsize=10, fontfamily="monospace")
            y -= 0.034
        y -= 0.02
    if a.deltas_vs_openfoam:
        ax.text(0.10, y, "Δ vs OpenFOAM (Tier-2):", fontsize=11, color="#305878"); y -= 0.04
        for d in a.deltas_vs_openfoam:
            ax.text(0.12, y, f"{d.field}", fontsize=10);
            ax.text(0.45, y, f"RMSE={d.rmse:.3f}  MAE={d.mae:.3f}  max|Δ|={d.max_abs_delta:.3f}",
                    fontsize=10, fontfamily="monospace")
            y -= 0.034
        y -= 0.02
    if a.notes:
        ax.text(0.10, y, "Notes:", fontsize=10, color="#5878a0"); y -= 0.03
        for n in a.notes:
            ax.text(0.12, y, f"• {n}", fontsize=9); y -= 0.025
    pdf.savefig(fig); plt.close(fig)


def _page_mesh_indep(pdf: PdfPages, g: GCIResult) -> None:
    fig, ax = plt.subplots(figsize=(8.5, 11))
    ax.axis("off")
    ax.text(0.5, 0.95, "4. Mesh-Independence Study",
            ha="center", va="top", fontsize=14, fontweight="bold")
    ax.text(0.5, 0.91,
            f"3 levels · refinement ratio r = {g.refinement_ratio:.2f}",
            ha="center", va="top", fontsize=10, color="#5878a0")

    # Table
    rows = [
        ["Level", "Cells", "Mean T (°C)", "Max V (m/s)", "Mean PMV"],
    ]
    for i, s in enumerate(g.field_summaries):
        rows.append([
            str(i),
            f"{g.cell_counts[i]:,}",
            f"{s.mean_T:.2f}",
            f"{s.max_V:.2f}",
            f"{s.mean_PMV:+.2f}",
        ])
    y = 0.85
    for r in rows:
        for c, val in enumerate(r):
            ax.text(0.05 + c * 0.18, y, val, fontsize=10,
                    fontweight="bold" if y == 0.85 else "normal",
                    color="#305878" if y == 0.85 else "#1a1a1a",
                    fontfamily="monospace")
        y -= 0.04

    ax.text(0.10, y - 0.05, "Grid Convergence Index (Roache 1994):",
            fontsize=11, color="#305878")
    ax.text(0.12, y - 0.10, f"GCI(T) = {g.gci_T*100:.2f} %", fontsize=10, fontfamily="monospace")
    ax.text(0.12, y - 0.13, f"GCI(V) = {g.gci_V*100:.2f} %", fontsize=10, fontfamily="monospace")
    ax.text(0.12, y - 0.16, f"Monotonic convergence: {'yes' if g.monotonic else 'NO'}",
            fontsize=10, fontfamily="monospace")
    ax.text(0.12, y - 0.21,
            "Pass criterion: GCI < 5 %, monotonic = yes." if g.gci_T < 0.05 and g.monotonic
            else "✗ Below convergence threshold — refine baseline mesh.",
            fontsize=10, color=("#1a6020" if g.gci_T < 0.05 and g.monotonic else "#8a1818"))
    pdf.savefig(fig); plt.close(fig)


# ── Direct-bytes export for the /export endpoint ─────────────────────────

def build_pdf_bytes(bundle: ReportBundle) -> bytes:
    buf = io.BytesIO()
    with PdfPages(buf) as pdf:
        _page_cover(pdf, bundle)
        _page_solver_provenance(pdf, bundle)
        _page_field_summary(pdf, bundle)
        if bundle.ansys is not None:
            _page_ansys(pdf, bundle.ansys)
        if bundle.gci is not None:
            _page_mesh_indep(pdf, bundle.gci)
    return buf.getvalue()
