/**
 * Time integration: energy advection-diffusion + Boussinesq buoyancy +
 * pressure projection. Ported from v6 lines 1295-1369.
 *
 * Each call to step() advances the field by `n` substeps of dt.
 */

import { NX, NY, NZ, NCELLS, K, type GridFields, type RoomDims, cellSize } from "./grid";
import { ALPHA, BETA, G, T_AMB, T_SOLAR, T_INFIL, DT } from "./constants";
import type { Opening } from "@/lib/io/schema";

// 3 Gauss-Seidel iterations of ∇²p = ∇·u, then subtract pressure gradient.
function pressureCorrect(
  fields: GridFields,
  dx: number, dy: number, dz: number,
  dt: number,
): void {
  const { Vx, Vy, Vz, p, wall } = fields;
  const ax = 1 / (dx * dx);
  const ay = 1 / (dy * dy);
  const az = 1 / (dz * dz);
  const asum = 2 * (ax + ay + az);
  for (let iter = 0; iter < 3; iter++) {
    for (let iz = 1; iz < NZ - 1; iz++)
      for (let iy = 1; iy < NY - 1; iy++)
        for (let ix = 1; ix < NX - 1; ix++) {
          const k = K(ix, iy, iz);
          if (wall[k]) { p[k] = 0; continue; }
          const div =
              (Vx[K(ix+1, iy, iz)] - Vx[K(ix-1, iy, iz)]) / (2*dx)
            + (Vy[K(ix, iy+1, iz)] - Vy[K(ix, iy-1, iz)]) / (2*dy)
            + (Vz[K(ix, iy, iz+1)] - Vz[K(ix, iy, iz-1)]) / (2*dz);
          p[k] = (
              ax * (p[K(ix+1, iy, iz)] + p[K(ix-1, iy, iz)])
            + ay * (p[K(ix, iy+1, iz)] + p[K(ix, iy-1, iz)])
            + az * (p[K(ix, iy, iz+1)] + p[K(ix, iy, iz-1)])
            - div / dt
          ) / asum;
        }
  }
  for (let iz = 1; iz < NZ - 1; iz++)
    for (let iy = 1; iy < NY - 1; iy++)
      for (let ix = 1; ix < NX - 1; ix++) {
        const k = K(ix, iy, iz);
        if (wall[k]) continue;
        Vx[k] -= dt * (p[K(ix+1, iy, iz)] - p[K(ix-1, iy, iz)]) / (2*dx);
        Vy[k] -= dt * (p[K(ix, iy+1, iz)] - p[K(ix, iy-1, iz)]) / (2*dy);
        Vz[k] -= dt * (p[K(ix, iy, iz+1)] - p[K(ix, iy, iz-1)]) / (2*dz);
      }
}

// Wall boundary temperature: looks up the opening at this cell to choose
// solar/infiltration/closed/ambient temperature.
function bndTemp(
  wall: "S" | "N" | "E" | "W",
  ih: number, iv: number,
  room: RoomDims,
  openings: Opening[],
  Tout: number,
): number {
  const { L, W, H } = room;
  const span  = wall === "S" || wall === "N" ? L : W;
  const cells = wall === "S" || wall === "N" ? NX : NZ;
  const posH = (ih / cells) * span;
  const posV = (iv / NY) * H;
  for (const f of openings) {
    if (f.wall !== wall) continue;
    if (
      posH >= f.u - f.uw / 2 && posH <= f.u + f.uw / 2 &&
      posV >= f.v - f.vh / 2 && posV <= f.v + f.vh / 2
    ) {
      if (f.open === false) return 33;
      if (["win", "circ", "arch"].includes(f.type)) return T_SOLAR;
      return T_INFIL;
    }
  }
  return Math.min(Tout, 33);
}

export interface StepInput {
  fields: GridFields;
  room: RoomDims;
  openings: Opening[];
  Tout: number;
  /** number of substeps per call */
  n: number;
}

