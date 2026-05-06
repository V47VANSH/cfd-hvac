"""Uncertainty quantification via Monte Carlo over user-selected inputs.

Inputs treated as uncertain (with default ranges centred at the scene
values):

    outdoor_temp_C      ±2 °C
    RH_outdoor_pct      ±10 percentage points
    occupancy_count     ±20 % rounded to int
    wall_u              ±15 % around the active material library values
    AC supply_temp_C    ±1 °C
    AC flow_rate_cfm    ±10 %

For each Monte-Carlo sample we draw a perturbed scene, run OpenFOAM,
extract comfort + energy outputs, and accumulate. After ``n_samples``
runs we report 95 % confidence intervals on every output.

Parallelism: we use ``asyncio.gather`` with a small concurrency cap so
the OpenFOAM runs don't all bottleneck the same disk. Default is 2
concurrent runs — bump if you have a beefy machine + lots of cores.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Optional

import numpy as np
from pydantic import BaseModel

from .schema import Scene
from .openfoam import run_steady, CASE_ROOT
from .results import parse_fields, summarize

log = logging.getLogger(__name__)


class CIPair(BaseModel):
    mean:  float
    lower: float    # 2.5th percentile
    upper: float    # 97.5th percentile


class UncertaintyResult(BaseModel):
    n_samples: int
    n_failed:  int
    pmv:       CIPair
    ppd:       CIPair
    mean_T:    CIPair
    max_V:     CIPair
    energy_kwh: CIPair
    notes: list[str] = []


CONCURRENCY = 2


async def monte_carlo(scene: Scene, n_samples: int) -> UncertaintyResult:
    log.info(f"uncertainty.monte_carlo: n_samples={n_samples}")
    rng = np.random.default_rng(42)
    perturbed_scenes = [_perturb(scene, rng) for _ in range(n_samples)]

    sem = asyncio.Semaphore(CONCURRENCY)
    out_lock = asyncio.Lock()
    results: list[dict] = []
    failed = [0]

    async def run_one(i: int, s: Scene):
        async with sem:
            req_id = f"uq-{uuid.uuid4().hex[:8]}"
            try:
                r = await run_steady(s, req_id)
                # Compute energy via Tier-1 formula
                cdh = s.environment.cooling_degree_hours or 2500
                cop = s.environment.cop or 3.0
                avg_load_W = sum(a.kw for a in s.ac_units) * 1000 * 0.6
                ekwh = avg_load_W * cdh / (cop * 1000)
                async with out_lock:
                    results.append({
                        "pmv": r.field_summary.mean_PMV,
                        "ppd": r.field_summary.mean_PPD,
                        "mean_T": r.field_summary.mean_T,
                        "max_V": r.field_summary.max_V,
                        "energy_kwh": ekwh,
                    })
            except Exception as e:
                log.warning(f"UQ sample {i} failed: {e}")
                async with out_lock:
                    failed[0] += 1

    await asyncio.gather(*(run_one(i, s) for i, s in enumerate(perturbed_scenes)))

    if not results:
        nan = float("nan")
        nullp = CIPair(mean=nan, lower=nan, upper=nan)
        return UncertaintyResult(
            n_samples=0, n_failed=failed[0],
            pmv=nullp, ppd=nullp, mean_T=nullp, max_V=nullp, energy_kwh=nullp,
            notes=["all samples failed"],
        )

    def _ci(values: list[float]) -> CIPair:
        a = np.array(values, dtype=float)
        return CIPair(
            mean=float(a.mean()),
            lower=float(np.percentile(a, 2.5)),
            upper=float(np.percentile(a, 97.5)),
        )

    return UncertaintyResult(
        n_samples=len(results),
        n_failed=failed[0],
        pmv     =_ci([r["pmv"]        for r in results]),
        ppd     =_ci([r["ppd"]        for r in results]),
        mean_T  =_ci([r["mean_T"]     for r in results]),
        max_V   =_ci([r["max_V"]      for r in results]),
        energy_kwh=_ci([r["energy_kwh"] for r in results]),
        notes=[
            f"{len(results)}/{n_samples + failed[0]} samples succeeded",
            f"concurrent runs: {CONCURRENCY}",
        ],
    )


def _perturb(scene: Scene, rng: np.random.Generator) -> Scene:
    """Draw a perturbed scene by sampling each uncertain input."""
    s = scene.model_copy(deep=True)
    s.environment.outdoor_temp_C += float(rng.uniform(-2.0, 2.0))
    s.environment.RH_outdoor_pct = float(np.clip(s.environment.RH_outdoor_pct + rng.uniform(-10, 10), 5, 95))

    # Wall U-values ±15 %
    if s.materials and s.materials.wall_u_values:
        for w in list(s.materials.wall_u_values.keys()):
            v = s.materials.wall_u_values[w]
            s.materials.wall_u_values[w] = float(np.clip(v * rng.uniform(0.85, 1.15), 0.05, 10))

    # Occupancy ±20 % — randomly toggle some humans on/off
    humans = [o for o in s.obstacles if o.shape == "human"]
    if humans:
        target = max(1, int(round(len(humans) * float(rng.uniform(0.8, 1.2)))))
        if target < len(humans):
            for o in humans[target:]: o.on = False
        # If target > len(humans), the scene as-imported is the cap.

    # AC perturbations
    for a in s.ac_units:
        if a.supply_temp_C is not None:
            a.supply_temp_C = float(np.clip(a.supply_temp_C + rng.uniform(-1.0, 1.0), 8, 22))
        if a.flow_rate_cfm is not None:
            a.flow_rate_cfm = float(np.clip(a.flow_rate_cfm * rng.uniform(0.9, 1.1), 50, 5000))

    return s
