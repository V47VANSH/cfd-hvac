/**
 * Sources for the MAC solver.
 *
 * Cell-centred sources (heat, RH emission, CO₂ emission) write into the
 * cell-centred Q* arrays. Momentum sources (AC jets, fans) write into the
 * face-centred forcing fields `fu`, `fv`, `fw`, which the solver re-applies
 * each substep so jets do not decay.
 */

import {
  NX, NY, NZ, NU, NV, NW, CK, type MACFields, type RoomDims, cellSize,
} from "./mac-grid";
import type { Obstacle, Opening } from "@/lib/io/schema";

const AC_SUPPLY_T_DEFAULT = 14;  // °C — used when an AC unit doesn't carry its own supply_temp_C
const HUMAN_W      = 75;         // sensible W per person (ASHRAE)
const HUMAN_RH_KG  = 50e-3 / 3600; // 50 g/h moisture per person → kg/s
const HUMAN_CO2_PPM_S = 0.20;    // ~0.005 L/s CO₂ at 1 met → ppm/s in a small room
const APPLIANCE_W  = 200;

// ── Cell-centred sensible heat ─────────────────────────────────────────
export function injectHeatSourcesMAC(
  f: MACFields, room: RoomDims, obstacles: Obstacle[],
): void {
  const { L, W } = room;
  const { dx, dy, dz } = cellSize(room);
  const cellVol = dx * dy * dz;
  for (const ob of obstacles) {
    if ((ob.shape !== "human" && ob.shape !== "appliance") || ob.on === false) continue;
    const watts = ob.shape === "human" ? HUMAN_W : (ob.watts || APPLIANCE_W);
    const Q = watts / (1200 * cellVol);   // ρ·cp ≈ 1200 J/m³K → °C/s per cell
    const cx = Math.round((ob.x + L / 2) / dx);
    const cz = Math.round((ob.z + W / 2) / dz);
    const cy = Math.round((ob.H / 2 + (ob.Yoff || 0)) / dy);
    for (let diz = -3; diz <= 3; diz++)
      for (let diy = 0; diy <= 4; diy++)
        for (let dix = -3; dix <= 3; dix++) {
          const ii = clamp(cx + dix, 0, NX - 1);
          const ij = clamp(cy + diy, 0, NY - 1);
          const ik = clamp(cz + diz, 0, NZ - 1);
          if (f.wall[CK(ii, ij, ik)]) continue;
          const dsq = dix * dix + diy * diy + diz * diz;
          f.Qs[CK(ii, ij, ik)] += Q * Math.exp(-dsq * 0.4);
        }
  }
}

// ── Cell-centred moisture + CO₂ emission (humans only) ─────────────────
export function injectScalarSourcesMAC(
  f: MACFields, room: RoomDims, obstacles: Obstacle[],
): void {
  const { L, W } = room;
  const { dx, dy, dz } = cellSize(room);
  const cellVol = dx * dy * dz;
  // Convert kg-water/s into Δ(RH-fraction)/s for a cell of volume cellVol.
  // Saturation humidity at 25 °C ≈ 0.020 kg-water/kg-air; ρ_air ≈ 1.2 kg/m³.
  // ΔRH/s = (kg_water / s) / (cellVol · 1.2 · 0.020).
  const RH_PER_KG = 1 / (cellVol * 1.2 * 0.020);
  for (const ob of obstacles) {
    if (ob.shape !== "human" || ob.on === false) continue;
    const cx = Math.round((ob.x + L / 2) / dx);
    const cz = Math.round((ob.z + W / 2) / dz);
    const cy = Math.round((ob.H / 2 + (ob.Yoff || 0)) / dy);
    const dRH  = HUMAN_RH_KG * RH_PER_KG;
    const dCO2 = HUMAN_CO2_PPM_S;
    for (let diy = -1; diy <= 4; diy++)
      for (let diz = -1; diz <= 1; diz++)
        for (let dix = -1; dix <= 1; dix++) {
          const ii = clamp(cx + dix, 0, NX - 1);
          const ij = clamp(cy + diy, 0, NY - 1);
          const ik = clamp(cz + diz, 0, NZ - 1);
          if (f.wall[CK(ii, ij, ik)]) continue;
          const dsq = dix * dix + diy * diy + diz * diz;
          const g = Math.exp(-dsq * 0.5);
          f.Qrh [CK(ii, ij, ik)] += dRH  * g;
          f.Qco2[CK(ii, ij, ik)] += dCO2 * g;
        }
  }
}

