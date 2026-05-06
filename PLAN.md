# HVAC CFD Optimization & Validation System — Master Plan

## North Stars

1. **Simple for the end user.** Open the URL, get an answer in under two minutes, no install, no terminal.
2. **Lightweight and fast.** Browser-only by default. ≤ 2 MB initial bundle. ≥ 30 fps during simulation. Optimizer returns in ≤ 30 s.
3. **Honest physics.** Fast solver is calibrated against a validated reference. Full OpenFOAM / ANSYS validation lives in an *optional* backend that the default user never has to touch.

If a feature breaks (1) or (2), it doesn't ship in Tier 1.

---

## System Philosophy

This is **not** a pure CFD tool. It is an **HVAC decision engine** powered by hybrid CFD (fast for interaction, accurate on demand).

- Browser is the product. Backend is a power-user accessory.
- Speed and accuracy are separate problems with separate solvers.
- The JSON scene is the single source of truth — UI, fast solver, OpenFOAM, and reports all read it.
- Progressive disclosure: 70 % of users see only "Simple Mode" controls.

---

## Tiered Architecture

```
┌─ Tier 1 — Browser (the default product) ─────────────────────────┐
│  Three.js editor + per-occupant comfort viz                      │
│  Fast CFD: MAC staggered grid · semi-Lagrangian advection ·      │
│            multigrid pressure projection · Smagorinsky LES ·     │
│            RH + CO₂ passive scalars · CFL-adaptive timestep      │
│  Compute backend: WebGL2 (turbo) ➜ JS Worker (universal fallback)│
│  PMV / PPD / Draft Risk overlays · per-occupant local PMV        │
│  ASHRAE heat-load · operative temperature · vertical ΔT          │
│  Joint multi-AC NSGA-II optimizer (1–3 ACs, Pareto front)        │
│  Live continuous optimization (background mode)                  │
│  Energy & cost estimate · constraint polygons                    │
│  One-click PDF report · JSON import/export                       │
└──────────────────────────────┬───────────────────────────────────┘
                               │ optional HTTPS
┌──────────────────────────────┴───────────────────────────────────┐
│  Tier 2 — Optional Python backend (gold-standard analysis)       │
│  OpenFOAM v2312 (OpenCFD) — buoyantBoussinesqSimpleFoam (steady) │
│                  + buoyantPimpleFoam (transient, on demand)      │
│  Turbulence: k-ω SST · k-ε realizable · LES (selectable)         │
│  Radiation: fvDOM or view-factor (proper Tmrt)                   │
│  Conjugate heat transfer for wall thermal mass                   │
│  Mesh-independence study (3 levels, GCI report)                  │
│  ANSYS CSV importer & three-way comparison                       │
│  Calibration loop (tunes Tier 1 constants from OpenFOAM truth)   │
│  Bayesian multi-AC optimizer (pymoo, full physics, no surrogate) │
│  Uncertainty quantification (Monte Carlo over BC inputs)         │
│  All Tier 1 reports + extensive Tier 2 report (every parameter   │
│  documented, all artefacts downloadable)                         │
└──────────────────────────────────────────────────────────────────┘
```

If Tier 2 is unreachable, its buttons are hidden — Tier 1 is fully
self-contained and capable of placing, optimizing, and reporting on
multi-AC configurations on its own.

---

## End-User Workflow (must stay this simple)

1. Open the URL.
2. A default room loads (4 × 3 × 2.7 m, one south window, one east door, outdoor 35 °C, setpoint 24 °C).
3. Adjust dimensions; drag in people / appliances as needed.
4. Click **Optimize**. Wait ≤ 30 s.
5. See best AC position, comfort map, energy estimate.
6. Click **Report** for a PDF or **Export** for the JSON config.

Anything else lives behind an "Advanced" toggle.

---

## Performance Budget (binding)

| Metric | Budget |
|---|---|
| Initial bundle (gzipped) | ≤ 2 MB |
| Time-to-interactive (cold cache, mid laptop) | ≤ 2 s |
| Frame rate while editing | ≥ 60 fps |
| Frame rate during fast sim | ≥ 30 fps |
| Single fast-sim convergence | ≤ 4 s |
| Optimizer (default scene, single AC) | ≤ 30 s |
| Report PDF generation | ≤ 3 s |
| Peak memory | ≤ 300 MB |

A feature that blows the budget moves to Tier 2 or gets cut. CI checks bundle size on every PR.

---

## JSON Scene Model — Single Source of Truth

Versioned. Migrations on load.

```jsonc
{
  "schema_version": 1,
  "geometry": {
    "L": 4.0, "W": 3.0, "H": 2.7,
    "extensions": [ { "x":0, "z":0, "W":2, "D":2, "H":2.7,
                      "ry_deg":0, "rx_deg":0, "rz_deg":0 } ],
    "stl": [ { "name":"…", "x":0, "y":0, "z":0,
               "scale":1, "ry_deg":0, "rx_deg":0, "rz_deg":0 } ]
  },
  "openings": [ { "wall":"S", "type":"win|door|circ|arch",
                  "u":1.5, "v":1.0, "uw":1.2, "vh":1.1, "open":true,
                  "u_value": 5.8,
                  "solar_transmittance": 0.65,
                  "air_permeability": 0.0 } ],
  "obstacles": [ { "shape":"box|cyl|shelf|human|appliance|cfan|tfan",
                   "x":0, "z":0, "W":0.6, "D":0.5, "H":0.9, "Yoff":0,
                   "watts":200, "rpm":120, "season":"summer", "dir":0,
                   "on":true } ],
  "environment": {
    "outdoor_temp_C": 35, "setpoint_C": 24,
    "RH_outdoor_pct": 60, "met": 1.1, "clo": 0.5,
    "tariff_per_kwh": 8.0, "co2_per_kwh_kg": 0.7
  },
  "constraints": {
    "forbidden_zones": [ { "shape":"polygon", "vertices":[[x,z],…],
                           "reason":"door swing" } ],
    "restricted_surfaces": [ { "wall":"E", "u":1.0, "v":1.2,
                               "uw":0.4, "vh":0.3,
                               "reason":"switchboard" } ],
    "wall_rules": { "S":"allow", "N":"allow", "E":"deny", "W":"allow" },
    "min_clearance_m": 0.5,
    "allowed_walls": ["S","N","E","W"]
  },
  "ac_units": [ { "wall":"S", "x":0, "z":-1.5,
                  "kw":1.5, "capacity_tr":0.43, "type":"split",
                  "throw_distance_m":4.0, "airflow_angle_deg":0,
                  "flow_rate_cfm":350, "on":true } ],
  "results_cache_key": "sha256(…)"
}
```

