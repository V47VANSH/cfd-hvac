/**
 * JSON Scene Model — Single Source of Truth
 * Versioned, with migrations on load. The schema is the contract every
 * module reads from and writes to.
 */

export const CURRENT_SCHEMA_VERSION = 1 as const;

// ── Sub-schemas ──────────────────────────────────────────────────────────

export type Wall = "S" | "N" | "E" | "W";
export type OpeningType = "win" | "door" | "circ" | "arch";
export type ObstacleShape =
  | "box" | "cyl" | "shelf" | "human" | "appliance" | "cfan" | "tfan";

export interface Geometry {
  L: number;             // room length (X), m
  W: number;             // room width  (Z), m
  H: number;             // room height (Y), m
  extensions: ExtensionBlock[];
  stl: STLObject[];
}

export interface ExtensionBlock {
  id: number;
  x: number; z: number;
  W: number; D: number; H: number;
  ry_deg?: number;
  rx_deg?: number;
  rz_deg?: number;
}

export interface STLObject {
  id: number;
  name: string;
  x: number; y: number; z: number;
  scale: number;
  ry_deg?: number;
  rx_deg?: number;
  rz_deg?: number;
  triCount: number;
  /** raw model-space vertices (Float32Array stored separately, not in JSON) */
  positions?: Float32Array;
  /**
   * "room"     — this STL is the actual room boundary; the cuboidal default
   *              walls are hidden and the simulation domain becomes the STL.
   * "obstacle" — this STL is an interior object (default). Multiple "obstacle"
   *              STLs are allowed; only one "room" STL makes sense per scene.
   */
  role?: "room" | "obstacle";
  /**
   * Bounding box of the *raw* (un-transformed) STL vertices. Cached at
   * import time so the room-fit logic doesn't re-scan the position array.
   * In model space (i.e. before scale / rotation / translation).
   */
  bbox?: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
}

export interface Opening {
  id: number;
  wall: Wall;
  type: OpeningType;
  u: number;             // position along wall, m
  v: number;             // height, m
  uw: number;            // width, m
  vh: number;            // height, m
  open: boolean;
  /** Per-opening physical properties (Phase 1 extensions). Defaults match v6 globals. */
  u_value?: number;            // W/m²K       (glass conduction)
  solar_transmittance?: number;// SHGC, 0..1
  air_permeability?: number;   // m³/h·m² @ 50 Pa
}

export interface Obstacle {
  id: number;
  shape: ObstacleShape;
  x: number; z: number;
  W: number; D: number; H: number;
  Yoff: number;
  on: boolean;
  watts?: number;        // human, appliance
  rpm?: number;          // cfan, tfan
  season?: "summer" | "winter"; // cfan
  dir?: number;          // tfan, deg
}

export interface Environment {
  outdoor_temp_C: number;
  setpoint_C: number;
  RH_outdoor_pct: number;
  met: number;           // metabolic rate
  clo: number;           // clothing
  tariff_per_kwh: number;
  co2_per_kwh_kg: number;
  /** Per-city annual cooling-degree-hours (overrides the default in the energy module). */
  cooling_degree_hours?: number;
  /** Coefficient of performance of the AC, cooling out / electrical in. */
  cop?: number;
  /** Climate preset key (UI hint, doesn't affect calculations). */
  climate_preset?: string;
}

/**
 * Material library — per-wall and per-roof U-values, picked from a
 * preset by the user or specified per-wall manually. Optional; if absent,
 * the ASHRAE module falls back to its global defaults
 * (wall 2.8 W/m²K, glass 5.8, roof 2.0).
 */
export interface MaterialLibrary {
  /** Active preset name (UI hint). */
  preset?: string;
  /** Per-wall U-values, W/m²K. Missing entries fall back to default. */
  wall_u_values?: Partial<Record<Wall, number>>;
  /** Roof / ceiling U-value, W/m²K. */
  roof_u_value?: number;
  /** Floor U-value (slab on ground typically much lower). */
  floor_u_value?: number;
}

export interface Constraints {
  forbidden_zones: ForbiddenZone[];
  restricted_surfaces: RestrictedSurface[];
  wall_rules: Record<Wall, "allow" | "deny">;
  min_clearance_m: number;
  allowed_walls: Wall[];
}

export interface ForbiddenZone {
  shape: "polygon" | "box";
  vertices?: [number, number][];
  x?: number; z?: number; W?: number; D?: number; H?: number;
  reason: string;
}

export interface RestrictedSurface {
  wall: Wall;
  u: number; v: number; uw: number; vh: number;
  reason: string;
}