// ── AC jet — real inlet boundary condition + short body-force assist ──
//
// Phase 2.5 model. Two pieces:
//
//   (1) Inlet patch — a small set of faces immediately in front of the AC
//       diffuser is set to a target velocity each substep. This is a
//       genuine Dirichlet BC, not a body force, so the multigrid pressure
//       projection sees it correctly: air leaves these faces, room air
//       must be pulled toward them by pressure to balance, and the jet
//       *entrains* surrounding fluid the way a real diffuser does.
//
//   (2) Short downstream body force — a much smaller and tighter Gaussian
//       (~1 m extent only) applied as a nudge to keep the jet coherent
//       in the first metre of throw, where the inlet patch can't reach.
//
// The geometry:
//   - "Inlet face patch" is a small rectangle on the AC's mounting wall,
//     centred on (ac.x, H·0.88, ac.z), sized in proportion to kW.
//   - Wall-normal direction is the dominant component; a downward tilt
//     (`jy`) plus the user's yaw angle handles off-axis aim.
//
// A 1.5 kW unit covers a 3 × 2 cell patch (~30 × 40 cm) on the wall;
// 12 kW covers ~6 × 4 cells (~70 × 80 cm). Matches real diffuser sizes.

export interface ACJetSpec {
  x: number; z: number;
  wall: "S" | "N" | "E" | "W";
  /** Rated cooling power, kW — drives patch size & target velocity */
  kw?: number;
  /** Throw distance (m) — controls how far the body-force assist reaches. */
  throwDistance?: number;
  /** Off-axis horizontal deflection in degrees (left/right of wall normal).
   *  When swing is on, the worker substitutes the instantaneous swept angle. */
  airflowAngleDeg?: number;
  /** Vertical pitch in degrees. Negative = downward. Default −5°. When
   *  vertical swing is on, the worker substitutes the swept pitch. */
  verticalAngleDeg?: number;
  /** Volumetric flow rate (m³/s). If absent, derived from kW. */
  flowRateM3s?: number;
  /** Mounting height above floor, metres. Default = 88% of room height
   *  (typical split AC). Overrides the legacy 0.88·H placement so the
   *  user can mount lower (cassette / window units / non-standard
   *  ceilings). The jet patch & body-force assist both centre on this Y. */
  mountingHeightM?: number;
}

