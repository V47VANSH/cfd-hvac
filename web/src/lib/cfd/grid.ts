/**
 * 3D CFD grid — geometry, indexing, allocation.
 *
 * Ported from v6 monolith (cfd_room_3d_v6.html:267-290). Layout is a
 * structured Cartesian grid sized NX × NY × NZ where:
 *   X = room length  (L)
 *   Y = room height  (H)
 *   Z = room width   (W)
 *
 * Cell index: K(ix, iy, iz) = ix + NX*iy + NX*NY*iz
 */

export const NX = 36;
export const NY = 14;
export const NZ = 28;
export const NCELLS = NX * NY * NZ;
export const NX_NY = NX * NY;

export function K(ix: number, iy: number, iz: number): number {
  return ix + NX * iy + NX_NY * iz;
}

export interface GridFields {
  T:    Float32Array;   // temperature (°C)
  Vx:   Float32Array;   // velocity x (m/s)
  Vy:   Float32Array;   // velocity y (m/s)
  Vz:   Float32Array;   // velocity z (m/s)
  p:    Float32Array;   // pressure (Pa, scaled)
  Qs:   Float32Array;   // heat source (°C/s/cell)
  Fx:   Float32Array;   // persistent forcing x (AC jets)
  Fz:   Float32Array;   // persistent forcing z
  wall: Uint8Array;     // 1 = solid cell, 0 = fluid
}

export function makeFields(): GridFields {
  return {
    T:    new Float32Array(NCELLS).fill(35),
    Vx:   new Float32Array(NCELLS),
    Vy:   new Float32Array(NCELLS),
    Vz:   new Float32Array(NCELLS),
    p:    new Float32Array(NCELLS),
    Qs:   new Float32Array(NCELLS),
    Fx:   new Float32Array(NCELLS),
    Fz:   new Float32Array(NCELLS),
    wall: new Uint8Array(NCELLS),
  };
}

export interface RoomDims {
  L: number; W: number; H: number;
}

export function cellSize(room: RoomDims): { dx: number; dy: number; dz: number } {
  return { dx: room.L / NX, dy: room.H / NY, dz: room.W / NZ };
}
