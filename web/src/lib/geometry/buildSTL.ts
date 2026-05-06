/**
 * Render an `STLObject` as a Three.js Mesh with the user's transform
 * (position, scale, rotation) applied.
 *
 * When `stl.role === "room"` the STL becomes the simulation domain itself
 * rather than an interior object: it's drawn translucent + double-sided so
 * the camera can sit inside or outside without wall-back-face culling
 * hiding things; it can be clipped by a horizontal plane (peel the roof
 * off) and the user can hide topmost faces entirely via `roomOpts`.
 */

import * as THREE from "three";
import type { STLObject } from "@/lib/io/schema";

const D2R = Math.PI / 180;

export interface STLBuildOptions {
  /**
   * If provided AND the STL has role==="room", clipping is enabled on its
   * material with this plane (typically a horizontal Y-plane at user-set
   * height; `localClippingEnabled` must be on the renderer).
   */
  clipPlane?: THREE.Plane;
  /**
   * If true AND role==="room", per-triangle filtering hides the topmost
   * portion of the mesh (any triangle whose minY > `roofYThreshold`). Use
   * `roofYThreshold = bbox.maxY - 0.001` for "the very top face only", or
   * lower for "the whole roof region".
   */
  hideRoof?: boolean;
  /** Y-coordinate (post-scale, post-translate, world space) above which
   *  to consider triangles part of the roof. */
  roofYThreshold?: number;
}

export function buildSTLMesh(
  stl: STLObject, opts: STLBuildOptions = {},
): THREE.Group | null {
  if (!stl.positions || stl.positions.length === 0) return null;
  const isRoom = stl.role === "room";

  const grp = new THREE.Group();
  grp.userData = { isSTL: true, sid: stl.id, isRoom };

  let positions = stl.positions;
  if (isRoom && opts.hideRoof && opts.roofYThreshold !== undefined) {
    positions = filterOutRoofTriangles(stl, opts.roofYThreshold);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();

  const mat = isRoom
    ? new THREE.MeshStandardMaterial({
        color: 0x6e8eb8,
        metalness: 0.05,
        roughness: 0.6,
        flatShading: true,
        // Translucent + DoubleSide — see plan for why both are essential
        // for closed-room STLs viewed from any camera position.
        transparent: true,
        opacity: 0.28,
        side: THREE.DoubleSide,
        depthWrite: false,
        clippingPlanes: opts.clipPlane ? [opts.clipPlane] : null,
      })
    : new THREE.MeshStandardMaterial({
        color: 0x88a0c0,
        metalness: 0.05,
        roughness: 0.55,
        flatShading: true,
      });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData = { isSTL: true, sid: stl.id, isRoom };
  // Apply Euler rotations in YXZ order to match the rest of the codebase
  mesh.rotation.set(
    (stl.rx_deg || 0) * D2R,
    (stl.ry_deg || 0) * D2R,
    (stl.rz_deg || 0) * D2R,
    "YXZ",
  );
  mesh.scale.setScalar(stl.scale || 1);
  mesh.position.set(stl.x, stl.y, stl.z);
  mesh.castShadow = !isRoom;       // a translucent roof shouldn't cast hard shadows
  mesh.receiveShadow = !isRoom;

  grp.add(mesh);

  // For room STLs, also draw the silhouette edges so the boundary is
  // legible even at low opacity. EdgesGeometry collapses any triangle
  // pair whose dihedral angle ≤ thresholdAngle to one shared edge, so the
  // line count stays modest even on complex meshes.
  if (isRoom) {
    const edgeGeo = new THREE.EdgesGeometry(geo, 35);
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x9bb6dc, transparent: true, opacity: 0.55,
      clippingPlanes: opts.clipPlane ? [opts.clipPlane] : null,
    });
    const lines = new THREE.LineSegments(edgeGeo, edgeMat);
    lines.rotation.copy(mesh.rotation);
    lines.scale.copy(mesh.scale);
    lines.position.copy(mesh.position);
    lines.userData = { isSTL: true, sid: stl.id, isRoomEdges: true };
    grp.add(lines);
  }

  return grp;
}

/**
 * Return a copy of the STL position array with every triangle whose lowest
 * vertex sits above `worldYThreshold` removed — i.e. drop the roof.
 *
 * Threshold is in world space (post-scale, post-translate); we transform
 * each vertex's Y by the same scale + offset that would be applied at
 * render time, so the filter behaves predictably regardless of how the
 * user has placed the STL.
 */
function filterOutRoofTriangles(stl: STLObject, worldYThreshold: number): Float32Array {
  if (!stl.positions) return new Float32Array(0);
  const src = stl.positions;
  const s = stl.scale || 1;
  const yOff = stl.y;
  const out: number[] = [];
  for (let i = 0; i + 9 <= src.length; i += 9) {
    const wy0 = s * src[i + 1] + yOff;
    const wy1 = s * src[i + 4] + yOff;
    const wy2 = s * src[i + 7] + yOff;
    const minY = Math.min(wy0, wy1, wy2);
    if (minY > worldYThreshold) continue;
    for (let k = 0; k < 9; k++) out.push(src[i + k]);
  }
  return new Float32Array(out);
}
