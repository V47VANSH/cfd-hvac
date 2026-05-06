/**
 * Particle tracer. 800 points seeded near the AC supply, advected by
 * trilinearly-sampled velocity, recolored per frame by either
 * temperature or speed.
 *
 * Ported from v6 lines 1516-1571.
 */

import * as THREE from "three";
import { NX, NY, NZ, K } from "@/lib/cfd/grid";
import { tempRGB, speedRGB, T_MIN, T_MAX, SPEED_MAX } from "@/lib/cfd/colormap";
import type { Geometry, Obstacle } from "@/lib/io/schema";

const NP = 800;

export interface Particles {
  group: THREE.Group;
  reset(geo: Geometry, ac: { x: number; z: number; wall: "S"|"N"|"E"|"W" }[]): void;
  step(
    dt: number,
    geo: Geometry,
    obstacles: Obstacle[],
    snap: { T: Float32Array; Vx: Float32Array; Vy: Float32Array; Vz: Float32Array },
    view: "both" | "flow" | "therm",
    ac: { x: number; z: number; wall: "S"|"N"|"E"|"W" }[],
  ): void;
  setVisible(v: boolean): void;
  dispose(): void;
}

export function buildParticles(): Particles {
  const group = new THREE.Group();
  const pPos = new Float32Array(NP * 3);
  const pCol = new Float32Array(NP * 3).fill(0.5);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(pCol, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.036, vertexColors: true, transparent: true,
    opacity: 0.88, sizeAttenuation: true, depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.visible = false;
  group.add(points);

  function spawnAt(p: number, room: Geometry, ac: { x: number; z: number; wall: "S"|"N"|"E"|"W" }[]) {
    const pi = p * 3;
    if (ac.length) {
      const a = ac[Math.floor(Math.random() * ac.length)];
      pPos[pi]     = a.x + (Math.random() - 0.5) * 0.8;
      pPos[pi + 1] = room.H * 0.82 + Math.random() * room.H * 0.14;
      pPos[pi + 2] = a.z + (Math.random() - 0.5) * 0.8;
    } else {
      pPos[pi]     = (Math.random() - 0.5) * room.L * 0.85;
      pPos[pi + 1] = Math.random() * room.H;
      pPos[pi + 2] = (Math.random() - 0.5) * room.W * 0.85;
    }
  }

  function reset(room: Geometry, ac: { x: number; z: number; wall: "S"|"N"|"E"|"W" }[]) {
    for (let p = 0; p < NP; p++) spawnAt(p, room, ac);
    (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  function step(
    dt: number,
    room: Geometry,
    obstacles: Obstacle[],
    snap: { T: Float32Array; Vx: Float32Array; Vy: Float32Array; Vz: Float32Array },
    view: "both" | "flow" | "therm",
    ac: { x: number; z: number; wall: "S"|"N"|"E"|"W" }[],
  ) {
    const { L, W, H } = room;
    const dx = L / NX, dy = H / NY, dz = W / NZ;
    const showTherm = view === "both" || view === "therm";
    const sc = 1.25;

    for (let p = 0; p < NP; p++) {
      const pi = p * 3;
      let x = pPos[pi], y = pPos[pi + 1], z = pPos[pi + 2];
      const ix = Math.max(0, Math.min(NX - 1, Math.floor((x + L / 2) / dx)));
      const iy = Math.max(0, Math.min(NY - 1, Math.floor(y / dy)));
      const iz = Math.max(0, Math.min(NZ - 1, Math.floor((z + W / 2) / dz)));
      const k = K(ix, iy, iz);
      const vx = snap.Vx[k], vy = snap.Vy[k], vz = snap.Vz[k], Tp = snap.T[k];

      x += vx * dt * sc; y += vy * dt * sc; z += vz * dt * sc;
      x += (Math.random() - 0.5) * 0.004;
      y += (Math.random() - 0.5) * 0.003;
      z += (Math.random() - 0.5) * 0.004;

      if (
        x < -L/2 + 0.06 || x > L/2 - 0.06 ||
        y <  0.03      || y > H   - 0.03 ||
        z < -W/2 + 0.06 || z > W/2 - 0.06
      ) {
        spawnAt(p, room, ac);
        continue;
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
    }
    (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.color    as THREE.BufferAttribute).needsUpdate = true;
  }

  return {
    group,
    reset,
    step,
    setVisible(v) { points.visible = v; },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}
