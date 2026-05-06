# Major-Project Documentation Bundle

This file holds the academic / submission-oriented sections that were
extracted from `PLAN.md` so the master plan stays focused on *building* the
tool. Nothing in this file affects the code. It exists if/when a college
submission, paper, or supervisor pack is ever needed.

---

## Methodology & Contributions

The project's contribution is not a new CFD method — it is an **architecture**
that makes a known set of methods accessible, calibrated, and reproducible
without research-grade install cost:

1. **Hybrid solver, single source of truth.** A fast in-browser solver
   (semi-Lagrangian advection on a MAC grid + Boussinesq buoyancy + multigrid
   pressure projection + Smagorinsky LES) and a research-grade backend
   (OpenFOAM 2312, k-ω SST + radiation + conjugate heat transfer) operate on
   the same versioned JSON scene.
2. **Calibration loop, not just validation.** The OpenFOAM backend doesn't
   merely score the fast solver — it generates constants the fast solver
   consumes. Fast vs validated becomes a continuum, not two disconnected
   modes.
3. **Comfort-first UI.** Most CFD-for-HVAC tools surface velocity and
   temperature; this one surfaces ISO 7730 PMV / PPD / Draft Risk per
   occupant as the primary user-facing metric, since those are what
   building codes and occupant complaints actually reference.
4. **Constraint-aware multi-AC optimization in browser.** Polygonal
   forbidden zones, restricted surfaces, per-wall rules, and per-occupant
   comfort weights are first-class scene objects. The optimizer skips
   infeasible candidates instead of penalizing them.
5. **Browser-only by default.** No Python install, no Docker, no localhost
   setup before the first answer. Tier 2 is opt-in.

---

## Reproducibility

Every published result is reproducible from the public repository alone:

- **Pinned versions.** `package-lock.json` and `pyproject.toml` lockfiles;
  OpenFOAM image referenced by Docker SHA-256 digest.
- **Pinned random seeds.** Optimizer RNG seeded; particle-tracer seed
  captured in the scene JSON.
- **Calibration provenance.** Calibrated Tier 1 constants ship as a JSON
  file with the git SHA + ISO timestamp of the OpenFOAM run that produced
  them.
- **Figure recipes.** Every figure has a numbered recipe — input scene
  file, command, expected output hash.
- **CI verification.** Every push to `main` runs the full validation
  suite and posts pass/fail to a README badge.

---

## Documentation Deliverables

Seven distinct documents, each with a defined audience:

1. `README.md` — repo landing; what / why / quickstart.
2. `PLAN.md` — engineering master plan (the primary working doc).
3. `PLAN-MAJOR-PROJECT.md` — this file.
4. `docs/SCHEMA.md` — JSON scene model reference + migration table.
5. `docs/USER_GUIDE.md` — end-user manual with screenshots.
6. `docs/VALIDATION.md` — every test case + result table + figures.
7. `docs/REPRODUCE.md` — figure-by-figure recipes.

---

## Glossary

| Term | Definition |
|---|---|
| **PMV** | Predicted Mean Vote — Fanger 1970 / ISO 7730 thermal sensation index, scale −3 (cold) to +3 (hot) |
| **PPD** | Predicted Percentage of Dissatisfied — derived from PMV; minimum 5 % at PMV = 0 |
| **DR** | Draft Risk — ISO 7730 §6.2 percentage dissatisfied due to draft |
| **Operative T** | Equivalent temperature combining air and radiant temperatures (ISO 7726) |
| **Vertical ΔT** | Air-temperature difference between head (1.1 m) and ankle (0.1 m); ISO 7730 limit ≤ 3 °C |
| **clo** | Clothing insulation; 1 clo = 0.155 m²K/W (typical office wear ≈ 0.5 clo) |
| **met** | Metabolic rate; 1 met = 58.15 W/m² (sedentary, seated) |
| **SHGC** | Solar Heat Gain Coefficient — fraction of incident solar admitted (0..1) |
| **U-value** | Thermal transmittance, W/m²K — lower = better insulator |
| **ACH** | Air Changes per Hour — infiltration / ventilation rate |
| **CDH** | Cooling Degree Hours — annual cooling demand proxy |
| **COP** | Coefficient of Performance — cooling output / electrical input |
| **TR** | Ton of Refrigeration; 1 TR = 3517 W |
| **Tmrt** | Mean Radiant Temperature, °C — area-weighted radiative surroundings |
| **Tier 1 / Tier 2** | This project's split between in-browser fast solver and optional OpenFOAM backend |
| **GCI** | Grid Convergence Index (Roache 1994) — quantitative mesh-independence metric |
| **Annex 20** | IEA Energy in Buildings Annex 20 (Nielsen 1990) — canonical validation case for indoor airflow |
| **Boussinesq** | Density variation neglected except in the buoyancy term; valid for indoor ΔT |
| **k-ω SST** | Menter 1994 turbulence model recommended for indoor jets per ASHRAE RP-1271 |
| **Semi-Lagrangian** | Stam 1999 unconditionally-stable advection scheme |
| **MAC grid** | Marker-and-Cell staggered grid (Harlow & Welch 1965) — pressure at cell centres, velocity components on faces |
| **Multigrid** | Pressure-Poisson solver with V-cycle relaxation across coarsened grids; near-optimal O(N) convergence |
| **NSGA-II** | Non-dominated Sorting Genetic Algorithm II (Deb 2002) — multi-objective Pareto-front optimizer |
| **WebGL2** | Browser GPU compute via fragment-shader ping-pong textures; ~99 % browser support |
| **PWA** | Progressive Web App — installable, offline-capable web app |
| **scene_hash** | SHA-256 of the canonicalized scene JSON; provenance on every export |

