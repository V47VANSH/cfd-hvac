# Project Context — what's done, what's left, where we are

Single-document summary so a future session can pick up cold without
replaying the whole chat. Keep this updated as work progresses.

## What this project is

A browser-only HVAC CFD + comfort + multi-AC optimization tool.

- **Tier 1** (`web/`) — Next.js + TypeScript + raw Three.js + a Web
  Worker running our own MAC solver. No install, no backend. Ships as
  static files. **This is the product.**
- **Tier 2** (`server/`) — Optional Python/FastAPI backend that wraps
  OpenFOAM for research-grade validation, calibration, Bayesian
  multi-AC optimization, ANSYS comparison, Monte-Carlo uncertainty,
  mesh-independence study. Tier 1 works without it.

User goal: "crazy ass solver and optimization tool" — not a college
submission. Optimize for the tool itself, not paperwork.

## Current state (top of mind)

**Working right now:**
- Tier 1 fully shipped end-to-end. 29/29 tests passing, 363 KB initial
  gzipped bundle, build clean.
- Tier 2 Python code is logically complete (~3500 lines across 13
  modules). All endpoints respond.
- Docker image builds successfully on Ubuntu 22.04 + **OpenFOAM v2312
  (OpenCFD)**. `/health` returns `{ "openfoam_version": "OpenFOAM v2312" }`.
- `buoyantBoussinesqSimpleFoam` runs end-to-end: 2000 SIMPLE iterations
  on the 4×3×2.7 m default scene in ~320 s, writes 0/, 1500/, 2000/
  time directories, residuals visible in `log.buoyantBoussinesqSimpleFoam`.

