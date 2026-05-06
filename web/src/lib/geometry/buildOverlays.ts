/**
 * Per-face overlay planes (floor, ceiling, 4 walls) that display the CFD
 * field as a CanvasTexture. Layered just inside the solid wall meshes.
 *
 * Ported from v6 lines 290-413 (initTex + buildRoom thermal mesh setup)
 * and 316-343 (updTex).
 */

import * as THREE from "three";
import { NX, NY, NZ, K } from "@/lib/cfd/grid";
import { tempRGB, speedRGB, vortRGB, pmvRGB, ppdRGB, drRGB, T_MIN, T_MAX, SPEED_MAX, VORT_MAX } from "@/lib/cfd/colormap";
import { type ComfortContext, pmvAt, ppdAt, drAt } from "@/lib/comfort";
import type { Geometry } from "@/lib/io/schema";

export type SimView = "both" | "flow" | "therm" | "vort" | "pmv" | "ppd" | "dr";

export const COMFORT_VIEWS: ReadonlyArray<SimView> = ["pmv", "ppd", "dr"];
export const isComfortView = (v: SimView): boolean => COMFORT_VIEWS.includes(v);

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
  /** Horizontal slice plane at the comfort plane (~1.1 m). High-impact
   *  temperature / PMV viz so the user sees the room's air at head height
   *  rather than just wall projections. */
  sliceMesh:   THREE.Mesh;
  /** Vertical CFD curtains through the room centre. These make jet throw,
   *  recirculation, stratification, and vorticity visible without needing
   *  a full volume renderer. */
  longSliceMesh:  THREE.Mesh;
  crossSliceMesh: THREE.Mesh;
  sliceTex:    OverlayTex;
  longSliceTex:  OverlayTex;
  crossSliceTex: OverlayTex;
  floorTex:    OverlayTex;
  ceilTex:     OverlayTex;
  wallTex:     Record<"S" | "N" | "E" | "W", OverlayTex>;
  setOpacity(view: SimView, simRunning: boolean): void;
  update(
    snap: { T: Float32Array; Vx: Float32Array; Vy: Float32Array; Vz: Float32Array; wall?: Uint8Array },
    view: SimView,
    comfortCtx?: ComfortContext,
  ): void;
  setCurtainAnchor(x: number, z: number): void;
  dispose(): void;
}

/** Pick the RGB triple for a given cell under the active view. */
function cellRGB(
  view: SimView,
  T: Float32Array, Vx: Float32Array, Vy: Float32Array, Vz: Float32Array,
  ix: number, iy: number, iz: number, k: number,
  dx: number, dy: number, dz: number,
  ctx: ComfortContext | undefined,
): [number, number, number] {
  const ux = Vx[k], uy = Vy[k], uz = Vz[k];
  const v = Math.sqrt(ux * ux + uy * uy + uz * uz);
  if (view === "pmv" || view === "ppd" || view === "dr") {
    if (!ctx) return [80, 80, 80]; // grey if no context
    const ta = T[k];
    if (view === "pmv") return pmvRGB(pmvAt(ta, v, ctx));
    if (view === "ppd") return ppdRGB(ppdAt(ta, v, ctx));
    return drRGB(drAt(ta, v, ctx));
  }
  if (view === "vort") {
    const omega = vorticityMagnitude(Vx, Vy, Vz, ix, iy, iz, dx, dy, dz);
    return vortRGB(omega / VORT_MAX);
  }
  const showTherm = view === "both" || view === "therm";
  return showTherm
    ? tempRGB((T[k] - T_MIN) / (T_MAX - T_MIN))
    : speedRGB(v / SPEED_MAX);
}

