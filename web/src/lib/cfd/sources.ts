/**
 * Source-term injection: heat sources, AC jets, fans, opening infiltration.
 * Ported from v6 lines 1133-1259.
 *
 * After voxelize.ts has stamped solid cells, sources.ts populates the
 * Qs (heat) and forcing (Fx/Fz) + initial-velocity (Vx/Vy/Vz) fields.
 */

import { NX, NY, NZ, K, type GridFields, type RoomDims, cellSize } from "./grid";
import { AC_SPEED } from "./constants";
import type { Obstacle, Opening, ACUnit } from "@/lib/io/schema";

// ── Human/appliance heat sources (Gaussian spread + plume) ─────────────
export function injectHeatSources(
  fields: GridFields,
  room: RoomDims,
  obstacles: Obstacle[],
): void {
  const { L, W } = room;
  const { dx, dy, dz } = cellSize(room);
  for (const ob of obstacles) {
    if ((ob.shape !== "human" && ob.shape !== "appliance") || ob.on === false) continue;
    const watts = ob.shape === "human" ? 75 : (ob.watts || 200);
    const Q_cell = watts / (1200 * dx * dy * dz);          // °C/s per cell
    const cx = Math.round((ob.x + L / 2) / dx);
    const cz = Math.round((ob.z + W / 2) / dz);
    const cy = Math.round((ob.H / 2 + (ob.Yoff || 0)) / dy);
    // Spread heat to surrounding fluid cells (Gaussian)
    for (let diz = -3; diz <= 3; diz++)
      for (let diy = 0; diy <= 4; diy++)
        for (let dix = -3; dix <= 3; dix++) {
          const ii = Math.max(0, Math.min(NX - 1, cx + dix));
          const ij = Math.max(0, Math.min(NY - 1, cy + diy));
          const ik = Math.max(0, Math.min(NZ - 1, cz + diz));
          if (fields.wall[K(ii, ij, ik)]) continue;
          const dsq = dix*dix + diy*diy + diz*diz;
          fields.Qs[K(ii, ij, ik)] += Q_cell * Math.exp(-dsq * 0.4);
        }
    // Rising hot air plume above source
    const plH = Math.min(NY - 2, cy + 5);
    for (let iy = cy; iy <= plH; iy++) {
      const k = K(
        Math.max(0, Math.min(NX - 1, cx)),
        iy,
        Math.max(0, Math.min(NZ - 1, cz)),
      );
      if (!fields.wall[k]) fields.Vy[k] += 0.18 * watts / 200;
    }
  }
}

// ── AC jet forcing (3D Gaussian, applied as initial velocity + persistent F) ──
export function injectACJets(
  fields: GridFields,
  room: RoomDims,
  acUnits: { x: number; z: number; wall: "S" | "N" | "E" | "W"; mounting_height_m?: number }[],
): void {
  const { L, W, H } = room;
  const { dx, dy, dz } = cellSize(room);
  for (const ac of acUnits) {
    // Mounting Y from per-AC value if provided, else legacy 88% of room
    // height. For STL rooms with chimney bbox (~5 m), explicit
    // mounting_height_m of 1.8 m keeps the jet at head level.
    const mountY = ac.mounting_height_m ?? H * 0.88;
    const acIY = Math.round(mountY / dy);
    const acIX = Math.round((ac.x + L / 2) / dx);
    const acIZ = Math.round((ac.z + W / 2) / dz);
    let jx = 0, jz = 0;
    if      (ac.wall === "S") jz = +1;
    else if (ac.wall === "N") jz = -1;
    else if (ac.wall === "W") jx = +1;
    else                      jx = -1;   // E
    for (let iz = 0; iz < NZ; iz++)
      for (let iy = 0; iy < NY; iy++)
        for (let ix = 0; ix < NX; ix++) {
          const k = K(ix, iy, iz);
          if (fields.wall[k]) continue;
          const rx = (ix - acIX) * dx;
          const ry = (iy - acIY) * dy;
          const rz = (iz - acIZ) * dz;
          const dist = Math.sqrt(rx*rx + ry*ry + rz*rz) + 0.001;
          const dot = (rx * jx + rz * jz) / dist;
          if (dot < 0) continue;
          const latH = rx * jz - rz * jx;
          const spH = 0.4 + 0.25 * dist;
          const spV = 0.3 + 0.15 * dist;
          const g = Math.exp(-0.5 * (latH / spH) ** 2)
                  * Math.exp(-0.5 * (ry   / spV) ** 2)
                  * Math.exp(-0.18 * dist);
          fields.Fx[k] += jx * AC_SPEED * g;
          fields.Fz[k] += jz * AC_SPEED * g;
          fields.Vx[k] += jx * AC_SPEED * g;
          fields.Vz[k] += jz * AC_SPEED * g;
          fields.Vy[k] -= 0.5 * g;
        }
  }
}

