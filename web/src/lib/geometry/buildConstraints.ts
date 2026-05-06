/**
 * Constraint visualization meshes — translucent red overlays for forbidden
 * floor zones (polygon or AABB) and restricted wall surfaces.
 *
 * Polygon triangulation uses fan triangulation from vertex 0. That works
 * cleanly for convex polygons; concave polygons render with a few overdraw
 * artefacts but still look obviously "blocked-off" to the user. A proper
 * ear-clipping triangulator can replace this when the constraint editor
 * gains polygon manipulation tools (Phase 5 polish).
 */

import * as THREE from "three";
import { uvToWorld } from "@/lib/geometry/walls";
import type { Geometry, ForbiddenZone, RestrictedSurface, Wall } from "@/lib/io/schema";

const ZONE_COLOR     = 0xff4040;
const ZONE_OPACITY   = 0.35;
const PATCH_OPACITY  = 0.55;
const FLOOR_LIFT     = 0.022;     // sit just above the floor texture
const WALL_LIFT      = 0.010;

export interface ConstraintMeshes {
  group: THREE.Group;
  dispose(): void;
}

export function buildConstraintMeshes(
  geo: Geometry,
  zones: ForbiddenZone[],
  patches: RestrictedSurface[],
): ConstraintMeshes {
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];

  // ── Forbidden floor zones ──
  for (const z of zones) {
    if (z.shape === "polygon" && z.vertices && z.vertices.length >= 3) {
      const mesh = polygonMesh(z.vertices);
      group.add(mesh);
      disposables.push(mesh.geometry, mesh.material as THREE.Material);
      // outline
      const outline = polygonOutline(z.vertices);
      group.add(outline);
      disposables.push(outline.geometry, outline.material as THREE.Material);
    } else if (z.shape === "box" &&
               z.x !== undefined && z.z !== undefined &&
               z.W !== undefined && z.D !== undefined) {
      const verts: [number, number][] = [
        [z.x - z.W / 2, z.z - z.D / 2],
        [z.x + z.W / 2, z.z - z.D / 2],
        [z.x + z.W / 2, z.z + z.D / 2],
        [z.x - z.W / 2, z.z + z.D / 2],
      ];
      const mesh = polygonMesh(verts);
      group.add(mesh);
      disposables.push(mesh.geometry, mesh.material as THREE.Material);
    }
  }

  // ── Restricted wall surfaces ──
  for (const rs of patches) {
    const mesh = wallPatchMesh(geo, rs);
    if (mesh) {
      group.add(mesh);
      disposables.push(mesh.geometry, mesh.material as THREE.Material);
    }
  }

  return {
    group,
    dispose() { for (const d of disposables) d.dispose(); },
  };
}