A migration table maps every prior version forward; the loader runs them in order. Schema is the contract every module reads from and writes to.

---

## Tier 1 — Modules

### 1. Geometry & UI
- Everything v6 already has (rooms, blocks, openings, obstacles, fans, STL).
- New: **constraint-zone polygon tool** (draw forbidden regions and restricted surfaces on walls/floor).
- New: **Simple ↔ Advanced** toggle hiding ~70 % of controls.
- New: **Onboarding tour** — three contextual tooltips on first visit, dismissible.
- New: **Multi-AC placement** — user may place up to **3 AC units** in Tier 1, each independently editable (capacity in kW/TR, airflow angle, throw distance). **Joint multi-AC optimization runs in Tier 1** (see §5); Tier 2 offers a deeper Bayesian variant with full physics for users who want maximum rigor.
- New: **AC swing (oscillating louvres)** — each AC carries `swing_horizontal`, `swing_vertical`, `swing_period_s`, `swing_h_amp_deg`, `swing_v_amp_deg`. The worker rebuilds the jet forcing every 5 substeps using the instantaneous swept yaw/pitch, so the jet visibly sweeps the room over the swing period. Also `vertical_angle_deg` (centre pitch) is per-AC, replacing the old hardcoded −10° downward tilt.
- **STL handling — Tier 1 scope: transform-only** (scale, rotate, translate). Mesh modification (cut, boolean, simplify) is a future Tier 2 option.
- **Dual animation viewer** — two playable animations side-by-side: (a) **Simulation animation** (actual physics evolution) and (b) **Suggested-fix animation** (optimized layout overlay / before-after). Each is independently playable in the UI and independently exportable (see *Export & Data Outputs*).

### 2. Fast Solver (Web Worker + WebGL2)

The Tier 1 solver is rebuilt to be **honest, fast, and interactive** — not
just a hand-tuned demo. It is calibrated against OpenFOAM (Tier 2) but
runs in the browser without any backend.

**Numerics.**
- **MAC (staggered) grid** — pressure at cell centres, velocity components
  on cell faces. Eliminates checkerboard pressure modes that bite a
  collocated grid under semi-Lagrangian advection. (Harlow & Welch 1965.)
- **Semi-Lagrangian momentum advection** (Stam 1999) — unconditionally
  stable, lets us run at large CFL.
- **Multigrid Poisson pressure solver** (V-cycle, Brandt 1977) — 5–20×
  faster than Gauss-Seidel at equivalent residual; gives a properly
  divergence-free velocity field instead of "approximately incompressible."
  Falls back to red-black GS if multigrid fails to converge.
- **MacCormack-style limited advection** for temperature and scalars —
  second-order accurate, monotone, no over/undershoot of the comfort field.
- **CFL-adaptive timestep** — `dt` scales with `min(dx/|V|max, …)`; the
  AC jet is stable at any throw distance, no hand-tuned clamps.
- **Smagorinsky LES eddy viscosity** (Cs configurable per scene) for
  large-Reynolds rooms; falls back to constant turbulent viscosity for
  small rooms where LES is overkill.

**Physics.**
- **RH passive scalar** — humans emit ~50 g/h moisture; infiltration sets
  boundary RH from `RH_outdoor_pct`. Feeds PMV / PPD directly.
- **CO₂ passive scalar** — humans emit ~0.005 L/s CO₂ at 1 met; lets the
  comfort engine flag stuffy zones (concentration > 1000 ppm).
- **Boussinesq buoyancy** with calibrated `BETA` from Tier 2.
- **Per-unit directional AC jet model** — each AC unit's
  `throw_distance_m`, `airflow_angle_deg`, and `flow_rate_cfm` shape a
  proper momentum-conserving jet (Gaussian profile decaying from the
  inlet, lateral spread tied to throw distance).
- **Per-opening physics** — each opening's `u_value`, `solar_transmittance`,
  and `air_permeability` drive the local boundary flux. Replaces v6's
  globals.
- **Per-occupant comfort sampling** — each `human` obstacle gets its own
  local PMV / PPD computed from the cells immediately around it (a 3×3×3
  cube), not just from the 3-height global average. The optimizer scores
  *per-person* dissatisfaction.
- **Approximate radiation** — Tmrt computed via a fast view-factor
  approximation against the six dominant surfaces; significantly more
  accurate than "Tmrt = Tair." (True view-factor or DOM is Tier 2.)

**Compute backend (auto-selected at startup).**

| Tier | Coverage | Speed-up vs JS | Used for |
|---|---|---|---|
| **WebGL2 fragment-shader compute** | ~99 % of modern browsers (Chrome, Edge, Safari, Firefox) | 10–30× | High-accuracy grid, multi-AC optimization inner loop |
| **JS in a Web Worker** | universal | 1× | Default fallback; small grids; deterministic regression tests |
| **WebGPU compute (opt-in flag)** | Chrome / Edge stable; Safari / Firefox eventually | 30–100× | Power users on supported browsers |

The selection is automatic and transparent — same code path, same
results within numerical tolerance. WebGL2 ping-pong textures handle
all three velocity components, pressure, T, RH, CO₂, and the wall mask.

**Grids.** Default **48 × 18 × 36** (≈ 31 k cells). "High accuracy"
toggle goes to **96 × 36 × 72** (≈ 250 k cells) — feasible only on the
WebGL2 backend, where it still runs at ≥ 30 fps on a mid laptop.

**Time-to-temperature accuracy.** Tier 1's transient evolution is now
*honest* (the multigrid + adaptive dt + proper inlet BCs make it so) but
remains **engineering-grade** — research-grade transient validation
still belongs to Tier 2's `buoyantPimpleFoam` runs.

**Calibration coupling.** All free constants — Smagorinsky `Cs`, jet
decay coefficient, AC relax factor, Boussinesq `BETA` correction,
multigrid pre/post-smoothing iterations — are read from
`web/public/calibration.json`, written by the Tier 2 calibration script.
The fast solver is honest by virtue of being calibrated, not by
hand-tuning.

### 3. Comfort Engine (ASHRAE 55 / ISO 7730)
Pure functions over the grid:
- **PMV** (Fanger)
- **PPD**
- **Draft Risk (DR)**
- **Vertical air-temperature difference** at 0.1 / 0.6 / 1.1 m
- **Operative temperature** (air T + mean radiant T)

Recomputed every 5 sim steps. Color overlays selectable: T, V, PMV, PPD, DR.

