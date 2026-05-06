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
┌─ Tier 1 — Browser (the default product) ────────────┐
│  Three.js editor                                    │
│  Fast CFD (JS, in Web Worker)                       │
│  PMV / PPD / Draft Risk overlays                    │
│  ASHRAE heat-load                                   │
│  AC placement optimizer                             │
│  Energy & cost estimate                             │
│  One-click PDF report                               │
│  JSON import / export                               │
└──────────────────────────┬──────────────────────────┘
                           │ optional HTTPS
┌──────────────────────────┴──────────────────────────┐
│  Tier 2 — Optional Python backend (power users)     │
│  OpenFOAM case generator + runner                   │
│  ANSYS CSV importer & comparison                    │
│  Calibration loop (tunes Tier 1 constants)          │
│  Bayesian multi-AC optimizer                        │
└─────────────────────────────────────────────────────┘
```

If Tier 2 is unreachable, Tier 2 buttons are hidden. Tier 1 is fully self-contained.

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
- New: **Multi-AC placement** — user may place up to **3 AC units** in Tier 1, each independently editable (capacity in kW/TR, airflow angle, throw distance). Joint multi-AC optimization stays Tier 2 (see §5).
- **STL handling — Tier 1 scope: transform-only** (scale, rotate, translate). Mesh modification (cut, boolean, simplify) is a future Tier 2 option.
- **Dual animation viewer** — two playable animations side-by-side: (a) **Simulation animation** (actual physics evolution) and (b) **Suggested-fix animation** (optimized layout overlay / before-after). Each is independently playable in the UI and independently exportable (see *Export & Data Outputs*).

### 2. Fast Solver (JS, Web Worker)
Upgrades over v6:
- Move into a Web Worker so UI stays at 60 fps.
- **Semi-Lagrangian momentum advection** (Stam 1999, ~80 lines, unconditionally stable).
- **Pressure projection: 3 → 12** Gauss-Seidel iterations, red-black ordered.
- Optional Smagorinsky LES eddy viscosity (one extra term).
- **Passive humidity scalar** — humans emit ~50 g/h moisture, infiltration sets boundary RH.
- **Per-unit directional AC jet model** — each AC unit's `throw_distance_m`, `airflow_angle_deg`, and (optional) `flow_rate_cfm` shape the existing Gaussian jet (decay rate + lateral spread + heading). No structural CFD changes; just per-unit jet parameters.
- **Window infiltration** uses each opening's `air_permeability` to scale the per-opening leakage flux (replaces the global infiltration constant for openings that specify it; defaults preserve v6 behavior).
- Grid stays **36 × 14 × 28** by default. "High accuracy" toggle goes to **56 × 20 × 40** (still in budget).

**Time-to-temperature accuracy.** Tier 1 transient evolution is **qualitative only** — useful for visualizing how flow develops, not for predicting "minutes to setpoint." Physically accurate transient curves require Tier 2 (OpenFOAM transient run with `buoyantPimpleFoam`).

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

### 5. Optimizer (in-browser)
**Tier 1 search: single-AC placement** (one unit's position optimized per run).
- Coarse search: 20 candidates, 5 per wall (current v6 algorithm).
- **Local refine**: 5 extra candidates around the best.
- Constraint check: skip candidates inside `forbidden_zones`, overlapping `restricted_surfaces`, violating `min_clearance_m`, or on a wall marked `deny` in `wall_rules`.
- Score:
  ```
  J = 0.40 · mean(PPD)
    + 0.30 · max(DR)
    + 0.20 · std(T)
    + 0.10 · max(0, mean(T) − T_set)
  ```
- Hard budget: 30 s on the default scene.

**Multi-AC scenes (Tier 1).** The user may *place* up to 3 AC units manually (each with its own capacity, throw distance, airflow angle). The fast solver evaluates the full multi-unit configuration. The Tier 1 optimizer searches **one unit's position at a time** (sequential, holding the others fixed). True joint multi-AC optimization remains **Tier 2** (Bayesian via `pymoo`).

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

Built only after Tier 1 is solid. End users never need it.

### Scope
- `POST /run-validation` { scene } → OpenFOAM run, returns field summary
- `POST /import-ansys` { csv, scene } → returns deltas vs fast solver
- `POST /optimize-multi-ac` { scene, n_ac } → returns positions
- `POST /calibrate` (offline batch) → fits Tier 1 constants

### Stack
- **FastAPI** + Uvicorn
- **OpenFOAM 2312** in Docker — solver `buoyantBoussinesqSimpleFoam` (steady, Boussinesq), turbulence `k-ω SST` (better than k-ε for indoor jets per ASHRAE RP-1271)
- **ofpp** for result parsing
- **pythermalcomfort** for reference PMV / PPD / DR (must match the JS port within numerical tolerance)
- **pymoo** for Bayesian / NSGA-II
- **CoolProp** for psychrometrics

### Validation Targets
1. **Annex 20 forced-ventilation room** (Nielsen 1990) — public benchmark, no license needed. Primary regression.
2. **Square cavity natural convection** at Ra = 10⁵ — analytical/numerical reference. Sanity check.
3. **OpenFOAM run on user's scene** — compute Δ vs fast solver.
4. **ANSYS CSV import** (when available) — compute Δ vs fast solver and Δ vs OpenFOAM.

### ANSYS CSV format (locked)
ANSYS CFD-Post tabular export, single steady-state value per (x, y, z):

```
X[m], Y[m], Z[m], T[K], U[m/s], V[m/s], W[m/s], RH[%]
```

Importer rejects anything else with a clear message.

### Calibration Mode
A standalone script that, given a small library of scenes:
1. Runs the fast solver and OpenFOAM on each.
2. Sweeps fast-solver constants (`BETA`, jet decay, AC relax, Smagorinsky Cs).
3. Minimizes RMSE vs OpenFOAM.
4. Outputs a JSON of calibrated constants checked into the web bundle.

This is what keeps the fast solver honest as the codebase evolves.

---

## What's in Tier 1 vs Tier 2

| Capability | Tier 1 | Tier 2 |
|---|---|---|
| 3D editor | ✓ | — |
| Fast CFD | ✓ | — |
| PMV / PPD / DR | live | validated |
| ASHRAE load | ✓ | — |
| Single-AC optimizer | ✓ | — |
| Multi-AC / Bayesian | — | ✓ |
| OpenFOAM run | — | ✓ |
| ANSYS comparison | — | ✓ |
| Calibration | — | ✓ |
| Annex 20 benchmark | display-only | runs |
| Energy / cost | ✓ | — |
| PDF report | ✓ | richer |
| Raw field export (CSV/JSON) | ✓ | ✓ |
| Field export (VTK / ParaView) | — | ✓ |
| Animation export (low-res GIF/MP4) | ✓ | — |
| Animation export (HD MP4) | — | ✓ |
| Flow diagnostics | ✓ | richer |

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

### Phase 2 — Solver Upgrade (~1.5 weeks)
- Semi-Lagrangian momentum advection
- 12 Poisson iterations (red-black GS)
- RH passive scalar
- Optional Smagorinsky
- Performance retune to budget

**Done = JS PMV is within ±0.5 of OpenFOAM PMV on the Annex 20 case.**

### Phase 3 — Optimizer & Energy (~1 week)
- Refined optimizer with local refine + constraints
- Energy / cost module
- AC option comparison

**Done = end user clicks Optimize, gets position + energy estimate in ≤ 30 s.**

### Phase 4 — Tier 2 Backend (~2 weeks, **optional gate**)
- FastAPI scaffold
- Docker image with OpenFOAM 2312
- JSON → snappyHexMesh + buoyantBoussinesqSimpleFoam case generator
- ofpp parser
- Calibration script
- Annex 20 regression run
- ANSYS CSV importer
- "Validate" button in UI

**Done = power users can validate against OpenFOAM/ANSYS; default user is unaffected.**

### Phase 5 — Polish
- Constraint-zone polygon tool
- Multi-AC Bayesian (Tier 2)
- Material library (per-wall U-values)
- Onboarding tour
- Touch hardening (tablet usability)

---

## Tech Stack (locked)

**Tier 1**
- TypeScript (strict mode)
- **Next.js 15+** (App Router) — built with `output: 'export'` so Tier 1 ships as **plain static files**, no Node server at runtime
- **Three.js r128** (already in v6 — no upgrade unless needed). Used **raw inside a single `useEffect`-managed component**, NOT react-three-fiber — the v6 imperative scene-graph code ports directly.
- **Tailwind CSS** with v6's color/typography tokens captured in `tailwind.config.ts`. Custom widgets (toggles, range sliders) keep small CSS modules.
- Web Worker for CFD (under `web/src/workers/cfd.worker.ts`)
- `html2pdf.js` for reports (lazy-loaded on first export)
- **No heavy UI library** (no Material UI, no Chakra, no Ant)

**Tier 2**
- Python 3.11
- FastAPI + Uvicorn
- NumPy, vtk, ofpp
- pymoo (optimization)
- pythermalcomfort
- CoolProp
- OpenFOAM 2312 in Docker
- Tested on WSL2 Ubuntu 22.04

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Solver upgrades break performance budget | Web Worker + grid resolution toggle + bundle-size CI |
| OpenFOAM install pain blocks contributors | Docker image; Tier 2 is fully optional |
| ANSYS license unavailability | Annex 20 benchmark covers core validation without ANSYS |
| Bundle bloat | ≤ 2 MB enforced in CI; Three.js tree-shaking; no UI framework |
| Schema churn | Versioned migrations from day 1 |
| Fast-solver drift from reality | Calibration script regenerates constants on every Tier 2 run |
| Mobile usability | Phase 5 polish; not a v1 blocker |

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

4. **Do NOT install OpenFOAM yet.** Wait until Phase 4. When the time comes:
   ```powershell
   wsl --install -d Ubuntu
   # then inside WSL:
   sudo apt install openfoam2312
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
