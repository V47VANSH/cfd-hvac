/**
 * Particle tracer seeded near the AC supply, advected by the live velocity
 * field, and rendered as bright points plus short line trails. It gives the
 * browser solver a lightweight smoke-test feel without running a volume
 * renderer.
 *
 * Ported from v6 lines 1516-1571.
 */

import * as THREE from "three";
import { NX, NY, NZ, K } from "@/lib/cfd/grid";
import { tempRGB, speedRGB, T_MIN, T_MAX, SPEED_MAX } from "@/lib/cfd/colormap";
import type { SimView } from "@/lib/geometry/buildOverlays";
import type { Geometry, Obstacle } from "@/lib/io/schema";

const NP = 1400;

export interface Particles {
  group: THREE.Group;
  reset(geo: Geometry, ac: { x: number; z: number; wall: "S"|"N"|"E"|"W"; mounting_height_m?: number }[]): void;
  step(
    dt: number,
    geo: Geometry,
    obstacles: Obstacle[],
    snap: { T: Float32Array; Vx: Float32Array; Vy: Float32Array; Vz: Float32Array },
    view: SimView,
    ac: { x: number; z: number; wall: "S"|"N"|"E"|"W"; mounting_height_m?: number }[],
  ): void;
  setVisible(v: boolean): void;
  dispose(): void;
}