### 4. ASHRAE Heat-Load (kept from v6)
Extended with:
- Latent factor for appliances (sensible-heat-ratio per category).
- Infiltration humidity term.
- Material library (configurable U-values per wall).
- **Per-window physical properties** — each opening carries its own `u_value` (W/m²K), `solar_transmittance` (SHGC), and `air_permeability` (m³/h·m² @ 50 Pa). The heat-load reads these directly; the fast-solver infiltration model also reads `air_permeability`. Defaults match v6's globals so existing scenes load unchanged.

### 5. Optimizer (in-browser, joint multi-AC)

**Tier 1 ships a real multi-AC optimizer** — not a sequential single-AC
hack. The WebGL2 backend makes ~50–200 CFD evaluations feasible inside
the 30 s budget; that is enough for genuine joint optimization in 1–3 AC
configurations.

**Modes (user-selectable).**
1. **Quick** — coarse grid + local refine, weighted-sum scalar score.
   ~8 s, single AC. The current v6 algorithm, kept as the fast path.
2. **Joint multi-AC (NSGA-II)** — 1 to 3 AC units optimized simultaneously
   over (wall, x, z, throw, angle). Population 24, generations 8–12,
   constraint-aware crowding distance. Returns a **Pareto front**, not
   a single answer. ~30 s on the default scene with WebGL2.
3. **Live continuous** — a low-priority background loop that runs gentler
   NSGA-II steps while the user edits the scene; the suggested-fix
   overlay updates in real time. Pauses when the user is interacting.

**Decision variables.**
- Per AC: wall, position-along-wall, throw distance, airflow angle,
  capacity tier (snapped to discrete kW values).
- Optional: ceiling-fan position and season (when fans are present).

**Objectives (multi-objective Pareto in mode 2).**
1. **Mean per-occupant PPD** — each human in the scene contributes; a
   single uncomfortable occupant is not averaged away.
2. **Max draft risk** — ISO 7730 §6.2 over the comfort plane (1.1 m).
3. **Annual energy** — from the energy module (CDH × Q_total / COP).
4. **Spatial std of T** at 1.1 m — penalises hot/cold pockets.
5. **Setpoint tracking** — `max(0, mean(T) − T_set)`.

The user picks a Pareto-front point in the UI (a 2-D scatter with
energy on x-axis, comfort on y-axis); the chosen point's AC config is
applied to the scene with one click.

**Constraints (hard, not penalty).**
- Skip candidates inside `forbidden_zones`.
- Reject candidates overlapping `restricted_surfaces`.
- Enforce `min_clearance_m` between AC units and obstacles.
- Reject candidates on walls marked `deny`.
- Capacity must cover ASHRAE load + 15 % safety factor.

**Surrogate-accelerated mode (advanced).** When Tier 2 has run and a
trained surrogate (small MLP, ~50 KB) is available, the optimizer
inner loop can use the surrogate for screening and reserve the full CFD
evaluation for the top-k candidates. Drops 30 s → 5 s on the default
scene without sacrificing Pareto quality.

**Determinism.** RNG seed is part of the optimization request; same
scene + same seed = bit-for-bit identical Pareto front. Used by CI.

**Score breakdown.** Every accepted/rejected candidate carries a full
breakdown (per-objective values, constraint violation reasons) — exposed
in the UI ranked list and downloadable as CSV/JSON.

### 6. Energy & Cost
- Annual cooling kWh = (Q_total × cooling-degree-hours / COP) — uses configurable climate file (or a flat CDH default).
- Money / year and CO₂ / year from tariff and grid-emissions inputs.
- Side-by-side comparison of two AC options.

### 7. PDF Report (one click)
HTML → printable PDF using `html2pdf.js` (small, no `puppeteer`). Sections:
1. Scene render (Three.js → PNG snapshot)
2. Room and load summary
3. Recommended AC: position, capacity (TR), score breakdown
4. Comfort maps at 0.1 / 0.6 / 1.1 m (PMV, PPD, DR)
5. Energy + cost estimate
6. Validation status (filled in if Tier 2 ran)

### 8. Comparison View
Side-by-side, delta, and point-probe — works on **any two scenes** (current vs optimized, current vs imported ANSYS, this-month vs last-month config). Works without Tier 2.

### 9. PWA / Offline
After first load, the app works offline (service worker caches static assets). Reduces friction for site engineers without reliable internet.

### 10. Flow Diagnostics
Detects airflow-quality problems on the simulated field and surfaces them in UI + report:
- **Low-velocity zones** — connected regions where |V| stays below a threshold (default 0.05 m/s) for the full sim window.
- **High-stagnation regions** — cells where flow recirculates with low net displacement (residence-time proxy from short particle trajectories).
- **Excessive draft regions** — paired with the Comfort Engine's DR map.

Output:
- Highlighted volumes in the 3D view (translucent shells, color-coded by severity).
- Severity scores in the sidebar.
- Dedicated section in the PDF report.
- Downloadable per-cell mask + summary (CSV / JSON) — see *Export & Data Outputs*.

---

## Tier 2 — Optional Python Backend

Tier 2 is the **gold-standard analysis backend**. It complements Tier 1
rather than competing with it: Tier 1 gives the user a fast, calibrated
answer in seconds; Tier 2 gives the user a research-grade, fully-resolved,
fully-documented answer in minutes-to-hours when accuracy matters more than
speed. End users never *need* it; consultants and engineers reach for it
when they want truth instead of speed.

### Scope (every endpoint)

| Endpoint | What it does |
|---|---|
| `POST /run-validation` | Generate an OpenFOAM case from the scene JSON, run it (steady or transient), parse and return the full field summary |
| `POST /run-transient` | `buoyantPimpleFoam` time-resolved run — produces real "minutes-to-setpoint" curves, animation frames, occupancy-schedule support |
| `POST /import-ansys` | ANSYS CFD-Post CSV import; computes Δ vs fast solver and Δ vs OpenFOAM; full three-way comparison |
| `POST /optimize-multi-ac` | Bayesian (Gaussian-process) multi-AC optimization via pymoo with full OpenFOAM in the loop — research-grade rigor, no surrogate |
| `POST /optimize-pareto` | NSGA-II / NSGA-III over the same objectives Tier 1 uses but with full-physics evaluation |
| `POST /benchmarks/annex20` | IEA Annex 20 regression — pass/fail against Nielsen 1990 reference |
| `POST /benchmarks/cavity` | de Vahl Davis Ra=10⁵ regression |
| `POST /uncertainty` | Monte Carlo over user-selected uncertain inputs (inlet velocity, wall U-values, occupant density) → confidence intervals on PMV / PPD / energy |
| `POST /mesh-independence` | Runs the same case at 3 refinement levels; returns Grid Convergence Index (Roache 1994) |
| `POST /calibrate` | Offline batch — fits Tier 1 constants from OpenFOAM truth across the test corpus |
| `POST /train-surrogate` | Trains a small MLP on a library of OpenFOAM runs; ships the resulting `surrogate.json` to the browser for accelerated optimization |
| `POST /export/{format}` | Re-export an existing run as VTK / VTU / Ensight / HD MP4 / Tier 2 PDF |
| `GET /health` | Backend status — used by Tier 1 to grey/un-grey buttons |

