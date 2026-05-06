/**
 * CFL-adaptive timestep selection for the MAC solver.
 *
 * Even though semi-Lagrangian advection is unconditionally stable, large
 * `dt` degrades accuracy and lets jets "tunnel" through obstacles. We
 * pick `dt` so the largest velocity in the field doesn't cross more than
 * `CFL_TARGET` cells per step.
 *
 * Buoyancy and pressure projection have their own implicit coupling; the
 * advective CFL is the binding constraint in this regime.
 */

import { NU, NV, NW, type MACFields, type RoomDims, cellSize } from "./mac-grid";

const CFL_TARGET = 0.8;     // ≤ 0.8 cells crossed per step
const DT_MIN     = 0.005;
const DT_MAX     = 0.10;

export function adaptiveTimestep(f: MACFields, room: RoomDims): number {
  const { dx, dy, dz } = cellSize(room);
  let umax = 0, vmax = 0, wmax = 0;
  for (let i = 0; i < NU; i++) { const a = Math.abs(f.u[i]); if (a > umax) umax = a; }
  for (let i = 0; i < NV; i++) { const a = Math.abs(f.v[i]); if (a > vmax) vmax = a; }
  for (let i = 0; i < NW; i++) { const a = Math.abs(f.w[i]); if (a > wmax) wmax = a; }
  const rateX = umax / dx;
  const rateY = vmax / dy;
  const rateZ = wmax / dz;
  const rate = Math.max(rateX, rateY, rateZ, 1e-3);
  const dt = CFL_TARGET / rate;
  return Math.max(DT_MIN, Math.min(DT_MAX, dt));
}
