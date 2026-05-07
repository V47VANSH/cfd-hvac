# Viva + Report Explainer — Indoor CFD Comfort Simulator

A speak-out-loud script for the live demo, plus answers to the
questions an examiner is most likely to fire. Pair this with
[core.md](core.md) for the equations.

---

## 1. The 30-second pitch (use this when you open)

> "I built a browser-based 3-D CFD solver that simulates how air
> moves, heats, and cools inside a real room — with furniture, AC
> units, windows, and people — and turns the velocity and temperature
> fields into the ISO-7730 thermal-comfort score that HVAC engineers
> actually use to size a cooling system. Everything runs client-side
> in a Web Worker, no server round-trip. The numerical core is a
> Marker-and-Cell staggered-grid Navier–Stokes solver with Boussinesq
> buoyancy, Smagorinsky LES, semi-Lagrangian advection, and a
> geometric multigrid pressure projection."

That single sentence covers **what**, **how**, and **why-it-matters**.
If they only let you say one thing, say that.

---

## 2. The 3-minute walk-through (matches the live demo)

Open the app, then narrate in this order:

1. **The room.** "This is a 4 × 3 × 2.7 metre room. I can drop in
   chairs, desks, humans, an AC unit, and windows. Each object is
   voxelised into the simulation grid — solids block flow and emit
   heat where appropriate."

2. **Press *Start*.** "Now the solver is running. Each frame is one
   physical time-step of about 50 milliseconds of simulated air
   motion. You can see the AC jet leave the diffuser, fall under
   gravity because cold air is denser, hit the opposite wall, and
   recirculate. That recirculation is what physically mixes the room."

3. **Switch to the temperature heat-map.** "Red is warm, blue is
   cold. Notice the cold pool building under the AC and the warm
   layer near the ceiling — that's natural stratification, driven by
   the Boussinesq buoyancy term."

4. **Switch to the PMV overlay.** "PMV is the Predicted Mean Vote
   from ISO 7730 — Fanger's thermal-comfort index, scale of −3 cold
   to +3 hot, with zero being neutral. The solver feeds air
   temperature, mean radiant temperature, velocity, and humidity into
   that model at every cell. So you can literally see *which seat in
   the room is uncomfortable* — and move the AC, change the supply
   temperature, or open a window and watch the comfort field
   respond."

5. **Resize the room or change AC kW.** "And every change rebuilds
   the geometry and re-runs in real time. That's the value
   proposition — instead of waiting an hour for ANSYS or OpenFOAM,
   the engineer iterates in the browser."

That's about three minutes if you don't rush.

---

## 3. The architecture diagram you should draw on the board

```
   ┌──────────────────────────────────────────────┐
   │  React UI  (Next.js, Three.js viewport)      │
   │  - scene editor, overlays, sliders           │
   └────────────┬─────────────────────────────────┘
                │ scene JSON, control messages
                ▼
   ┌──────────────────────────────────────────────┐
   │  Web Worker  (CFD solver, off main thread)   │
   │  ┌────────────────────────────────────────┐  │
   │  │  MAC staggered grid 36 × 14 × 28       │  │
   │  │  T, p, RH, CO₂  on cell centres         │  │
   │  │  u, v, w        on cell faces           │  │
   │  └────────────────────────────────────────┘  │
   │  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
   │  │ Voxelise │→ │ Step (×N)│→ │ Snapshot   │──┼─→ UI
   │  │ geometry │  │ fractional│  │ (T, |v|,   │  │
   │  │ + sources│  │ step      │  │  PMV, DR)  │  │
   │  └──────────┘  └──────────┘  └────────────┘  │
   └────────────┬─────────────────────────────────┘
                │ (offline)
                ▼
   ┌──────────────────────────────────────────────┐
   │  Tier-2 calibration (Python + OpenFOAM)      │
   │  - fits β, Cs, mgCycles, …                   │
   │  - emits calibration.json with provenance    │
   └──────────────────────────────────────────────┘
```

Key talking points around the diagram:

- **Why a Web Worker?** "The solver loop is CPU-bound — if it ran on
  the main thread, the UI would freeze every step. The worker keeps
  the 60-fps render loop responsive."
- **Why two tiers?** "Tier 1 is the fast in-browser solver; Tier 2
  is OpenFOAM running offline to *calibrate* the constants in the
  Tier-1 solver. So we get OpenFOAM-quality numbers without the
  OpenFOAM runtime."

---

## 4. The 5-minute deep dive (pick this if they push for technical depth)

### Step 1 — say the equations out loud

"The solver discretises the **incompressible Navier–Stokes equations
under the Boussinesq approximation**. There are three of them.

