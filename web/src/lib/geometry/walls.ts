/**
 * Wall coordinate conversions: world ↔ (u along wall, v height) UV space.
 * Ported from v6 lines 350-413.
 */

import * as THREE from "three";
import type { Wall, Geometry } from "@/lib/io/schema";

export interface WallInfo {
  pos: [number, number, number];
  ry: number;
  gW: number;
  gH: number;
  span: number;
}

export function wallInfo(geo: Geometry, w: Wall): WallInfo {
  const { L, W, H } = geo;
  const m: Record<Wall, WallInfo> = {
    S: { pos: [0,        H/2, -W/2], ry: 0,           gW: L, gH: H, span: L },
    N: { pos: [0,        H/2,  W/2], ry: Math.PI,     gW: L, gH: H, span: L },
    W: { pos: [-L/2,     H/2, 0],    ry: Math.PI / 2, gW: W, gH: H, span: W },
    E: { pos: [ L/2,     H/2, 0],    ry: -Math.PI / 2, gW: W, gH: H, span: W },
  };
  return m[w];
}

export const wallNormal: Record<Wall, THREE.Vector3> = {
  S: new THREE.Vector3(0, 0,  1),
  N: new THREE.Vector3(0, 0, -1),
  W: new THREE.Vector3(1, 0,  0),
  E: new THREE.Vector3(-1, 0, 0),
};

export function uvToWorld(geo: Geometry, w: Wall, u: number, v: number): THREE.Vector3 {
  const { L, W } = geo;
  const e = 0.028;
  if (w === "S") return new THREE.Vector3(u - L/2, v, -W/2 + e);
  if (w === "N") return new THREE.Vector3(u - L/2, v,  W/2 - e);
  if (w === "W") return new THREE.Vector3(-L/2 + e, v, u - W/2);
  return new THREE.Vector3(L/2 - e, v, u - W/2);  // E
}

export function worldToUV(geo: Geometry, w: Wall, p: THREE.Vector3): { u: number; v: number } {
  const { L, W } = geo;
  if (w === "S" || w === "N") return { u: p.x + L/2, v: p.y };
  return { u: p.z + W/2, v: p.y };
}
