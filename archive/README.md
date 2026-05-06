# CFD Room Builder 3D Pro v6 — Complete Documentation

A **single-file, browser-based 3D Computational Fluid Dynamics (CFD) simulator** for indoor airflow, thermal comfort, and air-conditioner placement optimization. Open [cfd_room_3d_v6.html](cfd_room_3d_v6.html) in any modern browser — no install, no server, no build step. The only external dependency is Three.js r128 loaded from a CDN.

The program lets a user draw a room, place windows, doors, furniture, people, appliances, and fans, then run a real-time 3D CFD simulation that solves the energy equation, buoyancy, and a pressure-projection step on a 36 × 14 × 28 grid (≈14 000 cells) directly in JavaScript. It also runs an ASHRAE heat-load calculation and an AC-position optimizer, and exports the whole scene as JSON.

---

## 1. What the program is, at a glance

| Capability | Where it lives in the code |
|---|---|
| 3D scene + interactive editor | `THREE.js` setup at [cfd_room_3d_v6.html:240-261](cfd_room_3d_v6.html#L240-L261) |
| Room geometry builder | `buildRoom()` at [cfd_room_3d_v6.html:361](cfd_room_3d_v6.html#L361) |
| Wall openings (windows/doors/round/arch) | `fMesh()` at [cfd_room_3d_v6.html:446](cfd_room_3d_v6.html#L446) |
| Obstacles (box, cylinder, shelf, human, appliance, fans) | `oMesh()` at [cfd_room_3d_v6.html:484](cfd_room_3d_v6.html#L484) |
| Room extension blocks (rotatable, sloped) | `blkMesh()` at [cfd_room_3d_v6.html:418](cfd_room_3d_v6.html#L418) |
| STL mesh import (binary + ASCII) | `loadSTL()` at [cfd_room_3d_v6.html:738](cfd_room_3d_v6.html#L738) |
| 3D CFD physics | `initCFD()` and `doSim()` at [cfd_room_3d_v6.html:1044](cfd_room_3d_v6.html#L1044) and [cfd_room_3d_v6.html:1318](cfd_room_3d_v6.html#L1318) |
| Pressure correction (incompressibility) | `pressureCorrect()` at [cfd_room_3d_v6.html:1295](cfd_room_3d_v6.html#L1295) |
| ASHRAE heat-load calculator | `calcHeatLoad()` at [cfd_room_3d_v6.html:1419](cfd_room_3d_v6.html#L1419) |
| AC-position optimizer | `runOpt()` at [cfd_room_3d_v6.html:1480](cfd_room_3d_v6.html#L1480) |
| Particle tracer | `updPart()` at [cfd_room_3d_v6.html:1541](cfd_room_3d_v6.html#L1541) |
| Live thermal/airflow visualization | `updTex()` and `updateArrows()` at [cfd_room_3d_v6.html:316](cfd_room_3d_v6.html#L316) and [cfd_room_3d_v6.html:983](cfd_room_3d_v6.html#L983) |
| JSON config export | `showCfg()` at [cfd_room_3d_v6.html:1576](cfd_room_3d_v6.html#L1576) |

---

## 2. User-Facing Features

### 2.1 Room geometry
Sliders at [cfd_room_3d_v6.html:145-149](cfd_room_3d_v6.html#L145-L149) control:
- **Length** (3–15 m), **Width** (3–12 m), **Height** (2–5 m)
- **Outdoor temperature** (25–48 °C)
- **Indoor set-point** (18–28 °C)

Walls have a thickness of `WT = 0.18 m`, a floor slab, a translucent ceiling, a grid helper, and N/S/E/W sprite labels.

### 2.2 Wall openings (toolbar group "Openings")
Click any opening tool, then click an inner wall face to place. Resize handles snap to corners; drag to move; drag handles to resize. All openings have an open/close toggle (closed openings still appear in geometry but block infiltration).

| Tool | Default size | Behavior in CFD | UI button |
|---|---|---|---|
| 🪟 **Window** | 1.2 × 1.1 m | Solar gain + warm infiltration when open, glass U-loss when closed | [cfd_room_3d_v6.html:106](cfd_room_3d_v6.html#L106) |
| 🚪 **Door** | 0.9 × 2.1 m | Air infiltration only (no solar gain), forced floor-aligned | [cfd_room_3d_v6.html:107](cfd_room_3d_v6.html#L107) |
| ⭕ **Round** opening | 0.8 m diameter | Treated as window (solar + infiltration) | [cfd_room_3d_v6.html:108](cfd_room_3d_v6.html#L108) |
| 🌉 **Arch** | 1.2 × 1.1 m | Treated as window (solar + infiltration) | [cfd_room_3d_v6.html:109](cfd_room_3d_v6.html#L109) |

### 2.3 Obstacles (toolbar group "Obstacles")
Click on the floor to place. Each can be moved by drag, resized in the Properties panel.

| Tool | Default | CFD effect |
|---|---|---|
| 📦 **Box** | 0.8 × 0.6 × 0.8 m | Solid (blocks airflow) |
| 🔵 **Cylinder** | Ø 0.5 × 0.9 m | Solid |
| 📚 **Shelf** | 0.45 × 0.3 × 1.9 m | Solid |

### 2.4 Heat sources
| Tool | Sensible heat | Latent heat (ASHRAE only) |
|---|---|---|
| 🧑 **Human** | 75 W (Gaussian-spread, plume) | 55 W |
| ⚡ **Appliance** | User-set Watts (default 200 W) | 0 W |

Heat sources use a Gaussian-distributed source term over a 7 × 5 × 7 cell volume around their centre, with a buoyant plume of upward velocity above them ([cfd_room_3d_v6.html:1141-1154](cfd_room_3d_v6.html#L1141-L1154)).

### 2.5 Fans
| Tool | Model |
|---|---|
| 💨 **Ceiling fan** | Mounted at ceiling. Summer mode: radial outward + downwash. Winter mode: pull air up at centre ([cfd_room_3d_v6.html:1182-1211](cfd_room_3d_v6.html#L1182-L1211)). Configurable RPM and season. |
| 🌀 **Table fan** | Free-standing, configurable height, RPM and direction (0–360°). Produces a directional jet using 3D Gaussian profile ([cfd_room_3d_v6.html:1212-1229](cfd_room_3d_v6.html#L1212-L1229)). |

### 2.6 Room extension blocks
🧱 Click floor to add a sub-room. Each block has independent **width / depth / height / position / Yaw / Pitch / Roll** rotations ([cfd_room_3d_v6.html:596-605](cfd_room_3d_v6.html#L596-L605)). For non-zero rotations the CFD switches from a fast AABB voxelization to an **OBB inverse-rotate test** (YXZ Euler order) to mark cells as solid ([cfd_room_3d_v6.html:1077-1105](cfd_room_3d_v6.html#L1077-L1105)). This lets the user model angled walls and sloped roofs.

### 2.7 STL mesh import
📂 Upload Button → file picker → reads as `ArrayBuffer`. Auto-detects binary vs. ASCII STL ([cfd_room_3d_v6.html:683-714](cfd_room_3d_v6.html#L683-L714)), parses triangles, auto-scales the largest dimension to 30 % of the smallest room dimension. The mesh is voxelized as an AABB into the CFD grid ([cfd_room_3d_v6.html:1109-1131](cfd_room_3d_v6.html#L1109-L1131)).

### 2.8 Simulation views
Toolbar toggle group ([cfd_room_3d_v6.html:131-135](cfd_room_3d_v6.html#L131-L135)):
- **Both** — thermal walls + airflow arrows + particles
- **Airflow** — only velocity field (arrows + cool-toned particles)
- **Thermal** — only temperature heatmap

### 2.9 Action buttons
- **▶ Run CFD** — toggles the simulation loop. Caps at 500 steps before auto-stop.
- **★ Optimize AC** — sweeps 20 candidate AC positions (5 along each of 4 walls), runs 50 short CFD steps each, ranks by `0.55·std + 0.30·max(0, mean−Tset) + 0.12·hot%` and shows top-N as gold rings + "★ BEST" labels ([cfd_room_3d_v6.html:1480-1509](cfd_room_3d_v6.html#L1480-L1509)).
- **⚙ Export** — opens modal with full JSON config; copy or download as `cfd_room_config.json`.

### 2.10 ASHRAE heat-load panel (sidebar)
Computed live every time the scene changes:
- Walls (`U=2.8 W/m²K`)
- Glass conduction (`U=5.8 W/m²K`)
- Solar gain (`SHGC=0.65`, `I=620 W/m²` per open glazing)
- Roof/ceiling (`U=2.0 W/m²K`)
- Occupants sensible (75 W × n people)
- Appliances (sum of Watts)
- Infiltration (ACH = 0.5)
- Latent (55 W × n people)
- **Total cooling load in TR** (1 TR = 3517 W)

The recommended AC capacity (`acCfg.kw`) is auto-set to the calculated total ([cfd_room_3d_v6.html:1467](cfd_room_3d_v6.html#L1467)).

### 2.11 Live result panel
- Mean temperature (°C)
- Standard deviation (uniformity)
- "Hot zone %" — fraction of cells > Tset + 4 °C (turns red if > 20 %)
- Max airspeed (m/s)
- Progress bar (simulation step / 500)
- Temperature legend (16 → 45 °C, blue→red)

### 2.12 Mouse / keyboard
- **Drag** background — orbit camera (spherical coords [cfd_room_3d_v6.html:835-840](cfd_room_3d_v6.html#L835-L840))
- **Scroll** — zoom (clamps r ∈ [3, 62])
- **Click** opening / obstacle — select; resize handles appear for openings
- **Drag** opening on its wall plane — reposition (snaps to wall normal plane)
- **Drag** obstacle on floor — reposition with floor-projection raycast
- **Esc** — return to orbit tool
- **Delete / Backspace** — delete selected object

---

## 3. The CFD Engine — How It Actually Works

### 3.1 Discretization
A staggered Eulerian grid:
- `NX = 36, NY = 14, NZ = 28` → 14 112 cells ([cfd_room_3d_v6.html:267](cfd_room_3d_v6.html#L267))
- Cell index packed as `K(ix, iy, iz) = ix + NX·iy + NX·NY·iz`
- Five `Float32Array`s for state: `T_grid`, `Vx_g`, `Vy_g`, `Vz_g`, `p_grid`
- Two `Float32Array` source terms: `Qs_g` (heat source), `Fx_g` / `Fz_g` (persistent forcing for AC jets)
- One `Uint8Array` solid-cell mask: `wall_g`

### 3.2 Physical constants
([cfd_room_3d_v6.html:1034-1037](cfd_room_3d_v6.html#L1034-L1037))
- `T_AMB = 35 °C` initial bulk temperature
- `T_AC = 16 °C` AC supply temperature
- `T_SOLAR = 48 °C` boundary T at sun-exposed openings
- `T_INFIL = 37 °C` boundary T at door infiltration
- `ALPHA = 2.5e-5 m²/s` thermal diffusivity of air
- `BETA = 3.4e-3 1/K` Boussinesq coefficient
- `G = 9.81 m/s²`

### 3.3 Geometry → CFD initialization (`initCFD`, [cfd_room_3d_v6.html:1044](cfd_room_3d_v6.html#L1044))
1. Zero all fields.
2. Voxelize **obstacles** (box/cyl/shelf/human/appliance/tfan) as AABB into `wall_g`. Ceiling fans are *not* solid — they are momentum sources.
3. Voxelize **room extension blocks**: AABB if no rotation, otherwise OBB inverse-rotation test (cy, sx, sy, sz precomputed). Rotation order is YXZ matching Three.js Euler default.
4. Voxelize **STL** objects as AABB of scaled+translated vertices.
5. **Heat sources** (humans/appliances): inject a Gaussian Q field around the source centre over a 7×5×7 stencil and seed an upward plume velocity column above.
6. **AC supply jets**: at each AC position (x, z, wall), forcing applied to all non-solid cells with positive dot product against jet direction. Profile is a 3D Gaussian (lateral spread 0.4 + 0.25·dist, vertical 0.3 + 0.15·dist, dist decay exp(−0.18·dist)). Both `Vx_g/Vz_g` (instant) and `Fx_g/Fz_g` (persistent re-forcing) are written.
7. **Ceiling fans**: radial+downwash (summer) or radial+upwash (winter) Gaussian momentum injection.
8. **Table fan**: directional jet derived from `dir` angle.
9. **Open windows/doors**: stripe across the wall opening with infiltration velocity (height-dependent `0.3 ± 0.15`) and, for windows, a heat source `Qs_g += g·1.2`.

### 3.4 Time integration (`doSim`, [cfd_room_3d_v6.html:1318](cfd_room_3d_v6.html#L1318))
For each substep (loop runs 2 substeps per animation frame):

1. **Energy equation** — solve advection-diffusion of `T`:
   ```
   ∂T/∂t + u·∇T = α∇²T + Q
   ```
   - Diffusion uses 7-point central differences.
   - Advection uses **first-order upwind** (the sign of u, v, w selects backward or forward difference).
   - Time step `dt = 0.055 s`.
   - `T` clamped to [10, 55] °C for stability.

2. **Boundary temperature update**:
   - Floor (`iy=0`): `min(30, Tout − 3)`
   - Ceiling (`iy=NY-1`): `min(28, Tout − 5)`
   - Walls (S/N/E/W): per-cell from `getBndT3D()` which checks if the cell sits inside a feature (window → 48 °C, door → 37 °C, closed → 33 °C) else uses outdoor temperature clamped to 33 °C.

3. **Buoyancy** — Boussinesq vertical force:
   ```
   Vy += BETA · G · (T − T_AMB) · 3·dt
   Vy *= 0.94          (mild damping)
   Vy ∈ [−2.8, 2.8]    (clamp)
   ```
   ([cfd_room_3d_v6.html:1349-1356](cfd_room_3d_v6.html#L1349-L1356))

4. **Re-apply forcing** — gentle relaxation toward stored `Fx_g`/`Fz_g` so the AC jet doesn't decay:
   ```
   Vx += (Fx − Vx) · 0.04
   Vz += (Fz − Vz) · 0.04
   ```

5. **No-penetration on floor & ceiling**: `Vy = 0` at `iy = 0` and `iy = NY-1`.

6. **Pressure projection** (`pressureCorrect`, [cfd_room_3d_v6.html:1295](cfd_room_3d_v6.html#L1295)):
   - 3 Gauss-Seidel iterations of `∇²p = ∇·u`
   - Then subtract `dt·∇p` from velocity to enforce incompressibility.

This is a Chorin-style fractional-step incompressible flow solver — not a full Navier-Stokes (the momentum advection and viscous diffusion of velocity are skipped to keep it real-time), but it captures the dominant physics: buoyancy, jet forcing, divergence-free correction, and energy advection by the velocity field.

### 3.5 Cooling loop
After every CFD step, `setACCold(autoACPos)` ([cfd_room_3d_v6.html:1278](cfd_room_3d_v6.html#L1278)) clamps the temperature in a small box around each AC unit toward `T_AC = 16 °C`, modeling the cold-air supply.

### 3.6 Loop budget
- 500 maximum steps (`MAX_STP`)
- 2 substeps per frame
- → ~250 frames ≈ 4 seconds of wall-clock simulation at 60 fps

---

## 4. Visualization Pipeline

### 4.1 Volumetric thermal rendering
The temperature field is projected onto **6 wall planes** (floor, ceiling, S, N, W, E). Each plane has a `CanvasTexture` whose pixels are filled by sampling the corresponding boundary of the 3D grid and color-mapping with `tempRGB(t)` (6-stop gradient blue→cyan→green→yellow→orange→red, [cfd_room_3d_v6.html:294-299](cfd_room_3d_v6.html#L294-L299)). Updated every 5 simulation steps via `updTex()` ([cfd_room_3d_v6.html:316-343](cfd_room_3d_v6.html#L316-L343)).

### 4.2 3D arrow field
324 arrows (12×9 lattice × 3 height layers at 12, 42, 72 % of room height) sample the velocity grid. Each arrow's length scales with speed and its color uses `speedRGB()` (dark navy → cyan → white) ([cfd_room_3d_v6.html:961-1005](cfd_room_3d_v6.html#L961-L1005)).

### 4.3 Particle tracer
800 particles seeded near the AC supply, advected by trilinear-ish nearest-cell velocity sampling with stochastic noise, recolored each frame by either temperature (thermal mode) or speed (airflow mode). Particles that hit walls or obstacles are respawned at the AC ([cfd_room_3d_v6.html:1541-1571](cfd_room_3d_v6.html#L1541-L1571)).

### 4.4 Live KPIs
Updated every 5 steps via `scoreT()` ([cfd_room_3d_v6.html:1371-1381](cfd_room_3d_v6.html#L1371-L1381)):
- **Mean** = ΣT / N
- **Std** = √(ΣT²/N − mean²)
- **Hot %** = fraction of cells with T > Tset + 4 °C
- **Max speed** = max √(Vx² + Vy² + Vz²)

---

## 5. AC Optimizer Algorithm

`runOpt()` ([cfd_room_3d_v6.html:1480](cfd_room_3d_v6.html#L1480)):
1. Generate **20 candidate positions** — 5 evenly spaced points along each of the 4 walls.
2. For each candidate:
   - Reset `T_grid`, `Vy_g`, `p_grid`
   - Run `initCFD([candidate])`
   - Run **50 simulation substeps** with cold-air injection
   - Compute `score = 0.55·std + 0.30·max(0, mean − Tset) + 0.12·hot%` (lower is better)
3. Sort, take the top `acCfg.n` (default 1).
4. Restore the user's previous CFD state.
5. Render gold rings + ceiling boxes + "★ BEST" sprite labels at the chosen positions.
6. Restart the simulation with the optimal AC configuration.

Weights favor **uniformity (std)** over raw mean temperature — this matches comfort-engineering practice where draftiness or hot pockets are worse than a slightly elevated room mean.

---

## 6. ASHRAE Heat-Load Calculation

`calcHeatLoad()` ([cfd_room_3d_v6.html:1419-1451](cfd_room_3d_v6.html#L1419-L1451)) — uses simplified single-zone steady-state formulas:

| Component | Formula | Notes |
|---|---|---|
| Walls | `U_wall · A_walls · ΔT` | A_walls = perimeter × H − A_glass |
| Glass conduction | `U_glass · A_glass · ΔT` | All windows + round + arch openings |
| Solar gain | `Σ SHGC · I · A_window` | Only when window is open |
| Roof | `U_roof · L · W · ΔT` | Treats ceiling as roof |
| Occupant sensible | `75 W × n` | ASHRAE standard sedentary sensible |
| Appliances | `Σ watts` | User-set per appliance |
| Infiltration | `ACH/3600 · Vol · ρcp · ΔT` | ACH = 0.5 air changes/hr |
| Latent | `55 W × n` | Occupant respiration/perspiration |

`Q_total = sensible + latent`, divided by **3517 W = 1 TR** to give tons of refrigeration. The result drives the AC capacity recommendation in the export.

---

## 7. Export Format

`showCfg()` produces a JSON document containing every parameter needed to reproduce the scene in an offline solver (e.g. Python with FEniCS/OpenFOAM):
```
{
  "version": "v5",
  "room_length": …, "room_width": …, "room_height": …,
  "outdoor_temp": …, "setpoint_temp": …,
  "room_extensions": [ {x,z,W,D,H,ry_deg,rx_deg,rz_deg}, … ],
  "stl_objects": [ {name, x,y,z, scale, ry_deg, rx_deg, rz_deg, triangles}, … ],
  "windows":   [ {wall, start, length, height, type, open}, … ],
  "doors":     [ {wall, start, length, height, open}, … ],
  "obstacles": [ {shape, x, z, W, D, H, Yoff, rpm, dir, on, watts, season}, … ],
  "ac_capacity_kw": …,
  "n_ac_units": …,
  "optimal_ac_positions": [ {x, z, wall}, … ],
  "ashrae_heat_load": { Q_walls_W, Q_glass_W, Q_solar_W, Q_roof_W,
                        Q_occupants_sens_W, Q_appliances_W,
                        Q_infiltration_W, Q_latent_W,
                        Q_total_W, required_TR }
}
```
The modal hints at running it with a Python script `python ac_cfd.py --config config.json`.

---

## 8. Architecture Map

```
HTML body
├── #tb         Top toolbar: tool selection + run/optimize/export buttons
├── #sb         Sidebar: room sliders, blocks list, properties, results, ASHRAE
└── #view       3D canvas (Three.js WebGLRenderer)

JavaScript layers (single <script>)
├── State                  MR (room), arrays for blocks/features/obstacles/STL
├── Three.js scene         Groups: roomGrp, blkGrp, featGrp, obsGrp, hndGrp,
│                          acGrp, partGrp, flowGrp, sliceGrp, stlGrp
├── CFD grid               36×14×28 Float32Arrays (T, Vx, Vy, Vz, p, Qs, F, wall)
├── Builders               buildRoom, blkMesh, fMesh, oMesh, buildSTLMesh
├── Interaction            mouse/keyboard handlers, raycaster, drag state
├── CFD physics            initCFD → doSim → pressureCorrect → setACCold
├── Visualization          updTex (textures), updateArrows (vectors),
│                          updPart (particles), applyViewMode (toggles)
├── Engineering tools      calcHeatLoad (ASHRAE), runOpt (AC optimizer),
│                          showCfg (export)
└── Render loop            requestAnimationFrame: spin + sim + draw
```

---

## 9. Strengths, Limits, and What This Is Not

**Strengths**
- Real-time interactive CFD that runs entirely in a browser, no setup
- Captures the dominant physics of indoor thermal comfort: buoyancy-driven mixing, jet entrainment, infiltration, solar gain, occupant heat
- Fully integrated: build → simulate → score → optimize → export, all in one file
- Includes a complete ASHRAE-style cooling-load calculation tied to the scene
- Supports STL import for arbitrary furniture geometry (as AABB voxels)
- Designed for engineering intuition: AC placement optimizer, season-aware ceiling fans, opening toggles

**Limits (what would change in a "real" CFD code)**
- **Grid is coarse** (36×14×28 ≈ 14k cells). Fine geometric details get smeared.
- **Velocity advection is omitted** — only temperature is advected; momentum is updated by buoyancy + persistent forcing + pressure correction. This is closer to a Boussinesq buoyancy plume model than full Navier-Stokes. Reynolds stresses, viscous dissipation, and turbulent eddy viscosity aren't modeled.
- **First-order upwind advection** introduces numerical diffusion (smears thermal gradients).
- **Pressure projection has only 3 Gauss-Seidel iterations** — divergence is reduced, not driven to zero.
- **STL meshes voxelize as AABB**, not as actual triangle boundaries — concave shapes are over-approximated.
- **Boundary temperatures are imposed (Dirichlet)** rather than computed from a wall heat-transfer model.
- **No turbulence model** (no k-ε, LES, etc.).
- **2D-style ASHRAE solver** runs independently from the 3D CFD — they don't share a heat balance.

**What this is**
A pedagogically strong, visually impressive engineering sketch tool — the right level of fidelity to compare AC placements, see hot/cold pockets, judge whether an open window matters, or estimate cooling capacity for a room. Not a substitute for a validated solver (OpenFOAM, ANSYS Fluent, EnergyPlus + CONTAM) for code-compliance work.

---

## 10. Quick Start

1. Open `cfd_room_3d_v6.html` in Chrome / Edge / Firefox / Safari.
2. Drag sliders to set room size and outdoor / set-point temperatures.
3. Click **🪟 Window** → click a wall to add a window. Repeat for doors, etc.
4. Click **🧑 Human** → click on the floor to add a person. The ASHRAE panel updates instantly.
5. Click **▶ Run CFD** to start the simulation. Watch temperature settle and arrows align.
6. Click **★ Optimize AC** to let the program find the best AC position.
7. Click **⚙ Export** to download the JSON config.
