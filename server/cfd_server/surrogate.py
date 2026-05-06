"""Surrogate-model trainer for the Tier-1 optimizer's inner loop.

Trains a small MLP to predict (mean_T, max_V, mean_PMV, hot_pct) from
a feature vector encoding scene geometry + AC config. Once trained,
the model is exported to ``web/public/surrogate.json`` and the Tier-1
NSGA-II picks it up automatically — fast screening of ~hundreds of
candidates per generation, then full CFD only for the top-k Pareto
front.

Pipeline:
    1. Generate a library of randomised scenes (varying room dims,
       AC kw / pos / throw / supply, occupancy)
    2. Run OpenFOAM on each (parallel, via asyncio.Semaphore)
    3. Build (X, Y) feature/target arrays
    4. Fit an MLPRegressor (scikit-learn)
    5. Export weights as JSON ready for the Tier-1 loader to consume
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from pydantic import BaseModel

from .schema import Scene, Geometry, Environment, Constraints, ACUnit
from .openfoam import run_steady

log = logging.getLogger(__name__)

OUTPUT_PATH = Path(__file__).resolve().parents[2] / "web" / "public" / "surrogate.json"


class SurrogateResult(BaseModel):
    status: str
    scene_count: int
    output_path: str
    train_score:    float    # R² on train
    test_score:     float    # R² on held-out
    feature_names:  list[str]
    target_names:   list[str]
    notes: list[str] = []


FEATURES = [
    "room_L", "room_W", "room_H",
    "outdoor_T", "RH_outdoor",
    "n_humans", "n_appliances",
    "ac_kw", "ac_supply_T", "ac_throw", "ac_angle", "ac_flow_cfm",
    "ac_wall_S", "ac_wall_N", "ac_wall_E", "ac_wall_W",   # one-hot
]
TARGETS = ["mean_T", "max_V", "mean_PMV", "hot_pct"]


async def train(scene_count: int = 200) -> dict:
    log.info(f"surrogate.train: generating {scene_count} synthetic scenes")
    rng = np.random.default_rng(7)
    scenes = [_random_scene(rng) for _ in range(scene_count)]

    X, Y, fail = await _evaluate_library(scenes)
    if len(X) < 30:
        return SurrogateResult(
            status="too-few-samples",
            scene_count=len(X),
            output_path=str(OUTPUT_PATH),
            train_score=0.0, test_score=0.0,
            feature_names=FEATURES, target_names=TARGETS,
            notes=[f"only {len(X)} valid samples ({fail} failed); need ≥30"],
        ).model_dump()

    X_arr = np.array(X, dtype=float)
    Y_arr = np.array(Y, dtype=float)

    # 80/20 train/test split
    n = len(X_arr)
    perm = rng.permutation(n)
    cut = int(0.8 * n)
    tr, te = perm[:cut], perm[cut:]

    # Normalise inputs + outputs (saved as part of the JSON export)
    x_mu, x_sd = X_arr[tr].mean(0), X_arr[tr].std(0) + 1e-9
    y_mu, y_sd = Y_arr[tr].mean(0), Y_arr[tr].std(0) + 1e-9
    Xn_tr = (X_arr[tr] - x_mu) / x_sd
    Xn_te = (X_arr[te] - x_mu) / x_sd
    Yn_tr = (Y_arr[tr] - y_mu) / y_sd
    Yn_te = (Y_arr[te] - y_mu) / y_sd

    from sklearn.neural_network import MLPRegressor
    mlp = MLPRegressor(
        hidden_layer_sizes=(64, 32),
        activation="relu",
        max_iter=2000,
        random_state=42,
    )
    mlp.fit(Xn_tr, Yn_tr)
    train_score = float(mlp.score(Xn_tr, Yn_tr))
    test_score  = float(mlp.score(Xn_te, Yn_te))

    # Export weights as JSON. Format chosen for cheap browser-side
    # inference: [{ W: [[...]], b: [...] }, ...] per layer.
    layers = []
    for w, b in zip(mlp.coefs_, mlp.intercepts_):
        layers.append({
            "W": w.tolist(),
            "b": b.tolist(),
        })
    payload = {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "feature_names": FEATURES,
        "target_names":  TARGETS,
        "input_mean":  x_mu.tolist(),
        "input_std":   x_sd.tolist(),
        "output_mean": y_mu.tolist(),
        "output_std":  y_sd.tolist(),
        "activation":  "relu",
        "layers":      layers,
        "train_score": train_score,
        "test_score":  test_score,
        "scene_count": int(n),
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, indent=2))
    log.info(f"surrogate.train: wrote {OUTPUT_PATH}, train_R²={train_score:.3f}, test_R²={test_score:.3f}")

    return SurrogateResult(
        status="ok",
        scene_count=int(n),
        output_path=str(OUTPUT_PATH),
        train_score=train_score, test_score=test_score,
        feature_names=FEATURES, target_names=TARGETS,
        notes=[f"failed scenes: {fail}/{scene_count}"],
    ).model_dump()


# ── Library generation ───────────────────────────────────────────────────

def _random_scene(rng: np.random.Generator) -> Scene:
    """Draw a random plausible HVAC scene for training.

    Room size ∈ [3, 8] m × [3, 6] m × [2.5, 3.5] m
    Outdoor T ∈ [28, 42] °C
    Humans   ∈ {0, 1, 2, 3, 4}
    AC kw    ∈ [1.0, 5.0]
    Supply T ∈ [10, 18] °C
    """
    L = float(rng.uniform(3, 8))
    W = float(rng.uniform(3, 6))
    H = float(rng.uniform(2.5, 3.5))
    Tout = float(rng.uniform(28, 42))
    n_humans = int(rng.integers(0, 5))

    walls = ["S", "N", "E", "W"]
    wall = walls[int(rng.integers(0, 4))]
    span = L if wall in {"S", "N"} else W
    pos  = float(rng.uniform(0.15, 0.85))
    if   wall == "S": x_, z_ = pos * span - L/2, -W/2 + 0.1
    elif wall == "N": x_, z_ = pos * span - L/2,  W/2 - 0.1
    elif wall == "W": x_, z_ = -L/2 + 0.1, pos * span - W/2
    else:             x_, z_ =  L/2 - 0.1, pos * span - W/2

    obstacles = []
    for i in range(n_humans):
        obstacles.append({
            "id": i + 100, "shape": "human",
            "x": float(rng.uniform(-L/4, L/4)), "z": float(rng.uniform(-W/4, W/4)),
            "W": 0.45, "D": 0.45, "H": 1.72, "Yoff": 0, "on": True,
            "watts": 75,
        })

    return Scene(
        schema_version=1,
        geometry=Geometry(L=L, W=W, H=H, extensions=[], stl=[]),
        openings=[],
        obstacles=obstacles,    # pydantic will coerce
        environment=Environment(
            outdoor_temp_C=Tout, setpoint_C=24, RH_outdoor_pct=float(rng.uniform(40, 70)),
            met=1.1, clo=0.5, tariff_per_kwh=8, co2_per_kwh_kg=0.7,
        ),
        constraints=Constraints(),
        ac_units=[ACUnit(
            id=1, wall=wall, x=x_, z=z_,
            kw=float(rng.uniform(1.0, 5.0)),
            type="split",
            throw_distance_m=float(rng.uniform(2, 8)),
            airflow_angle_deg=float(rng.uniform(-30, 30)),
            flow_rate_cfm=int(rng.uniform(150, 1500)),
            supply_temp_C=float(rng.uniform(10, 18)),
            on=True,
        )],
    )


async def _evaluate_library(scenes: list[Scene]) -> tuple[list[list[float]], list[list[float]], int]:
    """Run OpenFOAM on each scene; return (X, Y, n_failed)."""
    sem = asyncio.Semaphore(2)
    X: list[list[float]] = []; Y: list[list[float]] = []
    failed = [0]
    out_lock = asyncio.Lock()

    async def run_one(i: int, s: Scene):
        async with sem:
            req_id = f"surr-{uuid.uuid4().hex[:8]}"
            try:
                r = await run_steady(s, req_id)
                feat = _feature_vec(s)
                summ = r.field_summary
                # Hot pct can be derived from PPD; we approximate with PPD
                # band: cells likely "hot" when mean PPD > 20%
                hot_pct = max(0.0, min(100.0, summ.mean_PPD * 0.7))
                async with out_lock:
                    X.append(feat)
                    Y.append([summ.mean_T, summ.max_V, summ.mean_PMV, hot_pct])
            except Exception as e:
                log.warning(f"library eval {i} failed: {e}")
                async with out_lock:
                    failed[0] += 1

    await asyncio.gather(*(run_one(i, s) for i, s in enumerate(scenes)))
    return X, Y, failed[0]


def _feature_vec(s: Scene) -> list[float]:
    ac = s.ac_units[0] if s.ac_units else None
    n_humans = sum(1 for o in s.obstacles if o.shape == "human" and o.on is not False)
    n_apps   = sum(1 for o in s.obstacles if o.shape == "appliance" and o.on is not False)
    wall_one_hot = {"S": [1,0,0,0], "N": [0,1,0,0], "E": [0,0,1,0], "W": [0,0,0,1]}
    one_hot = wall_one_hot[ac.wall] if ac else [0, 0, 0, 0]
    return [
        s.geometry.L, s.geometry.W, s.geometry.H,
        s.environment.outdoor_temp_C, s.environment.RH_outdoor_pct,
        n_humans, n_apps,
        ac.kw if ac else 0.0,
        ac.supply_temp_C if (ac and ac.supply_temp_C is not None) else 14.0,
        ac.throw_distance_m if (ac and ac.throw_distance_m is not None) else 4.0,
        ac.airflow_angle_deg if (ac and ac.airflow_angle_deg is not None) else 0.0,
        ac.flow_rate_cfm if (ac and ac.flow_rate_cfm is not None) else 350.0,
        *one_hot,
    ]