### Stack
- **FastAPI** + Uvicorn (async, SSE streaming for progress)
- **OpenFOAM v2312** (OpenCFD) in Docker — bundled at build via `dl.openfoam.com`'s apt repo. (Foundation v9+ dropped the legacy solver names our case generator emits — `buoyantBoussinesqSimpleFoam` became the unified `buoyantFoam` with `physicalProperties` instead of `transportProperties`. v2312 keeps the legacy names. We bypass OpenCFD's broken `add-debian-repo.sh` and sign the apt repo manually with the dearmored key from `pubkey.gpg`.)
  - Steady: `buoyantBoussinesqSimpleFoam` (default, fast)
  - Transient: `buoyantPimpleFoam` (when time-resolved data needed)
  - Conjugate heat transfer: `chtMultiRegionFoam` (when wall thermal mass matters)
- **Turbulence models** (selectable per request): `k-ω SST` (default, ASHRAE RP-1271 recommendation), `k-ε realizable`, `RNG k-ε`, `LES Smagorinsky`
- **Radiation models** (selectable): `viewFactor` (fast, accurate enough for box rooms), `fvDOM` (more accurate, slower)
- **`snappyHexMesh`** for mesh generation; mesh-independence study runs at 3 refinement levels
- **ofpp + PyVista** for result parsing and field manipulation
- **pythermalcomfort** for reference PMV / PPD / DR (the JS port must match within ±0.05 PMV)
- **pymoo** for Bayesian / NSGA-II / NSGA-III
- **CoolProp** for psychrometrics + radiative property tables
- **scikit-learn** for the surrogate MLP
- **ffmpeg** for HD MP4 animation export

### Validation Targets
1. **IEA Annex 20** (Nielsen 1990) — primary regression, RMSE(V) ≤ 0.1 m/s on centreline
2. **de Vahl Davis cavity** (Ra = 10⁵) — analytical reference, Nu within 5 %
3. **Mundt 1996 stratification** — buoyancy-driven test for vertical ΔT
4. **Olesen 1979 natural-convection chamber** — additional comfort case
5. **OpenFOAM run on user's scene** — Δ vs fast solver, must hit the calibration targets
6. **ANSYS CSV import** (when available) — three-way Δ (Tier 1 vs OpenFOAM vs ANSYS)

### ANSYS CSV format (locked)
ANSYS CFD-Post tabular export, single steady-state value per (x, y, z):

```
X[m], Y[m], Z[m], T[K], U[m/s], V[m/s], W[m/s], RH[%]
```

Importer rejects anything else with a clear message.

### Calibration Mode
A standalone script that, given the test corpus + Annex 20 + cavity:
1. Runs OpenFOAM on each scene at full mesh resolution.
2. Sweeps Tier 1 constants (`BETA`, jet decay, AC relax, `Cs`, multigrid pre/post-smoothing iters, MacCormack limiter strength).
3. Minimises a weighted RMSE on (T, V, PMV) across scenes.
4. Outputs `web/public/calibration.json` with constants + git SHA + ISO timestamp + per-scene residual table.

This keeps the Tier 1 fast solver honest as the codebase evolves. CI
re-runs calibration on a small synthetic case on every PR; full
calibration runs nightly on a self-hosted runner.

### Tier 2 Reporting (extensive)

A Tier 2 run produces a **superset** of the Tier 1 PDF report. Every
parameter that went into the run, every artefact that came out, is
documented and downloadable. See *Tier 2 — UI Surface & Report Bindings*
below for the per-section schema and download menu. In summary, the Tier
2 PDF includes:

1. Everything in the Tier 1 report (scene render, ASHRAE load, comfort
   at 3 heights, energy & cost).
2. **Solver provenance** — solver name, turbulence model, radiation model,
   mesh cell count, refinement levels, residuals at convergence,
   wall time, CPU/RAM, OpenFOAM version, Docker SHA-256.
3. **Boundary conditions as run** — every inlet/outlet/wall BC type,
   inlet velocity profile, turbulence intensity, solar flux treatment.
4. **Validation table** — RMSE / MAE / max-Δ per field (T, V, PMV, RH)
   vs Tier 1 fast solver and vs ANSYS (if imported).
5. **Difference maps** — ΔT / ΔV / ΔPMV / ΔRH as embedded PNGs at the
   three sampling heights.
6. **Mesh-independence study** — fields at 3 refinement levels, GCI per
   field, monotonic convergence flag.
7. **Uncertainty quantification** (if `/uncertainty` was run) — 95 %
   confidence intervals on PMV, PPD, mean T, max V, energy.
8. **Multi-AC Bayesian results** — full Pareto front with per-candidate
   GP posterior mean and variance, accepted/rejected with reasons.
9. **Annex 20 / cavity / Mundt status** if any benchmark was attached.
10. **Calibration provenance** — git SHA + date of the calibration that
    produced the Tier 1 constants the comparison ran against.

All of this is also available as raw downloads (CSV / JSON / VTK / PNG /
MP4) so the user can inspect or process anything externally.

### Tier 2 — UI Surface & Report Bindings

Tier 2 capabilities are useless unless the user can invoke them and the report
can prove they ran. The Phase 4 UI work is this binding. Every Tier 2 button
checks `GET /health` on mount; if the backend is unreachable, the button greys
out and shows "Tier 2 unavailable" — Tier 1 stays fully functional.

**Toolbar buttons (Phase 4 deliverable).** The following buttons appear in
a "Tier 2" group, only when Tier 2 is reachable. Each button lights up
green/yellow/red based on the corresponding endpoint's `/health` status.