export function injectACJetsMAC(
  f: MACFields, room: RoomDims, units: ACJetSpec[],
): void {
  const { L, W, H } = room;
  const { dx, dy, dz } = cellSize(room);
  for (const ac of units) {
    const kW = Math.max(0.5, ac.kw ?? 1.5);
    const sizeScale = Math.cbrt(kW / 1.5);
    // Inlet patch half-extents (in cells)
    const halfPatchH = Math.max(1, Math.round(2 * sizeScale));   // along the wall
    const halfPatchV = Math.max(1, Math.round(1.5 * sizeScale)); // vertical

    // Volumetric flow: derived from kW if not given (typical 175 CFM/kW for split AC)
    const flowM3s = ac.flowRateM3s ?? (kW * 175 * 0.000472);
    // Inlet patch area in m² on the wall
    let patchArea: number;
    if (ac.wall === "S" || ac.wall === "N") patchArea = (2 * halfPatchH * dx) * (2 * halfPatchV * dy);
    else                                    patchArea = (2 * halfPatchH * dz) * (2 * halfPatchV * dy);
    const targetSpeed = Math.min(8, Math.max(2, flowM3s / Math.max(0.02, patchArea)));

    // ── Piece (1): Inlet patch — a real Dirichlet BC on faces ──
    //
    // For a wall AC, the patch sits one cell inside the wall (so it's on
    // the "fluid side" — wall faces themselves are no-penetration). The
    // velocity at those interior faces is held at `target * J` each
    // substep by the worker tick (see below).
    const mountY = ac.mountingHeightM ?? H * 0.88;
    const jet = resolveFluidJet(f, room, ac.x, mountY, ac.z, ac.wall, ac.airflowAngleDeg, ac.verticalAngleDeg);
    if (!jet) continue;
    const { seed, Jx, Jy, Jz } = jet;
    const cIY = seed.iy;

    const ihCenter = ac.wall === "S" || ac.wall === "N" ? seed.ix : seed.iz;
    const ihMin = Math.max(1, ihCenter - halfPatchH);
    const ihMax = Math.min((ac.wall === "S" || ac.wall === "N" ? NX - 2 : NZ - 2),
                           ihCenter + halfPatchH);
    const ivMin = Math.max(1, cIY - halfPatchV);
    const ivMax = Math.min(NY - 2, cIY + halfPatchV);

    for (let iv = ivMin; iv <= ivMax; iv++) {
      for (let ih = ihMin; ih <= ihMax; ih++) {
        // For each cell on the inlet patch, write target face velocities
        // in the appropriate component arrays of `fu / fv / fw`.
        //
        // Important for STL rooms: the mounted wall may be an arbitrary
        // interior STL perimeter, not the bbox's S/N/E/W face. Use the
        // actual AC centre and walk just inside the room before stamping
        // the diffuser patch. The `wall` label only chooses which tangent
        // axis the diffuser spans.
        const ix = (ac.wall === "S" || ac.wall === "N") ? ih : seed.ix;
        const iz = (ac.wall === "S" || ac.wall === "N") ? seed.iz : ih;
        const iy = iv;
        if (f.wall[CK(ix, iy, iz)]) continue;
        // u-face index (we set the u-face to the right of the patch cell)
        const ku1 = ix       + (NX + 1) * iy + (NX + 1) * NY * iz;
        const ku2 = (ix + 1) + (NX + 1) * iy + (NX + 1) * NY * iz;
        const kv1 = ix + NX *  iy      + NX * (NY + 1) * iz;
        const kv2 = ix + NX * (iy + 1) + NX * (NY + 1) * iz;
        const kw1 = ix + NX * iy + NX * NY *  iz;
        const kw2 = ix + NX * iy + NX * NY * (iz + 1);
        // Write half the target velocity to each of the two faces in the
        // dominant direction of the jet.  This produces a smooth velocity
        // field at the patch instead of a single-face spike.
        const Vt = targetSpeed;
        if (!f.uwall[ku1]) f.fu[ku1] = Jx * Vt;
        if (!f.uwall[ku2]) f.fu[ku2] = Jx * Vt;
        if (!f.vwall[kv1]) f.fv[kv1] = Jy * Vt;
        if (!f.vwall[kv2]) f.fv[kv2] = Jy * Vt;
        if (!f.wwall[kw1]) f.fw[kw1] = Jz * Vt;
        if (!f.wwall[kw2]) f.fw[kw2] = Jz * Vt;
      }
    }

    // ── Piece (2): Short body-force assist over ~throwM/3 metres ──
    //
    // A tightly-decaying Gaussian centred a metre downstream of the
    // inlet, kept *small* so the jet is mostly driven by piece (1) and
    // entrainment. This anchors the jet centreline so it doesn't swerve
    // off-target before the mixing zone develops.
    const throwM = ac.throwDistance ?? 4;
    const decay = 0.75 / Math.max(0.8, throwM);
    const ax = (seed.ix + 0.5) * dx - L / 2;
    const ay = (seed.iy + 0.5) * dy;
    const az = (seed.iz + 0.5) * dz - W / 2;
    const assistMag = 0.9 * targetSpeed;

    for (let iz = 0; iz < NZ; iz++)
      for (let iy = 0; iy < NY; iy++)
        for (let ix = 0; ix <= NX; ix++) {
          const x = ix * dx - L / 2;
          const y = (iy + 0.5) * dy;
          const z = (iz + 0.5) * dz - W / 2;
          const g = jetGaussian(x - ax, y - ay, z - az, Jx, Jy, Jz, decay, throwM);
          if (g < 1e-3) continue;
          const ku = ix + (NX + 1) * iy + (NX + 1) * NY * iz;
          if (!f.uwall[ku]) f.fu[ku] += Jx * assistMag * g;
        }
    for (let iz = 0; iz < NZ; iz++)
      for (let iy = 0; iy <= NY; iy++)
        for (let ix = 0; ix < NX; ix++) {
          const x = (ix + 0.5) * dx - L / 2;
          const y = iy * dy;
          const z = (iz + 0.5) * dz - W / 2;
          const g = jetGaussian(x - ax, y - ay, z - az, Jx, Jy, Jz, decay, throwM);
          if (g < 1e-3) continue;
          const kv = ix + NX * iy + NX * (NY + 1) * iz;
          if (!f.vwall[kv]) f.fv[kv] += Jy * assistMag * g;
        }
    for (let iz = 0; iz <= NZ; iz++)
      for (let iy = 0; iy < NY; iy++)
        for (let ix = 0; ix < NX; ix++) {
          const x = (ix + 0.5) * dx - L / 2;
          const y = (iy + 0.5) * dy;
          const z = iz * dz - W / 2;
          const g = jetGaussian(x - ax, y - ay, z - az, Jx, Jy, Jz, decay, throwM);
          if (g < 1e-3) continue;
          const kw = ix + NX * iy + NX * NY * iz;
          if (!f.wwall[kw]) f.fw[kw] += Jz * assistMag * g;
        }
  }
}

