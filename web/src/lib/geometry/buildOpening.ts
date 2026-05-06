/**
 * Build a THREE.Group representing one wall opening (window / door /
 * round / arch). Ported from v6 fMesh() (lines 446-479).
 */

import * as THREE from "three";
import { uvToWorld, wallInfo, type WallInfo } from "./walls";
import { WT } from "./buildRoom";
import type { Geometry, Opening } from "@/lib/io/schema";

export function buildOpening(geo: Geometry, f: Opening): THREE.Group {
  const d = wallInfo(geo, f.wall);
  const g = new THREE.Group();
  const isOpen = f.open !== false;

  if (f.type === "win") {
    const planeGeo = new THREE.PlaneGeometry(f.uw, f.vh);
    g.add(new THREE.Mesh(planeGeo, new THREE.MeshPhongMaterial({
      color: 0x2266cc, transparent: true, opacity: isOpen ? 0.42 : 0.15,
      side: THREE.DoubleSide, shininess: 120,
    })));
    g.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(planeGeo),
      new THREE.LineBasicMaterial({ color: isOpen ? 0x66aaee : 0x224466 }),
    ));
    const cp = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, -f.vh/2, 0.01),
      new THREE.Vector3(0,  f.vh/2, 0.01),
      new THREE.Vector3(-f.uw/2, 0, 0.01),
      new THREE.Vector3( f.uw/2, 0, 0.01),
    ]);
    g.add(new THREE.LineSegments(cp, new THREE.LineBasicMaterial({
      color: isOpen ? 0x4488cc : 0x1a3450, transparent: true, opacity: 0.5,
    })));
    if (!isOpen) {
      const bar = new THREE.Mesh(
        new THREE.PlaneGeometry(f.uw * 0.8, 0.04),
        new THREE.MeshBasicMaterial({ color: 0xcc4422 }),
      );
      bar.position.z = 0.02;
      g.add(bar);
    }
  } else if (f.type === "door") {
    const planeGeo = new THREE.PlaneGeometry(f.uw, f.vh);
    g.add(new THREE.Mesh(planeGeo, new THREE.MeshLambertMaterial({
      color: isOpen ? 0x6a3010 : 0x2a1408,
      transparent: true, opacity: isOpen ? 1 : 0.4, side: THREE.DoubleSide,
    })));
    g.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(planeGeo),
      new THREE.LineBasicMaterial({ color: isOpen ? 0xd06020 : 0x4a2010 }),
    ));
    const hh = new THREE.Mesh(
      new THREE.SphereGeometry(0.035, 6, 6),
      new THREE.MeshBasicMaterial({ color: isOpen ? 0xffaa40 : 0x443318 }),
    );
    hh.position.set(f.uw * 0.4, -f.vh * 0.05, 0.03);
    g.add(hh);
    if (!isOpen) {
      const bar = new THREE.Mesh(
        new THREE.PlaneGeometry(f.uw * 0.8, 0.04),
        new THREE.MeshBasicMaterial({ color: 0xcc4422 }),
      );
      bar.position.z = 0.02;
      g.add(bar);
    }
  } else if (f.type === "circ") {
    const sh = new THREE.Shape();
    sh.absarc(0, 0, f.uw / 2, 0, Math.PI * 2, false);
    g.add(new THREE.Mesh(
      new THREE.ShapeGeometry(sh, 32),
      new THREE.MeshPhongMaterial({
        color: isOpen ? 0xa0d060 : 0x304010,
        transparent: true, opacity: isOpen ? 0.38 : 0.1, side: THREE.DoubleSide,
      }),
    ));
    g.add(new THREE.Mesh(
      new THREE.TorusGeometry(f.uw / 2, 0.025, 8, 32),
      new THREE.MeshBasicMaterial({ color: isOpen ? 0xc0e870 : 0x405020 }),
    ));
  } else if (f.type === "arch") {
    const r = f.uw / 2, bh = f.vh * 0.5;
    const sh = new THREE.Shape();
    sh.moveTo(-r, -bh);
    sh.lineTo(-r, 0);
    sh.absarc(0, 0, r, Math.PI, 0, true);
    sh.lineTo(r, -bh);
    sh.lineTo(-r, -bh);
    g.add(new THREE.Mesh(
      new THREE.ShapeGeometry(sh, 24),
      new THREE.MeshPhongMaterial({
        color: isOpen ? 0xd0b060 : 0x402808,
        transparent: true, opacity: isOpen ? 0.42 : 0.12, side: THREE.DoubleSide,
      }),
    ));
    const ep: THREE.Vector3[] = [new THREE.Vector3(-r, -bh, 0.01)];
    for (let a = Math.PI; a >= 0; a -= Math.PI / 24)
      ep.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0.01));
    ep.push(new THREE.Vector3(r, -bh, 0.01));
    g.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(ep),
      new THREE.LineBasicMaterial({ color: isOpen ? 0xffe080 : 0x604020 }),
    ));
  }

  const stubGeo = new THREE.BoxGeometry(f.uw, f.vh, WT * 0.8);
  const stub = new THREE.Mesh(stubGeo, new THREE.MeshLambertMaterial({
    color: isOpen ? 0x050e1c : 0x0a0a0a, transparent: true, opacity: 0.95,
  }));
  stub.position.z = -WT * 0.4;
  g.add(stub);

  g.position.copy(uvToWorld(geo, f.wall, f.u, f.v));
  g.rotation.y = wallInfo(geo, f.wall).ry as WallInfo["ry"];
  g.userData = { isFeat: true, fid: f.id };
  return g;
}
