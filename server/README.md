# CFD HVAC — Tier 2 Backend

OpenFOAM-backed validation, calibration, mesh-independence, ANSYS comparison,
and Bayesian multi-AC optimization for the Tier-1 browser tool.

This directory is **independent of the frontend** — Tier 1 in `web/` runs
without any of this. Spin Tier 2 up only when you want research-grade
accuracy or want to recalibrate the fast solver.

## Quick start

```bash
# From the project root
cd server
docker compose up --build

# Verify
curl http://localhost:8000/health
# → { "status": "ok", "openfoam_version": "...", "endpoints": [...] }
```

The Tier-1 frontend will autodiscover the backend and light up the
"Tier 2" toolbar group as soon as `/health` succeeds.

## OpenFOAM version

The Docker image bundles **OpenFOAM v2312 (OpenCFD)**. We tried
Foundation v10 first — its repo signs cleanly — but v9+ dropped the
legacy solver names the case generator emits (`buoyantBoussinesqSimpleFoam`
became the unified `buoyantFoam` with `physicalProperties` instead of
`transportProperties`). v2312 keeps the legacy names and the
`transportProperties` schema, so it drops in cleanly. We bypass
OpenCFD's broken `add-debian-repo.sh` and sign the apt repo manually
with the dearmored key from `https://dl.openfoam.com/pubkey.gpg`.

## Without Docker (development)

Requires OpenFOAM v2312 installed locally (Linux or WSL2). On Ubuntu:

```bash
# Install OpenFOAM v2312 with modern apt signing (manual — OpenCFD's
# add-debian-repo.sh is broken at the GPG dearmor step).
curl -fsSL https://dl.openfoam.com/pubkey.gpg \
    | sudo gpg --dearmor -o /usr/share/keyrings/openfoam-archive-keyring.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/openfoam-archive-keyring.gpg] https://dl.openfoam.com/repos/deb jammy main" \
    | sudo tee /etc/apt/sources.list.d/openfoam.list
sudo apt update && sudo apt install -y openfoam2312-default
echo "source /usr/lib/openfoam/openfoam2312/etc/bashrc" >> ~/.bashrc
source ~/.bashrc

cd server
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
uvicorn cfd_server.app:app --reload --port 8000
```

## Endpoints

Mirrors PLAN.md §"Tier 2 — UI Surface & Report Bindings" exactly. See
`cfd_server/app.py` for the canonical list and signatures. Long-running
endpoints stream progress via SSE on `/progress/{request_id}`.

| Method | Path                       | What it does |
|--------|----------------------------|--------------|
| GET    | `/health`                  | service discovery + OpenFOAM availability |
| POST   | `/run-validation`          | steady OpenFOAM run on the user's scene |
| POST   | `/run-transient`           | time-resolved `buoyantPimpleFoam` run |
| POST   | `/import-ansys`            | three-way compare Tier1 vs OpenFOAM vs ANSYS |
| POST   | `/optimize-multi-ac`       | Bayesian GP multi-AC optimisation |
| POST   | `/optimize-pareto`         | NSGA-III multi-objective Pareto sweep |
| POST   | `/benchmarks/annex20`      | Nielsen 1990 forced-ventilation regression |
| POST   | `/benchmarks/cavity`       | de Vahl Davis Ra=1e5 cavity regression |
| POST   | `/benchmarks/mundt`        | Mundt 1996 stratification benchmark |
| POST   | `/uncertainty`             | Monte-Carlo uncertainty quantification |
| POST   | `/mesh-independence`       | 3-level GCI study |
| POST   | `/calibrate`               | sweep Tier-1 constants vs OpenFOAM |
| POST   | `/train-surrogate`         | train MLP surrogate for fast Tier-1 screening |
| GET    | `/export/{id}/{fmt}`       | re-export VTK / VTU / Ensight / MP4 / PDF / CSV / JSON |
| GET    | `/progress/{id}`           | SSE stream of progress events |

## Implementation status

Phase-4 stage 1 (this scaffold) is complete:

