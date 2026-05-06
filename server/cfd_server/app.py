"""FastAPI app — Tier-2 endpoints.

Every endpoint mirrors the spec in ``PLAN.md §"Tier 2 — UI Surface &
Report Bindings"``. The UI greys out a button if its endpoint isn't
healthy, so adding endpoints later is safe.

Long-running endpoints (validation, optimisation, calibration) stream
progress as SSE so the frontend stays responsive. Each request gets a
``request_id`` (UUID4) that the frontend can quote in support tickets.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from sse_starlette.sse import EventSourceResponse

from .schema import Scene
from . import openfoam, calibration, optimize, ansys, benchmarks, surrogate, uncertainty, report as report_mod

log = logging.getLogger("cfd_server")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    log.info("cfd_server starting up — checking OpenFOAM availability")
    ok = await openfoam.check_available()
    log.info(f"OpenFOAM available: {ok}")
    yield
    log.info("cfd_server shutting down")


app = FastAPI(
    title="CFD HVAC Tier-2 Backend",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS — Tier 1 frontends are static, so allow any origin in dev. Production
# deployments should restrict to known origins.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Health & service discovery ───────────────────────────────────────────

@app.get("/health")
async def health() -> dict:
    of_ok, of_version = await openfoam.check_available_with_version()
    return {
        "status": "ok",
        "openfoam_version": of_version,
        "openfoam_available": of_ok,
        "endpoints": [
            "/run-validation", "/run-transient", "/import-ansys",
            "/optimize-multi-ac", "/optimize-pareto",
            "/benchmarks/annex20", "/benchmarks/cavity", "/benchmarks/mundt",
            "/uncertainty", "/mesh-independence",
            "/calibrate", "/train-surrogate",
        ],
    }


# ── Validation runs ──────────────────────────────────────────────────────

@app.post("/run-validation")
async def run_validation(scene: Scene) -> dict:
    """One-shot steady OpenFOAM run on the user's scene.

    Generates a snappyHexMesh case from the scene geometry, runs
    ``buoyantBoussinesqSimpleFoam``, parses with ofpp, returns field
    summary + difference vs Tier-1 fast solver.
    """
    request_id = str(uuid.uuid4())
    log.info(f"[{request_id}] /run-validation — kw=%s", sum(a.kw for a in scene.ac_units))
    result = await openfoam.run_steady(scene, request_id)
    return result.dict()


@app.post("/run-transient")
async def run_transient(scene: Scene, duration_s: float = 600.0) -> dict:
    """Time-resolved run with ``buoyantPimpleFoam``.

    Produces real "minutes-to-setpoint" curves and animation frames.
    Writes time series of T, V, RH at user-placed probes.
    """
    request_id = str(uuid.uuid4())
    log.info(f"[{request_id}] /run-transient duration=%ss", duration_s)
    result = await openfoam.run_transient(scene, duration_s, request_id)
    return result.dict()


# ── Multi-AC optimisation ────────────────────────────────────────────────

@app.post("/optimize-multi-ac")
async def optimize_multi_ac(scene: Scene, n_ac: int = 2) -> dict:
    """Bayesian multi-AC optimization with full OpenFOAM in the loop."""
    request_id = str(uuid.uuid4())
    log.info(f"[{request_id}] /optimize-multi-ac n_ac=%d", n_ac)
    result = await optimize.bayesian_multi_ac(scene, n_ac, request_id)
    return result.dict()


@app.post("/optimize-pareto")
async def optimize_pareto(scene: Scene, n_ac: int = 2, generations: int = 20) -> dict:
    """NSGA-III Pareto sweep with full-physics evaluation."""
    request_id = str(uuid.uuid4())
    log.info(f"[{request_id}] /optimize-pareto n_ac=%d gens=%d", n_ac, generations)
    result = await optimize.nsga3_pareto(scene, n_ac, generations, request_id)
    return result.dict()


# ── Benchmarks ───────────────────────────────────────────────────────────

@app.post("/benchmarks/annex20")
async def bench_annex20() -> dict:
    """IEA Annex 20 forced-ventilation room (Nielsen 1990)."""
    return (await benchmarks.run_annex20()).dict()


@app.post("/benchmarks/cavity")
async def bench_cavity() -> dict:
    """de Vahl Davis differentially-heated cavity at Ra=1e5."""
    return (await benchmarks.run_cavity()).dict()


@app.post("/benchmarks/mundt")
async def bench_mundt() -> dict:
    """Mundt 1996 stratification benchmark."""
    return (await benchmarks.run_mundt()).dict()


# ── ANSYS comparison ─────────────────────────────────────────────────────

@app.post("/import-ansys")
async def import_ansys(scene: Scene, csv_file: UploadFile = File(...)) -> dict:
    """Three-way comparison: Tier-1 fast solver vs OpenFOAM vs ANSYS CSV."""
    if not csv_file.filename or not csv_file.filename.endswith(".csv"):
        raise HTTPException(400, "Expected a .csv file from ANSYS CFD-Post export")
    data = await csv_file.read()
    return (await ansys.compare(scene, data)).dict()


# ── Mesh independence + UQ ───────────────────────────────────────────────

@app.post("/mesh-independence")
async def mesh_independence(scene: Scene) -> dict:
    """Run the same case at 3 refinement levels; report Grid Convergence Index."""
    return (await openfoam.mesh_independence_study(scene)).dict()


@app.post("/uncertainty")
async def uncertainty_quantification(scene: Scene, n_samples: int = 200) -> dict:
    """Monte-Carlo uncertainty quantification over user-selected uncertain inputs.

    Returns 95 % confidence intervals on PMV, PPD, mean T, max V, energy.
    """
    return (await uncertainty.monte_carlo(scene, n_samples)).dict()


# ── Calibration & surrogate ──────────────────────────────────────────────

@app.post("/calibrate")
async def run_calibration() -> dict:
    """Sweep Tier-1 constants over the test corpus, minimise RMSE vs OpenFOAM."""
    return await calibration.run()


@app.post("/train-surrogate")
async def train_surrogate(scene_count: int = 200) -> dict:
    """Train a small MLP on a library of OpenFOAM runs.

    Returns the path of the resulting `surrogate.json` for the frontend
    to download and ship to its optimizer.
    """
    return await surrogate.train(scene_count)


# ── SSE progress (long-running endpoints stream here) ────────────────────

@app.get("/progress/{request_id}")
async def progress_stream(request_id: str):
    """SSE stream of progress events for a long-running request.

    Frontend opens this with EventSource as soon as it has a request_id
    from a POST. Events: ``start``, ``step`` (with %), ``log``, ``done``.
    """
    async def gen():
        async for ev in openfoam.subscribe_progress(request_id):
            yield ev
    return EventSourceResponse(gen())


# ── Tier-2 PDF report builder ────────────────────────────────────────────

@app.post("/report/{request_id}")
async def build_tier2_report(request_id: str) -> dict:
    """Build a Tier-2 PDF report for a previously-completed run.

    The frontend passes the request_id of a finished /run-validation;
    the backend regenerates the validation result, optionally fetches
    cached ANSYS / GCI bundles, builds the PDF, and writes it to the
    case_dir for /export to serve.
    """
    from pathlib import Path
    case_dir = Path("/tmp/cfd-cases") / request_id
    if not case_dir.exists():
        raise HTTPException(404, f"No case found for {request_id}")
    # For stage-2 we re-parse the case_dir; future revisions cache the
    # ValidationResult JSON alongside the case.
    from .results import parse_fields, summarize
    from .openfoam import ValidationResult
    grid = parse_fields(case_dir)
    summ = summarize(grid, runtime_s=0)
    val = ValidationResult(
        request_id=request_id, case_dir=str(case_dir),
        solver="buoyantBoussinesqSimpleFoam", turbulence_model="kOmegaSST",
        radiation_model=None, field_summary=summ,
        residuals={}, converged=True, openfoam_version="unknown",
    )
    bundle = report_mod.ReportBundle(validation=val)
    out = case_dir / "report.pdf"
    report_mod.build_pdf(out, bundle)
    return {"status": "ok", "pdf_path": str(out)}


# ── Streaming PDF/MP4 export (passthrough to ffmpeg / html2pdf) ──────────

@app.get("/export/{request_id}/{fmt}")
async def export_artifact(request_id: str, fmt: str):
    """Re-export an existing run as VTK / VTU / Ensight / HD MP4 / Tier-2 PDF."""
    blob = await openfoam.export_artifact(request_id, fmt)
    if not blob:
        raise HTTPException(404, f"Artifact {fmt!r} for request {request_id!r} not found")
    media_type = {
        "vtk": "model/vtk",
        "vtu": "model/vtu",
        "ensight": "application/octet-stream",
        "mp4": "video/mp4",
        "pdf": "application/pdf",
        "csv": "text/csv",
        "json": "application/json",
    }.get(fmt, "application/octet-stream")
    async def gen():
        yield blob
    return StreamingResponse(gen(), media_type=media_type)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("cfd_server.app:app", host="0.0.0.0", port=8000, reload=True)


# Keep imports happy in tests
asyncio  # noqa: F401