---

## References

**Standards**

1. ISO 7730:2005 — *Ergonomics of the thermal environment — PMV/PPD indices*. ISO.
2. ASHRAE Standard 55-2020 — *Thermal Environmental Conditions for Human Occupancy*. ASHRAE.
3. ASHRAE Handbook — *Fundamentals* (2021 ed.). ASHRAE.
4. ISO 7726:1998 — *Ergonomics — Instruments for measuring physical quantities*.

**Methods & models**

5. Fanger, P. O. (1970). *Thermal Comfort: Analysis and Applications in Environmental Engineering*. Danish Technical Press.
6. Stam, J. (1999). *Stable Fluids*. Proc. SIGGRAPH '99.
7. Harlow, F. H. & Welch, J. E. (1965). *Numerical Calculation of Time-Dependent Viscous Incompressible Flow of Fluid with Free Surface*. Phys. Fluids 8, 2182.
8. Smagorinsky, J. (1963). *General circulation experiments with the primitive equations*. Mon. Weather Rev. 91 (3): 99–164.
9. Menter, F. R. (1994). *Two-equation eddy-viscosity turbulence models for engineering applications*. AIAA J. 32 (8): 1598–1605.
10. Brandt, A. (1977). *Multi-level adaptive solutions to boundary-value problems*. Math. Comput. 31 (138): 333–390.
11. Deb, K. *et al.* (2002). *A fast and elitist multiobjective genetic algorithm: NSGA-II*. IEEE Trans. Evol. Comput. 6 (2): 182–197.
12. Roache, P. J. (1994). *Perspective: A method for uniform reporting of grid refinement studies*. J. Fluids Eng. 116 (3): 405–413.

**Validation references**

13. Nielsen, P. V. (1990). *Specification of a two-dimensional test case (IEA Annex 20)*. Aalborg University.
14. de Vahl Davis, G. (1983). *Natural convection of air in a square cavity: a benchmark numerical solution*. Int. J. Numer. Methods Fluids 3 (3): 249–264.
15. ASHRAE RP-1271 (2009). *Evaluation of CFD Models for Indoor Airflow*. ASHRAE.

**Software & libraries**

16. OpenFOAM Foundation. *OpenFOAM v2312 User Guide*. https://www.openfoam.com
17. Tartakovsky, F. *et al.* (2020). *pythermalcomfort*. JOSS 5 (52): 2325.
18. Bell, I. H. *et al.* (2014). *CoolProp*. Ind. Eng. Chem. Res. 53 (6): 2498–2508.
19. Blank, J., Deb, K. (2020). *pymoo: Multi-Objective Optimization in Python*. IEEE Access 8: 89497–89509.
20. Three.js authors. *three.js*. https://threejs.org
21. Vercel. *Next.js*. https://nextjs.org

**Background**

22. Chen, Q. (2009). *Ventilation performance prediction for buildings: A method overview and recent applications*. Build. Environ. 44 (4): 848–858.
23. Zhai, Z. *et al.* (2007). *Evaluation of various turbulence models in predicting airflow and turbulence in enclosed environments by CFD*. HVAC&R Research 13 (6): 853–870.
