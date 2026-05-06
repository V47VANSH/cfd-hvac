/**
 * Geometry → CFD solid-cell rasterization.
 * Ported from v6 lines 1049-1131 (initCFD).
 *
 * Marks the `wall_g` mask for obstacles, extension blocks (AABB or OBB
 * with rotation), and STL AABBs. Heat sources and jet forcing are NOT
 * voxelized here — see initFields().
 */

import { NX, NY, NZ, K, type GridFields, type RoomDims, cellSize } from "./grid";
import type { Obstacle, ExtensionBlock, STLObject } from "@/lib/io/schema";
import { computeRoomMask } from "@/lib/geometry/roomMask";

export function voxelizeObstacles(
  fields: GridFields,
  room: RoomDims,
  obstacles: Obstacle[],
): void {
  const { L, W } = room;
  const { dx, dy, dz } = cellSize(room);
  for (const ob of obstacles) {
    if (ob.shape === "cfan") continue;       // ceiling fan is momentum source, not solid
    if (ob.on === false) continue;
    const yTop = ob.H + (ob.Yoff || 0);
    const yBot = ob.Yoff || 0;
    const ix0 = Math.floor((ob.x - ob.W / 2 + L / 2) / dx);
    const ix1 = Math.ceil ((ob.x + ob.W / 2 + L / 2) / dx);
    const iz0 = Math.floor((ob.z - (ob.D || ob.W) / 2 + W / 2) / dz);
    const iz1 = Math.ceil ((ob.z + (ob.D || ob.W) / 2 + W / 2) / dz);
    const iy0 = Math.floor(yBot / dy);
    const iy1 = Math.ceil (yTop / dy);
    for (let iz = Math.max(0, iz0); iz < Math.min(NZ, iz1); iz++)
      for (let iy = Math.max(0, iy0); iy < Math.min(NY, iy1); iy++)
        for (let ix = Math.max(0, ix0); ix < Math.min(NX, ix1); ix++)
          fields.wall[K(ix, iy, iz)] = 1;
  }
}

export function voxelizeBlocks(
  fields: GridFields,
  room: RoomDims,
  blocks: ExtensionBlock[],
): void {
  const { L, W } = room;
  const { dx, dy, dz } = cellSize(room);
  const D2R = Math.PI / 180;
  for (const b of blocks) {
    const bRY = (b.ry_deg || 0) * D2R;
    const bRX = (b.rx_deg || 0) * D2R;
    const bRZ = (b.rz_deg || 0) * D2R;
    const hasRot = Math.abs(bRY) + Math.abs(bRX) + Math.abs(bRZ) > 0.01;
    if (!hasRot) {
      // Fast AABB path
      const ix0 = Math.floor((b.x - b.W / 2 + L / 2) / dx);
      const ix1 = Math.ceil ((b.x + b.W / 2 + L / 2) / dx);
      const iz0 = Math.floor((b.z - b.D / 2 + W / 2) / dz);
      const iz1 = Math.ceil ((b.z + b.D / 2 + W / 2) / dz);
      const iy1 = Math.ceil (b.H / dy);
      for (let iz = Math.max(0, iz0); iz < Math.min(NZ, iz1); iz++)
        for (let iy = 0; iy < Math.min(NY, iy1); iy++)
          for (let ix = Math.max(0, ix0); ix < Math.min(NX, ix1); ix++)
            fields.wall[K(ix, iy, iz)] = 1;
    } else {
      // OBB path — inverse-rotate cell centre into block local space (YXZ Euler)
      const cy_ = Math.cos(-bRY), sy_ = Math.sin(-bRY);
      const cx_ = Math.cos(-bRX), sx_ = Math.sin(-bRX);
      const cz_ = Math.cos(-bRZ), sz_ = Math.sin(-bRZ);
      const hW = b.W / 2, hD = b.D / 2, bH = b.H;
      const rad = Math.sqrt(hW*hW + hD*hD + bH*bH/4) + 0.5;
      const wx0 = Math.max(0,  Math.floor((b.x - rad + L / 2) / dx));
      const wx1 = Math.min(NX, Math.ceil ((b.x + rad + L / 2) / dx));
      const wz0 = Math.max(0,  Math.floor((b.z - rad + W / 2) / dz));
      const wz1 = Math.min(NZ, Math.ceil ((b.z + rad + W / 2) / dz));
      const wy1 = Math.min(NY, Math.ceil ((bH + rad) / dy));
      for (let iz = wz0; iz < wz1; iz++)
        for (let iy = 0; iy < wy1; iy++)
          for (let ix = wx0; ix < wx1; ix++) {
            let lx = (ix + 0.5) * dx - L / 2 - b.x;
            let ly = (iy + 0.5) * dy;
            let lz = (iz + 0.5) * dz - W / 2 - b.z;
            // inverse Y
            const tx1 = lx*cy_ - lz*sy_, tz1 = lx*sy_ + lz*cy_; lx = tx1; lz = tz1;
            // inverse X
            const ty1 = ly*cx_ + lz*sx_, tz2 = -ly*sx_ + lz*cx_; ly = ty1; lz = tz2;
            // inverse Z
            const tx2 = lx*cz_ + ly*sz_, ty2 = -lx*sz_ + ly*cz_; lx = tx2; ly = ty2;
            if (lx >= -hW && lx <= hW && lz >= -hD && lz <= hD && ly >= 0 && ly <= bH)
              fields.wall[K(ix, iy, iz)] = 1;
          }
    }
  }
}

export function voxelizeSTL(
  fields: GridFields,
  room: RoomDims,
  stls: STLObject[],
): void {
  const { L, W } = room;
  const { dx, dy, dz } = cellSize(room);
  for (const s of stls) {
    // Room STLs apply the hardcoded hexagonal-prism mask regardless of
    // whether triangle positions are populated.
    if (s.role === "room") {
      const mask = computeRoomMask({ NX, NY, NZ, L: room.L, W: room.W, H: room.H }, s);
      for (let k = 0; k < NX * NY * NZ; k++) {
        if (mask[k] === 0) fields.wall[k] = 1;
      }
      continue;
    }
    if (!s.positions || s.positions.length === 0) continue;
    const sc = s.scale || 1;
    let minX = +Infinity, maxX = -Infinity;
    let minY = +Infinity, maxY = -Infinity;
    let minZ = +Infinity, maxZ = -Infinity;
    const p = s.positions;
    for (let i = 0; i < p.length; i += 3) {
      const wx = p[i] * sc + (s.x || 0);
      const wy = p[i+1] * sc + (s.y || 0);
      const wz = p[i+2] * sc + (s.z || 0);
      if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
      if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
    }
    const ix0 = Math.max(0,  Math.floor((minX + L / 2) / dx));
    const ix1 = Math.min(NX, Math.ceil ((maxX + L / 2) / dx));
    const iy0 = Math.max(0,  Math.floor(minY / dy));
    const iy1 = Math.min(NY, Math.ceil (maxY / dy));
    const iz0 = Math.max(0,  Math.floor((minZ + W / 2) / dz));
    const iz1 = Math.min(NZ, Math.ceil ((maxZ + W / 2) / dz));
    for (let iz = iz0; iz < iz1; iz++)
      for (let iy = iy0; iy < iy1; iy++)
        for (let ix = ix0; ix < ix1; ix++)
          fields.wall[K(ix, iy, iz)] = 1;
  }
}