// Tight downstream Gaussian — used only by piece (2), so the lateral
// spread is intentionally narrow and the along-jet decay is fast.
function jetGaussian(
  rx: number, ry: number, rz: number,
  jx: number, jy: number, jz: number,
  decay: number,
  throwM: number,
): number {
  const d = Math.sqrt(rx * rx + ry * ry + rz * rz) + 1e-3;
  const dot = (rx * jx + ry * jy + rz * jz) / d;
  if (dot < 0) return 0;
  const along = dot * d;
  if (along > throwM * 1.2) return 0;
  const lx = rx - along * jx;
  const ly = ry - along * jy;
  const lz = rz - along * jz;
  const lat = Math.sqrt(lx * lx + ly * ly + lz * lz);
  const spLat = 0.12 + 0.20 * along;
  const throwFade = Math.max(0, 1 - along / (throwM * 1.2));
  return Math.exp(-0.5 * (lat / spLat) ** 2)
    * Math.exp(-decay * along)
    * (0.35 + 0.65 * throwFade);
}

function jetDirection(
  wall: "S" | "N" | "E" | "W",
  yawDeg = 0,
  pitchDeg = -5,
): { Jx: number; Jy: number; Jz: number } {
  let nx = 0, nz = 0;
  if      (wall === "S") nz =  1;
  else if (wall === "N") nz = -1;
  else if (wall === "W") nx =  1;
  else                   nx = -1;

  const yawR = (yawDeg * Math.PI) / 180;
  const cy = Math.cos(yawR), sy = Math.sin(yawR);
  const horizX = nx * cy - nz * sy;
  const horizZ = nx * sy + nz * cy;

  const pitchR = (pitchDeg * Math.PI) / 180;
  const cp = Math.cos(pitchR), sp = Math.sin(pitchR);
  const jx = horizX * cp;
  const jy = sp;       // negative pitch => downward
  const jz = horizZ * cp;
  const mag = Math.hypot(jx, jy, jz) || 1;
  return { Jx: jx / mag, Jy: jy / mag, Jz: jz / mag };
}

interface JetSeed {
  ix: number;
  iy: number;
  iz: number;
  found: boolean;
}

function resolveFluidJet(
  f: MACFields,
  room: RoomDims,
  acX: number,
  mountY: number,
  acZ: number,
  wall: "S" | "N" | "E" | "W",
  yawDeg?: number,
  pitchDeg?: number,
): { seed: JetSeed; Jx: number; Jy: number; Jz: number } | null {
  const nominal = jetDirection(wall, yawDeg, pitchDeg);
  const candidates = [
    { ...nominal, bias: 0.35 },
    { Jx: -nominal.Jx, Jy: nominal.Jy, Jz: -nominal.Jz, bias: 0 },
  ];
  let best: { seed: JetSeed; Jx: number; Jy: number; Jz: number; score: number } | null = null;
  for (const c of candidates) {
    const seed = findFluidJetSeed(f, room, acX, mountY, acZ, c.Jx, c.Jz);
    if (!seed.found) continue;
    const score = c.bias + scoreFluidCorridor(f, room, seed, c.Jx, c.Jy, c.Jz);
    if (!best || score > best.score) best = { seed, Jx: c.Jx, Jy: c.Jy, Jz: c.Jz, score };
  }
  return best;
}