export function step(input: StepInput): void {
  const { fields, room, openings, Tout, n } = input;
  const { T, Vx, Vy, Vz, Qs, Fx, Fz, wall } = fields;
  const { dx, dy, dz } = cellSize(room);
  const aDx = ALPHA * DT / (dx * dx);
  const aDy = ALPHA * DT / (dy * dy);
  const aDz = ALPHA * DT / (dz * dz);
  const nT = new Float32Array(T);

  for (let s = 0; s < n; s++) {
    // ── Energy equation: advection (upwind) + diffusion + source ──
    for (let iz = 1; iz < NZ - 1; iz++)
      for (let iy = 1; iy < NY - 1; iy++)
        for (let ix = 1; ix < NX - 1; ix++) {
          const k = K(ix, iy, iz);
          if (wall[k]) { T[k] = 33; continue; }
          const u = Vx[k], v = Vy[k], w = Vz[k];
          const diff =
              aDx * (T[K(ix+1, iy, iz)] + T[K(ix-1, iy, iz)] - 2 * T[k])
            + aDy * (T[K(ix, iy+1, iz)] + T[K(ix, iy-1, iz)] - 2 * T[k])
            + aDz * (T[K(ix, iy, iz+1)] + T[K(ix, iy, iz-1)] - 2 * T[k]);
          const ax = u >= 0 ? (T[k] - T[K(ix-1, iy, iz)]) / dx : (T[K(ix+1, iy, iz)] - T[k]) / dx;
          const ay = v >= 0 ? (T[k] - T[K(ix, iy-1, iz)]) / dy : (T[K(ix, iy+1, iz)] - T[k]) / dy;
          const az = w >= 0 ? (T[k] - T[K(ix, iy, iz-1)]) / dz : (T[K(ix, iy, iz+1)] - T[k]) / dz;
          nT[k] = Math.max(10, Math.min(55,
            T[k] + diff - u*ax*DT - v*ay*DT - w*az*DT + Qs[k] * DT,
          ));
        }
    // ── Boundary temperatures ──
    for (let iz = 0; iz < NZ; iz++)
      for (let ix = 0; ix < NX; ix++) {
        nT[K(ix, 0,      iz)] = Math.min(30, Tout - 3); // floor
        nT[K(ix, NY - 1, iz)] = Math.min(28, Tout - 5); // ceiling
      }
    for (let iy = 0; iy < NY; iy++)
      for (let ix = 0; ix < NX; ix++) {
        nT[K(ix, iy, 0)]      = bndTemp("S", ix, iy, room, openings, Tout);
        nT[K(ix, iy, NZ - 1)] = bndTemp("N", ix, iy, room, openings, Tout);
      }
    for (let iy = 0; iy < NY; iy++)
      for (let iz = 0; iz < NZ; iz++) {
        nT[K(0,      iy, iz)] = bndTemp("W", iz, iy, room, openings, Tout);
        nT[K(NX - 1, iy, iz)] = bndTemp("E", iz, iy, room, openings, Tout);
      }
    T.set(nT);

    // ── Buoyancy (Boussinesq) ──
    const buoyDt = DT * 3;
    for (let iz = 1; iz < NZ - 1; iz++)
      for (let iy = 1; iy < NY - 1; iy++)
        for (let ix = 1; ix < NX - 1; ix++) {
          const k = K(ix, iy, iz);
          if (wall[k]) continue;
          const buoy = BETA * G * (T[k] - T_AMB);
          Vy[k] += buoy * buoyDt;
          Vy[k] *= 0.94;
          Vy[k] = Math.max(-2.8, Math.min(2.8, Vy[k]));
        }

    // ── Re-apply persistent forcing (so AC jet does not decay) ──
    const relax = 0.04;
    for (let k = 0; k < NCELLS; k++) {
      if (wall[k]) continue;
      Vx[k] += (Fx[k] - Vx[k]) * relax;
      Vz[k] += (Fz[k] - Vz[k]) * relax;
    }

    // ── Floor/ceiling no-penetration ──
    for (let iz = 0; iz < NZ; iz++)
      for (let ix = 0; ix < NX; ix++) {
        Vy[K(ix, 0,      iz)] = 0;
        Vy[K(ix, NY - 1, iz)] = 0;
      }

    // ── Pressure projection (incompressibility) ──
    pressureCorrect(fields, dx, dy, dz, DT);
  }
}

// ── Aggregate field metrics (for live KPIs) ──
export interface FieldMetrics {
  mean:  number;
  std:   number;
  hot:   number;     // % cells > Tset + 4
  maxSpd: number;
}

export function metrics(fields: GridFields, Tset: number): FieldMetrics {
  let s = 0, s2 = 0, h = 0, n = 0, maxSpd = 0;
  for (let iz = 0; iz < NZ; iz++)
    for (let iy = 0; iy < NY; iy++)
      for (let ix = 0; ix < NX; ix++) {
        const k = K(ix, iy, iz);
        if (fields.wall[k]) continue;
        const T = fields.T[k];
        s += T; s2 += T * T;
        if (T > Tset + 4) h++;
        n++;
        const sp = Math.sqrt(
          fields.Vx[k] * fields.Vx[k] +
          fields.Vy[k] * fields.Vy[k] +
          fields.Vz[k] * fields.Vz[k],
        );
        if (sp > maxSpd) maxSpd = sp;
      }
  const mean = n > 0 ? s / n : 0;
  return {
    mean,
    std: Math.sqrt(Math.max(0, s2 / n - mean * mean)),
    hot: (h / n) * 100,
    maxSpd,
  };
}
