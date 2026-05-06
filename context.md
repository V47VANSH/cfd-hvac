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

## Current state (top of mind, 2026-05-07)

**Tier 1 (browser-only product) — fully working with STL room:**
- L6 STL test geometry loads as the room via toolbar `🏠 Use STL as room`.
  Cuboidal default room hides; STL becomes the simulation domain.
- All three Tier-1 backends (Legacy, MAC, WebGL2 GPU) restrict CFD to the
  L-shape interior via the shared `lib/geometry/roomMask.ts` 2D-footprint
  utility (stamp wall triangles into XZ plane, flood-fill from corners,
  cells outside the L-shape become wall).
- **Default backend is Legacy** (set in [AppShell.tsx](web/src/components/AppShell.tsx#L26))
  because Legacy is the v6-faithful animation the user wants.
- AC mounting height (`mounting_height_m`) plumbed end-to-end: schema →
  PropertyPanel "Mount Y m" field → worker → both Legacy
  ([sources.ts](web/src/lib/cfd/sources.ts#L61)) and MAC
  ([sources-mac.ts](web/src/lib/cfd/sources-mac.ts)) injection. STL-room
  default is 1.8 m (chimney-aware); cuboidal default stays 0.88·H.
- AC manual placement walks through wall material via face normal until
  the AC centre lands in a fluid cell — handles both inner and outer
  face clicks ([Room3D.tsx placeAC](web/src/components/Room3D.tsx)).
- Optimizer is STL-aware: candidates sample every "edge cell" inside the
  L-shape, AC flush against wall (not 0.5 m mid-air)
  ([runOptimizer.ts](web/src/lib/optimizer/runOptimizer.ts)).
- Particles spawn at `mounting_height_m ± 0.15 m` so they're caught by
  the AC throw cone immediately (was hardcoded to `H·0.82` which put
  them 2.5 m above the AC for STL bbox of 5.22 m — invisible throw).
- Bbox cuboid visuals fully suppressed when STL room active: walls,
  ceiling, floor, slab, grid, compass labels, AND the bbox-sized thermal
  overlays on those walls (otherwise they painted yellow ambient T
  outside the L-shape — the "yellow outer cuboid" the user complained
  about). Only the head-height slice plane stays
  ([buildOverlays.ts](web/src/lib/geometry/buildOverlays.ts) — its alpha
  follows the room mask so it traces just the L-shape footprint.
- Save / Load environment: toolbar `💾 Save / Load` opens a modal with
  both download (full-fidelity JSON, Float32Array STL positions
  serialised as plain arrays) and load (file picker OR paste textarea,
  with re-hydration of positions to Float32Array)
  ([ExportModal.tsx](web/src/components/ExportModal.tsx)).

**Tier 2 (OpenFOAM v2312) — backend ready, snappy fails on L6:**
- Docker image baked with all v2312 fixes + STL room support. `/health`
  returns OpenFOAM v2312 healthy. `cfd-tier2` container running.
- Pydantic schema accepts `role`, `bbox`, `positions`, `mounting_height_m`.
- `cases.py` writes `constant/triSurface/room.stl`, expands blockMesh
  bbox by 0.5 m + 0.3 m, registers STL as `triSurfaceMesh` with
  `refinementSurfaces.room { level (2 2); patchInfo { type wall; } }`,
  and emits a `room` patch entry in every BC writer (T, U, p_rgh, k,
  omega, alphat, nut).
- `tier2/client.ts` `serialiseScene` converts Float32Array STL positions
  to `number[]` so Pydantic accepts them.
- Tier2Panel has a `📄 Generate Report` button on validation results
  that calls `/report/{request_id}` and opens the PDF.

**Tier 2 active blocker** — `/run-validation` on L6 STL scene returned
HTTP 500 with `RuntimeError: snappyHexMesh failed (rc=-9)` (SIGKILL =
OOM). The L6 STL with refinement level (2,2) on a 9.6×10×5 m bbox blows
past snappy's `maxGlobalCells 4000000`. To unblock, either:
- Lower refinement to `level (1 1)` in [cases.py](server/cfd_server/cases.py)
- Lower `maxGlobalCells` to ~1M and `maxLocalCells` to ~250k
- OR coarsen the background blockMesh by reducing `nx_w/ny_w/nz_w`
  multipliers (currently `int(L*12)` etc.) to `int(L*6)`.

**Phase 4 follow-ups still open:**
- AC isn't injected as a momentum source in OpenFOAM cases yet (only
  natural convection). Add a `vectorSemiImplicitSource` fvOptions block
  in `_write_fv_options` keyed off scene.ac_units + mounting_height_m.
- Heat-source fvOptions reference `cellZone zone_obs_{ob.id}` that
  snappy doesn't currently create — solver may warn but should continue.
- Per-opening BCs still go to cuboidal `wall_S/N/E/W` patches, not the
  STL `room` patch's sub-regions. Day-2's auto-classifier output
  (`lib/geometry/classifySTL.ts`) could feed snappy's `regions` block to
  split `room` into `floor / roof / wall_S/N/E/W` patches.

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
| Phase 4 stage 2 | ✓ code, ◐ partially verified | All 13 modules substantively implemented (~3500 lines). v2312 swap done; solver runs end-to-end on default cuboidal scene (HTTP 200, real FieldSummary, mean_T 30.81°C, 46656 cells, 364s runtime). v2312 fixes baked into image. |
| Tier 2 frontend wiring | ✓ | `lib/tier2/client.ts` (with serialiseScene for Float32Array STL positions), `useTier2` hook, `Tier2Panel` in sidebar with health polling + greys-out on unavailable. `📄 Generate Report` button calls `/report/{request_id}`. |
| STL day-1 (Tier 1) | ✓ | Schema role + Use-as-room toggle + translucent + DoubleSide + clip-plane slider + hide-roof toggle. |
| STL day-2 (Tier 1) | ◐ | `lib/geometry/classifySTL.ts` written, ran on L6 (median-Y ceiling detection works). Patch list UI in sidebar deferred. |
| STL day-3 (Tier 1) | ✓ | `lib/geometry/roomMask.ts` 2D footprint inside-test, both voxelizers use it, optimizer uses it. CFD restricted to L-shape. |
| STL day-4 (Tier 2) | ◐ | cases.py emits room.stl + snappy refinementSurface + `room` patch BC. snappy OOMs on L6 — needs cell-cap tuning before /run-validation works on STL scenes. |

Total cumulative: ~12 000 lines TypeScript + ~3500 lines Python.

## What's remaining

### Right now (must-fix to unblock Tier 2 STL validation)
- [x] Dockerfile → OpenCFD v2312 with manual GPG signing
- [x] Solver `buoyantBoussinesqSimpleFoam` runs end-to-end on default scene
- [x] `/run-validation` returns parsed FieldSummary on default scene
- [x] Image rebuilt with all v2312 fixes + STL room support
- [x] STL-as-room: Tier 1 fully working (voxelizer, optimizer, manual
      placement, mounting height, particle spawn, viz cleanup)
- [ ] **snappy OOM on L6 STL**: refinement level (2,2) on a 9.6×10×5 m
      bbox blows past 4M cell cap. Lower to (1,1) or coarsen blockMesh.
- [ ] AC momentum source in OpenFOAM cases (currently natural-convection
      only; user can place AC in scene but it doesn't drive the solver).
- [ ] Per-opening BCs onto STL `room` patch sub-regions (use day-2
      classifier to split `room` into `floor / roof / wall_S/N/E/W`).

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

**Tier 2 (image already baked):**
```bash
cd server
docker compose up -d              # cfd-tier2, image cfd-server:0.1
curl http://localhost:8000/health
# Tier-1 frontend autodiscovers and lights up the Tier 2 sidebar panel
```

If you ever need a fresh rebuild:
```bash
cd server
docker compose down
docker build --network=host -t cfd-server:0.1 .   # ~15 min, --network=host critical (host is 14 MB/s, container without it is 56 KB/s)
docker compose up -d
```

## Handover notes for the next agent (2026-05-07)

**Architecture overview** — read these in order to onboard:
1. `PLAN.md` — engineering north stars, performance budgets, schema.
2. This file (`context.md`) — current state, blockers, what's next.
3. `web/src/lib/io/schema.ts` — the single source of truth for the JSON
   scene model. Every Tier-1 module reads from / writes to this. Tier-2
   Pydantic mirror is `server/cfd_server/schema.py`.
4. `web/src/lib/geometry/roomMask.ts` — the keystone for STL room
   support. 2D footprint stamp + flood-fill. Both Tier-1 voxelizers
   ([voxelize.ts](web/src/lib/cfd/voxelize.ts) for Legacy,
   [voxelize-mac.ts](web/src/lib/cfd/voxelize-mac.ts) for MAC) call it
   for STLs with `role: "room"`.

**Test STL** — user's reference geometry:
- `/home/sokhi/Downloads/L6 roof.STL` (uppercase `.STL` — Linux is case-sensitive).
- 138 KB binary STL, 2816 triangles, fully axis-aligned.
- Bbox in **millimetres** (9600 × 5010 × 9600 mm). Tier-1 import sets
  `scale ≈ 0.001042` to convert to metres, room bbox ends up
  9.31 × 10 × 5.22 m.
- Only 3 down-facing triangles (= "open-top" STL — was the original
  reason 3D flood-fill failed and we switched to 2D footprint).

**Verified end-to-end paths:**
- Tier-1 Legacy backend on L6 STL: voxelizes correctly, AC at 1.8 m
  injects throw, particles ride the throw, no bbox cuboid visible.
- Tier-2 default cuboidal scene: HTTP 200, real FieldSummary.

**Known broken / open paths:**
1. **Tier-2 `/run-validation` on STL room** — snappy OOM. Quick fix:
   change `level (2 2)` to `level (1 1)` in
   [cases.py `_write_snappy`](server/cfd_server/cases.py).
2. **AC has no effect in Tier-2 sim** — only natural convection; user
   needs to add a `vectorSemiImplicitSource` block in
   `_write_fv_options` keyed off `scene.ac_units`.
3. **Cabinet/step interior structures in L6 STL** — currently treated
   as walls (their vertical sides get stamped in the 2D footprint).
   Reasonable behaviour but means CFD blocks airflow through cabinet
   gaps. To fix would need 3D voxelization with min-height threshold
   (cabinets shorter than ~80% of room height = obstacles, not walls).
4. **WebGL2 backend on STL room** — uses MAC's wall mask (wired via
   `runtime.uploadFromMAC`) so should work in theory; not user-tested.
5. **Per-opening BCs on STL** — windows / doors still bind to cuboidal
   `wall_S/N/E/W`, not to the actual STL wall surface they overlap.

**Recently shipped UI:**
- Toolbar `💾 Save / Load` button (was `⚙ Export`) opens a modal with
  both download (full Scene including STL Float32Array as plain array)
  and load (file picker + paste textarea, hydrates back to Float32Array).
- `🏠 Use STL as room` second STL import button.
- `Hide roof` toggle + `Clip` slider in toolbar (only visible when room
  STL exists).
- `Mount Y m` field in AC PropertyPanel.
- `📄 Generate Report` button on Tier-2 validation result card.

**Useful shortcuts:**
- `cd "/home/sokhi/Downloads/cfd - Copy/web" && npx tsc --noEmit` to
  type-check the whole frontend (~30s, no output = clean).
- `docker logs cfd-tier2 --tail 50` to see Tier-2 errors.
- `docker exec cfd-tier2 bash -lc 'cd /tmp/cfd-cases && d=$(ls -1t | head -1); tail -40 "$d/log.snappyHexMesh"'`
  to inspect the latest OpenFOAM run.
- Worker file is `web/src/workers/cfd.worker.ts`. Hot-reload sometimes
  fails for workers — `rm -rf web/.next` if changes don't appear.

**User preferences observed:**
- Wants v6-faithful animation in Legacy backend (= the archive HTML
  `archive/cfd_room_3d_v6.html`). Don't deviate from v6 visual params.
- Wants AC visibly mounted at head height (not at chimney peak).
- Wants the bbox cuboid completely invisible in STL mode (any visible
  ghost rectangle = bug).
- Frustrated by repeated "click to test, screenshot, report" loops —
  prefer to ship in batches and verify holistically.