function scoreFluidCorridor(
  f: MACFields,
  room: RoomDims,
  seed: JetSeed,
  jx: number,
  jy: number,
  jz: number,
): number {
  const { L, W, H } = room;
  const { dx, dy, dz } = cellSize(room);
  const x0 = (seed.ix + 0.5) * dx - L / 2;
  const y0 = (seed.iy + 0.5) * dy;
  const z0 = (seed.iz + 0.5) * dz - W / 2;
  const ds = Math.max(0.08, Math.min(dx, dy, dz) * 0.6);
  let score = 0;
  for (let m = 0; m < 22; m++) {
    const x = x0 + jx * ds * m;
    const y = y0 + jy * ds * m;
    const z = z0 + jz * ds * m;
    if (x < -L / 2 || x > L / 2 || y < 0 || y > H || z < -W / 2 || z > W / 2) {
      score -= m < 5 ? 4 : 1;
      continue;
    }
    const ix = clamp(Math.floor((x + L / 2) / dx), 0, NX - 1);
    const iy = clamp(Math.floor(y / dy), 0, NY - 1);
    const iz = clamp(Math.floor((z + W / 2) / dz), 0, NZ - 1);
    if (f.wall[CK(ix, iy, iz)]) score -= m < 5 ? 4 : 1;
    else score += m < 5 ? 2.5 : 1;
  }
  return score;
}

function findFluidJetSeed(
  f: MACFields,
  room: RoomDims,
  acX: number,
  mountY: number,
  acZ: number,
  jx: number,
  jz: number,
): JetSeed {
  const { L, W } = room;
  const { dx, dy, dz } = cellSize(room);
  const iy0 = clamp(Math.round(mountY / dy), 1, NY - 2);
  const step = Math.max(0.05, Math.min(dx, dz) * 0.55);
  let bestIX = clamp(Math.round((acX + L / 2) / dx), 1, NX - 2);
  let bestIZ = clamp(Math.round((acZ + W / 2) / dz), 1, NZ - 2);
  let bestIY = iy0;
  const yOffsets = [0, -1, 1, -2, 2, -3, 3];
  for (let m = 0; m < 18; m++) {
    const x = acX + jx * step * m;
    const z = acZ + jz * step * m;
    const ix = clamp(Math.round((x + L / 2) / dx), 1, NX - 2);
    const iz = clamp(Math.round((z + W / 2) / dz), 1, NZ - 2);
    bestIX = ix; bestIZ = iz;
    for (const oy of yOffsets) {
      const iy = clamp(iy0 + oy, 1, NY - 2);
      bestIY = iy;
      if (!f.wall[CK(ix, iy, iz)]) return { ix, iy, iz, found: true };
    }
  }
  const fallback = findNearestFluidSeed(f, room, acX, mountY, acZ);
  return fallback ?? { ix: bestIX, iy: bestIY, iz: bestIZ, found: false };
}

function findNearestFluidSeed(
  f: MACFields,
  room: RoomDims,
  acX: number,
  mountY: number,
  acZ: number,
): JetSeed | null {
  const { L, W } = room;
  const { dx, dy, dz } = cellSize(room);
  const ix0 = clamp(Math.round((acX + L / 2) / dx), 1, NX - 2);
  const iy0 = clamp(Math.round(mountY / dy), 1, NY - 2);
  const iz0 = clamp(Math.round((acZ + W / 2) / dz), 1, NZ - 2);
  let best: JetSeed | null = null;
  let bestD2 = Infinity;
  for (let r = 1; r <= 6; r++) {
    for (let diz = -r; diz <= r; diz++)
      for (let diy = -Math.min(3, r); diy <= Math.min(3, r); diy++)
        for (let dix = -r; dix <= r; dix++) {
          if (Math.max(Math.abs(dix), Math.abs(diy), Math.abs(diz)) !== r) continue;
          const ix = clamp(ix0 + dix, 1, NX - 2);
          const iy = clamp(iy0 + diy, 1, NY - 2);
          const iz = clamp(iz0 + diz, 1, NZ - 2);
          if (f.wall[CK(ix, iy, iz)]) continue;
          const d2 = dix * dix + diy * diy + diz * diz;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = { ix, iy, iz, found: true };
          }
        }
    if (best) return best;
  }
  return null;
}

