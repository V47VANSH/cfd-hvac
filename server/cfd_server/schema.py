"""Pydantic mirror of the Tier-1 JSON scene schema.

Matches ``web/src/lib/io/schema.ts`` field-for-field. The Tier-1 frontend
posts a Scene JSON, the backend validates against this model, then the
case generator (``cases.py``) produces the OpenFOAM input deck.

Backwards-compat: optional fields stay optional so older Tier-1 exports
still round-trip. Migrations live in the TypeScript codebase; the backend
trusts that the incoming JSON has already been migrated.
"""

from __future__ import annotations
from typing import Literal, Optional
from pydantic import BaseModel, Field

Wall = Literal["S", "N", "E", "W"]
OpeningType = Literal["win", "door", "circ", "arch"]
ObstacleShape = Literal["box", "cyl", "shelf", "human", "appliance", "cfan", "tfan"]


class ExtensionBlock(BaseModel):
    id: int
    x: float; z: float
    W: float; D: float; H: float
    ry_deg: float = 0.0
    rx_deg: float = 0.0
    rz_deg: float = 0.0


class STLObject(BaseModel):
    id: int
    name: str
    x: float; y: float; z: float
    scale: float = 1.0
    ry_deg: float = 0.0
    rx_deg: float = 0.0
    rz_deg: float = 0.0
    triCount: int = 0
    # Optional raw vertex stream sent by the Tier-1 frontend so OpenFOAM
    # can write a real triSurface/room.stl. If absent, the case generator
    # falls back to AABB stamping (cuboidal approximation of the STL).
    positions: Optional[list[float]] = None
    # Tier-1 mode discrimination:
    #   "room"     — this STL is the actual room boundary; snappyHexMesh
    #                carves it out of the background blockMesh.
    #   "obstacle" — interior object (default).
    role: Optional[Literal["room", "obstacle"]] = None
    # Cached bbox of raw model-space vertices (set by Tier-1 import for
    # quick lookup without rescanning positions).
    bbox: Optional[dict] = None


class Geometry(BaseModel):
    L: float; W: float; H: float
    extensions: list[ExtensionBlock] = Field(default_factory=list)
    stl: list[STLObject] = Field(default_factory=list)


class Opening(BaseModel):
    id: int
    wall: Wall
    type: OpeningType
    u: float; v: float; uw: float; vh: float
    open: bool = True
    u_value: Optional[float] = None
    solar_transmittance: Optional[float] = None
    air_permeability: Optional[float] = None


class Obstacle(BaseModel):
    id: int
    shape: ObstacleShape
    x: float; z: float
    W: float; D: float; H: float
    Yoff: float = 0.0
    on: bool = True
    watts: Optional[float] = None
    rpm: Optional[float] = None
    season: Optional[Literal["summer", "winter"]] = None
    dir: Optional[float] = None


class Environment(BaseModel):
    outdoor_temp_C: float
    setpoint_C: float
    RH_outdoor_pct: float
    met: float = 1.1
    clo: float = 0.5
    tariff_per_kwh: float = 8.0
    co2_per_kwh_kg: float = 0.7
    cooling_degree_hours: Optional[float] = None
    cop: Optional[float] = None
    climate_preset: Optional[str] = None


class ForbiddenZone(BaseModel):
    shape: Literal["polygon", "box"]
    vertices: Optional[list[tuple[float, float]]] = None
    x: Optional[float] = None
    z: Optional[float] = None
    W: Optional[float] = None
    D: Optional[float] = None
    H: Optional[float] = None
    reason: str = ""


class RestrictedSurface(BaseModel):
    wall: Wall
    u: float; v: float; uw: float; vh: float
    reason: str = ""


class Constraints(BaseModel):
    forbidden_zones: list[ForbiddenZone] = Field(default_factory=list)
    restricted_surfaces: list[RestrictedSurface] = Field(default_factory=list)
    wall_rules: dict[str, Literal["allow", "deny"]] = Field(
        default_factory=lambda: {"S": "allow", "N": "allow", "E": "allow", "W": "allow"}
    )
    min_clearance_m: float = 0.5
    allowed_walls: list[Wall] = Field(default_factory=lambda: ["S", "N", "E", "W"])


class ACUnit(BaseModel):
    id: int
    wall: Wall
    x: float; z: float
    # Mounting height above floor, metres. None = case generator picks
    # 88% of room height (legacy default).
    mounting_height_m: Optional[float] = None
    kw: float
    capacity_tr: Optional[float] = None
    type: Optional[Literal["split", "window", "cassette"]] = "split"
    throw_distance_m: Optional[float] = None
    airflow_angle_deg: Optional[float] = None
    flow_rate_cfm: Optional[float] = None
    supply_temp_C: Optional[float] = None
    vertical_angle_deg: Optional[float] = None
    swing_horizontal: Optional[bool] = None
    swing_vertical: Optional[bool] = None
    swing_period_s: Optional[float] = None
    swing_h_amp_deg: Optional[float] = None
    swing_v_amp_deg: Optional[float] = None
    on: bool = True


class MaterialLibrary(BaseModel):
    preset: Optional[str] = None
    wall_u_values: Optional[dict[str, float]] = None
    roof_u_value: Optional[float] = None
    floor_u_value: Optional[float] = None


class Scene(BaseModel):
    schema_version: int
    geometry: Geometry
    openings: list[Opening] = Field(default_factory=list)
    obstacles: list[Obstacle] = Field(default_factory=list)
    environment: Environment
    constraints: Constraints = Field(default_factory=Constraints)
    ac_units: list[ACUnit] = Field(default_factory=list)
    materials: Optional[MaterialLibrary] = None
    results_cache_key: Optional[str] = None
