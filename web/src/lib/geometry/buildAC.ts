/**
 * Build a THREE.Group representing one AC unit mounted at the top of a
 * wall, facing into the room.
 *
 * The mesh sits in world space — orientation is baked into the group's
 * y-rotation so the box's "front" (vent face) points along +Z in local
 * coordinates and the wall's inward normal in world coordinates.
 */

import * as THREE from "three";
import type { Geometry, ACUnit } from "@/lib/io/schema";

const AC_W = 0.62;   // m — body width
const AC_H = 0.20;   // m — body height
const AC_D = 0.16;   // m — body depth (sticks out from wall)
const MOUNT_Y_FRAC = 0.88;    // fraction of room height (matches v6 jet height)
const AC_OFFSET = 0.04;       // m — push slightly into the room from wall

/** Inward-facing rotation about Y for an AC mounted on the named wall. */
function inwardYaw(wall: "S"|"N"|"E"|"W"): number {
  // Body's front is along +Z locally; rotate so it faces inward
  if (wall === "S") return 0;             // +Z faces +Z (north into room) ✓
  if (wall === "N") return Math.PI;       // +Z faces -Z (south into room) ✓
  if (wall === "W") return Math.PI / 2;   // +Z faces +X (east into room) ✓
  return -Math.PI / 2;                    // E
}

/** Snap an AC's (x,z) to its wall, leaving only the in-wall coordinate
 *  free. Used by the placement / drag handlers. */
export function snapACToWall(geo: Geometry, wall: "S"|"N"|"E"|"W", x: number, z: number) {
  const { L, W } = geo;
  if (wall === "S") return { x, z: -W/2 + AC_OFFSET };
  if (wall === "N") return { x, z:  W/2 - AC_OFFSET };
  if (wall === "W") return { x: -L/2 + AC_OFFSET, z };
  return                  { x:  L/2 - AC_OFFSET, z };  // E
}

/** Clamp the in-wall coordinate so the AC body stays inside the wall. */
export function clampACAlongWall(geo: Geometry, wall: "S"|"N"|"E"|"W", x: number, z: number) {
  const { L, W } = geo;
  const half = AC_W / 2 + 0.1;
  if (wall === "S" || wall === "N") {
    return { x: Math.max(-L/2 + half, Math.min(L/2 - half, x)), z };
  }
  return { x, z: Math.max(-W/2 + half, Math.min(W/2 - half, z)) };
}

export function buildACUnit(geo: Geometry, ac: ACUnit): THREE.Group {
  const g = new THREE.Group();
  const isOn = ac.on !== false;

  // Body
  const bodyGeo = new THREE.BoxGeometry(AC_W, AC_H, AC_D);
  const body = new THREE.Mesh(bodyGeo, new THREE.MeshLambertMaterial({
    color: isOn ? 0xe8f0fa : 0x4a5060,
  }));
  body.castShadow = true;
  body.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(bodyGeo),
    new THREE.LineBasicMaterial({ color: isOn ? 0xa0c8e0 : 0x303840 }),
  ));
  g.add(body);

  // Vent slats on the front face (local +Z)
  const ventColor = isOn ? 0x4090d0 : 0x182838;
  for (let i = 0; i < 5; i++) {
    const slat = new THREE.Mesh(
      new THREE.BoxGeometry(AC_W * 0.86, 0.012, 0.01),
      new THREE.MeshBasicMaterial({ color: ventColor }),
    );
    slat.position.set(0, AC_H * 0.36 - i * 0.022, AC_D / 2 + 0.001);
    g.add(slat);
  }

  // LED indicator (top-right of front face)
  const led = new THREE.Mesh(
    new THREE.SphereGeometry(0.022, 8, 6),
    new THREE.MeshBasicMaterial({ color: isOn ? 0x00ff88 : 0x202828 }),
  );
  led.position.set(AC_W * 0.4, AC_H * 0.4, AC_D / 2 + 0.005);
  g.add(led);

  // Cool blue glow under the unit when on (suggests cold-air supply)
  if (isOn) {
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 10, 6),
      new THREE.MeshBasicMaterial({
        color: 0x4090ff, transparent: true, opacity: 0.10, depthWrite: false,
      }),
    );
    glow.position.set(0, -AC_H * 0.6, AC_D);
    glow.scale.set(1.6, 0.5, 1.4);
    g.add(glow);
  }

  // Position + orient on the wall
  g.rotation.y = inwardYaw(ac.wall);
  g.position.set(ac.x, geo.H * MOUNT_Y_FRAC, ac.z);
  g.userData = { isAC: true, acid: ac.id };
  return g;
}