- ✅ FastAPI app with all endpoints wired
- ✅ Pydantic schema mirroring the Tier-1 JSON Scene model 1-to-1
- ✅ OpenFOAM case generator skeleton (`cases.py`) emitting valid
     `controlDict`, `blockMeshDict`, `snappyHexMeshDict`, `fvSchemes`,
     `fvSolution`, `transportProperties`, `turbulenceProperties`, plus
     initial fields for T, U, p_rgh, k, omega
- ✅ `openfoam.py` runner that calls `blockMesh + snappyHexMesh +
     buoyantBoussinesqSimpleFoam` and parses results
- ✅ ANSYS CSV header validator
- ✅ Calibration script that emits a default `calibration.json` with
     full provenance metadata
- ✅ Dockerfile (Ubuntu 22.04 + OpenFOAM v2312 + Python 3.10 + ffmpeg)
- ✅ docker-compose.yml with named volume for case artifacts

Phase-4 **stage 2** (next focused session, ~2 weeks of work):

- [ ] snappyHexMesh refinement boxes around obstacles + AC patches
- [ ] Per-opening BC types (windowSolar, doorInfiltration)
- [ ] AC inlet velocity profile + turbulence intensity
- [ ] Optional `viewFactor` or `fvDOM` radiation
- [ ] Conjugate heat transfer (`chtMultiRegionFoam`) for thick walls
- [ ] Real ofpp + PyVista parsing of T, U, p, k, omega fields
- [ ] Real difference-map PNG renderer
- [ ] pymoo Bayesian GP-EI optimiser with full physics
- [ ] pymoo NSGA-III with reference directions
- [ ] Real Annex 20 / cavity / Mundt benchmark cases
- [ ] Monte-Carlo UQ sampler with parallel workers
- [ ] Mesh-independence study runner with real GCI
- [ ] scikit-learn surrogate trainer + JSON export
- [ ] Tier-2 PDF report builder

## Architecture

```
                        ┌──────────────────┐
                        │  Tier-1 frontend │
                        │  web/  (Next.js) │
                        └────────┬─────────┘
                                 │ HTTPS / SSE
                                 ▼
                        ┌──────────────────┐
                        │   FastAPI app    │
                        │   cfd_server/    │
                        └────────┬─────────┘
                                 │
       ┌────────────────────────┼─────────────────────────┐
       ▼                        ▼                         ▼
┌──────────────┐        ┌──────────────┐         ┌──────────────┐
│  cases.py    │        │  openfoam.py │         │ optimize.py  │
│  Scene→case  │───────▶│  run + parse │◀────────│ Bayesian GP  │
└──────────────┘        └──────┬───────┘         │ NSGA-III     │
                               │                 └──────────────┘
                               ▼
                       ┌──────────────┐
                       │  /tmp/cfd-   │
                       │   cases/{id} │  ← OpenFOAM case_dir per request
                       └──────────────┘
```

## Calibration loop

The crucial Tier-1 ↔ Tier-2 link:

```
1. POST /calibrate  → backend runs OpenFOAM on test corpus
2. Sweeps Tier-1 constants (BETA, Cs, jet decay, AC relax, …)
3. Minimises weighted RMSE on (T, V, PMV) vs OpenFOAM truth
4. Writes web/public/calibration.json with provenance
5. Tier-1 fast solver loads it on next page reload
```

Tier 1 is honest because it's calibrated against Tier 2; Tier 2 is
honest because it's OpenFOAM with k-ω SST + radiation + CHT (when
stage-2 lands).

## Testing

```bash
pytest                  # all tests
pytest tests/unit       # unit only
pytest -k "ansys"       # only ANSYS-related tests
```

Stage-1 ships ~no tests (the modules are stubs). Stage-2 brings:

- Unit tests for `cases.py` (each emitted dict parses with `pyFoam`)
- Snapshot tests for OpenFOAM case directory structure
- Integration test that runs Annex 20 end-to-end and checks pass/fail