// ── AC cooling: physically-budgeted heat extraction ───────────────────
//
// Each AC unit removes thermal energy from a "cold patch" near its
// diffuser at a rate **capped by its rated kW**. The supply_temp_C is the
// absolute floor — cells in the patch never drop below it.
//
// Patch sizing:
//   - half-extent scales as kW^(1/3) so the cold-air *volume* scales
//     linearly with kW (matches real split-AC diffuser footprints).
//   - default 1.5 kW unit covers a 7 × 4 × 4 cell box, like before.
//   - 12 kW unit covers about 14 × 8 × 8 — substantially more reach.
//
// Energy budget:
//   Q_step  = kW · dt                        (joules this substep)
//   Q_avail = Σ ρ · cp · cellVol · max(0, T_cell − T_supply)
//   scale   = min(1, Q_step / Q_avail)
//   T_cell ← T_cell − scale · (T_cell − T_supply)
//
// When the patch is already cool, scale<1 and we under-use the budget —
// the AC isn't extracting more than it's modelling. When the patch is
// hot, scale=1 and we extract the full kW × dt for that substep, then
// the result depends on how fast advection refreshes the patch.
const RHO_AIR = 1.2;     // kg/m³
const CP_AIR  = 1005;    // J/(kg·K)

export interface ACUnitForCooling {
  x: number; z: number;
  wall?: "S" | "N" | "E" | "W";
  /** rated cooling power, kW */
  kw?: number;
  supply_temp_C?: number;
  /** Mounting height above floor, metres. Default = 88% of room height. */
  mounting_height_m?: number;
  throw_distance_m?: number;
  airflow_angle_deg?: number;
  vertical_angle_deg?: number;
}

export function applyACCooling(
  f: MACFields, room: RoomDims,
  units: ACUnitForCooling[],
  dt: number,
): void {
  const { L, W, H } = room;
  const { dx, dy, dz } = cellSize(room);
  const cellVol = dx * dy * dz;
  const cellHeatCap = RHO_AIR * cellVol * CP_AIR;     // J / K per cell
  for (const ac of units) {
    const Tsupply = ac.supply_temp_C ?? AC_SUPPLY_T_DEFAULT;
    const kW = Math.max(0.3, ac.kw ?? 1.5);
    if (ac.wall) {
      applyDirectionalACCooling(f, room, { ...ac, wall: ac.wall }, dt, Tsupply, kW, cellHeatCap);
      continue;
    }

    // kW^(1/3) → patch volume ∝ kW
    const sizeScale = Math.cbrt(kW / 1.5);
    const halfX = Math.max(2, Math.round(3 * sizeScale));
    const halfY = Math.max(1, Math.round(1.5 * sizeScale));
    const halfZ = Math.max(2, Math.round(2 * sizeScale));

    const cx = Math.round((ac.x + L / 2) / dx);
    const cz = Math.round((ac.z + W / 2) / dz);
    const mountY = ac.mounting_height_m ?? H * 0.88;
    const cy = Math.round(mountY / dy);

    // Pass 1 — compute total available energy above T_supply, also
    // applying a smooth supply-temperature ramp so cells very close to
    // the diffuser core sit at T_supply, edge cells slightly warmer.
    let totalQ = 0;
    const cells: { k: number; tFloor: number }[] = [];
    for (let diz = -halfZ; diz <= halfZ; diz++)
      for (let diy = -halfY; diy <= halfY * 2; diy++)
        for (let dix = -halfX; dix <= halfX; dix++) {
          const ii = clamp(cx + dix, 0, NX - 1);
          const ij = clamp(cy + diy, 0, NY - 1);
          const ik = clamp(cz + diz, 0, NZ - 1);
          const k = CK(ii, ij, ik);
          if (f.wall[k]) continue;
          // Soft falloff so the patch isn't a hard step
          const r2 = (dix / halfX) ** 2 + (diy / (halfY + 0.5)) ** 2 + (diz / halfZ) ** 2;
          if (r2 > 1) continue;
          const tFloor = Tsupply + Math.sqrt(r2) * 1.5;   // up to 1.5 °C above supply at edge
          const excess = f.T[k] - tFloor;
          if (excess > 0) {
            totalQ += cellHeatCap * excess;
            cells.push({ k, tFloor });
          }
        }
    if (totalQ <= 0 || cells.length === 0) continue;

    const Qbudget = kW * 1000 * dt;
    const scale = Math.min(1, Qbudget / totalQ);
    for (const { k, tFloor } of cells) {
      const excess = f.T[k] - tFloor;
      if (excess > 0) f.T[k] -= scale * excess;
    }
  }
}

