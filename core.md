# MAC Solver — Core Reference

This document describes the Tier-1 numerical core of the CFD app: a 3-D
incompressible Navier–Stokes solver running in a Web Worker, with
Boussinesq buoyancy, an LES eddy-viscosity model, semi-Lagrangian
advection, and a multigrid pressure projection. Source lives under
[web/src/lib/cfd/](web/src/lib/cfd/).

The downstream comfort layer (PMV / PPD / Draft Risk) consumes the
fields the solver produces and is summarised at the end.

---

## 1. What "MAC" means

**MAC = Marker-and-Cell** (Harlow & Welch, *Phys. Fluids* 1965). A
**staggered grid** layout where:

- **Cell-centred** scalars: pressure `p`, temperature `T`, relative
  humidity `RH`, CO₂, mean radiant temperature `Tmrt`, source terms
  `Qs / Qrh / Qco2`, wall mask.
- **Face-centred** velocity components: `u` lives on x-faces (between
  cells in the x-direction), `v` on y-faces, `w` on z-faces.

Why staggered? On a collocated grid, the natural pressure-gradient
stencil decouples even and odd cells and produces a checkerboard
pressure mode under semi-Lagrangian advection. Staggering eliminates
that null-space exactly: every pressure difference `p[i+1] − p[i]`
drives the velocity at the face *between* the two cells, so the
gradient operator is the transpose of the divergence operator and the
pressure projection is well-posed.

