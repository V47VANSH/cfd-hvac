/**
 * Build the room mesh group (floor, walls, ceiling, grid, labels).
 * Ported from v6 `buildRoom()` (lines 361-402).
 *
 * Returns the THREE.Group + a disposer so React can clean up.
 */

import * as THREE from "three";
import type { Geometry } from "@/lib/io/schema";

export const WT = 0.18;             // wall thickness, m

export interface RoomMeshes {
  group: THREE.Group;
  floor: THREE.Mesh;
  walls: Record<"S" | "N" | "E" | "W", THREE.Mesh>;
  dispose: () => void;
}

function makeLabel(text: string, x: number, y: number, z: number): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 72; c.height = 32;
  const cx = c.getContext("2d")!;
  cx.fillStyle = "#3a6888";
  cx.font = "bold 22px sans-serif";
  cx.textAlign = "center";
  cx.textBaseline = "middle";
  cx.fillText(text, 36, 16);
  const tex = new THREE.CanvasTexture(c);
  const sp  = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, opacity: 0.7, depthTest: false,
  }));
  sp.position.set(x, y, z);
  sp.scale.set(0.7, 0.35, 1);
  return sp;
}

export function buildRoomMeshes(geo: Geometry): RoomMeshes {
  const { L, W, H } = geo;
  const T2 = WT;
  const group = new THREE.Group();

  const disposables: { dispose: () => void }[] = [];
  const track = <T extends { dispose: () => void }>(x: T): T => {
    disposables.push(x); return x;
  };

  // Floor
  const floorMat = track(new THREE.MeshLambertMaterial({ color: 0x0e1a28 }));
  const floorGeo = track(new THREE.PlaneGeometry(L, W));
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.001;
  floor.receiveShadow = true;
  floor.userData = { isFloor: true };
  group.add(floor);

  // Grid helper (3× the room extent for visual context)
  const grid = new THREE.GridHelper(
    Math.max(L, W) * 3,
    Math.ceil(Math.max(L, W) * 4),
    0x1a3858, 0x102030,
  );
  grid.position.y = 0.003;
  group.add(grid);

  // Ceiling (translucent)
  const ceilMat = track(new THREE.MeshLambertMaterial({
    color: 0x162538, transparent: true, opacity: 0.25, side: THREE.DoubleSide,
  }));
  const ceilGeo = track(new THREE.PlaneGeometry(L, W));
  const ceil = new THREE.Mesh(ceilGeo, ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = H;
  group.add(ceil);

  // Wall meshes (4)
  const wallColor = 0x18304a;
  const wallColorEW = 0x142840;
  const wallMat = (c: number) => track(new THREE.MeshLambertMaterial({
    color: c, side: THREE.DoubleSide,
  }));
  const edgeMat = track(new THREE.LineBasicMaterial({ color: 0x2a5070 }));

  const addWallEdges = (geo: THREE.BufferGeometry, pos: THREE.Vector3) => {
    const eg = new THREE.EdgesGeometry(geo);
    disposables.push(eg);
    const el = new THREE.LineSegments(eg, edgeMat);
    el.position.copy(pos);
    group.add(el);
  };

  const walls: Record<"S" | "N" | "E" | "W", THREE.Mesh> = {} as never;
  const mkWall = (
    side: "S" | "N" | "E" | "W",
    geo: THREE.BoxGeometry,
    mat: THREE.Material,
    pos: [number, number, number],
  ) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...pos);
    m.receiveShadow = true;
    m.userData = { isWall: true, wall: side };
    group.add(m);
    walls[side] = m;
    addWallEdges(geo, m.position);
  };

  const sGeo = track(new THREE.BoxGeometry(L, H, T2));
  const nGeo = track(new THREE.BoxGeometry(L, H, T2));
  const wGeo = track(new THREE.BoxGeometry(T2, H, W + T2 * 2));
  const eGeo = track(new THREE.BoxGeometry(T2, H, W + T2 * 2));

  mkWall("S", sGeo, wallMat(wallColor),   [0,         H/2, -W/2 - T2/2]);
  mkWall("N", nGeo, wallMat(wallColor),   [0,         H/2,  W/2 + T2/2]);
  mkWall("W", wGeo, wallMat(wallColorEW), [-L/2 - T2/2, H/2, 0]);
  mkWall("E", eGeo, wallMat(wallColorEW), [ L/2 + T2/2, H/2, 0]);

  // Floor slab under the room
  const slabGeo = track(new THREE.BoxGeometry(L + T2 * 2, 0.06, W + T2 * 2));
  const slabMat = track(new THREE.MeshLambertMaterial({
    color: 0x0a1420, side: THREE.DoubleSide,
  }));
  const slab = new THREE.Mesh(slabGeo, slabMat);
  slab.position.set(0, -0.03, 0);
  group.add(slab);

  // Compass labels
  group.add(makeLabel("N", 0,         H * 0.9,  W/2 - 0.12));
  group.add(makeLabel("S", 0,         H * 0.9, -W/2 + 0.12));
  group.add(makeLabel("E",  L/2 + 0.12, H * 0.9, 0));
  group.add(makeLabel("W", -L/2 - 0.12, H * 0.9, 0));

  return {
    group,
    floor,
    walls,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