**Momentum:**
$$
\frac{\partial \mathbf{u}}{\partial t} + (\mathbf{u}\cdot\nabla)\mathbf{u}
= -\frac{1}{\rho_0}\nabla p + \nabla\cdot[(\nu+\nu_t)\nabla\mathbf{u}]
+ \mathbf{g}\,\beta\,(T-T_\text{ref})
$$

**Mass continuity:**
$$
\nabla\cdot\mathbf{u} = 0
$$

**Scalar transport** (for temperature, humidity, CO₂):
$$
\frac{\partial\varphi}{\partial t} + \mathbf{u}\cdot\nabla\varphi
= \nabla\cdot[(\alpha + \nu_t/\mathrm{Pr}_t)\nabla\varphi] + Q_\varphi
$$

That `g·β·(T − T_ref)` term is the Boussinesq buoyancy — it's the
only place density variation enters, and it's what makes hot air rise
and cold air fall."

### Step 2 — explain MAC in one sentence

"The grid is **staggered** — pressure, temperature, humidity live at
cell *centres*, but the velocity components live on cell *faces*.
That's the Marker-and-Cell layout from Harlow & Welch in 1965, and
the reason for it is that on a collocated grid the natural
pressure-gradient stencil decouples even and odd cells and gives you
a checkerboard pressure mode. Staggering eliminates that null space
exactly."

### Step 3 — the fractional step

"Each timestep is a **fractional / operator-split** scheme:

1. apply forcing (AC jets, body heat),
2. compute eddy viscosity,
3. diffuse the scalars,
4. apply Boussinesq buoyancy,
5. **advect** the velocity (semi-Lagrangian, Stam 1999),
6. advect the scalars,
7. apply boundary temperatures,
8. **project** onto the divergence-free space — solve `∇²p = ∇·u*/Δt`
   with multigrid, then subtract `Δt·∇p` from the velocity.

The advect step gives me a velocity field that's consistent with the
momentum equation but **violates mass continuity**. The projection
step is what fixes that — it's a Helmholtz / Hodge decomposition."

### Step 4 — the multigrid solver

"The pressure-Poisson is solved with a **3-level geometric multigrid
V-cycle**: red-black Gauss–Seidel smoothing on each level,
full-weighting restriction of the residual, recursion to the
coarsest grid, and constant-injection prolongation back up. Three
V-cycles per step gets the residual down by ~10⁴ — much faster than
plain Jacobi or GS, which would need thousands of iterations."

### Step 5 — the turbulence model

