/**
 * Per-face overlay planes (floor, ceiling, 4 walls) that display the CFD
 * field as a CanvasTexture. Layered just inside the solid wall meshes.
 *
 * Ported from v6 lines 290-413 (initTex + buildRoom thermal mesh setup)
 * and 316-343 (updTex).
 */

import * as THREE from "three";
import { NX, NY, NZ, K } from "@/lib/cfd/grid";
import { tempRGB, speedRGB, T_MIN, T_MAX, SPEED_MAX } from "@/lib/cfd/colormap";
import type { Geometry } from "@/lib/io/schema";

export type SimView = "both" | "flow" | "therm";

interface OverlayTex {
  tex: THREE.CanvasTexture;
  ctx: CanvasRenderingContext2D;
  w: number; h: number;
}

export interface Overlays {
  group: THREE.Group;
  floorMesh:   THREE.Mesh;
  ceilMesh:    THREE.Mesh;
  wallMeshes:  Record<"S" | "N" | "E" | "W", THREE.Mesh>;
  floorTex:    OverlayTex;
  ceilTex:     OverlayTex;
  wallTex:     Record<"S" | "N" | "E" | "W", OverlayTex>;
  setOpacity(view: SimView, simRunning: boolean): void;
  update(snap: { T: Float32Array; Vx: Float32Array; Vy: Float32Array; Vz: Float32Array }, view: SimView): void;
  dispose(): void;
}

function mkTex(w: number, h: number): OverlayTex {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d")!;
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  return { tex, ctx, w, h };
}