**Active work:**
- **STL-as-room (user's actual room geometry)** — user wants to import
  a non-cuboidal STL and have it BECOME the simulation domain (not
  just an obstacle inside the default cuboid). Roof in the STL must be
  hideable / translucent so the inside CFD animation is visible.
  Designed in this session, awaiting greenlight to implement.

**Resolved this session:**
- Switched Tier 2 from Foundation v10 → OpenCFD v2312 with manual apt
  signing. v10 dropped `buoyantBoussinesqSimpleFoam` (became unified
  `buoyantFoam` with `physicalProperties` instead of `transportProperties`).
- Docker pip install was 56 KB/s inside the container (host net was
  14 MB/s). Fixed by `docker build --network=host` so the container
  uses the host bridge directly. ~10× faster build.
- Split pip install into staged groups + `--prefer-binary` so resolver
  doesn't backtrack across the whole heavy scientific stack.
- Dropped unused `CoolProp` from pyproject.
- v2312 case-generator fixes (all in `cases.py` + `results.py`):
  - `fvSchemes` needs `wallDist { method meshWave; }` block (kOmegaSST
    requires it in v9+).
  - `0/p_rgh` dimensions changed from `[1 -1 -2 0 0 0 0]` (Pa) to
    `[0 2 -2 0 0 0 0]` (kinematic m²/s) — Boussinesq solver is
    incompressible, p_rgh is kinematic pressure.
  - `0/alphat` dimensions changed from `[1 -1 -1 0 0 0 0]` (dynamic)
    to `[0 2 -1 0 0 0 0]` (kinematic) — same incompressible reason.
  - `results.py` regex `nCells\s+(\d+)` → `nCells[\s:]+(\d+)` to handle
    the OpenCFD note format `"nCells:46656"` (colon, no space).
  - `results.py:106` had `np_array1 or np_array2` which trips numpy's
    truthiness check; replaced with explicit None check.

**Important caveat:** The above cases.py / results.py fixes are
currently **only `docker cp`'d into the running container** and will
vanish on rebuild. They ARE saved in the source files. A clean rebuild
is needed to bake them into the image, OR docker-compose can mount
`./cfd_server` as a bind mount during dev iteration.

## What's been done (timeline)

| Phase | Status | Notes |
|---|---|---|
| Phase 0 / 0b | ✓ before this session | Foundation, web worker, placement tools, overlays |
| Phase 1 | ✓ | PMV/PPD/DR, multi-height sampling, ComparisonView, PDF report |
| Phase 2 | ✓ | MAC grid, multigrid Poisson, semi-Lagrangian, Smagorinsky, RH+CO₂ scalars, view-factor Tmrt, per-occupant PMV, calibration loader |
| Phase 2.5 polish | ✓ | Real inlet BC (replaces body-force jet), kW coupling, adaptive Smagorinsky, AC swing, constraint polygon tool, restricted-surface tool, STL import, material library, climate picker, AI explanation, PWA/service worker, onboarding tour |
| Phase 3 | ✓ | NSGA-II joint multi-AC optimizer with Pareto front, energy & cost, Multi-AC modal with explanation panel |
| Phase 2b stage 1 | ✓ | WebGL2 GPU backend — atlas, framebuffer manager, 13 GLSL kernels, runtime, worker integration. Same grid as JS for v1; Jacobi pressure (not multigrid). |
| Phase 4 stage 1 | ✓ | Tier 2 scaffold — FastAPI app, all 13 endpoint stubs, Dockerfile, docker-compose |
| Phase 4 stage 2 | ✓ code, ◐ partially verified | All 13 modules substantively implemented (~3500 lines). v2312 swap done; solver runs end-to-end. `/run-validation` parsing chain fixed (4 v2312-compat patches in `cases.py` + `results.py`). Other endpoints unverified. Image needs rebuild to bake fixes in. |
| Tier 2 frontend wiring | ✓ | `lib/tier2/client.ts`, `useTier2` hook, `Tier2Panel` in sidebar with health polling + greys-out on unavailable |

Total cumulative: ~12 000 lines TypeScript + ~3500 lines Python.

## What's remaining

### Right now (must-fix to unblock Tier 2)
- [x] Dockerfile → OpenCFD v2312 with manual GPG signing
- [x] Solver `buoyantBoussinesqSimpleFoam` runs end-to-end on default scene
- [◐] `/run-validation` returns parsed FieldSummary — fixes shipped via
      docker cp, final verification + bake-into-image pending
- [ ] **Rebuild image so cases.py + results.py fixes survive**
- [ ] **STL-as-room feature** — user needs their actual room imported
      as the simulation domain (not just an interior obstacle), with
      roof hideable so they can see the CFD animation inside

### Short follow-ups (each ~½–1 day, fully verifiable here)
- [ ] STL transform gizmos in 3D viewport (drag/scroll/rotate handles)
- [ ] Live continuous optimization mode (background NSGA-II while user edits)
- [ ] Touch hardening for tablets

### Phase 2b stage 2 (~1 week) — bigger GPU win
- [ ] GPU multigrid pressure solver (replaces Jacobi)
- [ ] 96×36×72 high-accuracy grid (needs multigrid for budget)
- [ ] RH + CO₂ scalar advection on GPU
- [ ] Smagorinsky LES on GPU

### Phase 4 stage 3 (~1 week, after stage 2 stabilises)
- [ ] snappyHexMesh AC inlet patches (currently AC is fvOptions body force)
- [ ] Real conjugate heat transfer for thick walls (`chtMultiRegionFoam`)
- [ ] More benchmarks beyond Annex 20 / cavity / Mundt
- [ ] Wire the calibration loop's `optimize` step (currently emits
      defaults; the sweep is sketched but the constants don't flow back
      into `fast_solver.run_tier1` yet)

## Plan / scope decisions made

- **PLAN.md is the engineering bible**, not a submission doc. Academic
  sections (Methodology, Reproducibility, Glossary, References)
  archived to `PLAN-MAJOR-PROJECT.md` separately so they're available
  if ever needed but don't clutter the working plan.
- **WebGL2 over WebGPU** for Tier 1 GPU acceleration — broader browser
  support (Safari/Firefox covered). WebGPU stays as a Phase 5 opt-in.
- **Joint multi-AC moved to Tier 1** (was Tier 2 in original plan).
  NSGA-II in JS handles 1–3 AC units. Tier 2's Bayesian GP variant is
  the deeper version with full physics in the loop.
- **Optimizer scoring is two-pillar**: 50 % volume comfort (always),
  50 % occupant comfort (when humans present). Volume always matters
  even with humans — placements that cool only the people but skip the
  room get penalised.
- **AC kW means actual cooling power** — patch volume scales as `kW^(1/3)`,
  per-substep heat extraction capped at `kW × dt` joules.
- **OpenFOAM v2312 (OpenCFD) > v10 (Foundation)** because v10 removed
  legacy solver names that our case generator emits. Manual apt signing
  bypasses OpenCFD's broken `add-debian-repo.sh` script. **Verified
  this session** — solver runs end-to-end after four small v2312-compat
  patches to `cases.py` and `results.py` (see Resolved this session).
