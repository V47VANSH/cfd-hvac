/**
 * Sparse CFD cell-centre point cloud. It shows the actual solver samples
 * inside the room mask, colored by the active field, so STL rooms do not
 * feel like a black box behind the slice textures.
 */

import * as THREE from "three";
import { NX, NY, NZ, K } from "@/lib/cfd/grid";
import { tempRGB, speedRGB, vortRGB, T_MIN, T_MAX, SPEED_MAX, VORT_MAX } from "@/lib/cfd/colormap";
import type { Geometry } from "@/lib/io/schema";
import type { SimView } from "./buildOverlays";

const STRIDE_X = 3;
const STRIDE_Y = 2;
const STRIDE_Z = 3;

interface SamplePoint {
  ix: number;
  iy: number;
  iz: number;
  x: number;
  y: number;
  z: number;
}

export interface FieldPoints {
  group: THREE.Group;
  update(snap: { T: Float32Array; Vx: Float32Array; Vy: Float32Array; Vz: Float32Array; wall?: Uint8Array }, view: SimView): void;
  setVisible(v: boolean): void;
  dispose(): void;
}

export function buildFieldPoints(room: Geometry): FieldPoints {
  const { L, W, H } = room;
  const dx = L / NX, dy = H / NY, dz = W / NZ;
  const group = new THREE.Group();
  group.visible = false;

  const samples: SamplePoint[] = [];
  for (let iz = 1; iz < NZ - 1; iz += STRIDE_Z)
    for (let iy = 1; iy < NY - 1; iy += STRIDE_Y)
      for (let ix = 1; ix < NX - 1; ix += STRIDE_X) {
        samples.push({
          ix, iy, iz,
          x: (ix + 0.5) * dx - L / 2,
          y: (iy + 0.5) * dy,
          z: (iz + 0.5) * dz - W / 2,
        });
      }

  const pos = new Float32Array(samples.length * 3);
  const col = new Float32Array(samples.length * 3);
  samples.forEach((s, i) => {
    const p = i * 3;
    pos[p] = s.x; pos[p + 1] = s.y; pos[p + 2] = s.z;
    col[p] = 0.2; col[p + 1] = 0.7; col[p + 2] = 1;
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.045,
    vertexColors: true,
    transparent: true,
    opacity: 0.62,
    sizeAttenuation: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  group.add(points);

  function update(
    snap: { T: Float32Array; Vx: Float32Array; Vy: Float32Array; Vz: Float32Array; wall?: Uint8Array },
    view: SimView,
  ): void {
    const showTherm = view === "both" || view === "therm";
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const p = i * 3;
      const k = K(s.ix, s.iy, s.iz);
      const hidden = snap.wall?.[k] === 1;
      pos[p] = s.x;
      pos[p + 1] = hidden ? -999 : s.y;
      pos[p + 2] = s.z;
      const vx = snap.Vx[k], vy = snap.Vy[k], vz = snap.Vz[k];
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const rgb = view === "vort"
        ? vortRGB(vorticityMagnitude(snap, s.ix, s.iy, s.iz, dx, dy, dz) / VORT_MAX)
        : showTherm
          ? tempRGB((snap.T[k] - T_MIN) / (T_MAX - T_MIN))
          : speedRGB(speed / SPEED_MAX);
      col[p] = rgb[0] / 255;
      col[p + 1] = rgb[1] / 255;
      col[p + 2] = rgb[2] / 255;
    }
    (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  return {
    group,
    update,
    setVisible(v) { group.visible = v; },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

function vorticityMagnitude(
  snap: { Vx: Float32Array; Vy: Float32Array; Vz: Float32Array },
  ix: number, iy: number, iz: number,
  dx: number, dy: number, dz: number,
): number {
  const ixm = Math.max(0, ix - 1), ixp = Math.min(NX - 1, ix + 1);
  const iym = Math.max(0, iy - 1), iyp = Math.min(NY - 1, iy + 1);
  const izm = Math.max(0, iz - 1), izp = Math.min(NZ - 1, iz + 1);
  const ddx = Math.max(dx, (ixp - ixm) * dx);
  const ddy = Math.max(dy, (iyp - iym) * dy);
  const ddz = Math.max(dz, (izp - izm) * dz);

  const dWdy = (snap.Vz[K(ix, iyp, iz)] - snap.Vz[K(ix, iym, iz)]) / ddy;
  const dVdz = (snap.Vy[K(ix, iy, izp)] - snap.Vy[K(ix, iy, izm)]) / ddz;
  const dUdz = (snap.Vx[K(ix, iy, izp)] - snap.Vx[K(ix, iy, izm)]) / ddz;
  const dWdx = (snap.Vz[K(ixp, iy, iz)] - snap.Vz[K(ixm, iy, iz)]) / ddx;
  const dVdx = (snap.Vy[K(ixp, iy, iz)] - snap.Vy[K(ixm, iy, iz)]) / ddx;
  const dUdy = (snap.Vx[K(ix, iyp, iz)] - snap.Vx[K(ix, iym, iz)]) / ddy;

  const ox = dWdy - dVdz;
  const oy = dUdz - dWdx;
  const oz = dVdx - dUdy;
  return Math.sqrt(ox * ox + oy * oy + oz * oz);
}