function vorticityMagnitude(
  Vx: Float32Array, Vy: Float32Array, Vz: Float32Array,
  ix: number, iy: number, iz: number,
  dx: number, dy: number, dz: number,
): number {
  const ixm = Math.max(0, ix - 1), ixp = Math.min(NX - 1, ix + 1);
  const iym = Math.max(0, iy - 1), iyp = Math.min(NY - 1, iy + 1);
  const izm = Math.max(0, iz - 1), izp = Math.min(NZ - 1, iz + 1);
  const ddx = Math.max(dx, (ixp - ixm) * dx);
  const ddy = Math.max(dy, (iyp - iym) * dy);
  const ddz = Math.max(dz, (izp - izm) * dz);

  const dWdy = (Vz[K(ix, iyp, iz)] - Vz[K(ix, iym, iz)]) / ddy;
  const dVdz = (Vy[K(ix, iy, izp)] - Vy[K(ix, iy, izm)]) / ddz;
  const dUdz = (Vx[K(ix, iy, izp)] - Vx[K(ix, iy, izm)]) / ddz;
  const dWdx = (Vz[K(ixp, iy, iz)] - Vz[K(ixm, iy, iz)]) / ddx;
  const dVdx = (Vy[K(ixp, iy, iz)] - Vy[K(ixm, iy, iz)]) / ddx;
  const dUdy = (Vx[K(ix, iyp, iz)] - Vx[K(ix, iym, iz)]) / ddy;

  const ox = dWdy - dVdz;
  const oy = dUdz - dWdx;
  const oz = dVdx - dUdy;
  return Math.sqrt(ox * ox + oy * oy + oz * oz);
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

export interface BuildOverlaysOptions {
  /**
   * If true (set when an STL room is the simulation domain), the
   * bbox-sized S/N/E/W wall overlay planes and the bbox floor / ceiling
   * planes are hidden. Their boundary cells live OUTSIDE the L-shape
   * and would render as a yellow ambient-temperature ghost cuboid.
   * The horizontal slice plane stays visible (its alpha follows the
   * room mask, so it shows the L-shape footprint cleanly).
   */
  suppressBboxWallOverlays?: boolean;
}

export function buildOverlays(geo: Geometry, opts: BuildOverlaysOptions = {}): Overlays {
  const { L, W, H } = geo;
  const group = new THREE.Group();
  const suppressBbox = !!opts.suppressBboxWallOverlays;

  const floorTex = mkTex(NX, NZ);
  const ceilTex  = mkTex(NX, NZ);
  const sliceTex = mkTex(NX, NZ);    // horizontal slice @ ~1.1 m (head height)
  const longSliceTex = mkTex(NX, NY);
  const crossSliceTex = mkTex(NZ, NY);
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

  // Slice plane @ comfort height — drawn double-sided so it's visible
  // from above and below. Sits a hair above the AC mounting height by
  // default (1.15 m) so it's right at the head-height comfort plane.
  const sliceY = Math.min(1.15, H * 0.55);
  const sliceMat = track(new THREE.MeshBasicMaterial({
    map: sliceTex.tex, transparent: true, opacity: 0,
    depthWrite: false, side: THREE.DoubleSide,
  }));
  const sliceGeo = track(new THREE.PlaneGeometry(L, W));
  const sliceMesh = new THREE.Mesh(sliceGeo, sliceMat);
  sliceMesh.rotation.x = -Math.PI / 2;
  sliceMesh.position.y = sliceY;
  group.add(sliceMesh);

  // Longitudinal vertical slice (X × Y, through z=0). This makes the
  // supply plume and thermal stratification readable from an orbit camera.
  const longSliceMat = track(new THREE.MeshBasicMaterial({
    map: longSliceTex.tex, transparent: true, opacity: 0,
    depthWrite: false, side: THREE.DoubleSide,
  }));
  const longSliceGeo = track(new THREE.PlaneGeometry(L, H));
  const longSliceMesh = new THREE.Mesh(longSliceGeo, longSliceMat);
  longSliceMesh.position.set(0, H / 2, 0);
  group.add(longSliceMesh);

  // Cross vertical slice (Z × Y, through x=0), perpendicular to the
  // longitudinal curtain. Together they give a lightweight CFD volume view.
  const crossSliceMat = track(new THREE.MeshBasicMaterial({
    map: crossSliceTex.tex, transparent: true, opacity: 0,
    depthWrite: false, side: THREE.DoubleSide,
  }));
  const crossSliceGeo = track(new THREE.PlaneGeometry(W, H));
  const crossSliceMesh = new THREE.Mesh(crossSliceGeo, crossSliceMat);
  crossSliceMesh.rotation.y = Math.PI / 2;
  crossSliceMesh.position.set(0, H / 2, 0);
  group.add(crossSliceMesh);

  let curtainX = 0;
  let curtainZ = 0;

  function setCurtainAnchor(x: number, z: number): void {
    curtainX = Math.max(-L / 2, Math.min(L / 2, x));
    curtainZ = Math.max(-W / 2, Math.min(W / 2, z));
    longSliceMesh.position.z = curtainZ;
    crossSliceMesh.position.x = curtainX;
  }

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
    snap: { T: Float32Array; Vx: Float32Array; Vy: Float32Array; Vz: Float32Array; wall?: Uint8Array },
    view: SimView,
    ctx?: ComfortContext,
  ) {
    const { T, Vx, Vy, Vz } = snap;
    const wallMask = snap.wall;
    const dx = L / NX;
    const dy = H / NY;
    const dz = W / NZ;

    // Floor (iy = 0). Wall cells get alpha=0 so the L-shape footprint
    // shows transparent corners instead of a uniform colored bbox.
    {
      const img = floorTex.ctx.createImageData(NX, NZ);
      for (let iz = 0; iz < NZ; iz++)
        for (let ix = 0; ix < NX; ix++) {
          const k = K(ix, 0, iz);
          const a = wallMask && wallMask[k] === 1 ? 0 : 215;
          pixel(img.data, (iz * NX + ix) * 4, cellRGB(view, T, Vx, Vy, Vz, ix, 0, iz, k, dx, dy, dz, ctx), a);
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
          const a = wallMask && wallMask[k] === 1 ? 0 : 160;
          pixel(img.data, (iz * NX + ix) * 4, cellRGB(view, T, Vx, Vy, Vz, ix, NY - 1, iz, k, dx, dy, dz, ctx), a);
        }
      ceilTex.ctx.putImageData(img, 0, 0);
      ceilTex.tex.needsUpdate = true;
    }
    // Slice plane (iy = comfort plane). Vivid head-height temperature /
    // PMV viz — alpha follows the room mask so the L-shape is the visible
    // shape, with transparent gaps where there's no room.
    {
      const iySlice = Math.max(0, Math.min(NY - 1, Math.round((sliceY / H) * NY)));
      const img = sliceTex.ctx.createImageData(NX, NZ);
      for (let iz = 0; iz < NZ; iz++)
        for (let ix = 0; ix < NX; ix++) {
          const k = K(ix, iySlice, iz);
          const a = wallMask && wallMask[k] === 1 ? 0 : 200;
          pixel(img.data, (iz * NX + ix) * 4, cellRGB(view, T, Vx, Vy, Vz, ix, iySlice, iz, k, dx, dy, dz, ctx), a);
        }
      sliceTex.ctx.putImageData(img, 0, 0);
      sliceTex.tex.needsUpdate = true;
    }
    // Longitudinal vertical slice through the active curtain Z.
    {
      const izMid = Math.max(0, Math.min(NZ - 1, Math.floor((curtainZ + W / 2) / dz)));
      const img = longSliceTex.ctx.createImageData(NX, NY);
      for (let iy = 0; iy < NY; iy++)
        for (let ix = 0; ix < NX; ix++) {
          const k = K(ix, iy, izMid);
          const a = wallMask && wallMask[k] === 1 ? 0 : 145;
          pixel(img.data, ((NY - 1 - iy) * NX + ix) * 4, cellRGB(view, T, Vx, Vy, Vz, ix, iy, izMid, k, dx, dy, dz, ctx), a);
        }
      longSliceTex.ctx.putImageData(img, 0, 0);
      longSliceTex.tex.needsUpdate = true;
    }
    // Cross vertical slice through the active curtain X.
    {
      const ixMid = Math.max(0, Math.min(NX - 1, Math.floor((curtainX + L / 2) / dx)));
      const img = crossSliceTex.ctx.createImageData(NZ, NY);
      for (let iy = 0; iy < NY; iy++)
        for (let iz = 0; iz < NZ; iz++) {
          const k = K(ixMid, iy, iz);
          const a = wallMask && wallMask[k] === 1 ? 0 : 125;
          pixel(img.data, ((NY - 1 - iy) * NZ + iz) * 4, cellRGB(view, T, Vx, Vy, Vz, ixMid, iy, iz, k, dx, dy, dz, ctx), a);
        }
      crossSliceTex.ctx.putImageData(img, 0, 0);
      crossSliceTex.tex.needsUpdate = true;
    }
    // S/N walls (iz = 0 / NZ-1)
    for (const side of ["S", "N"] as const) {
      const t = wallTex[side];
      const iz = side === "S" ? 0 : NZ - 1;
      const img = t.ctx.createImageData(NX, NY);
      for (let iy = 0; iy < NY; iy++)
        for (let ix = 0; ix < NX; ix++) {
          const k = K(ix, iy, iz);
          pixel(img.data, ((NY - 1 - iy) * NX + ix) * 4, cellRGB(view, T, Vx, Vy, Vz, ix, iy, iz, k, dx, dy, dz, ctx), 185);
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
          pixel(img.data, ((NY - 1 - iy) * NZ + iz) * 4, cellRGB(view, T, Vx, Vy, Vz, ix, iy, iz, k, dx, dy, dz, ctx), 185);
        }
      t.ctx.putImageData(img, 0, 0);
      t.tex.needsUpdate = true;
    }
  }

  function setOpacity(view: SimView, simRunning: boolean) {
    if (!simRunning) {
      (floorMesh.material as THREE.MeshBasicMaterial).opacity = 0;
      (ceilMesh.material  as THREE.MeshBasicMaterial).opacity = 0;
      (sliceMesh.material as THREE.MeshBasicMaterial).opacity = 0;
      (longSliceMesh.material  as THREE.MeshBasicMaterial).opacity = 0;
      (crossSliceMesh.material as THREE.MeshBasicMaterial).opacity = 0;
      for (const w of ["S","N","W","E"] as const)
        (wallMeshes[w].material as THREE.MeshBasicMaterial).opacity = 0;
      return;
    }
    const isComfort = isComfortView(view);
    const showScalar = view === "both" || view === "therm" || view === "vort" || isComfort;
    const showFlow  = view === "both" || view === "flow" || view === "vort";
    // STL room mode: HIDE the bbox-sized overlays entirely so they
    // don't paint a yellow ambient-temperature ghost cuboid in the
    // chimney/L-shape corners. Only the head-height slice plane stays
    // (its alpha follows the room mask, so it traces the L-shape).
    if (suppressBbox) {
      (floorMesh.material as THREE.MeshBasicMaterial).opacity = 0;
      (ceilMesh.material  as THREE.MeshBasicMaterial).opacity = 0;
      for (const w of ["S","N","W","E"] as const)
        (wallMeshes[w].material as THREE.MeshBasicMaterial).opacity = 0;
      (sliceMesh.material as THREE.MeshBasicMaterial).opacity =
        showScalar ? 0.85 : showFlow ? 0.55 : 0;
      (longSliceMesh.material as THREE.MeshBasicMaterial).opacity =
        showScalar ? 0.40 : showFlow ? 0.30 : 0;
      (crossSliceMesh.material as THREE.MeshBasicMaterial).opacity =
        showScalar ? 0.34 : showFlow ? 0.26 : 0;
      return;
    }
    (floorMesh.material as THREE.MeshBasicMaterial).opacity =
      showScalar ? 0.88 : showFlow ? 0.62 : 0;
    (ceilMesh.material  as THREE.MeshBasicMaterial).opacity =
      showScalar ? 0.65 : showFlow ? 0.48 : 0;
    // Slice plane is the high-impact view — bring it to a strong opacity
    // when any thermal/comfort overlay is active.
    (sliceMesh.material as THREE.MeshBasicMaterial).opacity =
      showScalar ? 0.85 : showFlow ? 0.55 : 0;
    (longSliceMesh.material as THREE.MeshBasicMaterial).opacity =
      showScalar ? 0.40 : showFlow ? 0.30 : 0;
    (crossSliceMesh.material as THREE.MeshBasicMaterial).opacity =
      showScalar ? 0.34 : showFlow ? 0.26 : 0;
    for (const w of ["S","N","W","E"] as const)
      (wallMeshes[w].material as THREE.MeshBasicMaterial).opacity =
        showScalar ? 0.80 : showFlow ? 0.58 : 0;
  }

  return {
    group, floorMesh, ceilMesh, wallMeshes, sliceMesh, longSliceMesh, crossSliceMesh,
    sliceTex, longSliceTex, crossSliceTex, floorTex, ceilTex, wallTex,
    setOpacity, update, setCurtainAnchor,
    dispose() {
      for (const d of disposables) d.dispose();
      floorTex.tex.dispose();
      ceilTex.tex.dispose();
      sliceTex.tex.dispose();
      longSliceTex.tex.dispose();
      crossSliceTex.tex.dispose();
      for (const w of ["S","N","W","E"] as const) wallTex[w].tex.dispose();
    },
  };
}
