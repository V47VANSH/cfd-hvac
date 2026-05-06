/**
 * MAC solver step — the new Tier 1 numerical core.
 *
 * Per substep:
 *   1. Re-apply persistent forcing  (AC jets, fan momentum, infiltration)
 *   2. Compute Smagorinsky eddy viscosity  ν_t  on cell centres
 *   3. Diffuse temperature, RH, CO₂ (forward Euler with α + ν_t/Pr_t)
 *   4. Apply scalar source terms  (Qs, Qrh, Qco2)
 *   5. Apply Boussinesq buoyancy  (force on v-faces from cell ΔT)
 *   6. Advect velocity (semi-Lagrangian) — out of place
 *   7. Advect scalars (semi-Lagrangian) — out of place
 *   8. Apply boundary conditions  (no-penetration, wall T, supply T)
 *   9. Pressure projection: divergence → multigrid → ∇p subtraction
 *
 * The solver is deliberately decoupled from the rest of the codebase: it
 * takes a `MACFields` plus a `Scene` snapshot and mutates the fields in
 * place. Voxelization and source injection are done once per scene rebuild
 * (when the user adds/moves/removes objects), not per step.
 */

import { NX, NY, NZ, NCELLS, CK, NU, NV, NW, type MACFields, type RoomDims, cellSize } from "./mac-grid";
import { Multigrid, divergence, subtractPressureGradient } from "./multigrid";
import { advectVelocity, advectScalar } from "./advection";
import { smagorinskyViscosity } from "./turbulence";
import { computeViewFactorTmrt } from "./radiation";
import type { Calibration } from "./calibration";
import type { Opening } from "@/lib/io/schema";

const PR_T = 0.85;        // turbulent Prandtl number (T)
const SC_T = 0.7;         // turbulent Schmidt number (RH, CO₂)

/** Pre-allocated scratch buffers shared across calls. */
export interface SolverScratch {
  rhs:  Float32Array;       // ∇·u for pressure
  nut:  Float32Array;       // Smagorinsky ν_t per cell
  uTmp: Float32Array;
  vTmp: Float32Array;
  wTmp: Float32Array;
  tTmp: Float32Array;
  rhTmp:Float32Array;
  coTmp:Float32Array;
  mg:   Multigrid;
}

export function makeScratch(room: RoomDims): SolverScratch {
  return {
    rhs:  new Float32Array(NCELLS),
    nut:  new Float32Array(NCELLS),
    uTmp: new Float32Array(NU),
    vTmp: new Float32Array(NV),
    wTmp: new Float32Array(NW),
    tTmp: new Float32Array(NCELLS),
    rhTmp:new Float32Array(NCELLS),
    coTmp:new Float32Array(NCELLS),
    mg:   new Multigrid(room),
  };
}

export interface StepInput {
  fields:   MACFields;
  room:     RoomDims;
  openings: Opening[];
  Tout:     number;
  RHout:    number;     // 0..1
  dt:       number;
  /** Calibrated solver constants (loaded once from calibration.json). */
  cal:      Calibration;
  scratch:  SolverScratch;
}