function applyDirectionalACCooling(
  f: MACFields,
  room: RoomDims,
  ac: ACUnitForCooling & { wall: "S" | "N" | "E" | "W" },
  dt: number,
  Tsupply: number,
  kW: number,
  cellHeatCap: number,
): void {
  const { L, W, H } = room;
  const { dx, dy, dz } = cellSize(room);
  const mountY = ac.mounting_height_m ?? H * 0.88;
  const jet = resolveFluidJet(f, room, ac.x, mountY, ac.z, ac.wall, ac.airflow_angle_deg, ac.vertical_angle_deg);
  if (!jet) return;
  const { seed, Jx, Jy, Jz } = jet;

  const sx = (seed.ix + 0.5) * dx - L / 2;
  const sy = (seed.iy + 0.5) * dy;
  const sz = (seed.iz + 0.5) * dz - W / 2;
  const sizeScale = Math.cbrt(kW / 1.5);
  const throwM = ac.throw_distance_m ?? 4;
  const coreLen = Math.max(0.9, Math.min(1.8, throwM * 0.42)) * sizeScale;
  const baseRadius = 0.18 * sizeScale;

  let totalQ = 0;
  const cells: { k: number; tFloor: number; w: number }[] = [];
  for (let iz = 0; iz < NZ; iz++)
    for (let iy = 0; iy < NY; iy++)
      for (let ix = 0; ix < NX; ix++) {
        const k = CK(ix, iy, iz);
        if (f.wall[k]) continue;
        const rx = (ix + 0.5) * dx - L / 2 - sx;
        const ry = (iy + 0.5) * dy - sy;
        const rz = (iz + 0.5) * dz - W / 2 - sz;
        const along = rx * Jx + ry * Jy + rz * Jz;
        if (along < -0.15 || along > coreLen) continue;
        const lx = rx - along * Jx;
        const ly = ry - along * Jy;
        const lz = rz - along * Jz;
        const lat = Math.hypot(lx, ly, lz);
        const radius = baseRadius + 0.20 * Math.max(0, along);
        if (lat > radius * 2.5) continue;
        const lateral = Math.exp(-0.5 * (lat / Math.max(0.05, radius)) ** 2);
        const stream = Math.max(0.15, 1 - Math.max(0, along) / (coreLen * 1.15));
        const w = lateral * stream;
        if (w < 0.015) continue;
        const tFloor = Tsupply + 1.2 * (lat / Math.max(0.05, radius)) + 1.0 * Math.max(0, along) / coreLen;
        const excess = f.T[k] - tFloor;
        if (excess > 0) {
          totalQ += cellHeatCap * excess * w;
          cells.push({ k, tFloor, w });
        }
      }
  if (totalQ <= 0 || cells.length === 0) return;

  const Qbudget = kW * 1000 * dt;
  const scale = Math.min(1, Qbudget / totalQ);
  for (const { k, tFloor, w } of cells) {
    const excess = f.T[k] - tFloor;
    if (excess > 0) f.T[k] -= scale * excess * w;
  }
}

/**
 * Backward-compat wrapper. Older call sites used `setACSupplyT(f, room, units)`
 * inside the worker tick loop without a dt argument. Internally now defers
 * to applyACCooling with a default dt. Kept so we don't have to chase
 * every call site simultaneously.
 *
 * Once the worker is fully on the new signature this can go.
 */
export function setACSupplyT(
  f: MACFields, room: RoomDims,
  units: ACUnitForCooling[],
  dt = 0.05,
): void {
  applyACCooling(f, room, units, dt);
}