// ── Ceiling/table fan momentum injection ──
export function injectFans(
  fields: GridFields,
  room: RoomDims,
  obstacles: Obstacle[],
): void {
  const { L, W, H } = room;
  const { dx, dy, dz } = cellSize(room);
  for (const ob of obstacles) {
    if (ob.on === false) continue;
    if (ob.shape === "cfan") {
      const fanIX = Math.round((ob.x + L / 2) / dx);
      const fanIZ = Math.round((ob.z + W / 2) / dz);
      const fanIY = NY - 2;
      const spd  = 1.5 * (ob.rpm || 120) / 120;
      const fanR = ob.W;
      const isWinter = ob.season === "winter";
      for (let iz = 0; iz < NZ; iz++)
        for (let iy = 0; iy < NY; iy++)
          for (let ix = 0; ix < NX; ix++) {
            const k = K(ix, iy, iz);
            if (fields.wall[k]) continue;
            const rx = (ix - fanIX) * dx;
            const ry = (iy - fanIY) * dy;
            const rz = (iz - fanIZ) * dz;
            const distH = Math.sqrt(rx*rx + rz*rz) + 0.001;
            const distV = Math.abs(ry) + 0.001;
            if (distH > fanR * 2 && distV > H * 0.6) continue;
            const gH = Math.exp(-1.5 * (distH / fanR) ** 2);
            const gV = Math.exp(-0.8 * (distV / (H * 0.5)) ** 2);
            const g = gH * gV;
            if (isWinter) {
              fields.Vx[k] -= rx / distH * spd * g * 1.4;
              fields.Vz[k] -= rz / distH * spd * g * 1.4;
              fields.Vy[k] += spd * gH * 0.7;
            } else {
              fields.Vx[k] += rx / distH * spd * g * 1.8;
              fields.Vz[k] += rz / distH * spd * g * 1.8;
              fields.Vy[k] -= spd * gH * 0.9;
            }
          }
    } else if (ob.shape === "tfan") {
      const dr = ((ob.dir || 0) * Math.PI) / 180;
      const jx = Math.sin(dr), jz = -Math.cos(dr);
      const fanIX = Math.round((ob.x + L / 2) / dx);
      const fanIZ = Math.round((ob.z + W / 2) / dz);
      const fanY  = (ob.H + (ob.Yoff || 0)) * 0.65;
      const fanIY = Math.round(fanY / dy);
      const spd  = 1.8 * (ob.rpm || 300) / 300;
      for (let iz = 0; iz < NZ; iz++)
        for (let iy = 0; iy < NY; iy++)
          for (let ix = 0; ix < NX; ix++) {
            const k = K(ix, iy, iz);
            if (fields.wall[k]) continue;
            const rx = (ix - fanIX) * dx;
            const ry = (iy - fanIY) * dy;
            const rz = (iz - fanIZ) * dz;
            const dot = rx*jx + rz*jz;
            if (dot < 0) continue;
            const lat = rx*jz - rz*jx;
            const sp  = 0.3 + 0.2 * dot;
            const spV = 0.3 + 0.1 * dot;
            const g = Math.exp(-0.5 * (lat / sp) ** 2)
                    * Math.exp(-0.5 * (ry  / spV) ** 2)
                    * Math.exp(-0.25 * dot);
            fields.Vx[k] += jx * spd * 3.2 * g;
            fields.Vz[k] += jz * spd * 3.2 * g;
            fields.Vy[k] += spd * 0.3 * g;
          }
    }
  }
}

