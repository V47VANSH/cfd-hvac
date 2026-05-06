"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import * as THREE from "three";
import { buildRoomMeshes, type RoomMeshes } from "@/lib/geometry/buildRoom";
import { buildOverlays, type Overlays, type SimView, isComfortView } from "@/lib/geometry/buildOverlays";
import { makeComfortContext } from "@/lib/comfort";
import { buildArrows,   type ArrowField } from "@/lib/geometry/buildArrows";
import { buildParticles, type Particles  } from "@/lib/geometry/buildParticles";
import { buildFieldPoints, type FieldPoints } from "@/lib/geometry/buildFieldPoints";
import { buildOpening } from "@/lib/geometry/buildOpening";
import { buildObstacle } from "@/lib/geometry/buildObstacle";
import { buildConstraintMeshes, type ConstraintMeshes } from "@/lib/geometry/buildConstraints";
import { buildSTLMesh } from "@/lib/geometry/buildSTL";
import { buildACUnit, snapACToWall, clampACAlongWall } from "@/lib/geometry/buildAC";
import { isInsideRoom } from "@/lib/geometry/roomMask";
import { NX as MASK_NX, NY as MASK_NY, NZ as MASK_NZ } from "@/lib/cfd/grid";
import { wallInfo, wallNormal, uvToWorld, worldToUV } from "@/lib/geometry/walls";
import type {
  Scene, Opening, Obstacle, ACUnit, Wall, OpeningType, ObstacleShape,
} from "@/lib/io/schema";
import type { CFDSnapshot } from "@/lib/cfd/workerClient";

export const MAX_AC_UNITS = 3;

export type ToolKind =
  | "orbit"
  | OpeningType
  | ObstacleShape
  | "ac"
  | "polygon"     // draw a forbidden-zone polygon on the floor
  | "restrict"    // drop a restricted-surface rectangle on a wall
  | "stl";        // import / pick an STL mesh

export interface Selection {
  id: number | null;
  type: "feat" | "obs" | "ac" | "stl" | null;
}

interface Props {
  scene:        Scene;
  setScene:     (s: Scene) => void;
  selection:    Selection;
  setSelection: (s: Selection) => void;
  curTool:      ToolKind;
  setCurTool:   (t: ToolKind) => void;
  simView:      SimView;
  simRunning:   boolean;
  ac:           { x: number; z: number; wall: Wall }[];
  subscribeSnapshot: (cb: (s: CFDSnapshot) => void) => () => void;
  /** Called once after mount with the underlying <canvas>; lets parents
   * grab a PNG of the current 3D scene for reports / comparison thumbnails. */
  onCanvasMount?: (canvas: HTMLCanvasElement) => void;
  /** Hide topmost faces of the room STL (so the user can see inside from above). */
  hideRoof?:  boolean;
  /**
   * Y-height of the horizontal clip plane. 0 disables; otherwise everything
   * above this Y is hidden via Three.js clipping. Used to peel the roof off
   * incrementally without modifying the STL. Only affects STLs with role==="room".
   */
  clipY?:     number;
}

/* ─── Disposer helper ────────────────────────────────────────────────── */
function disposeGroup(g: THREE.Group) {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    if (m.material) {
      const arr = Array.isArray(m.material) ? m.material : [m.material];
      for (const mm of arr) mm.dispose();
    }
  });
}

/* ─── Defaults for placed objects ────────────────────────────────────── */
const OPENING_DEFAULTS: Record<OpeningType, { uw: number; vh: number }> = {
  win:  { uw: 1.2, vh: 1.1 },
  door: { uw: 0.9, vh: 2.1 },
  circ: { uw: 0.8, vh: 0.8 },
  arch: { uw: 1.2, vh: 1.1 },
};

const OBSTACLE_DEFAULTS: Record<ObstacleShape, Partial<Obstacle>> = {
  box:       { W: 0.8, D: 0.6, H: 0.8 },
  cyl:       { W: 0.5, D: 0.5, H: 0.9 },
  shelf:     { W: 0.45, D: 0.3, H: 1.9 },
  human:     { W: 0.45, D: 0.45, H: 1.72 },
  appliance: { W: 0.6, D: 0.5, H: 0.9, watts: 200 },
  cfan:      { W: 1.1, D: 1.1, H: 0.3, rpm: 120, season: "summer" },
  tfan:      { W: 0.25, D: 0.25, H: 0.5, rpm: 300, dir: 0 },
};

