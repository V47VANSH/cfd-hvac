/**
 * 3D arrow vector field. Sample the velocity field at a regular lattice
 * (12 × 9 × 3 layers at 12/42/72 % of room height) and draw a line +
 * cone arrow per sample. Color and length scale with speed.
 *
 * Ported from v6 lines 957-1005.
 */

import * as THREE from "three";
import { NX, NY, NZ, K } from "@/lib/cfd/grid";
import { speedRGB } from "@/lib/cfd/colormap";
import type { Geometry } from "@/lib/io/schema";

const ARROW_NX = 12;
const ARROW_NZ = 9;
const ARROW_Y_FRACS = [0.12, 0.42, 0.72];

interface Arrow {
  line: THREE.Line;
  head: THREE.Mesh;
  wx: number; wz: number; y: number; yf: number;
}

export interface ArrowField {
  group: THREE.Group;
  update(snap: { Vx: Float32Array; Vy: Float32Array; Vz: Float32Array }): void;
  setVisible(v: boolean): void;
  dispose(): void;
}

export function buildArrows(geo: Geometry): ArrowField {
  const { L, W, H } = geo;
  const group = new THREE.Group();
  group.visible = false;
  const arrows: Arrow[] = [];
  const disposables: { dispose: () => void }[] = [];

  for (const yf of ARROW_Y_FRACS) {
    const y = yf * H;
    for (let j = 0; j < ARROW_NZ; j++)
      for (let i = 0; i < ARROW_NX; i++) {
        const wx = (i / (ARROW_NX - 1) - 0.5) * L * 0.88;
        const wz = (j / (ARROW_NZ - 1) - 0.5) * W * 0.88;
        const pts = new Float32Array([0, 0, 0, 0, 0, 0]);
        const lineGeo = new THREE.BufferGeometry();
        lineGeo.setAttribute("position", new THREE.BufferAttribute(pts, 3));
        const lineMat = new THREE.LineBasicMaterial({
          color: 0x103060, transparent: true, opacity: 0.6,
        });
        const line = new THREE.Line(lineGeo, lineMat);
        line.position.set(wx, y, wz);
        group.add(line);
        disposables.push(lineGeo, lineMat);

        const headGeo = new THREE.ConeGeometry(0.022, 0.07, 6);
        const headMat = new THREE.MeshBasicMaterial({
          color: 0x103060, transparent: true, opacity: 0.75,
        });
        const head = new THREE.Mesh(headGeo, headMat);
        head.position.set(wx, y, wz);
        group.add(head);
        disposables.push(headGeo, headMat);

        arrows.push({ line, head, wx, wz, y, yf });
      }
  }

  function update(snap: { Vx: Float32Array; Vy: Float32Array; Vz: Float32Array }) {
    const { Vx, Vy, Vz } = snap;
    const dx = L / NX;
    const dz = W / NZ;
    const sMax = 4;
    for (const a of arrows) {
      const ix = Math.max(0, Math.min(NX - 1, Math.floor((a.wx + L / 2) / dx)));
      const iy = Math.max(0, Math.min(NY - 1, Math.round(a.yf * (NY - 1))));
      const iz = Math.max(0, Math.min(NZ - 1, Math.floor((a.wz + W / 2) / dz)));
      const k = K(ix, iy, iz);
      const vx = Vx[k], vy = Vy[k], vz = Vz[k];
      const spd = Math.sqrt(vx*vx + vy*vy + vz*vz);
      const scale = Math.min(spd / sMax, 1);
      const len = scale * 0.32 + 0.018;
      const nx = vx / Math.max(spd, 0.01);
      const ny = vy / Math.max(spd, 0.01);
      const nz = vz / Math.max(spd, 0.01);
      const pa = (a.line.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
      pa[0] = 0; pa[1] = 0; pa[2] = 0;
      pa[3] = nx * len; pa[4] = ny * len; pa[5] = nz * len;
      (a.line.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      a.head.position.set(a.wx + nx * len, a.y + ny * len, a.wz + nz * len);
      if (spd > 0.05) {
        const dir = new THREE.Vector3(nx, ny, nz).normalize();
        a.head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      }
      const [r, g, b] = speedRGB(scale);
      const col = new THREE.Color(r / 255, g / 255, b / 255);
      (a.line.material as THREE.LineBasicMaterial).color.copy(col);
      (a.head.material as THREE.MeshBasicMaterial).color.copy(col);
      (a.line.material as THREE.LineBasicMaterial).opacity = 0.2 + scale * 0.55;
      (a.head.material as THREE.MeshBasicMaterial).opacity = 0.35 + scale * 0.55;
    }
  }

  return {
    group,
    update,
    setVisible(v) { group.visible = v; },
    dispose() { for (const d of disposables) d.dispose(); },
  };
}