// ── Open-window/door infiltration (boundary forcing + heat) ──
export function injectInfiltration(
  fields: GridFields,
  room: RoomDims,
  openings: Opening[],
): void {
  const { L, W, H } = room;
  for (const f of openings) {
    if (f.open === false) continue;
    if (!["win", "circ", "arch", "door"].includes(f.type)) continue;
    const span  = f.wall === "S" || f.wall === "N" ? L : W;
    const cells = f.wall === "S" || f.wall === "N" ? NX : NZ;
    const i0 = Math.round((f.u - f.uw / 2) / span * cells);
    const i1 = Math.round((f.u + f.uw / 2) / span * cells);
    const iy0 = Math.round((f.v - f.vh / 2) / H * NY);
    const iy1 = Math.round((f.v + f.vh / 2) / H * NY);
    let jx = 0, jz = 0;
    if      (f.wall === "S") jz = +1;
    else if (f.wall === "N") jz = -1;
    else if (f.wall === "W") jx = +1;
    else                     jx = -1;
    for (let ci = i0; ci <= i1; ci++) {
      for (let iy = Math.max(0, iy0); iy < Math.min(NY, iy1 + 1); iy++) {
        let ii: number, iz: number;
        if (f.wall === "S" || f.wall === "N") {
          ii = Math.max(0, Math.min(NX - 1, ci));
          iz = f.wall === "S" ? 0 : NZ - 1;
        } else {
          ii = f.wall === "W" ? 0 : NX - 1;
          iz = Math.max(0, Math.min(NZ - 1, ci));
        }
        const hfrac = iy / (NY - 1);
        const netFlow = 0.3 + (hfrac > 0.5 ? 0.15 : -0.15);
        for (let di = -2; di <= 2; di++)
          for (let dj = -1; dj <= 1; dj++)
            for (let dk = -1; dk <= 1; dk++) {
              const mix = (f.wall === "S" || f.wall === "N")
                ? K(
                    Math.max(0, Math.min(NX - 1, ii + di)),
                    Math.max(0, Math.min(NY - 1, iy + dj)),
                    Math.max(0, Math.min(NZ - 1, iz + dk)),
                  )
                : K(
                    Math.max(0, Math.min(NX - 1, ii + dk)),
                    Math.max(0, Math.min(NY - 1, iy + dj)),
                    Math.max(0, Math.min(NZ - 1, iz + di)),
                  );
              if (fields.wall[mix]) continue;
              const g = Math.exp(-0.6 * (Math.abs(di) + Math.abs(dj) + Math.abs(dk)));
              fields.Vx[mix] += jx * netFlow * g;
              fields.Vz[mix] += jz * netFlow * g;
              if (["win", "circ", "arch"].includes(f.type)) fields.Qs[mix] += g * 1.2;
            }
      }
    }
  }
}

// ── Small box of cold air around AC supply (re-applied each substep) ──
//
// Each unit's `supply_temp_C` (defaults to 14 °C) sets the floor of the
// cold patch around its outlet. Lower supply temperature = stronger local
// cooling; the rest of the room mixes via advection.
export function setACCold(
  fields: GridFields,
  room: RoomDims,
  acUnits: { x: number; z: number; supply_temp_C?: number; mounting_height_m?: number }[],
): void {
  const { L, W, H } = room;
  const { dx, dy, dz } = cellSize(room);
  for (const ac of acUnits) {
    const Tsupply = ac.supply_temp_C ?? 14;
    const acIX = Math.round((ac.x + L / 2) / dx);
    const acIZ = Math.round((ac.z + W / 2) / dz);
    const mountY = ac.mounting_height_m ?? H * 0.88;
    const acIY = Math.round(mountY / dy);
    for (let diz = -1; diz <= 1; diz++)
      for (let diy = -1; diy <= 1; diy++)
        for (let dix = -2; dix <= 2; dix++) {
          const ii = Math.max(0, Math.min(NX - 1, acIX + dix));
          const ij = Math.max(0, Math.min(NY - 1, acIY + diy));
          const ik = Math.max(0, Math.min(NZ - 1, acIZ + diz));
          const r = Math.sqrt(dix*dix + diy*diy + diz*diz) + 0.001;
          fields.T[K(ii, ij, ik)] = Math.min(fields.T[K(ii, ij, ik)], Tsupply + r * 2);
        }
  }
}