| Button | Endpoint | UX flow |
|---|---|---|
| **Validate (steady)** | `POST /run-validation` | Submits the current scene, shows SSE-streamed progress, drops the result into Comparison slot B |
| **Validate (transient)** | `POST /run-transient` | Same as above but produces time-resolved fields and an HD animation; dialog asks for sim duration + sample rate |
| **Import ANSYS** | `POST /import-ansys` | File picker for the locked CSV format; validates header; three-way Δ (Tier 1 vs OpenFOAM vs ANSYS) |
| **Optimize (Bayesian)** | `POST /optimize-multi-ac` | `n_ac` selector (1–3), submits Bayesian GP optimization with full OpenFOAM in the loop; ranked candidates with posterior mean + variance |
| **Pareto sweep** | `POST /optimize-pareto` | NSGA-III over multi-objective space; returns full Pareto front with selectable point |
| **Mesh independence** | `POST /mesh-independence` | Runs the same case at 3 refinement levels; returns GCI report |
| **Uncertainty (Monte Carlo)** | `POST /uncertainty` | User selects which inputs are uncertain (BC ranges, U-values, occupancy); returns 95 % CIs on every output |
| **Run Annex 20** | `POST /benchmarks/annex20` | Pass/fail + RMSE vs Nielsen 1990 |
| **Calibrate Tier 1** | `POST /calibrate` | Runs the calibration sweep; on success, the resulting `calibration.json` is hot-reloaded into the live Tier 1 solver |
| **Train surrogate** | `POST /train-surrogate` | Trains the optimization surrogate from a library of OpenFOAM runs; ships the model to the browser for use in Tier 1's "surrogate-accelerated" mode |

Long-running endpoints stream progress via SSE so the UI stays responsive.
Each result card carries the same `scene_hash` as its source scene.

**Per-result download menu.** A dropdown next to every Tier 2 result card
exposes every artefact the run produced — never bundled, always individually
downloadable:

- Field summary — **CSV + JSON**
- Difference maps — **ΔT, ΔV, ΔPMV as PNG** overlays at the three sampling heights
- Raw field — **VTK (`.vtu`)** for ParaView
- Animation — **HD MP4** (if requested)
- Tier 2 PDF report — the enriched version of the standard report

**PDF report — Tier 2 section schema.** When a Tier 2 result is attached,
the standard report's *"Validation status"* section expands into a full
report appendix. Every Tier 2 capability that ran is documented; nothing
is omitted; nothing is summarised away. See *Tier 2 Reporting* above for
the full field list — solver provenance, BCs, validation tables, mesh
study, UQ, Pareto fronts, calibration provenance — all rendered to PDF
and individually downloadable as raw artefacts.

**Power-user diagnostic panel (Advanced mode only).** A side panel exposes
raw OpenFOAM artefacts for users who want to inspect the underlying run:

- Solver log (last 200 lines)
- Residual plot
- Mesh quality summary (`checkMesh` output)
- Cell count + memory + wall time
- Download full case directory as `.zip`

Hidden behind the Simple/Advanced toggle so the 70 % target user never sees it.

**Backend availability contract.**
- Backend exposes `GET /health` → `{ "status": "ok", "openfoam_version": "...", "endpoints": [...] }`
- Frontend pings `/health` on app load and on focus; result cached 30 s
- A status dot in the toolbar shows current Tier 2 reachability with a
  tooltip explaining which endpoints are unavailable
- All Tier 2 calls carry a request ID; failures roll back cleanly with no
  half-written state

---

## What's in Tier 1 vs Tier 2

The split is **speed vs depth**, not "useful vs useless." Tier 1 alone is
a complete, capable HVAC tool that can place, simulate, and jointly
optimize multi-AC layouts. Tier 2 adds research-grade rigor on top.

| Capability | Tier 1 | Tier 2 |
|---|---|---|
| 3D editor | ✓ | — |
| Fast CFD (MAC + multigrid + WebGL2) | ✓ (sec/eval) | — |
| Steady CFD (OpenFOAM) | — | ✓ (min/eval) |
| Transient CFD (`buoyantPimpleFoam`) | — | ✓ |
| Conjugate heat transfer | — | ✓ |
| Radiation (proper Tmrt) | approximate view-factor | `viewFactor` / `fvDOM` |
| Turbulence model | Smagorinsky LES | k-ω SST / k-ε / RNG / LES (selectable) |
| Mesh independence study | — | ✓ (3 levels, GCI) |
| Uncertainty quantification (Monte Carlo) | — | ✓ |
| PMV / PPD / DR | live, per-occupant | validated |
| ASHRAE heat load | ✓ | ✓ (with proper radiation) |
| Energy / cost | ✓ | ✓ (more accurate) |
| Single-AC optimizer | ✓ | ✓ |
| Joint multi-AC optimizer | ✓ NSGA-II (Pareto) | ✓ Bayesian GP + NSGA-III (deeper) |
| Live continuous optimization | ✓ | — |
| Surrogate-accelerated optimization | ✓ (consumes Tier 2 surrogate) | ✓ (trains surrogate) |
| ANSYS three-way comparison | — | ✓ |
| Calibration loop | consumes constants | produces constants |
| Annex 20 / cavity / Mundt benchmarks | display-only | runs |
| PDF report | comfort + placement | comfort + placement + every Tier 2 parameter |
| Raw field export (CSV/JSON) | ✓ | ✓ |
| Field export (VTK / VTU / Ensight) | — | ✓ |
| Animation export (GIF/MP4 low-res) | ✓ | — |
| Animation export (HD MP4) | — | ✓ |
| Flow diagnostics | ✓ | richer (full residence-time, age-of-air) |

---

## Export & Data Outputs

The whole point of running these simulations is to take the data away. Every produced field, score, and animation is downloadable.

### Raw simulation export
Per-cell or per-probe data, end-of-sim snapshot or time-resolved series:
- Fields: **Temperature, U, V, W (velocity components), PMV, PPD, RH**
- **CSV** (mandatory) — wide format, one row per `(x, y, z)` or `(x, y, z, t)`
- **JSON** (mandatory) — structured, machine-friendly, includes scene metadata
- **VTK** (optional, Tier 2) — ParaView-ready, includes full unstructured mesh

### Point-probe export
For any number of user-placed probes:
- Time series of **T, V, PMV, PPD, RH** at each probe location
- CSV columns: `probe_id, t, x, y, z, T, V_x, V_y, V_z, PMV, PPD, RH`
- JSON: same content, structured with probe metadata

### Optimization results export
- Ranked candidate list (top-N, by score J)
- Per-candidate **score breakdown** — each J component (PPD, DR, std, excess) shown separately
- **Accepted vs rejected** with reason: `inside_forbidden_zone`, `clearance_violated`, `wall_disallowed`, `restricted_surface_overlap`
- CSV + JSON