function polygonMesh(verts: [number, number][]): THREE.Mesh {
  // Ear-clipping triangulation — handles concave polygons cleanly
  const tris = earClip(verts);
  const positions: number[] = [];
  for (const [a, b, c] of tris) {
    const [ax, az] = verts[a], [bx, bz] = verts[b], [cx, cz] = verts[c];
    positions.push(ax, FLOOR_LIFT, az,  bx, FLOOR_LIFT, bz,  cx, FLOOR_LIFT, cz);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({
    color: ZONE_COLOR,
    transparent: true,
    opacity: ZONE_OPACITY,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  return new THREE.Mesh(geo, mat);
}

/**
 * Classic ear-clipping triangulation — O(n²) which is fine for the small
 * polygons users draw on the floor. Returns an array of [i, j, k] vertex
 * indices into the input list.
 *
 * Handles both clockwise and counter-clockwise input. Skips degenerate
 * vertices but doesn't repair self-intersecting polygons (the user has
 * to redraw those).
 */
function earClip(verts: [number, number][]): [number, number, number][] {
  const n = verts.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];

  const indices = Array.from({ length: n }, (_, i) => i);
  // Ensure counter-clockwise winding (positive signed area)
  if (signedArea(verts) < 0) indices.reverse();

  const tris: [number, number, number][] = [];
  let remaining = indices.slice();
  let guard = 0;
  while (remaining.length > 3 && guard++ < n * n) {
    let earFound = false;
    for (let i = 0; i < remaining.length; i++) {
      const a = remaining[(i - 1 + remaining.length) % remaining.length];
      const b = remaining[i];
      const c = remaining[(i + 1) % remaining.length];
      const va = verts[a], vb = verts[b], vc = verts[c];
      // Convex vertex? (cross product positive in CCW)
      if (cross(va, vb, vc) <= 0) continue;
      // No other vertex inside this candidate triangle?
      let any = false;
      for (let j = 0; j < remaining.length; j++) {
        const idx = remaining[j];
        if (idx === a || idx === b || idx === c) continue;
        if (pointInTriangle(verts[idx], va, vb, vc)) { any = true; break; }
      }
      if (any) continue;
      tris.push([a, b, c]);
      remaining.splice(i, 1);
      earFound = true;
      break;
    }
    if (!earFound) {
      // Self-intersecting / numerically pathological polygon — fall
      // back to fan triangulation so the user still sees something.
      remaining = indices.slice();
      tris.length = 0;
      for (let i = 1; i < remaining.length - 1; i++) {
        tris.push([remaining[0], remaining[i], remaining[i + 1]]);
      }
      return tris;
    }
  }
  if (remaining.length === 3) {
    tris.push([remaining[0], remaining[1], remaining[2]]);
  }
  return tris;
}

function signedArea(v: [number, number][]): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const [x1, y1] = v[i];
    const [x2, y2] = v[(i + 1) % v.length];
    s += (x2 - x1) * (y2 + y1);
  }
  return s; // negative = CCW, positive = CW (but we use cross() for ear test)
}

function cross(
  a: [number, number], b: [number, number], c: [number, number],
): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function pointInTriangle(
  p: [number, number],
  a: [number, number], b: [number, number], c: [number, number],
): boolean {
  const d1 = cross(p, a, b);
  const d2 = cross(p, b, c);
  const d3 = cross(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function polygonOutline(verts: [number, number][]): THREE.LineLoop {
  const positions: number[] = [];
  for (const [x, z] of verts) positions.push(x, FLOOR_LIFT + 0.005, z);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0xff8080,
    transparent: true,
    opacity: 0.85,
  });
  return new THREE.LineLoop(geo, mat);
}

function wallPatchMesh(geo: Geometry, rs: RestrictedSurface): THREE.Mesh | null {
  // Build a small rectangular patch on the wall's interior face. Use the
  // existing uvToWorld helper for the corner positions, then assemble two
  // triangles. Lift slightly off the wall to avoid z-fighting.
  const u0 = rs.u - rs.uw / 2, u1 = rs.u + rs.uw / 2;
  const v0 = rs.v - rs.vh / 2, v1 = rs.v + rs.vh / 2;
  const c00 = uvToWorld(geo, rs.wall, u0, v0);
  const c10 = uvToWorld(geo, rs.wall, u1, v0);
  const c01 = uvToWorld(geo, rs.wall, u0, v1);
  const c11 = uvToWorld(geo, rs.wall, u1, v1);
  const lift = wallLiftVec(rs.wall);
  const lifted = (c: THREE.Vector3) => c.clone().add(lift);
  const a = lifted(c00), b = lifted(c10), c = lifted(c01), d = lifted(c11);
  const positions = [
    a.x, a.y, a.z,  b.x, b.y, b.z,  d.x, d.y, d.z,
    a.x, a.y, a.z,  d.x, d.y, d.z,  c.x, c.y, c.z,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({
    color: ZONE_COLOR,
    transparent: true,
    opacity: PATCH_OPACITY,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  return new THREE.Mesh(g, mat);
}

function wallLiftVec(w: Wall): THREE.Vector3 {
  switch (w) {
    case "S": return new THREE.Vector3(0, 0,  WALL_LIFT);
    case "N": return new THREE.Vector3(0, 0, -WALL_LIFT);
    case "W": return new THREE.Vector3( WALL_LIFT, 0, 0);
    case "E": return new THREE.Vector3(-WALL_LIFT, 0, 0);
  }
}