export interface ACUnit {
  id: number;
  wall: Wall;
  x: number; z: number;
  /**
   * Mounting height of the AC unit centre, metres above floor. Default
   * 1.8 m for a typical split AC mounted high on the wall, but for STL
   * rooms with non-standard heights or for cassette / window units the
   * user adjusts this in the AC config panel. Used by:
   *   • the 3D mesh builder to position the AC body
   *   • the CFD source injector (jet centre line is at this Y)
   *   • the optimizer (jet placement uses this Y)
   */
  mounting_height_m?: number;
  kw: number;
  capacity_tr?: number;
  type?: "split" | "window" | "cassette";
  throw_distance_m?: number;
  airflow_angle_deg?: number;
  flow_rate_cfm?: number;
  /**
   * Supply-air temperature, °C. The temperature of the air the AC blows
   * into the room. Default 14 °C — a typical split-AC supply at full
   * cooling. Lower = colder supply = stronger cooling. Distinct from
   * `environment.setpoint_C`, which is the comfort target used by the
   * heat-load calc and the optimizer's score.
   */
  supply_temp_C?: number;
  /** Vertical (pitch) angle of the louvres, degrees. Negative = downward.
   *  Default −10 (typical split-AC angle aimed slightly toward the floor).
   *  Used as the centre angle of vertical swing when `swing_vertical` is on. */
  vertical_angle_deg?: number;
  /** Horizontal swing (yaw oscillation) on/off. */
  swing_horizontal?: boolean;
  /** Vertical swing (pitch oscillation) on/off. */
  swing_vertical?: boolean;
  /** Swing period in seconds (one full back-and-forth). Typical AC ≈ 6 s. */
  swing_period_s?: number;
  /** Horizontal swing amplitude in degrees (peak yaw deviation). Default ±30°. */
  swing_h_amp_deg?: number;
  /** Vertical swing amplitude in degrees (peak pitch deviation). Default ±20°. */
  swing_v_amp_deg?: number;
  on: boolean;
}

// ── Top-level scene ──────────────────────────────────────────────────────

export interface Scene {
  schema_version: number;
  geometry: Geometry;
  openings: Opening[];
  obstacles: Obstacle[];
  environment: Environment;
  constraints: Constraints;
  ac_units: ACUnit[];
  /** Optional material library — per-wall U-values, picked via the Material panel. */
  materials?: MaterialLibrary;
  /** sha256 of the canonicalized scene; filled by exporter */
  results_cache_key?: string;
}

// ── Defaults ─────────────────────────────────────────────────────────────

export function defaultScene(): Scene {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    geometry: { L: 4.0, W: 3.0, H: 2.7, extensions: [], stl: [] },
    openings: [
      { id: 1, wall: "S", type: "win", u: 2.0, v: 1.2, uw: 1.2, vh: 1.1, open: true,
        u_value: 5.8, solar_transmittance: 0.65, air_permeability: 0.0 },
      { id: 2, wall: "E", type: "door", u: 1.5, v: 1.05, uw: 0.9, vh: 2.1, open: true,
        u_value: 2.0, solar_transmittance: 0.0, air_permeability: 1.0 },
    ],
    obstacles: [],
    environment: {
      outdoor_temp_C: 35,
      setpoint_C: 24,
      RH_outdoor_pct: 60,
      met: 1.1,
      clo: 0.5,
      tariff_per_kwh: 8.0,
      co2_per_kwh_kg: 0.7,
    },
    constraints: {
      forbidden_zones: [],
      restricted_surfaces: [],
      wall_rules: { S: "allow", N: "allow", E: "allow", W: "allow" },
      min_clearance_m: 0.5,
      allowed_walls: ["S", "N", "E", "W"],
    },
    ac_units: [],
  };
}

// ── Migrations ───────────────────────────────────────────────────────────
//
// A migration takes a scene at version N and returns a scene at version N+1.
// The loader runs migrations in order until reaching CURRENT_SCHEMA_VERSION.

type Migration = (scene: any) => any;

const migrations: Record<number, Migration> = {
  // 0 → 1: add the schema_version field if missing; treat any v6-export-format
  // scene as version 0 and bring it forward. (No structural changes yet.)
  0: (s) => ({ ...s, schema_version: 1 }),
};

export function migrateScene(raw: any): Scene {
  let s = raw;
  let v = typeof s?.schema_version === "number" ? s.schema_version : 0;
  while (v < CURRENT_SCHEMA_VERSION) {
    const migrate = migrations[v];
    if (!migrate) {
      throw new Error(
        `No migration from schema_version ${v} to ${v + 1}; ` +
        `scene cannot be loaded by this build.`,
      );
    }
    s = migrate(s);
    v += 1;
  }
  return s as Scene;
}

// ── Validation (lightweight; fail loudly on missing fields) ──────────────

export function validateScene(s: Scene): string[] {
  const errs: string[] = [];
  if (s.schema_version !== CURRENT_SCHEMA_VERSION) {
    errs.push(`schema_version mismatch (got ${s.schema_version}, expected ${CURRENT_SCHEMA_VERSION})`);
  }
  if (!s.geometry || s.geometry.L <= 0 || s.geometry.W <= 0 || s.geometry.H <= 0) {
    errs.push("geometry: L/W/H must be positive");
  }
  if (!Array.isArray(s.openings)) errs.push("openings must be an array");
  if (!Array.isArray(s.obstacles)) errs.push("obstacles must be an array");
  if (!s.environment) errs.push("environment missing");
  if (!s.constraints) errs.push("constraints missing");
  return errs;
}

// ── Canonical hash (for results_cache_key + export provenance) ───────────

export async function sceneHash(s: Scene): Promise<string> {
  const canonical = JSON.stringify(s, Object.keys(s).sort());
  const buf = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