### Validation export (Tier 2)
- **RMSE, MAE, max-Δ** vs OpenFOAM and (if imported) ANSYS — per field (T, V, PMV)
- **Field difference maps** (ΔT, ΔV, ΔPMV) on a comparison grid
- CSV (numeric) + PNG (overlay images) + JSON (summary)

### Animation export — dual outputs (formalized)
Two **separate** exportable animations:
- **Simulation animation** — actual physics evolution from initial to converged state.
- **Suggested-fix animation** — overlay/before-after of the optimizer's recommended layout result.

Formats:
- **GIF / MP4 (low-res)** — Tier 1, in-browser via `gif.js` or MediaRecorder API. Encoder loaded **lazily on first export** so the 2 MB initial bundle is not affected.
- **MP4 (high-res)** — Tier 2 server-side via ffmpeg.

Both animations are independently playable in the dual viewer (§1) and independently exportable.

### Comparison export
- Side-by-side scene + delta-metrics package
- **CSV** (per-metric deltas) + **PDF** (rendered side-by-side report)
- Same template as the standard PDF report, doubled

### Flow Diagnostics export
- Per-cell mask of low-velocity / high-stagnation / draft zones
- Severity scores
- CSV + JSON

### Provenance
Every export tags `schema_version` and a `scene_hash` (SHA-256 of the canonicalized scene JSON) so any downloaded file can be linked back to the exact scene that produced it.

---

## Validation Plan

Every claim the project makes is backed by a test case with a quantitative
pass/fail criterion. The validation suite is structured so a single command
runs the whole battery and emits a pass/fail report consumed by CI.

| Case | Reference | Tolerance (pass) | Phase |
|---|---|---|---|
| Schema round-trip | This project | JSON → migrate → re-export → identical SHA-256 | Phase 0 ✓ |
| Differentially-heated cavity, Ra ≈ 10⁵ | de Vahl Davis 1983 | mean T within 1 °C of analytical; positive vertical stratification | Phase 0 ✓ |
| ISO 7730 worked examples (PMV / PPD) | ISO 7730:2005 Annex D | ±0.05 PMV, ±2 % PPD | Phase 1 ✓ |
| Optimizer match | Brute-force grid search | Selected position in top 10 % of full-grid score | Phase 3 |
| Tier 1 vs OpenFOAM, default scene | This project | PMV deviation ≤ ±0.5; PPD deviation ≤ ±10 % | Phase 4 |
| IEA Annex 20 forced-ventilation room | Nielsen 1990 | RMSE(V) ≤ 0.1 m/s on the centreline | Phase 4 |
| Square cavity natural convection | Numerical reference | Nu within 5 % of de Vahl Davis | Phase 4 |
| Tier 1 vs ANSYS CSV (when available) | User-provided | RMSE(T) ≤ 1 °C; RMSE(V) ≤ 0.15 m/s | Phase 4 |

**Mesh independence.** The Annex 20 case is run at three refinement
levels in Tier 2; the Grid Convergence Index (Roache 1994) is reported in
`docs/VALIDATION.md`. Results that fail GCI < 5 % require a written
justification in the final report.

**Repeatability.** Every case is run with a pinned RNG seed; re-running
must reproduce numerical results bit-for-bit on the same machine. CI
verifies this on every push.

---

## Test Corpus (validation fixtures)

Beyond the analytical cases, the project ships four reference scenes used
across validation, optimization, and the user study. Each lives in
`validation/scenes/` as a versioned scene JSON with its expected outputs:

1. **Default room** — 4 × 3 × 2.7 m, one south window, one east door.
   Used for: bundle-size budget, smoke tests, ASHRAE 55 compliance.
2. **Office** — 6 × 4 × 2.7 m, three north windows, one west door, four
   desks (60 W appliances each), four occupants. Used for: optimizer
   regression, comfort engine.
3. **Classroom** — 8 × 6 × 3 m, three south windows, two east doors,
   24 occupants in 4 × 6 grid, one ceiling fan. Used for: high-density
   load, multi-AC sequential.
4. **Restaurant kitchen** — 8 × 5 × 3 m, two north windows (operable),
   two appliances (1500 W each, latent-heavy), six occupants. Used for:
   stress test on infiltration + latent load.

Each scene has a published expected-output table (mean T, max V, mean PMV
at 1.1 m, total cooling load) used by CI as a regression fixture.

---

## Phases

Each phase ends with a deployable build. No phase blocks the previous one from being released.

### Phase 0 — Foundation (~1 week)
- `git init`, GitHub repo, MIT license
- Move `cfd_room_3d_v6.html` → `archive/` (untouched reference)
- Next.js (App Router) + TypeScript + Tailwind project in `web/` (static-export mode)
- Modularize: `geometry/`, `cfd/`, `comfort/`, `ashrae/`, `optimizer/`, `ui/`, `io/`
- JSON schema v1 + migration scaffold
- CFD step in a Web Worker
- One regression test (Ra = 10⁵ cavity)
- CI: typecheck + bundle-size budget
- Deploy to GitHub Pages

**Done = current functionality runs in modular form, in a Worker, on a public URL, under bundle budget.**

### Phase 1 — Comfort & Reporting (~1 week)
- PMV, PPD, DR, vertical ΔT, operative T (JS)
- Multi-height sampling at 0.1 / 0.6 / 1.1 m
- Color overlays for each metric
- Comparison view (two snapshots side-by-side)
- HTML→PDF report

**Done = end user gets a comfort PDF in one click.**

### Phase 2 — Solver Foundations (~3 weeks)

The big one. The Tier 1 solver is rebuilt from scalar-grid hand-tuned to
**MAC + multigrid + WebGL2 + calibrated** so subsequent phases (multi-AC
optimization, energy, Tier 2 calibration) can build on a sound base.

- **MAC staggered grid** — refactor `web/src/lib/cfd/grid.ts` from
  collocated to face-centred velocities; pressure stays cell-centred
- **Stam semi-Lagrangian advection** on the MAC grid
- **MacCormack-limited scalar advection** for T, RH, CO₂
- **Multigrid V-cycle Poisson solver** (3–4 levels); GS fallback
- **CFL-adaptive timestep**
- **Smagorinsky LES** with configurable `Cs`
- **RH + CO₂ passive scalars** with per-source emission rates
- **Approximate view-factor radiation** for Tmrt (~6 dominant surfaces)
- **Per-occupant local PMV** sampling around each `human` obstacle
- **WebGL2 fragment-shader compute backend** (ping-pong textures); JS
  Worker fallback retained as the regression baseline