/* ─── Component ──────────────────────────────────────────────────────── */
export function Room3D(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Latest props bag — read by long-lived handlers/loop without re-binding.
  const latestRef = useRef(props);
  useLayoutEffect(() => {
    latestRef.current = props;
  });

  // All Three.js state lives here.
  const sceneRef = useRef<{
    renderer:   THREE.WebGLRenderer;
    scene:      THREE.Scene;
    camera:     THREE.PerspectiveCamera;
    raycaster:  THREE.Raycaster;
    sph:        { r: number; th: number; ph: number };
    autoSpinRef:{ value: number };
    groups: {
      room:    THREE.Group;
      overlay: THREE.Group;
      feat:    THREE.Group;
      obs:     THREE.Group;
      arrow:   THREE.Group;
      field:   THREE.Group;
      part:    THREE.Group;
      handle:  THREE.Group;
      ac:      THREE.Group;
      cons:    THREE.Group;
      stl:     THREE.Group;
    };
    roomMeshes: RoomMeshes | null;
    overlays:   Overlays | null;
    arrows:     ArrowField | null;
    fieldPoints: FieldPoints | null;
    particles:  Particles | null;
    featMeshes: Map<number, THREE.Group>;
    obsMeshes:  Map<number, THREE.Group>;
    acMeshes:   Map<number, THREE.Group>;
    stlMeshes:  Map<number, THREE.Group>;
    constraintMeshes: ConstraintMeshes | null;
    geomKey:    string;
  } | null>(null);

  /* ── 1. Mount: renderer, camera, lights, animation loop, handlers ─── */
  useEffect(() => {
    const canvas = canvasRef.current!;
    // preserveDrawingBuffer keeps the GL backbuffer readable so the report /
    // comparison view can call canvas.toDataURL() without a black image. The
    // perf cost on a small viewport is negligible.
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    // Required for the Use-as-room clip-plane slider (peels the roof off
    // a translucent STL room). Off by default; per-material clippingPlanes
    // controls which surfaces are affected.
    renderer.localClippingEnabled = true;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x040710);
    scene.fog = new THREE.Fog(0x040710, 35, 90);

    const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 200);

    scene.add(new THREE.AmbientLight(0x6688cc, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 0.7);
    sun.position.set(8, 14, 6); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0x4466bb, 0.6);
    fill.position.set(-5, 4, -4); scene.add(fill);

    const groups = {
      room:    new THREE.Group(),
      overlay: new THREE.Group(),
      feat:    new THREE.Group(),
      obs:     new THREE.Group(),
      arrow:   new THREE.Group(),
      field:   new THREE.Group(),
      part:    new THREE.Group(),
      handle:  new THREE.Group(),
      ac:      new THREE.Group(),
      cons:    new THREE.Group(),
      stl:     new THREE.Group(),
    };
    for (const g of Object.values(groups)) scene.add(g);

    const sph = { r: 16, th: -0.6, ph: 1.1 };
    const updateCam = () => {
      sph.ph = Math.max(0.12, Math.min(Math.PI * 0.46, sph.ph));
      const tgt = new THREE.Vector3(0, latestRef.current.scene.geometry.H * 0.4, 0);
      camera.position.set(
        tgt.x + sph.r * Math.sin(sph.ph) * Math.cos(sph.th),
        tgt.y + sph.r * Math.cos(sph.ph),
        tgt.z + sph.r * Math.sin(sph.ph) * Math.sin(sph.th),
      );
      camera.lookAt(tgt);
    };

    const raycaster = new THREE.Raycaster();
    const ndc = (e: MouseEvent): THREE.Vector2 => {
      const r = canvas.getBoundingClientRect();
      return new THREE.Vector2(
        ((e.clientX - r.left) / r.width)  * 2 - 1,
        -((e.clientY - r.top) / r.height) * 2 + 1,
      );
    };

    /* ── Mouse interaction state ── */
    let orbiting   = false;
    let orbLast    = { x: 0, y: 0 };
    let mDn        = { x: 0, y: 0 };
    let didMove    = false;
    /** In-progress polygon vertices (world x, z) for the polygon tool. */
    let polyDraft: [number, number][] = [];
    type FeatDrag = { id: number };
    type ObsDrag  = { id: number; ox: number; oz: number };
    type ACDrag   = { id: number };
    type HandleDrag = { id: number; dir: "L"|"R"|"T"|"B" };
    let featDrag: FeatDrag | null   = null;
    let obsDrag:  ObsDrag  | null   = null;
    let acDrag:   ACDrag   | null   = null;
    let handleDrag: HandleDrag | null = null;

    const wallPlane = new THREE.Plane();

    /**
     * Wall hit-test. Returns intersections whose `userData.wall` is one of
     * S/N/E/W (the project compass).
     *
     * When the scene has an STL with role==="room" we raycast against the
     * STL geometry directly and synthesise the wall direction from the
     * hit face's world-space normal — that way clicks on the inside of an
     * L-shaped room land on the STL surface, not the (invisible) cuboidal
     * bbox wall sitting outside the actual perimeter.
     *
     * Note: three.js's `intersectObjects` ignores the `visible` flag, so
     * we cannot rely on hiding the cuboidal walls to skip them — we have
     * to actually exclude them from the raycast target list.
     */
    function intersectWalls(e: MouseEvent): THREE.Intersection[] {
      raycaster.setFromCamera(ndc(e), camera);
      const s = sceneRef.current;
      if (!s) return [];
      const hasRoomSTL = latestRef.current.scene.geometry.stl
        .some((so) => so.role === "room");
      if (hasRoomSTL) {
        // Raycast against the room STL meshes (ignoring obstacle STLs).
        const targets: THREE.Object3D[] = [];
        groups.stl.children.forEach((g) => {
          if (!g.userData?.isRoom) return;
          g.traverse((o) => {
            // Edges line-segments aren't useful pickers; only meshes.
            if ((o as THREE.Mesh).isMesh) targets.push(o);
          });
        });
        if (targets.length === 0) return [];
        const hits = raycaster.intersectObjects(targets, false);
        // Filter to PERIMETER WALL triangles only — reject hits on:
        //   • floor / ceiling (face normal mostly vertical)
        //   • interior cabinets / steps / chimney (full-height check)
        // For each surviving hit, compute the INWARD direction (face
        // normal flipped to point toward the room centroid) and store it
        // on the hit object so the placement step can walk along it
        // until the AC sits in fluid air. Two-face thick walls are
        // handled automatically: a click on the outer face has its inward
        // pointing INTO the wall material; the placement walks through
        // the material until it pops out on the inner face inside the
        // room — that's where the AC lands.
        const roomH = latestRef.current.scene.geometry.H;
        const filtered: THREE.Intersection[] = [];
        for (const h of hits) {
          if (!isPerimeterWallHit(h, roomH)) continue;
          const inward = inwardFromHit(h);
          const w = wallFromInward(inward);
          h.object.userData = { ...(h.object.userData || {}), isWall: true, wall: w };
          (h as HitWithWall).inwardX = inward.x;
          (h as HitWithWall).inwardZ = inward.z;
          (h as HitWithWall).wallDir = w;
          filtered.push(h);
        }
        return filtered;
      }
      const ms = s.roomMeshes;
      if (!ms) return [];
      return raycaster.intersectObjects([
        ms.walls.S, ms.walls.N, ms.walls.W, ms.walls.E,
      ], false);
    }
    /**
     * Decide if a hit is on a perimeter room wall (vs floor / ceiling /
     * interior cabinet / step). Two checks:
     *   1. Face normal must be mostly horizontal (|n.y| < 0.30) — not floor/ceiling.
     *   2. The hit triangle's Y span must cover ≥ 50 % of the room height —
     *      cabinets and steps are short (< 0.5 H), real perimeter walls
     *      go floor→ceiling.
     */
    function isPerimeterWallHit(h: THREE.Intersection, roomH: number): boolean {
      type FaceLike = { normal: THREE.Vector3; a: number; b: number; c: number };
      const face = (h as THREE.Intersection & { face?: FaceLike }).face;
      if (!face) return false;
      // Normal: transform to world space.
      const nm = new THREE.Matrix3().getNormalMatrix(h.object.matrixWorld);
      const wn = face.normal.clone().applyMatrix3(nm).normalize();
      if (Math.abs(wn.y) > 0.30) return false;        // floor/ceiling/sloped roof
      // Triangle Y span: pull the three vertices from the geometry.
      const mesh = h.object as THREE.Mesh;
      const geo = mesh.geometry as THREE.BufferGeometry;
      const pos = geo.attributes.position as THREE.BufferAttribute | undefined;
      if (!pos) return true;       // can't tell, accept conservatively
      const v = new THREE.Vector3();
      let yMin = +Infinity, yMax = -Infinity;
      for (const idx of [face.a, face.b, face.c]) {
        v.fromBufferAttribute(pos, idx).applyMatrix4(mesh.matrixWorld);
        if (v.y < yMin) yMin = v.y;
        if (v.y > yMax) yMax = v.y;
      }
      const span = yMax - yMin;
      return span >= 0.50 * roomH;
    }
    function intersectFloor(e: MouseEvent) {
      raycaster.setFromCamera(ndc(e), camera);
      const s = sceneRef.current;
      if (!s) return null;
      const hasRoomSTL = latestRef.current.scene.geometry.stl
        .some((so) => so.role === "room");
      if (hasRoomSTL) {
        // Same as walls: pick directly on the STL room (any +Y-facing face
        // near the floor Y) so floor-tool clicks land inside the actual
        // L-shaped footprint, not the bbox cuboid.
        const targets: THREE.Object3D[] = [];
        groups.stl.children.forEach((g) => {
          if (!g.userData?.isRoom) return;
          g.traverse((o) => { if ((o as THREE.Mesh).isMesh) targets.push(o); });
        });
        const hits = raycaster.intersectObjects(targets, false);
        if (hits.length) return hits[0].point;
        // Fall through: if the user clicked outside the STL, try the
        // cuboidal floor as a backup (so they can still drop obstacles
        // on the slab even when zoomed wide).
      }
      const ms = s.roomMeshes;
      if (!ms) return null;
      const h = raycaster.intersectObjects([ms.floor], false);
      return h.length ? h[0].point : null;
    }
    /**
     * Compute the world-space INWARD direction for a wall hit: the side
     * of the triangle that faces the room interior. We take the face
     * normal in world space and flip it (if needed) so it points roughly
     * toward the room centroid (origin XZ).
     *
     * Why use the face normal (not the click position): for thick walls,
     * a click on the OUTER face has the click position OUTSIDE the room,
     * but the face normal still tells us which side is the wall material.
     * Flipping toward the centroid yields a direction that walks INTO
     * the wall material → emerges through the inner face → enters the
     * room. The placement step uses this to land on the inner face
     * regardless of which face the user clicked on.
     */
    function inwardFromHit(h: THREE.Intersection): THREE.Vector3 {
      const face = (h as THREE.Intersection & { face?: { normal: THREE.Vector3 } }).face;
      const n = face?.normal ?? new THREE.Vector3(0, 0, -1);
      const nm = new THREE.Matrix3().getNormalMatrix(h.object.matrixWorld);
      const wn = n.clone().applyMatrix3(nm).normalize();
      // Flip so it points toward the room centroid in XZ.
      // (Centroid of an STL room auto-fitted to its bbox is at world origin.)
      const towardCentroid = new THREE.Vector3(-h.point.x, 0, -h.point.z);
      const dot = wn.x * towardCentroid.x + wn.z * towardCentroid.z;
      if (dot < 0) wn.multiplyScalar(-1);
      // Force horizontal — wall normals can have tiny y components from
      // mesh export noise; AC placement only cares about XZ direction.
      wn.y = 0; wn.normalize();
      return wn;
    }
    function wallFromInward(inward: THREE.Vector3): Wall {
      // Inward = direction into the room from the wall surface. The wall
      // ITSELF sits on the opposite side, so:
      //   inward +X → wall is on the W (−X) side of the room → "W"
      //   inward −X → wall is on the E side                  → "E"
      //   inward +Z → wall is on the S (−Z) side             → "S"
      //   inward −Z → wall is on the N side                  → "N"
      const ax = Math.abs(inward.x), az = Math.abs(inward.z);
      if (ax > az) return inward.x > 0 ? "W" : "E";
      return inward.z > 0 ? "S" : "N";
    }
    interface HitWithWall extends THREE.Intersection {
      wallDir: Wall;
      inwardX: number;
      inwardZ: number;
    }
    function pickFeat(e: MouseEvent): Opening | null {
      const targets: THREE.Object3D[] = [];
      groups.feat.children.forEach((g) =>
        g.traverse((o) => { if ((o as THREE.Mesh).isMesh) targets.push(o); }));
      raycaster.setFromCamera(ndc(e), camera);
      const h = raycaster.intersectObjects(targets);
      if (!h.length) return null;
      let o: THREE.Object3D | null = h[0].object;
      while (o && !o.userData.isFeat) o = o.parent;
      if (!o) return null;
      const fid = o.userData.fid as number;
      return latestRef.current.scene.openings.find((f) => f.id === fid) ?? null;
    }
    function pickObs(e: MouseEvent): Obstacle | null {
      const targets: THREE.Object3D[] = [];
      groups.obs.children.forEach((g) =>
        g.traverse((o) => { if ((o as THREE.Mesh).isMesh) targets.push(o); }));
      raycaster.setFromCamera(ndc(e), camera);
      const h = raycaster.intersectObjects(targets);
      if (!h.length) return null;
      let o: THREE.Object3D | null = h[0].object;
      while (o && !o.userData.isObs) o = o.parent;
      if (!o) return null;
      const oid = o.userData.oid as number;
      return latestRef.current.scene.obstacles.find((ob) => ob.id === oid) ?? null;
    }
    function pickSTL(e: MouseEvent): { id: number } | null {
      const targets: THREE.Object3D[] = [];
      groups.stl.children.forEach((g) =>
        g.traverse((o) => { if ((o as THREE.Mesh).isMesh) targets.push(o); }));
      raycaster.setFromCamera(ndc(e), camera);
      const h = raycaster.intersectObjects(targets);
      if (!h.length) return null;
      let o: THREE.Object3D | null = h[0].object;
      while (o && !o.userData.isSTL) o = o.parent;
      if (!o) return null;
      return { id: o.userData.sid as number };
    }
    function pickAC(e: MouseEvent): ACUnit | null {
      const targets: THREE.Object3D[] = [];
      groups.ac.children.forEach((g) =>
        g.traverse((o) => { if ((o as THREE.Mesh).isMesh) targets.push(o); }));
      raycaster.setFromCamera(ndc(e), camera);
      const h = raycaster.intersectObjects(targets);
      if (!h.length) return null;
      let o: THREE.Object3D | null = h[0].object;
      while (o && !o.userData.isAC) o = o.parent;
      if (!o) return null;
      const id = o.userData.acid as number;
      return latestRef.current.scene.ac_units.find((a) => a.id === id) ?? null;
    }
    function pickHandle(e: MouseEvent): { id: number; dir: "L"|"R"|"T"|"B" } | null {
      raycaster.setFromCamera(ndc(e), camera);
      const h = raycaster.intersectObjects(groups.handle.children);
      if (!h.length) return null;
      const d = h[0].object.userData;
      return { id: d.fid as number, dir: d.dir as "L"|"R"|"T"|"B" };
    }

    const onDown = (e: MouseEvent) => {
      mDn = { x: e.clientX, y: e.clientY }; didMove = false;
      const p = latestRef.current;
      // Stop any auto-spin once the user grabs the camera/scene
      if (sceneRef.current) sceneRef.current.autoSpinRef.value = 0;

      if (p.curTool !== "orbit") return;

      // Resize handles take priority
      const hh = pickHandle(e);
      if (hh && p.selection.type === "feat" && p.selection.id === hh.id) {
        const f = p.scene.openings.find((x) => x.id === hh.id);
        if (f) {
          handleDrag = hh;
          const wi = wallInfo(p.scene.geometry, f.wall);
          wallPlane.setFromNormalAndCoplanarPoint(wallNormal[f.wall], new THREE.Vector3(...wi.pos));
          canvas.style.cursor = "ew-resize";
          return;
        }
      }
      // Move opening
      const f = pickFeat(e);
      if (f) {
        featDrag = { id: f.id };
        const wi = wallInfo(p.scene.geometry, f.wall);
        wallPlane.setFromNormalAndCoplanarPoint(wallNormal[f.wall], new THREE.Vector3(...wi.pos));
        canvas.style.cursor = "grabbing";
        return;
      }
      // Move obstacle
      const ob = pickObs(e);
      if (ob) {
        const fp = intersectFloor(e);
        const hp = fp ?? new THREE.Vector3();
        obsDrag = { id: ob.id, ox: hp.x - ob.x, oz: hp.z - ob.z };
        canvas.style.cursor = "grabbing";
        return;
      }
      // Move AC unit (slides along its mounted wall)
      const ac = pickAC(e);
      if (ac) {
        acDrag = { id: ac.id };
        const wi = wallInfo(p.scene.geometry, ac.wall);
        wallPlane.setFromNormalAndCoplanarPoint(wallNormal[ac.wall], new THREE.Vector3(...wi.pos));
        canvas.style.cursor = "grabbing";
        return;
      }
      // Otherwise orbit
      orbiting = true; orbLast = { x: e.clientX, y: e.clientY };
      canvas.style.cursor = "grabbing";
    };

    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - mDn.x, dy = e.clientY - mDn.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didMove = true;
      const p = latestRef.current;

      if (handleDrag) {
        const f = p.scene.openings.find((x) => x.id === handleDrag!.id);
        if (!f) return;
        const wi = wallInfo(p.scene.geometry, f.wall);
        wallPlane.setFromNormalAndCoplanarPoint(wallNormal[f.wall], new THREE.Vector3(...wi.pos));
        raycaster.setFromCamera(ndc(e), camera);
        const pt = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(wallPlane, pt)) {
          const uv = worldToUV(p.scene.geometry, f.wall, pt);
          const next = { ...f };
          if (handleDrag!.dir === "L") {
            const nu = Math.min(f.u + f.uw/2 - 0.15, uv.u);
            next.uw = Math.max(0.15, (f.u + f.uw/2) - nu) * 2;
            next.u  = nu + next.uw / 2;
          } else if (handleDrag!.dir === "R") {
            const nu = Math.max(f.u - f.uw/2 + 0.15, uv.u);
            next.uw = Math.max(0.15, nu - (f.u - f.uw/2));
            next.u  = (f.u - f.uw/2) + next.uw / 2;
          } else if (handleDrag!.dir === "T") {
            const nv = Math.max(f.v - f.vh/2 + 0.15, uv.v);
            next.vh = Math.max(0.15, nv - (f.v - f.vh/2));
            next.v  = (f.v - f.vh/2) + next.vh / 2;
          } else {
            const nv = Math.min(f.v + f.vh/2 - 0.15, uv.v);
            next.vh = Math.max(0.15, (f.v + f.vh/2) - nv);
            next.v  = nv + next.vh / 2;
            if (next.type === "door" || next.type === "arch") next.v = next.vh / 2 + 0.01;
          }
          // Clamp into wall
          next.u = Math.max(next.uw/2 + 0.05, Math.min(wi.span - next.uw/2 - 0.05, next.u));
          next.v = Math.max(next.vh/2 + 0.05, Math.min(p.scene.geometry.H - next.vh/2 - 0.05, next.v));
          p.setScene({
            ...p.scene,
            openings: p.scene.openings.map((x) => x.id === f.id ? next : x),
          });
        }
        return;
      }
      if (featDrag) {
        const f = p.scene.openings.find((x) => x.id === featDrag!.id);
        if (!f) return;
        const wi = wallInfo(p.scene.geometry, f.wall);
        wallPlane.setFromNormalAndCoplanarPoint(wallNormal[f.wall], new THREE.Vector3(...wi.pos));
        raycaster.setFromCamera(ndc(e), camera);
        const pt = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(wallPlane, pt)) {
          const uv = worldToUV(p.scene.geometry, f.wall, pt);
          const next = { ...f };
          next.u = Math.max(f.uw/2 + 0.05, Math.min(wi.span - f.uw/2 - 0.05, uv.u));
          if (f.type !== "door" && f.type !== "arch")
            next.v = Math.max(f.vh/2 + 0.05, Math.min(p.scene.geometry.H - f.vh/2 - 0.05, uv.v));
          p.setScene({
            ...p.scene,
            openings: p.scene.openings.map((x) => x.id === f.id ? next : x),
          });
        }
        return;
      }
      if (obsDrag) {
        const fp = intersectFloor(e);
        if (fp) {
          const o = p.scene.obstacles.find((x) => x.id === obsDrag!.id);
          if (!o) return;
          const next = { ...o };
          next.x = Math.max(-p.scene.geometry.L/2 + o.W/2, Math.min(p.scene.geometry.L/2 - o.W/2, fp.x - obsDrag!.ox));
          next.z = Math.max(-p.scene.geometry.W/2 + (o.D || o.W)/2, Math.min(p.scene.geometry.W/2 - (o.D || o.W)/2, fp.z - obsDrag!.oz));
          p.setScene({
            ...p.scene,
            obstacles: p.scene.obstacles.map((x) => x.id === o.id ? next : x),
          });
        }
        return;
      }
      if (acDrag) {
        const a = p.scene.ac_units.find((x) => x.id === acDrag!.id);
        if (!a) return;
        const wi = wallInfo(p.scene.geometry, a.wall);
        wallPlane.setFromNormalAndCoplanarPoint(wallNormal[a.wall], new THREE.Vector3(...wi.pos));
        raycaster.setFromCamera(ndc(e), camera);
        const pt = new THREE.Vector3();
        if (raycaster.ray.intersectPlane(wallPlane, pt)) {
          const snapped = snapACToWall(p.scene.geometry, a.wall, pt.x, pt.z);
          const clamped = clampACAlongWall(p.scene.geometry, a.wall, snapped.x, snapped.z);
          p.setScene({
            ...p.scene,
            ac_units: p.scene.ac_units.map((x) =>
              x.id === a.id ? { ...x, x: clamped.x, z: clamped.z } : x),
          });
        }
        return;
      }
      if (orbiting) {
        sph.th -= (e.clientX - orbLast.x) * 0.0082;
        sph.ph += (e.clientY - orbLast.y) * 0.0082;
        orbLast = { x: e.clientX, y: e.clientY };
        updateCam();
      }
    };

    const onUp = (e: MouseEvent) => {
      const p = latestRef.current;
      const wasDrag = didMove;
      handleDrag = null; featDrag = null; obsDrag = null; acDrag = null; orbiting = false;
      canvas.style.cursor = p.curTool === "orbit" ? "grab" : "crosshair";
      if (wasDrag) return;

      // Click — selection or placement
      if (p.curTool === "orbit") {
        const f = pickFeat(e);
        if (f) { p.setSelection({ id: f.id, type: "feat" }); return; }
        const ob = pickObs(e);
        if (ob) { p.setSelection({ id: ob.id, type: "obs" }); return; }
        const ac = pickAC(e);
        if (ac) { p.setSelection({ id: ac.id, type: "ac" }); return; }
        const so = pickSTL(e);
        if (so) { p.setSelection({ id: so.id, type: "stl" }); return; }
        p.setSelection({ id: null, type: null });
        return;
      }

      // AC placement
      if (p.curTool === "ac") {
        if (p.scene.ac_units.length >= MAX_AC_UNITS) return;
        const wh = intersectWalls(e);
        if (!wh.length) return;
        const h0 = wh[0] as HitWithWall;
        const w = (h0.wallDir ?? (h0.object.userData.wall as Wall)) as Wall;
        const ix = h0.inwardX, iz = h0.inwardZ;
        placeAC(p, w, h0.point.x, h0.point.z, ix, iz);
        return;
      }

      // Wall-opening placement tools
      if (["win","door","circ","arch"].includes(p.curTool)) {
        const wh = intersectWalls(e);
        if (!wh.length) return;
        const w = wh[0].object.userData.wall as Wall;
        const uv = worldToUV(p.scene.geometry, w, wh[0].point);
        placeOpening(p, w, uv.u, uv.v);
        return;
      }

      // Floor-placement obstacles
      if (["box","cyl","shelf","human","appliance","cfan","tfan"].includes(p.curTool)) {
        const fp = intersectFloor(e);
        if (!fp) return;
        placeObstacle(p, fp.x, fp.z);
        return;
      }

      // Polygon (forbidden floor zone)
      if (p.curTool === "polygon") {
        const fp = intersectFloor(e);
        if (!fp) return;
        const isDouble = (e as MouseEvent & { detail?: number }).detail === 2;
        if (isDouble && polyDraft.length >= 3) {
          // Double-click → close
          finalizePolygon(p);
          return;
        }
        polyDraft.push([fp.x, fp.z]);
        return;
      }

      // Restricted-surface patch on a wall
      if (p.curTool === "restrict") {
        const wh = intersectWalls(e);
        if (!wh.length) return;
        const w = wh[0].object.userData.wall as Wall;
        const uv = worldToUV(p.scene.geometry, w, wh[0].point);
        // Default patch size — user can edit the resulting object via the
        // Constraints panel later (or re-place it).
        const span = (w === "S" || w === "N") ? p.scene.geometry.L : p.scene.geometry.W;
        const next = {
          ...p.scene,
          constraints: {
            ...p.scene.constraints,
            restricted_surfaces: [
              ...p.scene.constraints.restricted_surfaces,
              {
                wall: w,
                u: Math.max(0.3, Math.min(span - 0.3, uv.u)),
                v: Math.max(0.3, Math.min(p.scene.geometry.H - 0.3, uv.v)),
                uw: 0.6, vh: 0.5,
                reason: "user-marked",
              },
            ],
          },
        };
        p.setScene(next);
        // stay in restrict tool so user can drop multiple
        return;
      }
    };

    /** Commit the in-progress polygon to scene.constraints. Called on
     *  double-click or Enter. Skips degenerate (<3 vertices) drafts. */
    function finalizePolygon(p: Props): void {
      if (polyDraft.length < 3) { polyDraft = []; return; }
      const next: Scene = {
        ...p.scene,
        constraints: {
          ...p.scene.constraints,
          forbidden_zones: [
            ...p.scene.constraints.forbidden_zones,
            {
              shape: "polygon" as const,
              vertices: polyDraft.map(([x, z]) => [x, z] as [number, number]),
              reason: "user-drawn",
            },
          ],
        },
      };
      polyDraft = [];
      p.setScene(next);
      p.setCurTool("orbit");
    }

    function placeOpening(p: Props, wall: Wall, u: number, v: number) {
      const tool = p.curTool as OpeningType;
      const def  = OPENING_DEFAULTS[tool];
      const wi   = wallInfo(p.scene.geometry, wall);
      const uc   = Math.max(def.uw/2 + 0.05, Math.min(wi.span - def.uw/2 - 0.05, u));
      const vc   = (tool === "door" || tool === "arch")
        ? def.vh / 2 + 0.01
        : Math.min(p.scene.geometry.H - def.vh/2 - 0.1, Math.max(def.vh/2 + 0.2, v));
      const id   = nextId(p.scene);
      const f: Opening = {
        id, wall, type: tool, u: uc, v: vc, ...def, open: true,
        u_value: tool === "door" ? 2.0 : 5.8,
        solar_transmittance: tool === "door" ? 0.0 : 0.65,
        air_permeability:    tool === "door" ? 1.0 : 0.0,
      };
      p.setScene({ ...p.scene, openings: [...p.scene.openings, f] });
      p.setSelection({ id, type: "feat" });
    }
    function placeObstacle(p: Props, x: number, z: number) {
      const shape = p.curTool as ObstacleShape;
      const def   = OBSTACLE_DEFAULTS[shape];
      const id    = nextId(p.scene);
      const ob: Obstacle = {
        id, shape,
        x, z,
        W: def.W ?? 0.5, D: def.D ?? 0.5, H: def.H ?? 1.0,
        Yoff: 0,
        on: true,
        watts:  def.watts,
        rpm:    def.rpm,
        season: def.season,
        dir:    def.dir,
      };
      p.setScene({ ...p.scene, obstacles: [...p.scene.obstacles, ob] });
      p.setSelection({ id, type: "obs" });
    }
    function isInsideSTLRoom(
      g: { L: number; W: number; H: number },
      stl: import("@/lib/io/schema").STLObject,
      x: number, y: number, z: number,
    ): boolean {
      return isInsideRoom(
        { NX: MASK_NX, NY: MASK_NY, NZ: MASK_NZ, L: g.L, W: g.W, H: g.H },
        stl, x, y, z,
      );
    }
    /**
     * Refuse a candidate that's inside the room but too close to a
     * different wall (would put the AC at a corner). Looks `clearance`
     * metres in the four cardinal directions (excluding the wall the AC
     * is mounted on); if any of them hits OUTSIDE the room, that's a
     * corner and we reject.
     */
    function hasClearanceFromOtherWalls(
      g: { L: number; W: number; H: number },
      stl: import("@/lib/io/schema").STLObject,
      x: number, y: number, z: number, clearance: number, mountedWall: Wall,
    ): boolean {
      const probes: { dx: number; dz: number; wall: Wall }[] = [
        { dx: +clearance, dz: 0, wall: "E" },
        { dx: -clearance, dz: 0, wall: "W" },
        { dx: 0, dz: +clearance, wall: "N" },
        { dx: 0, dz: -clearance, wall: "S" },
      ];
      for (const p of probes) {
        if (p.wall === mountedWall) continue;  // OK to be near the mounted wall
        if (!isInsideSTLRoom(g, stl, x + p.dx, y, z + p.dz)) return false;
      }
      return true;
    }
    function placeAC(
      p: Props, wall: Wall, x: number, z: number,
      inwardX?: number, inwardZ?: number,
    ) {
      const roomSTL = p.scene.geometry.stl.find((s) => s.role === "room");
      let px = x, pz = z;
      if (!roomSTL) {
        const snapped = snapACToWall(p.scene.geometry, wall, x, z);
        const clamped = clampACAlongWall(p.scene.geometry, wall, snapped.x, snapped.z);
        px = clamped.x; pz = clamped.z;
      } else {
        // STL room placement: snap the AC's back face to the inner wall
        // surface, regardless of which face was clicked.
        //
        // We get an INWARD vector from intersectWalls (face normal flipped
        // toward the room centroid). Walking from the click point in this
        // direction:
        //   • If user clicked the inner face: AC sits flush, back face
        //     ~AC_D/2 + 2 cm inward of the click point.
        //   • If user clicked the outer face of a thick wall (translucent
        //     render shows both sides): walking inward passes through wall
        //     material (stamped cells), then emerges into the room — the
        //     first AC_centre that lands in a fluid cell is on the inner
        //     face, exactly what the user expects.
        const ix = inwardX ?? 0, iz = inwardZ ?? 0;
        const lenIn = Math.hypot(ix, iz);
        if (lenIn < 0.01) {
          alert("Couldn't determine the wall direction. Click again — try a clearer perimeter wall surface.");
          return;
        }
        const ux = ix / lenIn, uz = iz / lenIn;
        // AC body geometry: depth 0.16 m → centre is offset by half-depth
        // + a tiny clearance so the back face is visibly off the wall.
        const acDepth = 0.16;
        const surfaceClearance = 0.02;
        const baseInset = acDepth / 2 + surfaceClearance;
        // Walk in cell-sized increments (~0.27 m at default grid). At
        // each step, the AC centre must be in a fluid cell — that's the
        // condition for "this side is the inner face."
        let placed = false;
        for (let extra = 0; extra < 1.5; extra += 0.27) {
          const tx = x + ux * (baseInset + extra);
          const tz = z + uz * (baseInset + extra);
          if (isInsideSTLRoom(p.scene.geometry, roomSTL, tx, 1.8, tz)) {
            px = tx; pz = tz;
            placed = true; break;
          }
        }
        if (!placed) {
          alert("AC can't be placed here — no room interior in front of this wall. Pick a different wall surface.");
          return;
        }
      }
      void hasClearanceFromOtherWalls;
      const id = nextId(p.scene);
      // Default mounting height: 1.8 m for STL rooms (typical AC mount,
      // independent of bbox height — important for STLs where the bbox
      // includes a chimney/dormer that would push the 88%·H heuristic
      // way too high). Cuboidal default keeps the legacy 88% behaviour
      // for backward compatibility with the v6 default scene.
      const defaultMountingHeight = roomSTL
        ? Math.min(1.8, p.scene.geometry.H - 0.3)
        : undefined;
      const ac: ACUnit = {
        id,
        wall,
        x: px,
        z: pz,
        mounting_height_m: defaultMountingHeight,
        kw: 1.5,
        capacity_tr: 0.43,
        type: "split",
        throw_distance_m: 4.0,
        airflow_angle_deg: 0,
        vertical_angle_deg: -5,
        flow_rate_cfm: 350,
        supply_temp_C: 14,
        on: true,
      };
      p.setScene({ ...p.scene, ac_units: [...p.scene.ac_units, ac] });
      p.setSelection({ id, type: "ac" });
    }
    function nextId(s: Scene): number {
      let max = 0;
      for (const o of s.openings)  if (o.id > max) max = o.id;
      for (const o of s.obstacles) if (o.id > max) max = o.id;
      for (const a of s.ac_units)  if (a.id > max) max = a.id;
      return max + 1;
    }

    canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      sph.r = Math.max(3, Math.min(62, sph.r + e.deltaY * 0.02));
      updateCam();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    // Keyboard
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack keystrokes that the user is typing into a property-panel
      // input — Backspace inside a number field has to erase a digit, not
      // delete the selected AC. Same goes for Delete inside text fields and
      // any other editable element (textarea, select, contenteditable).
      const t = e.target as HTMLElement | null;
      if (t && (
        t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT" ||
        t.isContentEditable
      )) return;

      const p = latestRef.current;
      if (e.key === "Escape") {
        polyDraft = [];     // discard any in-progress polygon
        p.setCurTool("orbit");
      }
      if (e.key === "Enter" && p.curTool === "polygon") {
        finalizePolygon(p);
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && p.selection.id !== null) {
        if (p.selection.type === "feat") {
          p.setScene({
            ...p.scene,
            openings: p.scene.openings.filter((f) => f.id !== p.selection.id),
          });
        } else if (p.selection.type === "obs") {
          p.setScene({
            ...p.scene,
            obstacles: p.scene.obstacles.filter((o) => o.id !== p.selection.id),
          });
        } else if (p.selection.type === "ac") {
          p.setScene({
            ...p.scene,
            ac_units: p.scene.ac_units.filter((a) => a.id !== p.selection.id),
          });
        } else if (p.selection.type === "stl") {
          p.setScene({
            ...p.scene,
            geometry: {
              ...p.scene.geometry,
              stl: p.scene.geometry.stl.filter((s) => s.id !== p.selection.id),
            },
          });
        }
        p.setSelection({ id: null, type: null });
      }
    };
    window.addEventListener("keydown", onKey);

    // Resize
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      renderer.setSize(r.width, r.height, false);
      camera.aspect = r.width / r.height;
      camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener("resize", resize);

    /* ── Animation loop ── */
    const autoSpinRef = { value: 100 };
    let raf = 0; let lastT = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min((t - lastT) / 1000, 0.05);
      lastT = t;
      if (autoSpinRef.value-- > 0 && !orbiting) {
        sph.th -= 0.0022; updateCam();
      }
      // Spin fan blades
      const p = latestRef.current;
      const obsMap = sceneRef.current?.obsMeshes;
      if (obsMap) {
        for (const ob of p.scene.obstacles) {
          if ((ob.shape === "cfan" || ob.shape === "tfan") && ob.on !== false) {
            const m = obsMap.get(ob.id);
            const blades = m?.userData.fanBlades as THREE.Group | undefined;
            if (blades) {
              const axis = ob.shape === "cfan" ? "y" : "z";
              blades.rotation[axis as "y" | "z"] += (ob.rpm || 120) / 60 * Math.PI * 2 * dt;
            }
          }
        }
      }
      // Particles step
      const snap = sceneRef.current?.particles
        ? (sceneRef.current.particles as Particles)
        : null;
      void snap;
      const particles = sceneRef.current?.particles;
      const arrows    = sceneRef.current?.arrows;
      const overlays  = sceneRef.current?.overlays;
      // We use the latest snapshot via a ref stored on sceneRef
      const lastSnap = (sceneRef.current as { latestSnap?: CFDSnapshot } | null)?.latestSnap;
      if (particles && lastSnap && p.simRunning) {
        // Augment p.ac with mounting_height_m from the scene so particles
        // spawn at the actual AC mounting height (not the legacy 0.82·H
        // bbox heuristic, which puts them above a chimney peak in STL
        // rooms and out of the throw cone).
        const acWithY = p.ac.map((a) => {
          const u = p.scene.ac_units.find((x) => x.x === a.x && x.z === a.z && x.wall === a.wall);
          return { ...a, mounting_height_m: u?.mounting_height_m };
        });
        particles.step(dt, p.scene.geometry, p.scene.obstacles, lastSnap, p.simView, acWithY);
      }
      void arrows; void overlays;

      renderer.render(scene, camera);
    };
    canvas.style.cursor = "grab";
    updateCam();
    loop(0);

    latestRef.current.onCanvasMount?.(canvas);

    sceneRef.current = {
      renderer, scene, camera, raycaster, sph, autoSpinRef,
      groups,
      roomMeshes: null, overlays: null, arrows: null, fieldPoints: null, particles: null,
      featMeshes: new Map(),
      obsMeshes:  new Map(),
      acMeshes:   new Map(),
      stlMeshes:  new Map(),
      constraintMeshes: null,
      geomKey: "",
    };

    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", resize);
      const s = sceneRef.current;
      s?.roomMeshes?.dispose();
      s?.overlays?.dispose();
      s?.arrows?.dispose();
      s?.fieldPoints?.dispose();
      s?.particles?.dispose();
      for (const g of s?.featMeshes.values() ?? []) disposeGroup(g);
      for (const g of s?.obsMeshes.values()  ?? []) disposeGroup(g);
      for (const g of s?.acMeshes.values()   ?? []) disposeGroup(g);
      for (const g of s?.stlMeshes.values()  ?? []) disposeGroup(g);
      s?.constraintMeshes?.dispose();
      renderer.dispose();
      sceneRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── 2. Update cursor when tool changes ───────────────────────────── */
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    canvas.style.cursor = props.curTool === "orbit" ? "grab" : "crosshair";
  }, [props.curTool]);

  /* ── 3. Rebuild room when geometry changes ─────────────────────────── */
  const { L, W, H } = props.scene.geometry;
  const hasRoomSTL = props.scene.geometry.stl.some((s) => s.role === "room");
  // `geomKey` includes the hasRoomSTL flag so toggling Use-as-room rebuilds
  // the cuboidal shell (visible vs hidden).
  const geomKey = `${L},${W},${H},${hasRoomSTL ? "stl" : "box"}`;
  useEffect(() => {
    const s = sceneRef.current; if (!s) return;
    if (s.geomKey === geomKey && s.roomMeshes && s.overlays && s.arrows && s.fieldPoints) return;
    if (s.roomMeshes) { s.groups.room.remove(s.roomMeshes.group);   s.roomMeshes.dispose(); }
    if (s.overlays)   { s.groups.overlay.remove(s.overlays.group);  s.overlays.dispose(); }
    if (s.arrows)     { s.groups.arrow.remove(s.arrows.group);      s.arrows.dispose(); }
    if (s.fieldPoints) { s.groups.field.remove(s.fieldPoints.group); s.fieldPoints.dispose(); }
    s.roomMeshes = buildRoomMeshes(props.scene.geometry, { hideShell: hasRoomSTL });
    s.overlays   = buildOverlays(props.scene.geometry, { suppressBboxWallOverlays: hasRoomSTL });
    s.arrows     = buildArrows(props.scene.geometry);
    s.fieldPoints = buildFieldPoints(props.scene.geometry);
    if (!s.particles) {
      s.particles = buildParticles();
      s.groups.part.add(s.particles.group);
    }
    s.groups.room.add(s.roomMeshes.group);
    s.groups.overlay.add(s.overlays.group);
    s.groups.arrow.add(s.arrows.group);
    s.groups.field.add(s.fieldPoints.group);
    s.geomKey = geomKey;
    s.sph.r = Math.max(L, W, H) * 2.8;
  }, [geomKey, L, W, H, hasRoomSTL, props.scene.geometry]);

  /* ── 4. Sync openings ──────────────────────────────────────────────── */
  useEffect(() => {
    const s = sceneRef.current; if (!s) return;
    const seen = new Set<number>();
    for (const f of props.scene.openings) {
      seen.add(f.id);
      const old = s.featMeshes.get(f.id);
      if (old) { s.groups.feat.remove(old); disposeGroup(old); }
      const m = buildOpening(props.scene.geometry, f);
      s.featMeshes.set(f.id, m);
      s.groups.feat.add(m);
    }
    for (const [id, m] of s.featMeshes) {
      if (!seen.has(id)) { s.groups.feat.remove(m); disposeGroup(m); s.featMeshes.delete(id); }
    }
  }, [props.scene.openings, props.scene.geometry]);

  /* ── 5. Sync obstacles ────────────────────────────────────────────── */
  useEffect(() => {
    const s = sceneRef.current; if (!s) return;
    const seen = new Set<number>();
    for (const ob of props.scene.obstacles) {
      seen.add(ob.id);
      const old = s.obsMeshes.get(ob.id);
      if (old) { s.groups.obs.remove(old); disposeGroup(old); }
      const m = buildObstacle(props.scene.geometry, ob);
      s.obsMeshes.set(ob.id, m);
      s.groups.obs.add(m);
    }
    for (const [id, m] of s.obsMeshes) {
      if (!seen.has(id)) { s.groups.obs.remove(m); disposeGroup(m); s.obsMeshes.delete(id); }
    }
  }, [props.scene.obstacles, props.scene.geometry]);

  /* ── 5a-2. Sync constraint visualizations (zones + restricted patches) ── */
  useEffect(() => {
    const s = sceneRef.current; if (!s) return;
    if (s.constraintMeshes) {
      s.groups.cons.remove(s.constraintMeshes.group);
      s.constraintMeshes.dispose();
    }
    s.constraintMeshes = buildConstraintMeshes(
      props.scene.geometry,
      props.scene.constraints.forbidden_zones,
      props.scene.constraints.restricted_surfaces,
    );
    s.groups.cons.add(s.constraintMeshes.group);
  }, [props.scene.constraints, props.scene.geometry]);

  /* ── 5a-3. Sync imported STL meshes ────────────────────────────────── */
  // The clip plane is a horizontal plane whose normal points DOWN (0,-1,0)
  // and whose constant is `clipY`. Three.js convention: a point P is
  // clipped iff plane.normal·P + plane.constant < 0; with normal (0,-1,0)
  // that's -P.y + clipY < 0  ⇔  P.y > clipY. So everything above clipY
  // disappears, which is exactly "peel the roof off at this height".
  const clipY = props.clipY ?? 0;
  const hideRoof = !!props.hideRoof;
  useEffect(() => {
    const s = sceneRef.current; if (!s) return;
    const seen = new Set<number>();
    const plane = clipY > 0 && clipY < props.scene.geometry.H
      ? new THREE.Plane(new THREE.Vector3(0, -1, 0), clipY)
      : undefined;
    for (const so of props.scene.geometry.stl) {
      seen.add(so.id);
      const old = s.stlMeshes.get(so.id);
      if (old) { s.groups.stl.remove(old); disposeGroup(old); }
      // Roof threshold: top 15% of the STL bbox (everything in the upper
      // 15% slice gets dropped when hideRoof is on). The auto-classifier
      // (day-2) will replace this with proper "roof patch" tagging.
      const roofYThreshold = so.bbox
        ? so.y + (so.scale || 1) * (so.bbox.minY + 0.85 * (so.bbox.maxY - so.bbox.minY))
        : props.scene.geometry.H * 0.85;
      const m = buildSTLMesh(so, {
        clipPlane: plane,
        hideRoof: hideRoof && so.role === "room",
        roofYThreshold,
      });
      if (m) {
        s.stlMeshes.set(so.id, m);
        s.groups.stl.add(m);
      }
    }
    for (const [id, m] of s.stlMeshes) {
      if (!seen.has(id)) { s.groups.stl.remove(m); disposeGroup(m); s.stlMeshes.delete(id); }
    }
  }, [props.scene.geometry.stl, clipY, hideRoof, props.scene.geometry.H]);

  /* ── 5b. Sync AC units ─────────────────────────────────────────────── */
  useEffect(() => {
    const s = sceneRef.current; if (!s) return;
    const seen = new Set<number>();
    for (const a of props.scene.ac_units) {
      seen.add(a.id);
      const old = s.acMeshes.get(a.id);
      if (old) { s.groups.ac.remove(old); disposeGroup(old); }
      const m = buildACUnit(props.scene.geometry, a);
      s.acMeshes.set(a.id, m);
      s.groups.ac.add(m);
    }
    for (const [id, m] of s.acMeshes) {
      if (!seen.has(id)) { s.groups.ac.remove(m); disposeGroup(m); s.acMeshes.delete(id); }
    }
  }, [props.scene.ac_units, props.scene.geometry]);

  /* ── 6. Resize handles for selected opening ────────────────────────── */
  useEffect(() => {
    const s = sceneRef.current; if (!s) return;
    while (s.groups.handle.children.length) {
      const c = s.groups.handle.children[0];
      s.groups.handle.remove(c);
      disposeGroup(c as THREE.Group);
    }
    if (props.selection.type !== "feat" || props.selection.id === null) return;
    const f = props.scene.openings.find((x) => x.id === props.selection.id);
    if (!f) return;
    const positions: [string, number, number][] = [
      ["L", f.u - f.uw / 2, f.v],
      ["R", f.u + f.uw / 2, f.v],
      ["T", f.u,             f.v + f.vh / 2],
      ["B", f.u,             f.v - f.vh / 2],
    ];
    for (const [dir, hu, hv] of positions) {
      const hm = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, 0.1, 0.1),
        new THREE.MeshBasicMaterial({ color: 0xffd040, transparent: true, opacity: 0.9 }),
      );
      hm.position.copy(uvToWorld(props.scene.geometry, f.wall, hu, hv));
      hm.userData = { isHandle: true, dir, fid: f.id };
      const grp = new THREE.Group();
      grp.add(hm);
      s.groups.handle.add(grp);
    }
  }, [props.selection, props.scene.openings, props.scene.geometry]);

  /* ── 7. Subscribe to CFD snapshots → update overlays + arrows ──────── */
  useEffect(() => {
    const unsub = props.subscribeSnapshot((snap) => {
      const s = sceneRef.current; if (!s) return;
      // Stash the snapshot so the animation loop can step particles
      (s as { latestSnap?: CFDSnapshot }).latestSnap = snap;
      const view = latestRef.current.simView;
      const env  = latestRef.current.scene.environment;
      const ctx  = isComfortView(view)
        ? makeComfortContext(snap.T, env.RH_outdoor_pct, env.met, env.clo)
        : undefined;
      const anchor = latestRef.current.ac[0];
      s.overlays?.setCurtainAnchor(anchor?.x ?? 0, anchor?.z ?? 0);
      s.overlays?.update(snap, view, ctx);
      if (!isComfortView(view)) {
        s.fieldPoints?.update(snap, view);
      }
      if (view !== "therm" && !isComfortView(view)) {
        s.arrows?.update(snap);
      }
    });
    return unsub;
  }, [props.subscribeSnapshot]);

  /* ── 8. View toggle / running state → opacities + visibility ───────── */
  useEffect(() => {
    const s = sceneRef.current; if (!s) return;
    s.overlays?.setOpacity(props.simView, props.simRunning);
    const arrowsVisible = props.simRunning && props.simView !== "therm" && !isComfortView(props.simView);
    s.arrows?.setVisible(arrowsVisible);
    s.fieldPoints?.setVisible(props.simRunning && !isComfortView(props.simView));
    s.particles?.setVisible(props.simRunning && !isComfortView(props.simView));
    const acWithY = props.ac.map((a) => {
      const u = props.scene.ac_units.find((x) => x.x === a.x && x.z === a.z && x.wall === a.wall);
      return { ...a, mounting_height_m: u?.mounting_height_m };
    });
    if (props.simRunning && s.particles) s.particles.reset(props.scene.geometry, acWithY);
    s.overlays?.setCurtainAnchor(props.ac[0]?.x ?? 0, props.ac[0]?.z ?? 0);
    // Repaint overlay textures with the cached snapshot so the new view
    // is visible immediately, without waiting for the next worker tick.
    const snap = (s as { latestSnap?: CFDSnapshot }).latestSnap;
    if (snap && s.overlays) {
      const env = props.scene.environment;
      const ctx = isComfortView(props.simView)
        ? makeComfortContext(snap.T, env.RH_outdoor_pct, env.met, env.clo)
        : undefined;
      s.overlays.update(snap, props.simView, ctx);
      if (!isComfortView(props.simView)) s.fieldPoints?.update(snap, props.simView);
    }
  }, [props.simView, props.simRunning, props.ac, props.scene.geometry, props.scene.environment]);

  return <canvas ref={canvasRef} className="block h-full w-full" />;
}