export function stepMAC(input: StepInput): void {
  const { fields: f, room, openings, Tout, dt, cal, scratch } = input;
  const { dx, dy, dz } = cellSize(room);

  // ── 1. Re-apply persistent forcing (AC + fan + infiltration momentum) ──
  const relax = cal.forceRelax;
  for (let i = 0; i < NU; i++) f.u[i] += (f.fu[i] - f.u[i]) * relax;
  for (let i = 0; i < NV; i++) f.v[i] += (f.fv[i] - f.v[i]) * relax;
  for (let i = 0; i < NW; i++) f.w[i] += (f.fw[i] - f.w[i]) * relax;

  // ── 2. Eddy viscosity ──
  smagorinskyViscosity(f, room, cal.smagorinskyCs, dt, scratch.nut);

  // ── 3. Diffusion (temperature + scalars) — forward Euler ──
  const aDx = dt / (dx * dx);
  const aDy = dt / (dy * dy);
  const aDz = dt / (dz * dz);
  diffuseScalar(f.T,   f.wall, scratch.tTmp,  cal.alphaAir, scratch.nut, PR_T, aDx, aDy, aDz,  10,    55);
  diffuseScalar(f.RH,  f.wall, scratch.rhTmp, cal.alphaAir, scratch.nut, SC_T, aDx, aDy, aDz,   0,     1);
  diffuseScalar(f.CO2, f.wall, scratch.coTmp, cal.alphaAir, scratch.nut, SC_T, aDx, aDy, aDz, 380, 5000);

  // ── 4. Scalar source terms ──
  for (let k = 0; k < NCELLS; k++) {
    if (f.wall[k]) continue;
    f.T  [k] += f.Qs  [k] * dt;
    f.RH [k] = clamp01(f.RH[k] + f.Qrh[k] * dt);
    f.CO2[k] = Math.max(380, f.CO2[k] + f.Qco2[k] * dt);
  }

  // ── 5. Boussinesq buoyancy on v-faces ──
  // Body force on the v-face between cells (ix, iy-1, iz) and
  // (ix, iy, iz) uses the average T of the two adjacent cells. The
  // damping factor 0.985 is much lighter than before (0.96) so cold
  // air actually falls and hot air actually rises — Phase 2.5 fixes
  // the "looks like the AC isn't doing anything" symptom by letting
  // buoyancy-driven recirculation develop.
  //
  // Stability is still enforced by the magnitude clamp + the pressure
  // projection step downstream.
  for (let iz = 0; iz < NZ; iz++)
    for (let iy = 1; iy < NY; iy++)
      for (let ix = 0; ix < NX; ix++) {
        const kv = ix + NX * iy + NX * (NY + 1) * iz;
        if (f.vwall[kv]) continue;
        const k1 = CK(ix, iy - 1, iz);
        const k2 = CK(ix, iy,     iz);
        const Tavg = 0.5 * (f.T[k1] + f.T[k2]);
        const dT = Tavg - cal.Tamb;
        f.v[kv] = (f.v[kv] + cal.beta * 9.81 * dT * dt) * 0.985;
        if (f.v[kv] >  3.0) f.v[kv] =  3.0;
        if (f.v[kv] < -3.0) f.v[kv] = -3.0;
      }

  // ── 6. Velocity advection (semi-Lagrangian, out of place) ──
  advectVelocity(f, room, dt, scratch.uTmp, scratch.vTmp, scratch.wTmp);
  f.u.set(scratch.uTmp);
  f.v.set(scratch.vTmp);
  f.w.set(scratch.wTmp);

  // ── 7. Scalar advection ──
  advectScalar(f, room, dt, f.T,   scratch.tTmp,  10, 55);
  advectScalar(f, room, dt, f.RH,  scratch.rhTmp,  0,  1);
  advectScalar(f, room, dt, f.CO2, scratch.coTmp, 380, 5000);
  f.T  .set(scratch.tTmp);
  f.RH .set(scratch.rhTmp);
  f.CO2.set(scratch.coTmp);

  // ── 8. Boundary temperatures ──
  applyBoundaryTemperatures(f, room, openings, Tout);

  // ── 9. Pressure projection (multigrid) ──
  divergence(f, scratch.rhs, dt, room);
  scratch.mg.solve(scratch.rhs, f.wall, f.p, cal.mgCycles);
  subtractPressureGradient(f, f.p, dt, room);
}

/**
 * Forward-Euler diffusion of a cell-centred scalar with a non-uniform
 * eddy-viscosity field (turbulent diffusivity ≈ ν_t / Pr_t).
 *
 * The per-cell coefficient is capped to a stability-safe maximum so this
 * step cannot blow up even if the upstream Smagorinsky cap is bypassed
 * (defensive against future changes). After the update we clamp into
 * `[clipMin, clipMax]` — exact same envelope advection uses, so a
 * single rogue cell can never cascade into NaN.
 */
function diffuseScalar(
  s: Float32Array, wall: Uint8Array, tmp: Float32Array,
  alpha: number, nut: Float32Array, prT: number,
  aDx: number, aDy: number, aDz: number,
  clipMin: number, clipMax: number,
): void {
  tmp.set(s);
  // Stability bound: per-direction coefficient ≤ ~0.16 keeps the 3D
  // forward-Euler diffusion stable in any reasonable scene. We compute
  // the maximum permissible D from the time-step coefficients themselves
  // so the clamp follows the timestep automatically.
  const aSum = aDx + aDy + aDz;
  const Dmax = aSum > 0 ? 0.45 / aSum : Infinity;
  for (let iz = 1; iz < NZ - 1; iz++)
    for (let iy = 1; iy < NY - 1; iy++)
      for (let ix = 1; ix < NX - 1; ix++) {
        const k = CK(ix, iy, iz);
        if (wall[k]) continue;
        const kxp = CK(ix + 1, iy, iz);
        const kxm = CK(ix - 1, iy, iz);
        const kyp = CK(ix, iy + 1, iz);
        const kym = CK(ix, iy - 1, iz);
        const kzp = CK(ix, iy, iz + 1);
        const kzm = CK(ix, iy, iz - 1);
        let D = alpha + nut[k] / prT;
        if (D > Dmax) D = Dmax;
        const v = tmp[k]
          + D * aDx * (tmp[kxp] + tmp[kxm] - 2 * tmp[k])
          + D * aDy * (tmp[kyp] + tmp[kym] - 2 * tmp[k])
          + D * aDz * (tmp[kzp] + tmp[kzm] - 2 * tmp[k]);
        s[k] = v < clipMin ? clipMin : v > clipMax ? clipMax : v;
      }
}