export function buildOverlays(geo: Geometry): Overlays {
  const { L, W, H } = geo;
  const group = new THREE.Group();

  const floorTex = mkTex(NX, NZ);
  const ceilTex  = mkTex(NX, NZ);
  const wallTex: Record<"S" | "N" | "E" | "W", OverlayTex> = {
    S: mkTex(NX, NY),
    N: mkTex(NX, NY),
    W: mkTex(NZ, NY),
    E: mkTex(NZ, NY),
  };

  const disposables: { dispose: () => void }[] = [];
  const track = <T extends { dispose: () => void }>(x: T): T => {
    disposables.push(x); return x;
  };

  // Floor overlay
  const floorMat = track(new THREE.MeshBasicMaterial({
    map: floorTex.tex, transparent: true, opacity: 0, depthWrite: false,
  }));
  const floorGeo = track(new THREE.PlaneGeometry(L, W));
  const floorMesh = new THREE.Mesh(floorGeo, floorMat);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = 0.014;
  group.add(floorMesh);

  // Ceiling overlay
  const ceilMat = track(new THREE.MeshBasicMaterial({
    map: ceilTex.tex, transparent: true, opacity: 0,
    depthWrite: false, side: THREE.DoubleSide,
  }));
  const ceilGeo = track(new THREE.PlaneGeometry(L, W));
  const ceilMesh = new THREE.Mesh(ceilGeo, ceilMat);
  ceilMesh.rotation.x = -Math.PI / 2;
  ceilMesh.position.y = H - 0.01;
  group.add(ceilMesh);

  // Wall overlays — placed just inside the solid wall faces
  const innerOff = 0.025;
  const wallMeshes: Record<"S" | "N" | "E" | "W", THREE.Mesh> = {} as never;

  const mkWallMesh = (
    side: "S" | "N" | "E" | "W",
    pos: [number, number, number],
    ry: number,
    gW: number, gH: number,
  ) => {
    const mat = track(new THREE.MeshBasicMaterial({
      map: wallTex[side].tex, transparent: true, opacity: 0,
      depthWrite: false, side: THREE.DoubleSide,
    }));
    const geo = track(new THREE.PlaneGeometry(gW, gH));
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...pos);
    m.rotation.y = ry;
    group.add(m);
    wallMeshes[side] = m;
  };
  mkWallMesh("S", [0,         H/2, -W/2 + innerOff], 0,           L, H);
  mkWallMesh("N", [0,         H/2,  W/2 - innerOff], Math.PI,     L, H);
  mkWallMesh("W", [-L/2 + innerOff, H/2, 0],          Math.PI / 2, W, H);
  mkWallMesh("E", [ L/2 - innerOff, H/2, 0],         -Math.PI / 2, W, H);

  // ── Update routines ──
  function pixel(out: Uint8ClampedArray, pi: number, rgb: [number, number, number], a: number) {
    out[pi]     = rgb[0];
    out[pi + 1] = rgb[1];
    out[pi + 2] = rgb[2];
    out[pi + 3] = a;
  }

  function update(
    snap: { T: Float32Array; Vx: Float32Array; Vy: Float32Array; Vz: Float32Array },
    view: SimView,
  ) {
    const { T, Vx, Vy, Vz } = snap;
    const showTherm = view === "both" || view === "therm";

    // Floor (iy = 0)
    {
      const img = floorTex.ctx.createImageData(NX, NZ);
      for (let iz = 0; iz < NZ; iz++)
        for (let ix = 0; ix < NX; ix++) {
          const k = K(ix, 0, iz);
          const rgb = showTherm
            ? tempRGB((T[k] - T_MIN) / (T_MAX - T_MIN))
            : speedRGB(Math.sqrt(Vx[k]**2 + Vy[k]**2 + Vz[k]**2) / SPEED_MAX);
          pixel(img.data, (iz * NX + ix) * 4, rgb, 215);
        }
      floorTex.ctx.putImageData(img, 0, 0);
      floorTex.tex.needsUpdate = true;
    }
    // Ceiling (iy = NY-1)
    {
      const img = ceilTex.ctx.createImageData(NX, NZ);
      for (let iz = 0; iz < NZ; iz++)
        for (let ix = 0; ix < NX; ix++) {
          const k = K(ix, NY - 1, iz);
          const rgb = showTherm
            ? tempRGB((T[k] - T_MIN) / (T_MAX - T_MIN))
            : speedRGB(Math.sqrt(Vx[k]**2 + Vy[k]**2 + Vz[k]**2) / SPEED_MAX);
          pixel(img.data, (iz * NX + ix) * 4, rgb, 160);
        }
      ceilTex.ctx.putImageData(img, 0, 0);
      ceilTex.tex.needsUpdate = true;
    }
    // S/N walls (iz = 0 / NZ-1)
    for (const side of ["S", "N"] as const) {
      const t = wallTex[side];
      const iz = side === "S" ? 0 : NZ - 1;
      const img = t.ctx.createImageData(NX, NY);
      for (let iy = 0; iy < NY; iy++)
        for (let ix = 0; ix < NX; ix++) {
          const k = K(ix, iy, iz);
          const rgb = showTherm
            ? tempRGB((T[k] - T_MIN) / (T_MAX - T_MIN))
            : speedRGB(Math.sqrt(Vx[k]**2 + Vy[k]**2 + Vz[k]**2) / SPEED_MAX);
          pixel(img.data, ((NY - 1 - iy) * NX + ix) * 4, rgb, 185);
        }
      t.ctx.putImageData(img, 0, 0);
      t.tex.needsUpdate = true;
    }
    // W/E walls (ix = 0 / NX-1)
    for (const side of ["W", "E"] as const) {
      const t = wallTex[side];
      const ix = side === "W" ? 0 : NX - 1;
      const img = t.ctx.createImageData(NZ, NY);
      for (let iy = 0; iy < NY; iy++)
        for (let iz = 0; iz < NZ; iz++) {
          const k = K(ix, iy, iz);
          const rgb = showTherm
            ? tempRGB((T[k] - T_MIN) / (T_MAX - T_MIN))
            : speedRGB(Math.sqrt(Vx[k]**2 + Vy[k]**2 + Vz[k]**2) / SPEED_MAX);
          pixel(img.data, ((NY - 1 - iy) * NZ + iz) * 4, rgb, 185);
        }
      t.ctx.putImageData(img, 0, 0);
      t.tex.needsUpdate = true;
    }
  }

  function setOpacity(view: SimView, simRunning: boolean) {
    if (!simRunning) {
      (floorMesh.material as THREE.MeshBasicMaterial).opacity = 0;
      (ceilMesh.material  as THREE.MeshBasicMaterial).opacity = 0;
      for (const w of ["S","N","W","E"] as const)
        (wallMeshes[w].material as THREE.MeshBasicMaterial).opacity = 0;
      return;
    }
    const showTherm = view === "both" || view === "therm";
    const showFlow  = view === "both" || view === "flow";
    (floorMesh.material as THREE.MeshBasicMaterial).opacity =
      showTherm ? 0.88 : showFlow ? 0.62 : 0;
    (ceilMesh.material  as THREE.MeshBasicMaterial).opacity =
      showTherm ? 0.65 : showFlow ? 0.48 : 0;
    for (const w of ["S","N","W","E"] as const)
      (wallMeshes[w].material as THREE.MeshBasicMaterial).opacity =
        showTherm ? 0.80 : showFlow ? 0.58 : 0;
  }

  return {
    group, floorMesh, ceilMesh, wallMeshes,
    floorTex, ceilTex, wallTex,
    setOpacity, update,
    dispose() {
      for (const d of disposables) d.dispose();
      floorTex.tex.dispose();
      ceilTex.tex.dispose();
      for (const w of ["S","N","W","E"] as const) wallTex[w].tex.dispose();
    },
  };
}