Grid sizing — see [mac-grid.ts:32-39](web/src/lib/cfd/mac-grid.ts#L32-L39):

```
NX × NY × NZ = 36 × 14 × 28           ≈ 14 000 cells
u-faces      = (NX+1) × NY × NZ
v-faces      =  NX × (NY+1) × NZ
w-faces      =  NX × NY × (NZ+1)
```

`y` is the vertical axis (so gravity acts on v-faces); `x` and `z` are
the horizontal floor-plane axes. Cell size `(dx, dy, dz) =
(L/NX, H/NY, W/NZ)` is computed from room dimensions in
[`cellSize()`](web/src/lib/cfd/mac-grid.ts#L122-L124).

---

## 2. Governing equations

The solver discretises the **incompressible Navier–Stokes equations
under the Boussinesq approximation** (small density variations enter
only as buoyancy in the momentum equation, not as compressibility).

### 2.1 Momentum

$$
\frac{\partial \mathbf u}{\partial t}
+ (\mathbf u \cdot \nabla)\mathbf u
= -\frac{1}{\rho_0}\nabla p
+ \nabla \cdot \big[(\nu + \nu_t)\nabla \mathbf u\big]
+ \mathbf g \,\beta\,(T - T_{\text{ref}})
+ \mathbf F
$$

| Term | Meaning | Where in code |
|------|---------|---------------|
| `(u·∇)u` | non-linear advection | [`advectVelocity`](web/src/lib/cfd/advection.ts#L25-L79) |
| `−∇p / ρ₀` | pressure gradient | [`subtractPressureGradient`](web/src/lib/cfd/multigrid.ts#L272-L322) |
| `(ν + ν_t)∇²u` | molecular + turbulent diffusion (implicit in semi-Lagrangian) | scalar diffusion done explicitly in [`diffuseScalar`](web/src/lib/cfd/solver-mac.ts#L157-L189); momentum diffusion is supplied by the Smagorinsky term + the natural numerical viscosity of semi-Lagrangian advection |
| `g β (T − T_ref)` | Boussinesq buoyancy on v-faces only | [solver-mac.ts:109-121](web/src/lib/cfd/solver-mac.ts#L109-L121) |
| `F` | persistent forcing (AC jets, fans, infiltration) | [`sources-mac.ts`](web/src/lib/cfd/sources-mac.ts) |

### 2.2 Mass continuity

$$
\nabla \cdot \mathbf u = 0
$$

Enforced by the Helmholtz / Hodge projection (Chorin 1968): after the
explicit substep updates `u*`, solve

$$
\nabla^2 p = \frac{1}{\Delta t}\,\nabla \cdot \mathbf u^*,
\qquad
\mathbf u^{n+1} = \mathbf u^* - \Delta t\,\nabla p
$$

so that `∇·u^{n+1} = 0`. Implemented in
[`divergence`](web/src/lib/cfd/multigrid.ts#L247-L266),
[`Multigrid.solve`](web/src/lib/cfd/multigrid.ts#L72-L89), and
[`subtractPressureGradient`](web/src/lib/cfd/multigrid.ts#L272-L322).

### 2.3 Scalar transport

For each scalar `φ ∈ {T, RH, CO₂}`:

$$
\frac{\partial \varphi}{\partial t}
+ \mathbf u \cdot \nabla \varphi
= \nabla \cdot \big[(\alpha + \nu_t / \mathrm{Pr}_t)\nabla \varphi\big]
+ Q_\varphi
$$

with turbulent **Prandtl number** `Pr_t = 0.85` for temperature and
turbulent **Schmidt number** `Sc_t = 0.7` for RH and CO₂
(see [solver-mac.ts:28-29](web/src/lib/cfd/solver-mac.ts#L28-L29)).
`α` is the molecular thermal diffusivity of air,
`α_air ≈ 2.0 × 10⁻⁵ m²/s` ([calibration.ts:42-51](web/src/lib/cfd/calibration.ts#L41-L51)).

### 2.4 Turbulence — Smagorinsky LES

The eddy viscosity `ν_t` closes the unresolved subgrid stresses
(Smagorinsky 1963):

$$
\nu_t = (C_s\,\Delta)^2 \,|S|,
\qquad
|S| = \sqrt{2\,S_{ij}S_{ij}},
\qquad
\Delta = (dx\,dy\,dz)^{1/3}
$$

with the strain-rate tensor

$$
S_{ij} = \tfrac{1}{2}\!\left(\frac{\partial u_i}{\partial x_j} + \frac{\partial u_j}{\partial x_i}\right).
$$

`C_s = 0.17` (Lilly's value) by default, calibratable. Implemented
per-cell from MAC face values in
[`smagorinskyViscosity`](web/src/lib/cfd/turbulence.ts#L43-L102).

`ν_t` is capped each step at `min(0.10 m²/s, 0.40 / [Δt·(1/dx²+1/dy²+1/dz²)])`
so the explicit forward-Euler diffusion stays inside its stability bound
([turbulence.ts:34, 50-51](web/src/lib/cfd/turbulence.ts#L34-L51)).

### 2.5 Boussinesq buoyancy

Only the vertical (v) component of momentum gets the buoyancy body
force. Per substep on each interior v-face:

```
v ← (v + β · g · (T_avg − T_ref) · Δt) · 0.985
clamp |v| ≤ 3 m/s
```

with `β = 3.4 × 10⁻³ K⁻¹` (air), `g = 9.81 m/s²`, `T_ref = 28 °C`. The
0.985 factor is a light artificial damping that suppresses spurious
buoyancy oscillations without killing the recirculation cells.
See [solver-mac.ts:109-121](web/src/lib/cfd/solver-mac.ts#L109-L121).

### 2.6 Radiation — view-factor `Tmrt`

Mean Radiant Temperature at every fluid cell, used by PMV. Six
axis-aligned rays are marched until they hit a solid cell or domain
boundary; each contributes 1/6 of the surface temperature (uniform
solid-angle approximation). Implemented in
[`computeViewFactorTmrt`](web/src/lib/cfd/radiation.ts#L35-L65).

No inter-reflection, no spectral integration — this is a Tier-1
approximation, accurate to ≈0.5 °C versus a proper view-factor
solver on box-shaped rooms.

---

## 3. Discretisation strategy — fractional step

The solver advances one substep with the **operator-split** sequence
in [`stepMAC`](web/src/lib/cfd/solver-mac.ts#L70-L145):

| # | Step | Operator | File |
|---|------|----------|------|
| 1 | Re-apply persistent forcing (AC, fan, infiltration) | relaxation toward `f.fu / fv / fw` | [solver-mac.ts:75-78](web/src/lib/cfd/solver-mac.ts#L75-L78) |
| 2 | Smagorinsky eddy viscosity | `ν_t = (Cs·Δ)²·|S|` | [turbulence.ts](web/src/lib/cfd/turbulence.ts) |
| 3 | Diffuse `T, RH, CO₂` (forward Euler) | `D = α + ν_t/Pr_t` | [solver-mac.ts:84-89](web/src/lib/cfd/solver-mac.ts#L84-L89) |
| 4 | Apply scalar source terms | `φ ← φ + Q_φ · Δt` | [solver-mac.ts:92-97](web/src/lib/cfd/solver-mac.ts#L92-L97) |
| 5 | Boussinesq buoyancy on v-faces | `v ← v + βg(T−T_ref)Δt` | [solver-mac.ts:109-121](web/src/lib/cfd/solver-mac.ts#L109-L121) |
| 6 | Velocity advection (semi-Lagrangian, OOP) | back-trace + trilinear sample | [advection.ts](web/src/lib/cfd/advection.ts) |
| 7 | Scalar advection | back-trace + trilinear sample, monotonic clip | [advection.ts:86-108](web/src/lib/cfd/advection.ts#L86-L108) |
| 8 | Boundary temperatures (mixed BC) | `T ← (1−k)T + k·T_wall` | [solver-mac.ts:204-239](web/src/lib/cfd/solver-mac.ts#L204-L239) |
| 9 | **Pressure projection** | `∇²p = ∇·u*/Δt`; `u ← u − Δt·∇p` | [multigrid.ts](web/src/lib/cfd/multigrid.ts) |
| 10 | Re-pin strong supply faces | restore Dirichlet at AC diffuser | [solver-mac.ts:282-302](web/src/lib/cfd/solver-mac.ts#L282-L302) |

### 3.1 Semi-Lagrangian advection — Stam's "Stable Fluids"

For each face / cell, trace its position back along the velocity field
by `−Δt`, sample the field at that back-traced point via trilinear
interpolation in the appropriate face layout, and copy that value
forward. Unconditionally stable for any Δt — the only constraint on
the timestep is **accuracy** (CFL), not stability.

Reference: Stam, *Stable Fluids*, SIGGRAPH 1999.

### 3.2 Pressure-Poisson — geometric multigrid V-cycle

`∇²p = rhs` is solved on a hierarchy of three grids
(36×14×28 → 18×7×14 → 9×4×7), with:

- **Red-black Gauss–Seidel** smoothing (2 pre / 2 post per level).
- **Full-weighting restriction** on residuals (2×2×2 average).
- **Constant-injection prolongation** (each coarse correction added
  into the 2×2×2 fine block).
- **Coarsest grid**: 32 GS sweeps — effectively a direct solve at that
  size.
- **Wall handling**: solid cells are homogeneous Dirichlet (`p = 0`);
  Neumann at fluid–solid interfaces by dropping the neighbour term and
  reducing the diagonal coefficient.

Three V-cycles per timestep is the default
([calibration.ts:46](web/src/lib/cfd/calibration.ts#L46)). Reference:
Brandt 1977.

### 3.3 Adaptive timestep — CFL

Although semi-Lagrangian is unconditionally stable, large `Δt` smears
the field and lets jets tunnel through obstacles. Each tick we compute

$$
\Delta t = \mathrm{clamp}\!\left(\frac{C_{\max}}{\max(|u|/dx,\,|v|/dy,\,|w|/dz)},\;0.005,\;0.10\right)
$$

with `C_max = 0.8` cells/step ([timestep.ts:15-30](web/src/lib/cfd/timestep.ts#L15-L30)).

---

## 4. Boundary conditions

### 4.1 Walls

- **No-penetration** at the domain box: outermost u/v/w faces forced
  to zero in [`subtractPressureGradient`](web/src/lib/cfd/multigrid.ts#L307-L321).
- **Solid obstacles / STL geometry**: cell-centred `wall` mask is the
  ground truth; face masks (`uwall, vwall, wwall`) are derived — a
  face is closed iff either adjacent cell is solid, or the face lies
  on the domain boundary. See [voxelize-mac.ts](web/src/lib/cfd/voxelize-mac.ts).

### 4.2 Wall temperatures — mixed BC, not Dirichlet

Pure Dirichlet at boundary cells turns the wall into an infinite heat
bath at `T_out`, which crushes the AC effect. Instead, each boundary
cell uses a per-substep blend approximating a real surface heat-transfer
coefficient `h ≈ 5 W/m²K`:

```
T_cell ← (1 − k) · T_cell + k · T_target
k_wall   = 0.015     (opaque walls)
k_window = 0.05      (windows — solar gain dominates)
T_target = T_out + SHGC · 8   (windows, capped at 48 °C)
         = T_out               (open doors)
         = min(T_out, 30)      (insulated walls)
```

See [solver-mac.ts:204-276](web/src/lib/cfd/solver-mac.ts#L204-L276).

### 4.3 AC supply — Dirichlet face patch + body-force assist

A real diffuser is modelled as a **Dirichlet velocity patch** on the
inlet faces (so the multigrid sees it correctly and the jet entrains
surrounding air). A small downstream Gaussian body-force keeps the
core anchored over the first metre of throw.

Patch size scales as `kW^(1/3)` so the cold-air *volume* scales linearly
with rated power. Target speed is derived from volumetric flow:

```
flow_m3/s    = kW · 175 CFM/kW · 0.000472
target_speed = clamp(flow / patch_area, 2, 8) m/s
```

Cooling is **energy-budgeted**: `Q_step = kW · Δt`, distributed across
the cold patch in proportion to the cell-by-cell excess above the
supply temperature. See
[`injectACJetsMAC`](web/src/lib/cfd/sources-mac.ts#L127-L247) and
[`applyACCooling`](web/src/lib/cfd/sources-mac.ts#L467-L527).

### 4.4 Infiltration — windows / doors

Each open opening drives a small wall-normal inflow (`0.1 + 0.04·perm` m/s)
plus a per-step blend of the interior cell toward outdoor `T, RH, CO₂`.
[`injectInfiltrationMAC`](web/src/lib/cfd/sources-mac.ts#L615-L672).

---

## 5. Source terms

| Source | Magnitude | Distribution | Reference |
|--------|-----------|--------------|-----------|
| Sensible heat — human | 75 W / person | Gaussian over a 7×5×7 cell box around the body | ASHRAE Handbook Fundamentals (sedentary, 1.2 met) |
| Sensible heat — appliance | 200 W default, override per object | same Gaussian | typical task lighting / monitor |
| Moisture — human | 50 g/h ≈ 1.4×10⁻⁵ kg/s | small Gaussian → ΔRH/s using `ΔRH = ṁ_w / (V · ρ_air · w_sat)` with `w_sat ≈ 0.020 kg/kg` at 25 °C | ASHRAE 62.1 |
| CO₂ — human | 0.2 ppm/s in a small room (≈ 0.005 L/s exhalation at 1 met) | small Gaussian | ASHRAE 62.1 / ISO 17772 |

Implemented in [sources-mac.ts:14-79](web/src/lib/cfd/sources-mac.ts#L14-L79).

---

## 6. Calibration

The constants `(β, Cs, mgCycles, forceRelax, α_air, T_ref)` ship in
`web/public/calibration.json`, fitted by the Tier-2 OpenFOAM
calibration script. Defaults if no file is present
([calibration.ts:41-51](web/src/lib/cfd/calibration.ts#L41-L51)):

| Constant | Default | Meaning |
|----------|---------|---------|
| `beta` | 3.4 × 10⁻³ K⁻¹ | Boussinesq coefficient for air at ~25 °C |
| `smagorinskyCs` | 0.17 | Lilly's value |
| `mgCycles` | 3 | V-cycles per pressure projection |
| `forceRelax` | 0.10 | Per-step pull toward persistent forcing |
| `alphaAir` | 2.0 × 10⁻⁵ m²/s | Molecular thermal diffusivity of air |
| `Tamb` | 28 °C | Reference temperature for Boussinesq |

The provenance block records `gitSha`, `generatedAt`, `sourceCases`,
and the validation RMSEs (`rmseT`, `rmseV`, `rmsePMV`) so the UI can
show which Tier-2 run produced the active constants.

---

## 7. Validation & measurement standards

### 7.1 Numerical sanity (Tier-1, runs in CI)

Vitest suite in [web/src/lib/cfd/\_\_tests\_\_/](web/src/lib/cfd/__tests__/):

- **[multigrid.test.ts](web/src/lib/cfd/__tests__/multigrid.test.ts)** —
  V-cycle convergence on a smooth Gaussian RHS; homogeneous Dirichlet
  inside solid slabs; finiteness of every output cell.
- **[mac-cavity.test.ts](web/src/lib/cfd/__tests__/mac-cavity.test.ts)** —
  3×3×3 m cubic cavity with one hot window; after ~5 sim seconds the
  mean temperature must be physically plausible (20–48 °C) and the
  thermal standard deviation > 0.5 °C (proves the solver actually does
  something).
- **[advection.test.ts](web/src/lib/cfd/__tests__/advection.test.ts)** —
  semi-Lagrangian back-trace correctness.
- **[mac-ac.test.ts](web/src/lib/cfd/__tests__/mac-ac.test.ts)** — AC
  jet patch produces a coherent throw and the energy budget is
  respected.

### 7.2 Reference benchmarks (Tier-2)

Stored under [validation/](validation/):

| Reference | Use |
|-----------|-----|
| **Annex 20** room-airflow benchmarks (Nielsen 1990) | classical isothermal mixing-ventilation case — measured velocity profiles at standard rake positions; raw data lives in `validation/annex20/`. |
| **ANSYS Fluent / CFD-Post** exports for the four canonical scenes (default room, office, classroom, restaurant kitchen) | ground-truth fields for RMSE comparison; exported CSVs in `validation/ansys/`. |
| **OpenFOAM** runs (Tier-2 calibration) | drives the fitted `calibration.json`. RMSEs for `T`, `|v|`, and PMV are recorded in `provenance.rmseT / rmseV / rmsePMV`. |

The Tier-2 calibration script lives in `server/cfd_server/calibration.py`;
it ingests `validation/scenes/*.json`, runs the matching OpenFOAM case,
fits `(β, Cs, …)` by minimising the field RMSEs, and emits a new
`calibration.json` with provenance.

### 7.3 Comfort & air-quality standards consumed downstream

The solver hands fields to [web/src/lib/comfort/](web/src/lib/comfort/),
which evaluates:

- **PMV — ISO 7730 / Fanger**, iterative implementation per Annex D.
  See [`pmv()`](web/src/lib/comfort/pmv.ts#L22-L72). Inputs: `T_a, T_r,
  v_a, RH, met, clo`. Output clamped to [-3, +3] outside the ISO valid
  range (10 < `T_a` < 30 °C, 10 < `T_r` < 40 °C, 0 < `v_a` < 1 m/s,
  30 < RH < 70 %, 0.8 < met < 4, 0 < clo < 2).
- **PPD — ISO 7730 §5**: `PPD = 100 − 95·exp(−0.03353·PMV⁴ − 0.2179·PMV²)`.
- **Draft Risk — ISO 7730 §6.2**: `DR = (34 − T_a)(v − 0.05)^0.62 (0.37·v·Tu + 3.143)`,
  Tu = 40 % default. [draftRisk.ts](web/src/lib/comfort/draftRisk.ts).
- **Operative temperature — ISO 7726 §G.3**:
  `T_op = A·T_air + (1−A)·T_rad`, with `A` chosen by velocity band.
  [operativeT.ts](web/src/lib/comfort/operativeT.ts).
- **Mean Radiant Temperature** — `Tmrt` from the 6-ray view-factor
  approximation in [radiation.ts](web/src/lib/cfd/radiation.ts).
- **CO₂ / RH thresholds** — ASHRAE 62.1 (CO₂ ≤ 1000 ppm above outdoor
  baseline of 380–420 ppm) and ASHRAE 55 (30 % ≤ RH ≤ 60 %).

### 7.4 Heat-load cross-check — ASHRAE

The Tier-1 boundary thermal coupling (`K_WALL = 0.015`, `K_WINDOW = 0.05`)
is sized so the net wall heat flux for a 4×3×2.7 m room with default
U-values lands on the ~3 kW order-of-magnitude that ASHRAE Fundamentals
predicts for a typical residential cooling-load calculation
([solver-mac.ts:208-213](web/src/lib/cfd/solver-mac.ts#L208-L213)).
The materials and U-value table used downstream are in
[web/src/lib/ashrae/materials.ts](web/src/lib/ashrae/materials.ts) and
[heatLoad.ts](web/src/lib/ashrae/heatLoad.ts).

---

## 8. Limitations (what this solver does *not* do)

- **Compressible flow / Mach effects** — Boussinesq only.
- **Spectral radiation / inter-reflection** — `Tmrt` is a 6-ray sum.
- **Wall functions** — Smagorinsky LES with no near-wall law of the
  wall; near-wall accuracy is limited by the cell size.
- **Moisture phase change** — RH is advected as a passive scalar,
  capped to [0, 1]. No condensation, no latent heat release.
- **Particulate / aerosol transport** — out of scope.
- **Conjugate heat transfer in solids** — solid cells are treated
  adiabatically at the surrounding air temperature.

These belong in the Tier-2 OpenFOAM / ANSYS path that the calibration
script runs offline.

---

## 9. Reference summary

| Topic | Reference |
|-------|-----------|
| MAC staggered grid | Harlow & Welch, *Phys. Fluids* 8 (1965) 2182 |
| Fractional-step / Hodge projection | Chorin, *Math. Comp.* 22 (1968) 745 |
| Semi-Lagrangian "Stable Fluids" | Stam, SIGGRAPH 1999 |
| Smagorinsky LES | Smagorinsky, *Mon. Wea. Rev.* 91 (1963) 99; Lilly 1967 |
| Geometric multigrid V-cycle | Brandt, *Math. Comp.* 31 (1977) 333 |
| Boussinesq buoyancy | Spiegel & Veronis, *Astrophys. J.* 131 (1960) 442 |
| PMV / PPD / Draft Risk | ISO 7730:2005 |
| Operative temperature | ISO 7726:1998 §G.3 |
| Indoor air quality | ASHRAE 62.1; ISO 17772-1 |
| Thermal comfort envelope | ASHRAE 55 |
| Annex 20 benchmark | Nielsen, *IEA Annex 20*, 1990 |