- **Compute-backend selector** at startup; same code path, parametrised
  on the kernel runtime
- Performance retune to budget across both backends

**Gate.** On the JS backend: 48×18×36 grid runs at ≥ 30 fps; cavity test
matches the new solver within tolerance; PMV computed per-occupant.
On the WebGL2 backend: 96×36×72 grid runs at ≥ 30 fps. Calibration JSON
file is loaded if present and applied at solver init.

### Phase 3 — Multi-AC Optimization, Energy & Cost (~2 weeks)

- **NSGA-II in JS** with constraint handling and crowding-distance ranking
- **Joint multi-AC** (1–3 ACs) over (wall, x, z, throw, angle)
- **Per-objective scoring** — per-occupant PPD, max DR, energy, std T,
  setpoint excess; user picks weights or runs full Pareto
- **Pareto-front UI** — interactive 2-D scatter; user clicks a point to
  apply that configuration to the scene
- **Live continuous optimization** background mode (low-priority loop;
  pauses on user interaction)
- **Surrogate-accelerated mode** — when `surrogate.json` is present,
  use it for screening and reserve full CFD for the top-k
- **Energy & cost module** — annual cooling kWh from CDH integration,
  money/year from tariff, CO₂/year from grid emissions
- **AC option comparison** wired into the existing Comparison view

**Gate.** User clicks Optimize on the default scene; in ≤ 30 s with
WebGL2 backend, gets a multi-AC Pareto front with ≥ 12 candidates.
The selected configuration's per-occupant PPD is at least 5 % better
than the user-placed initial config on average across the test corpus.

### Phase 4 — Tier 2 Backend (~3 weeks)

The full backend, not a stub. Every endpoint listed in *Tier 2 — Scope*
ships in this phase.

- **FastAPI scaffold** with SSE-streamed progress, request IDs, clean rollback
- **Docker image** — OpenFOAM v2312 (OpenCFD), all turbulence/radiation models compiled, ffmpeg, Python deps
- **JSON → OpenFOAM case generator** — `snappyHexMesh` from scene geometry; per-AC inlets; per-opening BCs from `u_value` / `air_permeability` / `solar_transmittance`; selectable turbulence + radiation
- **Solver wrappers** for `buoyantBoussinesqSimpleFoam`, `buoyantPimpleFoam`, `chtMultiRegionFoam`
- **`ofpp` + PyVista** result parser → field summary + difference maps
- **Calibration script** — sweeps Tier 1 constants over the test corpus
- **Surrogate trainer** — small MLP from a library of OpenFOAM runs
- **Multi-AC Bayesian optimizer** via `pymoo` (GP-based)
- **Pareto sweep** via NSGA-III
- **Mesh-independence study** runner (3 refinement levels, GCI)
- **Uncertainty quantification** runner (Monte Carlo, parallel workers)
- **Annex 20 / cavity / Mundt benchmark** runners
- **ANSYS CSV importer** with three-way comparison
- **Tier 2 PDF builder** — every parameter, every artefact
- **Tier 1 UI bindings** — every endpoint has a button + per-result download menu (per *Tier 2 — UI Surface*)

**Gate.** Default scene runs end-to-end through `/run-validation`,
returns full field summary + difference maps + Tier 2 PDF; the Tier 2
PDF includes solver provenance, BCs, validation table, and mesh-study
GCI for at least one phase-4-internal scene. Annex 20 passes its
RMSE tolerance. Calibration produces a `calibration.json` that, when
loaded, brings Tier 1 PMV deviation ≤ ±0.5 vs OpenFOAM on Annex 20.

### Phase 2.5 — Polish (delivered alongside Phase 2 / 3)

The following were promoted out of Phase 5 because they unblock real-
world use of the optimizer and are cheap once the core is in place:

- **AC swing** — horizontal + vertical louvre oscillation per AC unit.
  Adds dynamism to the simulation without rebuilding scene state; the
  worker periodically re-injects forcing with swept yaw/pitch.
- **Constraint-zone polygon tool** — click on the floor to plant
  vertices, double-click or Enter to close. Renders as translucent red
  overlays. Already honoured by the single-AC and multi-AC optimizers.
- **Restricted surface tool** — click any wall to drop a 0.6 × 0.5 m
  red patch (e.g. switchboard, beam). Optimizer skips overlapping
  candidates.
- **Wall-rules toggle** — 4-button allow/deny per wall in the sidebar
  Constraints panel. NSGA-II uses `allowed_walls` for AC-wall mutation.
- **STL import** — file picker in the toolbar (📐 Import STL); parses
  binary and ASCII STL via `three/examples/jsm/loaders/STLLoader.js`,
  auto-fits to room scale, renders the mesh in the 3D view. Tier-1
  voxelization remains AABB-based (mesh refinement is Tier 2 work).

### Phase 5 — Long-tail polish (~ open)