// ── Window / door infiltration (boundary momentum + scalar BC) ─────────
//
// Each opening drives a small inflow from outside with the ambient air
// properties. The effect is modelled as a face-centred boundary forcing
// plus a temperature/RH/CO₂ adjustment in the cells immediately inside
// the wall.

export function injectInfiltrationMAC(
  f: MACFields, room: RoomDims, openings: Opening[],
  Tout: number, RH_out: number,
): void {
  const { L, W, H } = room;
  for (const o of openings) {
    if (o.open === false) continue;
    if (!["win", "circ", "arch", "door"].includes(o.type)) continue;
    const span  = o.wall === "S" || o.wall === "N" ? L : W;
    const cells = o.wall === "S" || o.wall === "N" ? NX : NZ;
    const i0  = Math.round((o.u - o.uw / 2) / span * cells);
    const i1  = Math.round((o.u + o.uw / 2) / span * cells);
    const iy0 = Math.round((o.v - o.vh / 2) / H * NY);
    const iy1 = Math.round((o.v + o.vh / 2) / H * NY);
    const perm = o.air_permeability ?? (o.type === "door" ? 1.0 : 0.3);
    const inflow = 0.10 + 0.04 * perm;     // m/s order-of-magnitude
    const Tedge = ["win", "circ", "arch"].includes(o.type) ? Tout + 2 : Tout;
    let nx = 0, nz = 0;
    if      (o.wall === "S") nz =  1;
    else if (o.wall === "N") nz = -1;
    else if (o.wall === "W") nx =  1;
    else                     nx = -1;
    for (let ci = i0; ci <= i1; ci++) {
      for (let iy = Math.max(0, iy0); iy < Math.min(NY, iy1 + 1); iy++) {
        let ix: number, iz: number;
        if (o.wall === "S" || o.wall === "N") {
          ix = clamp(ci, 0, NX - 1);
          iz = o.wall === "S" ? 0 : NZ - 1;
        } else {
          ix = o.wall === "W" ? 0 : NX - 1;
          iz = clamp(ci, 0, NZ - 1);
        }
        // Push small momentum into the cell just inside the boundary
        // (write to the persistent forcing so it doesn't decay).
        if (o.wall === "S" || o.wall === "N") {
          // adjust v on the appropriate cell pair
          // we drive Vz at the interior cell via fw on the face just inside
          const izIn = o.wall === "S" ? 0 : NZ - 1;
          const kw = ix + NX * iy + NX * NY * (o.wall === "S" ? izIn : izIn + 1);
          if (!f.wwall[kw]) f.fw[kw] += nz * inflow;
        } else {
          const ixIn = o.wall === "W" ? 0 : NX - 1;
          const ku = (o.wall === "W" ? ixIn : ixIn + 1) + (NX + 1) * iy + (NX + 1) * NY * iz;
          if (!f.uwall[ku]) f.fu[ku] += nx * inflow;
        }
        // Boundary scalar forcing — pull cell T toward outdoor T,
        // RH toward outdoor RH, CO₂ toward 420 ppm.
        const k = CK(ix, iy, iz);
        if (!f.wall[k]) {
          const blend = 0.10;
          f.T  [k] = f.T  [k] * (1 - blend) + Tedge       * blend;
          f.RH [k] = f.RH [k] * (1 - blend) + (RH_out)    * blend;
          f.CO2[k] = f.CO2[k] * (1 - blend) + 420         * blend;
        }
      }
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Bake a fraction of the persistent forcing field into the velocity field
 * at scene rebuild. Without this, the velocity starts at zero and ramps
 * up at ~4 % per substep — the AC jet takes a long time to be visible.
 * Pre-loading a fraction makes the simulation usable from t=0.
 *
 * Skips wall faces (already enforced to zero by the buildFaceMasks step).
 */
export function bakeInitialVelocity(f: MACFields, frac = 0.7): void {
  for (let i = 0; i < NU; i++) if (!f.uwall[i]) f.u[i] = f.fu[i] * frac;
  for (let i = 0; i < NV; i++) if (!f.vwall[i]) f.v[i] = f.fv[i] * frac;
  for (let i = 0; i < NW; i++) if (!f.wwall[i]) f.w[i] = f.fw[i] * frac;
}