// Set boundary cell temperatures using a blended (mixed) BC.
//
// Earlier the boundary cells were *overwritten* with the wall target
// temperature every step. That makes them behave as an infinite heat
// bath at outdoor conditions: the AC pours cold air in, advection drags
// it toward the boundaries, the next step erases it back to "wall
// temperature." Net result: a 12 kW AC barely budges the mean.
//
// Real walls have a thermal coupling on the order of h ≈ 5 W/m²K. We
// approximate that with a per-step blend  T ← (1-k) T + k T_wall, where
// `k` is small enough that the boundary supplies a heat flux comparable
// to the ASHRAE-load order of magnitude (~3 kW for a typical room),
// not 50× that.
function applyBoundaryTemperatures(
  f: MACFields, room: RoomDims, openings: Opening[], Tout: number,
): void {
  const { L, W } = room;

  /* Boundary thermal coupling per substep — matches the ~3 kW heat-load
   * scale for a 4×3×2.7 m room with default U-values. Window cells get a
   * stronger coupling because solar gain dominates there. */
  const K_WALL   = 0.015;
  const K_WINDOW = 0.05;

  // Floor (iy=0) and ceiling (iy=NY-1) — softened targets too. Real
  // floors with AC running sit ~24-26 °C, not "Tout − 3".
  const Tfloor   = Math.min(Tout, 28);
  const Tceiling = Math.min(Tout, 26);
  for (let iz = 0; iz < NZ; iz++)
    for (let ix = 0; ix < NX; ix++) {
      const kf = CK(ix, 0,      iz);
      const kc = CK(ix, NY - 1, iz);
      f.T[kf] = f.T[kf] * (1 - K_WALL) + Tfloor   * K_WALL;
      f.T[kc] = f.T[kc] * (1 - K_WALL) + Tceiling * K_WALL;
    }

  // S/N walls (iz=0/NZ-1)
  for (let iy = 0; iy < NY; iy++)
    for (let ix = 0; ix < NX; ix++) {
      blendWallCell(f, CK(ix, iy, 0),       "S", ix, iy, room, openings, Tout, L, K_WALL, K_WINDOW);
      blendWallCell(f, CK(ix, iy, NZ - 1),  "N", ix, iy, room, openings, Tout, L, K_WALL, K_WINDOW);
    }
  // W/E walls (ix=0/NX-1)
  for (let iy = 0; iy < NY; iy++)
    for (let iz = 0; iz < NZ; iz++) {
      blendWallCell(f, CK(0,      iy, iz),  "W", iz, iy, room, openings, Tout, W, K_WALL, K_WINDOW);
      blendWallCell(f, CK(NX - 1, iy, iz),  "E", iz, iy, room, openings, Tout, W, K_WALL, K_WINDOW);
    }
}

function blendWallCell(
  f: MACFields, k: number,
  wall: "S" | "N" | "E" | "W", ih: number, iv: number,
  room: RoomDims, openings: Opening[], Tout: number, span: number,
  kWall: number, kWin: number,
): void {
  const { Twall, isWindow } = wallTempInfoAt(wall, ih, iv, room, openings, Tout, span);
  const kCoupling = isWindow ? kWin : kWall;
  f.T[k] = f.T[k] * (1 - kCoupling) + Twall * kCoupling;
}

function wallTempInfoAt(
  wall: "S" | "N" | "E" | "W",
  ih: number, iv: number,
  room: RoomDims, openings: Opening[], Tout: number, span: number,
): { Twall: number; isWindow: boolean } {
  const cells = wall === "S" || wall === "N" ? NX : NZ;
  const posH = (ih / cells) * span;
  const posV = (iv / NY) * room.H;
  for (const o of openings) {
    if (o.wall !== wall) continue;
    if (
      posH >= o.u - o.uw / 2 && posH <= o.u + o.uw / 2 &&
      posV >= o.v - o.vh / 2 && posV <= o.v + o.vh / 2
    ) {
      if (o.open === false) return { Twall: Math.min(Tout, 32), isWindow: false };
      if (o.type === "win" || o.type === "circ" || o.type === "arch") {
        const shgc = o.solar_transmittance ?? 0.65;
        // Exterior glass surface temperature (radiation-driven)
        return { Twall: Math.min(48, Tout + shgc * 8), isWindow: true };
      }
      return { Twall: Tout, isWindow: false };  // open door
    }
  }
  return { Twall: Math.min(Tout, 30), isWindow: false };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