- **Docker pip stage uses `--network=host`**: without it the pip
  resolution-and-download took >30 min at 56 KB/s. With host network
  it runs at full host bandwidth. Implication: `docker compose build`
  alone won't get the speedup — call `docker build --network=host`
  directly, or set `network: host` in the compose `build:` block.

## Key file locations

```
cfd/
├── PLAN.md                                  ← engineering plan (working doc)
├── PLAN-MAJOR-PROJECT.md                    ← archived academic sections
├── phase_0_complete.md                      ← Phase 0/0b history (old)
├── context.md                               ← this file
├── archive/cfd_room_3d_v6.html              ← original monolith, untouched
│
├── web/                                     ← Tier 1 (Next.js)
│   ├── src/
│   │   ├── app/                             ← Next.js routes
│   │   ├── components/                      ← Room3D, Toolbar, Sidebar, modals
│   │   ├── lib/
│   │   │   ├── cfd/                         ← MAC solver + multigrid + advection
│   │   │   │   ├── webgl2/                  ← Phase 2b GPU backend
│   │   │   │   ├── solver-mac.ts            ← MAC solver step()
│   │   │   │   ├── multigrid.ts             ← V-cycle Poisson
│   │   │   │   ├── advection.ts             ← Stam semi-Lagrangian
│   │   │   │   └── …
│   │   │   ├── comfort/                     ← ISO 7730 PMV/PPD/DR
│   │   │   ├── ashrae/                      ← Heat load + materials
│   │   │   ├── energy/                      ← CDH + cost
│   │   │   ├── optimizer/                   ← NSGA-II + scoring + AI explanation
│   │   │   ├── geometry/                    ← Three.js mesh builders
│   │   │   ├── io/schema.ts                 ← JSON scene model (single source of truth)
│   │   │   ├── report/                      ← Tier 1 PDF
│   │   │   └── tier2/                       ← Tier 2 client + useTier2 hook
│   │   └── workers/cfd.worker.ts            ← runs solver off main thread
│   ├── public/
│   │   ├── sw.js                            ← PWA service worker
│   │   ├── manifest.json
│   │   └── calibration.json                 ← (written by Tier 2 calibrate)
│   └── package.json
│
└── server/                                  ← Tier 2 (FastAPI + OpenFOAM)
    ├── Dockerfile                           ← currently Foundation v10, needs swap to OpenCFD v2312
    ├── docker-compose.yml
    ├── pyproject.toml
    ├── README.md
    └── cfd_server/
        ├── app.py                           ← FastAPI app, 13 endpoints + /report/{id}
        ├── schema.py                        ← Pydantic mirror of TS Scene
        ├── cases.py                         ← OpenFOAM case generator (full)
        ├── openfoam.py                      ← case runner + parser wiring
        ├── results.py                       ← ofpp/PyVista field parser
        ├── optimize.py                      ← Bayesian GP-EI + NSGA-III
        ├── benchmarks.py                    ← Annex 20 / cavity / Mundt
        ├── ansys.py                         ← three-way comparison
        ├── uncertainty.py                   ← Monte Carlo UQ
        ├── surrogate.py                     ← MLP trainer
        ├── calibration.py                   ← Tier-1 constants sweep
        ├── report.py                        ← Tier 2 PDF builder
        └── fast_solver.py                   ← Python port of Tier 1 collocated solver
```

## Verifications snapshot

- TypeScript strict: clean
- Tests: 29/29 passing
- Build: clean, 363 KB initial gzipped bundle
- Python ast.parse: 13/13 modules parse cleanly
- Docker build: ✓ (OpenCFD v2312, ~3 GB image)
- Docker run: container starts, `/health` returns 200 with
  `openfoam_version: "OpenFOAM v2312"`
- `buoyantBoussinesqSimpleFoam`: runs end-to-end (320 s, 2000 iters)
- `/run-validation`: ◐ ran solver successfully, parsing fixes shipped
  via docker cp, full end-to-end verification in progress

## How to run

**Tier 1 alone (works now):**
```bash
cd web
npm install
npm run dev
# open http://localhost:3000
```

**Tier 2 (after the v2312 fix):**
```bash
cd server
docker compose up --build         # ~15 min first time
curl http://localhost:8000/health
# Tier-1 frontend autodiscovers and lights up the Tier 2 sidebar panel
```
