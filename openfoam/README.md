# OpenFOAM Case Templates & Reference Decks

This directory holds **canonical case templates** the Tier-2 backend
copies and patches with user data. Keeping templates here (rather than
generating them from scratch every time) means:

- The output of `cases.py` is reviewable as a diff against the template
- Hand-tuned numerics (relaxation, schemes) survive across solver versions
- Validation cases (Annex 20, cavity, Mundt) are reproducible from
  bit-identical input decks

## Layout

```
openfoam/
    templates/
        steady-boussinesq/       ← buoyantBoussinesqSimpleFoam baseline
        transient-pimple/        ← buoyantPimpleFoam baseline
        cht-multi-region/        ← chtMultiRegionFoam (Phase-4 stage 2)
    benchmarks/
        annex20/                 ← Nielsen 1990 reference case
        cavity-ra1e5/            ← de Vahl Davis 1983
        mundt-stratification/    ← Mundt 1996
```

## Status

**Phase-4 stage 1** (current): empty skeleton — `cases.py` emits
dictionaries inline. The templates land in stage 2 once we know exactly
which numerics produce mesh-independent Annex 20 results.

**Phase-4 stage 2**: full canonical templates committed here, plus the
benchmark reference data for pass/fail comparison.
