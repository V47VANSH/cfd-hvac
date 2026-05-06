# Validation Test Corpus

Test fixtures used by both the Tier-1 CI suite and the Tier-2 calibration
script. Each scene file is a versioned JSON Scene plus an
`expected.json` with the reference outputs.

## Layout

```
validation/
    scenes/
        default.json             ← Tier-1 default (4×3×2.7 m)
        office.json              ← 6×4×2.7 m, 3 windows, 4 occupants
        classroom.json           ← 8×6×3 m, 24 occupants in a 4×6 grid
        restaurant-kitchen.json  ← 8×5×3 m, 1500 W appliances + heat sources
    expected/
        default.json             ← matching expected outputs
        office.json
        classroom.json
        restaurant-kitchen.json
    annex20/                     ← raw measurement data (Nielsen 1990)
    ansys/                       ← ANSYS CFD-Post CSV exports (if available)
```

## Usage

Tier-1 CI:
```bash
cd web && npx vitest run --testNamePattern "validation"
```

Tier-2 calibration:
```bash
cd server && python -m cfd_server.calibration  # uses validation/scenes/
```

## Status

**Phase-4 stage 1**: scaffold only. The scene JSONs and expected
outputs land in stage 2, computed by running the canonical solver
against each scene once and committing the result.