- Material library (per-wall U-values, weight-based thermal mass)
- Onboarding tour (3 contextual tooltips on first visit)
- Touch hardening (tablet usability)
- Service worker for full PWA / offline mode
- Climate file picker (CDH from city) for the energy module
- Human-readable AI explanation of optimization results ("we suggest
  this layout because…")
- STL transform gizmos (drag to translate, scroll to scale, R/X/Z to
  rotate) — currently STL transforms are JSON-only / drag-from-list
- Concave polygon ear-clipping (currently fan triangulation on the
  forbidden zones — visible artefact only on highly concave shapes)
- WebGPU compute backend as opt-in (for users on Chrome 113+ who want
  the absolute fastest path)

---

## Tech Stack (locked)

**Tier 1 (browser)**
- TypeScript strict mode
- **Next.js 15+** (App Router) — built with `output: 'export'` so Tier 1 ships as **plain static files**, no Node server at runtime
- **Three.js r0.184** — used raw inside a single `useEffect`-managed component, NOT react-three-fiber; the v6 imperative scene-graph code ports directly
- **WebGL2 fragment-shader compute** (primary turbo path); **JS in a Web Worker** (universal fallback); **WebGPU** opt-in for Chrome 113+
- **Tailwind v4** with v6's color/typography tokens
- `html2pdf.js` for reports (lazy-loaded on first export)
- **No heavy UI library** (no MUI, no Chakra, no Ant) — keeps the bundle lean

**Tier 2 (server)**
- Python 3.11
- FastAPI + Uvicorn (async, SSE for progress streaming)
- NumPy, SciPy, PyVista, ofpp
- pymoo (NSGA-II / NSGA-III / Bayesian GP)
- pythermalcomfort, CoolProp
- scikit-learn (surrogate MLP)
- ffmpeg (HD MP4 export)
- OpenFOAM v2312 (OpenCFD) in Docker (all turbulence + radiation models compiled)
- Tested on WSL2 Ubuntu 22.04 and native Linux

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| WebGL2 backend has subtle bugs (texture precision, ping-pong races) | JS-in-worker path is the canonical reference; CI runs both backends and asserts numerical agreement within tolerance |
| MAC-grid refactor breaks the existing solver | Phase 2 work happens behind a feature flag; v6-derived collocated solver is kept until the new one passes the test corpus |
| Multigrid Poisson divergence on pathological scenes | Falls back to red-black Gauss-Seidel automatically; flagged in the diagnostics panel |
| Joint multi-AC NSGA-II blows the 30 s budget on 3-AC scenes | Surrogate-accelerated mode (Tier 2 trains, Tier 1 consumes); coarser population/generation budget on the JS fallback |
| OpenFOAM install pain blocks Tier 2 setup | Docker image with everything compiled; one-line spin-up; Tier 2 is optional |
| ANSYS license unavailability | Annex 20, cavity, and Mundt benchmarks cover validation without ANSYS |
| Bundle bloat from new modules | ≤ 2 MB initial gzip enforced in CI; html2pdf and animation encoders lazy-loaded |
| Schema churn as solver gains new fields | Versioned migrations from day 1; all schema changes go through a migration |
| Fast-solver drift from OpenFOAM truth | Calibration script regenerates `calibration.json` on every Tier 2 release; CI compares Tier 1 vs Tier 2 on the test corpus |
| Browser memory blows up at 96×36×72 grid | High-accuracy grid is opt-in; WebGL2 textures release on view change; soft cap warns the user before allocating |
| WebGPU adoption stalls (Safari/Firefox slow) | WebGPU is opt-in only; WebGL2 covers the same fast path with ~99 % browser support |

---

## Quality Gates & KPIs

The project is judged against numbers, not vibes. Every metric below has a
verifiable home — typically a CI job, a benchmark script, or a user study.

| Metric | Target | Verified by |
|---|---|---|
| TypeScript strict mode | Clean | `tsc --noEmit` on every commit |
| ESLint | Clean | CI on every PR |
| Test coverage (physics modules) | ≥ 70 % | `vitest run --coverage` |
| Bundle size (initial, gzipped) | ≤ 2 MB | CI bundle-size check on every PR |
| Time-to-interactive (cold cache, mid laptop) | ≤ 2 s | Lighthouse run in CI |
| Frame rate during fast sim | ≥ 30 fps | Manual benchmark on the test corpus |
| Single fast-sim convergence | ≤ 4 s | `bench/cfd-convergence.ts` |
| Optimizer (default scene, single AC) | ≤ 30 s | Performance regression test |
| PMV deviation vs OpenFOAM | ≤ ±0.5 | Annex 20 validation |
| PPD deviation vs OpenFOAM | ≤ ±10 % | Annex 20 validation |
| User task completion | ≥ 80 % of N=10 finish in ≤ 2 min unaided | Phase 5 user study |
| Reproducibility | Every figure rebuilds from `docs/REPRODUCE.md` | Manual re-run by examiner |

A failing gate blocks the corresponding phase from being declared "done."

---

## Definition of Done — Tier 1 v1.0

- [ ] End user opens the URL and gets a comfort + placement answer in ≤ 2 minutes without instructions.
- [ ] PDF report contains everything an HVAC consultant needs to specify the unit.
- [ ] PMV deviation vs OpenFOAM ≤ ±0.5 on Annex 20.
- [ ] PPD deviation vs OpenFOAM ≤ ±10 % on Annex 20.
- [ ] Optimizer finds a position within the top 10 % of full grid search.
- [ ] All performance budgets met.
- [ ] Works offline after first load (PWA).
- [ ] Zero install, zero terminal, zero login.

---

## Out of Scope

- Mobile-first design (room editing on a phone is bad UX even with effort)
- Real-time collaboration
- Multi-room / whole-building modeling (single-zone tool by design)
- Custom turbulence models in Tier 1 (OpenFOAM's domain)
- A native app (web-first; Electron-wrap later only if a paying customer asks)

---

## First Steps in This Directory

Do these now, in this order. Don't clone anything — this is greenfield on top of v6.

1. **Initialize git and push to GitHub**
   ```powershell
   git init
   git add .
   git commit -m "initial: v6 monolith + plan + readme"
   gh repo create cfd-hvac --private --source=. --push
   ```

2. **Install Node.js LTS** (20.x). Confirm: `node -v && npm -v`.

3. **Install Python 3.11+** (for Phase 4 only — fine to defer until then).

4. **Do NOT install OpenFOAM yet.** Wait until Phase 4. When the time comes (use OpenCFD v2312, NOT Foundation v10 — v10 dropped `buoyantBoussinesqSimpleFoam`):
   ```powershell
   wsl --install -d Ubuntu
   # then inside WSL:
   curl -fsSL https://dl.openfoam.com/pubkey.gpg | sudo gpg --dearmor -o /usr/share/keyrings/openfoam-archive-keyring.gpg
   echo "deb [arch=amd64 signed-by=/usr/share/keyrings/openfoam-archive-keyring.gpg] https://dl.openfoam.com/repos/deb jammy main" | sudo tee /etc/apt/sources.list.d/openfoam.list
   sudo apt update && sudo apt install -y openfoam2312-default
   ```

5. **Decide directory layout** (will be created in Phase 0):
   ```
   cfd/
     archive/
       cfd_room_3d_v6.html       ← the v6 monolith, never edited again
     web/                         ← Next.js + TS + Tailwind (static export)
       src/
         app/                     ← App Router pages
         lib/{geometry,cfd,comfort,ashrae,optimizer,io}/
         components/              ← React components (UI shell)
         workers/                 ← cfd.worker.ts
       public/
       package.json
       next.config.mjs            ← output: 'export'
       tailwind.config.ts
       tsconfig.json
     server/                      ← Tier 2 (created in Phase 4)
       pyproject.toml
       cfd_server/
       Dockerfile
     openfoam/                    ← case templates
     validation/                  ← Annex 20 + ANSYS CSVs
     docs/
       PLAN.md
       README.md
       SCHEMA.md
   ```

6. **Framework locked**: Next.js 15+ (App Router, static export) + TypeScript + Tailwind + raw Three.js. No react-three-fiber. No heavy UI library.

After these six steps, Phase 0 begins.

---

END OF PLAN
