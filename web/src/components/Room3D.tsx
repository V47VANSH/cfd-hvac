"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { buildRoomMeshes, type RoomMeshes } from "@/lib/geometry/buildRoom";
import { buildOverlays, type Overlays, type SimView } from "@/lib/geometry/buildOverlays";
import { buildArrows,   type ArrowField } from "@/lib/geometry/buildArrows";
import { buildParticles, type Particles  } from "@/lib/geometry/buildParticles";
import { buildOpening } from "@/lib/geometry/buildOpening";
import { buildObstacle } from "@/lib/geometry/buildObstacle";
import { buildACUnit, snapACToWall, clampACAlongWall } from "@/lib/geometry/buildAC";
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
  | "ac";

export interface Selection {
  id: number | null;
  type: "feat" | "obs" | "ac" | null;
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
  latestRef.current = props;

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
      part:    THREE.Group;
      handle:  THREE.Group;
      ac:      THREE.Group;
    };
    roomMeshes: RoomMeshes | null;
    overlays:   Overlays | null;
    arrows:     ArrowField | null;
    particles:  Particles | null;
    featMeshes: Map<number, THREE.Group>;
    obsMeshes:  Map<number, THREE.Group>;
    acMeshes:   Map<number, THREE.Group>;
    geomKey:    string;
  } | null>(null);

  /* ── 1. Mount: renderer, camera, lights, animation loop, handlers ─── */
  useEffect(() => {
    const canvas = canvasRef.current!;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
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
      part:    new THREE.Group(),
      handle:  new THREE.Group(),
      ac:      new THREE.Group(),
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
    type FeatDrag = { id: number };
    type ObsDrag  = { id: number; ox: number; oz: number };
    type ACDrag   = { id: number };
    type HandleDrag = { id: number; dir: "L"|"R"|"T"|"B" };
    let featDrag: FeatDrag | null   = null;
    let obsDrag:  ObsDrag  | null   = null;
    let acDrag:   ACDrag   | null   = null;
    let handleDrag: HandleDrag | null = null;

    const wallPlane = new THREE.Plane();

    function intersectWalls(e: MouseEvent) {
      raycaster.setFromCamera(ndc(e), camera);
      const ms = sceneRef.current?.roomMeshes;
      if (!ms) return [];
      return raycaster.intersectObjects([
        ms.walls.S, ms.walls.N, ms.walls.W, ms.walls.E,
      ]);
    }
    function intersectFloor(e: MouseEvent) {
      raycaster.setFromCamera(ndc(e), camera);
      const ms = sceneRef.current?.roomMeshes;
      if (!ms) return null;
      const h = raycaster.intersectObjects([ms.floor]);
      return h.length ? h[0].point : null;
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
        p.setSelection({ id: null, type: null });
        return;
      }

      // AC placement
      if (p.curTool === "ac") {
        if (p.scene.ac_units.length >= MAX_AC_UNITS) return;
        const wh = intersectWalls(e);
        if (!wh.length) return;
        const w = wh[0].object.userData.wall as Wall;
        placeAC(p, w, wh[0].point.x, wh[0].point.z);
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
    };

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
    function placeAC(p: Props, wall: Wall, x: number, z: number) {
      const snapped = snapACToWall(p.scene.geometry, wall, x, z);
      const clamped = clampACAlongWall(p.scene.geometry, wall, snapped.x, snapped.z);
      const id = nextId(p.scene);
      const ac: ACUnit = {
        id,
        wall,
        x: clamped.x,
        z: clamped.z,
        kw: 1.5,
        capacity_tr: 0.43,
        type: "split",
        throw_distance_m: 4.0,
        airflow_angle_deg: 0,
        flow_rate_cfm: 350,
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
      const p = latestRef.current;
      if (e.key === "Escape") p.setCurTool("orbit");
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
        particles.step(dt, p.scene.geometry, p.scene.obstacles, lastSnap, p.simView, p.ac);
      }
      void arrows; void overlays;

      renderer.render(scene, camera);
    };
    canvas.style.cursor = "grab";
    updateCam();
    loop(0);

    sceneRef.current = {
      renderer, scene, camera, raycaster, sph, autoSpinRef,
      groups,
      roomMeshes: null, overlays: null, arrows: null, particles: null,
      featMeshes: new Map(),
      obsMeshes:  new Map(),
      acMeshes:   new Map(),
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
      s?.particles?.dispose();
      for (const g of s?.featMeshes.values() ?? []) disposeGroup(g);
      for (const g of s?.obsMeshes.values()  ?? []) disposeGroup(g);
      for (const g of s?.acMeshes.values()   ?? []) disposeGroup(g);
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
  const geomKey = `${L},${W},${H}`;
  useEffect(() => {
    const s = sceneRef.current; if (!s) return;
    if (s.geomKey === geomKey && s.roomMeshes && s.overlays && s.arrows) return;
    if (s.roomMeshes) { s.groups.room.remove(s.roomMeshes.group);   s.roomMeshes.dispose(); }
    if (s.overlays)   { s.groups.overlay.remove(s.overlays.group);  s.overlays.dispose(); }
    if (s.arrows)     { s.groups.arrow.remove(s.arrows.group);      s.arrows.dispose(); }
    s.roomMeshes = buildRoomMeshes(props.scene.geometry);
    s.overlays   = buildOverlays(props.scene.geometry);
    s.arrows     = buildArrows(props.scene.geometry);
    if (!s.particles) {
      s.particles = buildParticles();
      s.groups.part.add(s.particles.group);
    }
    s.groups.room.add(s.roomMeshes.group);
    s.groups.overlay.add(s.overlays.group);
    s.groups.arrow.add(s.arrows.group);
    s.geomKey = geomKey;
    s.sph.r = Math.max(L, W, H) * 2.8;
  }, [geomKey, L, W, H, props.scene.geometry]);

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
      s.overlays?.update(snap, latestRef.current.simView);
      if (latestRef.current.simView !== "therm") {
        s.arrows?.update(snap);
      }
    });
    return unsub;
  }, [props.subscribeSnapshot]);

  /* ── 8. View toggle / running state → opacities + visibility ───────── */
  useEffect(() => {
    const s = sceneRef.current; if (!s) return;
    s.overlays?.setOpacity(props.simView, props.simRunning);
    s.arrows?.setVisible(props.simRunning && props.simView !== "therm");
    s.particles?.setVisible(props.simRunning);
    if (props.simRunning && s.particles) s.particles.reset(props.scene.geometry, props.ac);
  }, [props.simView, props.simRunning, props.ac, props.scene.geometry]);

  return <canvas ref={canvasRef} className="block h-full w-full" />;
}