"Indoor jets are turbulent — Reynolds number around 10⁴ at a typical
diffuser. Rather than DNS-ing the turbulence, I use **Smagorinsky
Large-Eddy Simulation**: the resolved scales are computed directly,
and the unresolved subgrid stresses are modelled as an extra eddy
viscosity `ν_t = (Cs·Δ)²·|S|` where `Cs = 0.17` (Lilly's value) and
`Δ` is the local cell size. It's added to the molecular viscosity in
the diffusion term."

### Step 6 — comfort

"The fields are then fed into ISO 7730: **PMV** (Predicted Mean Vote)
on the −3 to +3 thermal sensation scale, **PPD** (Predicted
Percentage Dissatisfied), and **Draft Risk**. PMV is Fanger's
iterative model — it solves a heat-balance equation on a clothed
human body for the clothing surface temperature, then converts the
residual heat-load into a sensation vote. That's the standard the
HVAC industry uses."

---

## 5. The likely viva questions — and your answers

### Q1. Why MAC and not just a regular grid?
**A.** Two reasons. First, the staggered layout makes the
pressure-gradient operator the exact transpose of the divergence
operator, so the projection is well-posed and there's no
checkerboard pressure mode. Second, every velocity face *is* the
boundary between two pressure cells, so a no-penetration wall is
trivial — you just zero the face. On a collocated grid you'd need
extra stabilisation (Rhie–Chow interpolation) to get either of those
properties.

### Q2. Why semi-Lagrangian advection? Isn't that diffusive?
**A.** Yes, semi-Lagrangian has more numerical diffusion than a
high-order upwind scheme. I picked it because it's **unconditionally
stable** — you can take a large timestep without the solver blowing
up. For interactive simulation that's worth more than perfect sharp
edges. The Smagorinsky term then *adds* the right amount of physical
diffusion on top, so the total mixing is calibrated against
OpenFOAM rather than being an accident of the scheme.

### Q3. What's the Boussinesq approximation and when does it break?
**A.** Boussinesq says: density is constant *everywhere except* in
the buoyancy term, where we use `ρ = ρ₀(1 − β·ΔT)`. It's valid when
the temperature differences are small compared to the absolute
temperature — typically `ΔT/T ≪ 1`, which is true for indoor air
(differences of 10–15 K against an absolute 300 K). It breaks for
fires, ovens, or cryogenic flow.

### Q4. How do you handle turbulence near the wall?
**A.** Honest answer: not well. Pure Smagorinsky LES doesn't have a
near-wall law-of-the-wall built in, so the velocity profile within
one cell of a solid surface is under-resolved. Production CFD codes
use wall functions or hybrid RANS-LES; I traded that fidelity for
real-time performance. The Tier-2 OpenFOAM calibration partially
compensates by tuning the bulk constants against high-resolution
runs that *do* resolve the boundary layer.

### Q5. What's the spatial resolution and is it enough?
**A.** 36 × 14 × 28 cells, so about 14 000 cells, with a typical
cell size of 10–15 cm. That's enough to capture the bulk
recirculation patterns and the jet trajectory, which is what
determines mean comfort. It's *not* enough to resolve a ceiling-fan
blade or a thin laminar boundary layer. The architecture supports
swapping in a 96 × 36 × 72 grid (~250 k cells) on a WebGL2 backend
for higher accuracy — that's the planned Phase 2b path.

### Q6. How do you validate the results?
**A.** Three layers:
- **Unit / smoke tests** in Vitest — multigrid convergence on a
  smooth Gaussian RHS, a 3 × 3 × 3 m cavity with a hot window has to
  reach a sensible mean temperature with non-trivial variance, the
  semi-Lagrangian back-trace lands at the right cell, the AC energy
  budget is respected.
- **Reference benchmarks** — the IEA **Annex 20** room-airflow
  case (Nielsen 1990) provides measured velocity profiles I can
  compare against, and ANSYS Fluent / CFD-Post exports give me
  ground-truth fields for the four canonical scenes.
- **Tier-2 OpenFOAM calibration** fits the solver's free constants
  against the reference cases and records the resulting RMSE in
  temperature, velocity magnitude, and PMV — so every shipped
  `calibration.json` carries its own validation numbers as
  provenance.

### Q7. Why three V-cycles per step? Why not one, why not ten?
**A.** Empirical. With one V-cycle the residual is still about 1 %
of the input divergence — visible drift over a few hundred steps.
With three cycles it's down to ~0.01 %, which is below the noise
floor introduced by the explicit advection step, so adding more
cycles wastes CPU without improving the answer.

### Q8. What is PMV and why ISO 7730?
**A.** PMV is the **Predicted Mean Vote**, an empirical thermal
sensation index Fanger derived in the 1970s from climate-chamber
experiments on hundreds of subjects. It takes six inputs — air
temp, mean radiant temp, air velocity, humidity, metabolic rate
(`met`), and clothing insulation (`clo`) — and predicts what an
average occupant would *say* if asked to rate the environment on a
scale from −3 (cold) to +3 (hot). ISO 7730 standardises both the
formula and its valid range. Then **PPD** maps PMV to the percentage
of dissatisfied occupants, and **Draft Risk** is a separate
ISO 7730 metric for cold-air-current discomfort. Engineers use these
to size HVAC equipment so the *Predicted Percentage Dissatisfied*
stays under 10 %, which is the ASHRAE 55 comfort criterion.

### Q9. What's the role of the Web Worker?
**A.** The CFD step is CPU-bound — it does maybe 30 ms of arithmetic
per tick. If that ran on the main thread the React UI would drop
frames every step. The worker runs the solver on a separate OS
thread; it sends back compressed snapshots (downsampled fields plus
metrics) over `postMessage`. The main thread renders Three.js
overlays from the latest snapshot. So the simulation can be heavy
while the UI stays at 60 fps.

### Q10. What does the calibration step actually do?
**A.** The MAC solver has a handful of free constants — the
Smagorinsky `Cs`, the Boussinesq `β`, the per-step forcing relaxation
factor, the number of multigrid cycles, and the air thermal
diffusivity. Tier-2 takes the four reference scenes
(default room, office, classroom, restaurant kitchen), runs each one
through OpenFOAM at high resolution to get a "truth" field, then
sweeps the Tier-1 constants to **minimise the RMSE** in temperature,
velocity, and PMV against that truth. The fitted constants land in
`calibration.json` with a git SHA and the achieved RMSEs as
provenance, so the UI can show exactly which calibration is active.

### Q11. Limitations — be honest.
**A.** Five things this solver doesn't do:
1. **Compressible flow** — Boussinesq only, no Mach effects.
2. **Spectral radiation** — `Tmrt` is a 6-ray view-factor sum, not a
   radiosity solve.
3. **Wall functions** — near-wall velocity profile is mesh-resolved
   only.
4. **Moisture phase change** — humidity is a passive scalar; no
   condensation, no latent heat release.
5. **Conjugate heat transfer in solids** — solid cells are treated
   adiabatically.
   
   These are intentional Tier-1 simplifications; the full physics
   stays in the Tier-2 OpenFOAM path.

### Q12. What's novel here? Why not just use OpenFOAM?
**A.** OpenFOAM is the gold standard, but it takes ~30 minutes per
case, needs a Linux box, needs a meshing pipeline, and the output is
post-processed in ParaView. None of that fits an HVAC engineer
*designing* a system, where they want to try ten room layouts in an
hour. The novelty is the **two-tier architecture**: I use OpenFOAM
*offline* to calibrate a fast in-browser solver, so the engineer
iterates in the browser at interactive rates while the underlying
constants are still anchored to high-fidelity physics. And the
output is comfort numbers an HVAC engineer recognises (PMV, PPD,
Draft Risk, CO₂ ppm), not raw fields they'd have to interpret.

### Q13. Performance numbers?
**A.** ~30 ms per substep on a mid-range laptop CPU at 14 000 cells.
Adaptive timestep keeps the CFL number around 0.8, so a typical
substep advances 50 ms of simulated time. Net: a 5-minute simulated
run completes in about 3 seconds of wall-clock time. Memory
footprint is dominated by the Float32Arrays for the fields — about
2 MB total at the current grid size.

### Q14. Why TypeScript / Next.js for a numerical solver?
**A.** Three reasons. (1) The whole product *is* a web app —
shipping the solver inside the same toolchain eliminates a network
hop and a backend deployment. (2) Modern V8 compiles tight
Float32Array loops to near-native speed; the gap to C is much
smaller than people expect for this kind of data-parallel
arithmetic. (3) Type safety on the field layouts (`MACFields`,
`SolverScratch`) catches off-by-one face-vs-cell indexing bugs at
compile time — those are the *worst* bugs in MAC code.

### Q15. If you had another month, what would you add?
**A.** Three things. First, a **WebGL2 / WebGPU compute backend** to
push the grid to 250 k cells. Second, **wall functions** so near-wall
velocity is honest. Third, a **scenario library** — pre-baked
classroom / hospital / residential templates with the right occupant
schedules and ASHRAE 62.1 ventilation rates pre-set, so an engineer
doesn't start from a blank room every time.

---

## 6. Glossary they may quiz you on

| Term | One-line definition |
|------|---------------------|
| **CFD** | Computational Fluid Dynamics — numerical solution of the equations of fluid motion. |
| **MAC** | Marker-and-Cell — staggered-grid layout where pressure is at cell centres and velocity is at cell faces. |
| **Boussinesq** | Approximation: treat density as constant everywhere except in the buoyancy term. |
| **LES** | Large-Eddy Simulation — resolve the big eddies, model the small ones with an eddy viscosity. |
| **Smagorinsky constant `Cs`** | The proportionality factor in the eddy-viscosity model; ~0.17 for free shear flows (Lilly). |
| **Semi-Lagrangian** | Advection scheme that traces particles backward in time — unconditionally stable. |
| **Multigrid** | Iterative linear solver that uses a hierarchy of grids to kill all error frequencies efficiently. |
| **CFL number** | `u·Δt/Δx` — how many cells a particle crosses per timestep. Bound for stability / accuracy. |
| **Reynolds number Re** | Ratio of inertial to viscous forces; ~10⁴ at an indoor diffuser → turbulent. |
| **Prandtl number Pr** | Ratio of momentum to thermal diffusivity; air ≈ 0.7. Turbulent `Pr_t` ≈ 0.85. |
| **Schmidt number Sc** | Same idea for mass (humidity, CO₂); turbulent `Sc_t` ≈ 0.7. |
| **PMV / PPD** | Fanger thermal sensation vote / percentage dissatisfied — ISO 7730. |
| **Tmrt** | Mean Radiant Temperature — area-weighted average surface temperature seen by a point. |
| **clo** | Clothing insulation unit; 1 clo ≈ a business suit ≈ 0.155 m²·K/W. |
| **met** | Metabolic rate unit; 1 met ≈ seated quiet ≈ 58.15 W/m² of body surface. |
| **SHGC** | Solar Heat Gain Coefficient — fraction of incident solar radiation a window admits. |
| **U-value** | Overall heat-transfer coefficient of a wall assembly, W/m²·K. |
| **Annex 20** | The IEA reference experimental dataset for room-air-flow CFD validation (Nielsen 1990). |
| **ASHRAE 55** | The American thermal-comfort standard; PPD ≤ 10 % for general comfort. |
| **ASHRAE 62.1** | Ventilation standard; CO₂ target ≤ ~1000 ppm, RH band 30–60 %. |

---

## 7. Stock report-section text

You can paste these as the opening paragraphs of each chapter and
adapt the phrasing.

### Abstract
> This project presents a real-time, browser-based Computational
> Fluid Dynamics (CFD) simulator targeted at indoor thermal-comfort
> design. The numerical core is a three-dimensional incompressible
> Navier–Stokes solver on a Marker-and-Cell staggered grid, with
> Boussinesq buoyancy, a Smagorinsky Large-Eddy Simulation
> turbulence closure, semi-Lagrangian advection, and a geometric
> multigrid Poisson projection for incompressibility. The solver
> runs entirely client-side in a Web Worker, produces fields for
> velocity, temperature, humidity and CO₂, and feeds them into the
> ISO 7730 Predicted Mean Vote / Predicted Percentage Dissatisfied
> and Draft Risk comfort indices. The free constants of the in-browser
> solver are calibrated offline against high-fidelity OpenFOAM
> reference runs on the IEA Annex 20 room-airflow benchmark, giving
> production-grade physics at interactive rates.

### Problem statement
> HVAC designers iterating on a room layout currently choose between
> spreadsheet-grade load calculations (fast but field-blind) and
> full CFD (accurate but hour-scale per case, off-line, and outside
> the design tool). Neither tells the designer *which seat* in a
> proposed layout will be uncomfortable, in time to redesign. This
> project closes that gap with an in-browser CFD solver whose
> outputs are the comfort indices the relevant standards already
> specify.

### Methodology
> The solver implements a fractional-step (Chorin 1968) projection
> scheme on the MAC layout (Harlow & Welch 1965). Per timestep, the
> velocity field is updated for explicit forcing and Boussinesq
> buoyancy, advected semi-Lagrangianly (Stam 1999), and projected
> onto the divergence-free subspace by solving the pressure-Poisson
> equation with a three-level geometric multigrid V-cycle (Brandt
> 1977) using red-black Gauss–Seidel smoothing. Sub-grid turbulence
> is modelled via Smagorinsky LES with `Cs = 0.17`. Scalar
> transport (T, RH, CO₂) is solved on the cell-centred grid with a
> turbulent Prandtl number of 0.85 and Schmidt number of 0.7. Wall
> heat transfer is modelled as a Robin-type mixed boundary
> condition tuned to deliver an ASHRAE-load-magnitude flux; AC
> diffusers are modelled as a Dirichlet velocity patch combined with
> an energy-budgeted cooling rate.

### Validation
> The solver is verified at three levels: (i) unit tests for
> multigrid convergence, semi-Lagrangian back-trace correctness,
> and AC energy-budget conservation; (ii) cavity-flow smoke tests
> against the Annex 20 benchmark; and (iii) Tier-2 OpenFOAM
> calibration runs whose RMSE in temperature, velocity magnitude,
> and PMV is recorded as provenance metadata in every shipped
> `calibration.json`.

### Conclusion
> The two-tier architecture — fast in-browser MAC solver,
> high-fidelity OpenFOAM calibration off-line — makes interactive
> CFD-grade comfort design practical inside an ordinary web
> browser. ISO 7730 / ASHRAE 55 outputs let HVAC engineers reason
> in the units they already use, without exporting raw fields to a
> separate post-processing tool.

---

## 8. Demo-day defensive moves

- **If the simulation looks "too smooth"**: that's the
  semi-Lagrangian numerical diffusion. Mention it before they do.
- **If the AC jet looks weak**: increase `kw` in the AC parameters,
  or shorten the throw distance — both are exposed sliders. Don't
  just say "it's an artefact."
- **If a question mentions ANSYS**: agree it's the gold standard,
  point out you're calibrating *against* it via the OpenFOAM tier,
  not competing with it.
- **If the projection step gets questioned**: draw the Hodge
  decomposition on the board: any vector field decomposes uniquely
  into a divergence-free part plus a gradient. Subtracting the
  gradient leaves the divergence-free part. That's the projection.
- **If they ask "is this real CFD?"**: it solves the same equations
  ANSYS and OpenFOAM solve, with weaker turbulence resolution and
  no wall functions. The physics is real; the resolution is the
  trade-off for interactivity.

Good luck. Open with the 30-second pitch, demo for three minutes,
then let them lead.