export function buildParticles(): Particles {
  const group = new THREE.Group();
  const pPos = new Float32Array(NP * 3);
  const pCol = new Float32Array(NP * 3).fill(0.5);
  const trailPos = new Float32Array(NP * 2 * 3);
  const trailCol = new Float32Array(NP * 2 * 3).fill(0.25);
  const age = new Float32Array(NP);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(pCol, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.044, vertexColors: true, transparent: true,
    opacity: 0.92, sizeAttenuation: true, depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.visible = false;
  group.add(points);

  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPos, 3));
  trailGeo.setAttribute("color", new THREE.BufferAttribute(trailCol, 3));
  const trailMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const trails = new THREE.LineSegments(trailGeo, trailMat);
  trails.visible = false;
  group.add(trails);

  function spawnAt(p: number, room: Geometry, ac: { x: number; z: number; wall: "S"|"N"|"E"|"W"; mounting_height_m?: number }[]) {
    const pi = p * 3;
    if (ac.length) {
      const a = ac[Math.floor(Math.random() * ac.length)];
      // Spawn at the AC's actual mounting height ± 0.15 m so particles
      // are immediately caught by the jet's velocity field. v6's
      // hardcoded H·0.82 was correct for a 2.7 m room (= ~2.2 m, near
      // the 0.88·H AC) but for STL rooms with chimney bbox (~5 m) it
      // spawns particles 2.5 m above the actual AC, totally missing
      // the throw cone — that's why the throw "stayed near the AC".
      const mountY = a.mounting_height_m ?? room.H * 0.88;
      const n = inwardNormal(a.wall);
      const t = tangent(a.wall);
      const across = (Math.random() - 0.5) * 0.72;
      const forward = 0.10 + Math.random() * 0.28;
      pPos[pi]     = a.x + n.x * forward + t.x * across;
      pPos[pi + 1] = mountY + (Math.random() - 0.5) * 0.30;
      pPos[pi + 2] = a.z + n.z * forward + t.z * across;
    } else {
      pPos[pi]     = (Math.random() - 0.5) * room.L * 0.85;
      pPos[pi + 1] = Math.random() * room.H;
      pPos[pi + 2] = (Math.random() - 0.5) * room.W * 0.85;
    }
    age[p] = Math.random() * 1.5;
    const ti = p * 6;
    trailPos[ti] = pPos[pi];
    trailPos[ti + 1] = pPos[pi + 1];
    trailPos[ti + 2] = pPos[pi + 2];
    trailPos[ti + 3] = pPos[pi];
    trailPos[ti + 4] = pPos[pi + 1];
    trailPos[ti + 5] = pPos[pi + 2];
  }

  function reset(room: Geometry, ac: { x: number; z: number; wall: "S"|"N"|"E"|"W"; mounting_height_m?: number }[]) {
    for (let p = 0; p < NP; p++) spawnAt(p, room, ac);
    (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (trailGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  function step(
    dt: number,
    room: Geometry,
    obstacles: Obstacle[],
    snap: { T: Float32Array; Vx: Float32Array; Vy: Float32Array; Vz: Float32Array; wall?: Uint8Array },
    view: SimView,
    ac: { x: number; z: number; wall: "S"|"N"|"E"|"W"; mounting_height_m?: number }[],
  ) {
    const { L, W, H } = room;
    const dx = L / NX, dy = H / NY, dz = W / NZ;
    // Particles are hidden in comfort views; when visible, color by temperature
    // in thermal modes and by speed in airflow / vortex modes.
    const showTherm = view === "both" || view === "therm";
    const sc = 1.45;
    const wallMask = snap.wall;

    for (let p = 0; p < NP; p++) {
      const pi = p * 3;
      const ti = p * 6;
      let x = pPos[pi], y = pPos[pi + 1], z = pPos[pi + 2];
      const vx = sampleField(snap.Vx, room, x, y, z);
      const vy = sampleField(snap.Vy, room, x, y, z);
      const vz = sampleField(snap.Vz, room, x, y, z);
      const Tp = sampleField(snap.T, room, x, y, z);
      const x0 = x, y0 = y, z0 = z;

      x += vx * dt * sc; y += vy * dt * sc; z += vz * dt * sc;
      x += (Math.random() - 0.5) * 0.006;
      y += (Math.random() - 0.5) * 0.004;
      z += (Math.random() - 0.5) * 0.006;
      age[p] += dt;

      if (
        x < -L/2 + 0.06 || x > L/2 - 0.06 ||
        y <  0.03      || y > H   - 0.03 ||
        z < -W/2 + 0.06 || z > W/2 - 0.06 ||
        age[p] > 7.5 + (p % 37) * 0.08
      ) {
        spawnAt(p, room, ac);
        continue;
      }
      // Wall-mask check: respawn if particle wandered into a solid cell
      // (outside the L-shape for STL rooms, or inside an obstacle).
      if (wallMask) {
        const ix2 = Math.max(0, Math.min(NX - 1, Math.floor((x + L / 2) / dx)));
        const iy2 = Math.max(0, Math.min(NY - 1, Math.floor(y / dy)));
        const iz2 = Math.max(0, Math.min(NZ - 1, Math.floor((z + W / 2) / dz)));
        if (wallMask[K(ix2, iy2, iz2)] === 1) {
          // Try respawning in a random fluid cell inside the L-shape
          // by re-spawning at an AC location (most likely fluid). Fall
          // back to the bbox-random spawn if no AC.
          spawnAt(p, room, ac);
          continue;
        }
      }
      let hit = false;
      for (const ob of obstacles) {
        if (ob.shape === "cfan") continue;
        const hy = ob.H + (ob.Yoff || 0);
        if (
          Math.abs(x - ob.x) < ob.W / 2 + 0.05 &&
          Math.abs(z - ob.z) < (ob.D || ob.W) / 2 + 0.05 &&
          y < hy + 0.05 && y > (ob.Yoff || 0) - 0.05
        ) { spawnAt(p, room, ac); hit = true; break; }
      }
      if (hit) continue;

      pPos[pi] = x; pPos[pi + 1] = y; pPos[pi + 2] = z;
      const rgb = showTherm
        ? tempRGB((Tp - T_MIN) / (T_MAX - T_MIN))
        : speedRGB(Math.sqrt(vx*vx + vy*vy + vz*vz) / SPEED_MAX);
      pCol[pi]     = rgb[0] / 255;
      pCol[pi + 1] = rgb[1] / 255;
      pCol[pi + 2] = rgb[2] / 255;
      trailPos[ti]     = x0;
      trailPos[ti + 1] = y0;
      trailPos[ti + 2] = z0;
      trailPos[ti + 3] = x;
      trailPos[ti + 4] = y;
      trailPos[ti + 5] = z;
      trailCol[ti]     = pCol[pi] * 0.35;
      trailCol[ti + 1] = pCol[pi + 1] * 0.35;
      trailCol[ti + 2] = pCol[pi + 2] * 0.35;
      trailCol[ti + 3] = pCol[pi];
      trailCol[ti + 4] = pCol[pi + 1];
      trailCol[ti + 5] = pCol[pi + 2];
    }
    (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.color    as THREE.BufferAttribute).needsUpdate = true;
    (trailGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (trailGeo.attributes.color    as THREE.BufferAttribute).needsUpdate = true;
  }

  return {
    group,
    reset,
    step,
    setVisible(v) { points.visible = v; trails.visible = v; },
    dispose() { geo.dispose(); mat.dispose(); trailGeo.dispose(); trailMat.dispose(); },
  };
}

function sampleField(field: Float32Array, room: Geometry, x: number, y: number, z: number): number {
  const dx = room.L / NX, dy = room.H / NY, dz = room.W / NZ;
  const fx = (x + room.L / 2) / dx - 0.5;
  const fy = y / dy - 0.5;
  const fz = (z + room.W / 2) / dz - 0.5;
  const ix = Math.max(0, Math.min(NX - 2, Math.floor(fx)));
  const iy = Math.max(0, Math.min(NY - 2, Math.floor(fy)));
  const iz = Math.max(0, Math.min(NZ - 2, Math.floor(fz)));
  const tx = clamp01(fx - ix);
  const ty = clamp01(fy - iy);
  const tz = clamp01(fz - iz);

  const c000 = field[K(ix,     iy,     iz    )];
  const c100 = field[K(ix + 1, iy,     iz    )];
  const c010 = field[K(ix,     iy + 1, iz    )];
  const c110 = field[K(ix + 1, iy + 1, iz    )];
  const c001 = field[K(ix,     iy,     iz + 1)];
  const c101 = field[K(ix + 1, iy,     iz + 1)];
  const c011 = field[K(ix,     iy + 1, iz + 1)];
  const c111 = field[K(ix + 1, iy + 1, iz + 1)];
  const c00 = c000 * (1 - tx) + c100 * tx;
  const c10 = c010 * (1 - tx) + c110 * tx;
  const c01 = c001 * (1 - tx) + c101 * tx;
  const c11 = c011 * (1 - tx) + c111 * tx;
  const c0 = c00 * (1 - ty) + c10 * ty;
  const c1 = c01 * (1 - ty) + c11 * ty;
  return c0 * (1 - tz) + c1 * tz;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function inwardNormal(wall: "S"|"N"|"E"|"W"): { x: number; z: number } {
  if (wall === "S") return { x: 0, z: 1 };
  if (wall === "N") return { x: 0, z: -1 };
  if (wall === "W") return { x: 1, z: 0 };
  return { x: -1, z: 0 };
}

function tangent(wall: "S"|"N"|"E"|"W"): { x: number; z: number } {
  if (wall === "S" || wall === "N") return { x: 1, z: 0 };
  return { x: 0, z: 1 };
}
