/**
 * Build a THREE.Group representing one obstacle: box, cylinder, shelf,
 * human, appliance, ceiling fan, or table fan. Ported from v6 oMesh()
 * (lines 484-539).
 *
 * The fan groups expose userData.fanBlades so the animation loop can
 * spin them.
 */

import * as THREE from "three";
import type { Obstacle, Geometry } from "@/lib/io/schema";

export function buildObstacle(geo: Geometry, ob: Obstacle): THREE.Group {
  const g = new THREE.Group();
  const yo = ob.Yoff || 0;
  const isOn = ob.on !== false;

  if (ob.shape === "box" || ob.shape === "shelf") {
    const boxGeo = new THREE.BoxGeometry(ob.W, ob.H, ob.D || ob.W);
    const m = new THREE.Mesh(boxGeo, new THREE.MeshLambertMaterial({
      color: ob.shape === "shelf" ? 0x3a2010 : 0x172030,
    }));
    m.castShadow = true;
    m.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(boxGeo),
      new THREE.LineBasicMaterial({
        color: ob.shape === "shelf" ? 0x6a4018 : 0x284060,
      }),
    ));
    g.add(m);
  } else if (ob.shape === "cyl") {
    const cylGeo = new THREE.CylinderGeometry(ob.W / 2, ob.W / 2, ob.H, 24);
    const m = new THREE.Mesh(cylGeo, new THREE.MeshLambertMaterial({ color: 0x101e2c }));
    m.castShadow = true;
    m.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(cylGeo),
      new THREE.LineBasicMaterial({ color: 0x203848 }),
    ));
    g.add(m);
  } else if (ob.shape === "human") {
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.24, ob.H * 0.74, 8),
      new THREE.MeshLambertMaterial({ color: isOn ? 0x4a2a18 : 0x1c0e0a }),
    );
    body.position.y = ob.H * 0.37;
    g.add(body);
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.14, 8, 6),
      new THREE.MeshLambertMaterial({ color: isOn ? 0x5a3828 : 0x1c0e0a }),
    );
    head.position.y = ob.H * 0.74 + 0.16;
    g.add(head);
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.35, 6, 6),
      new THREE.MeshBasicMaterial({
        color: isOn ? 0xff4400 : 0x280800,
        transparent: true, opacity: isOn ? 0.12 : 0.03, depthWrite: false,
      }),
    );
    glow.position.y = ob.H * 0.45;
    g.add(glow);
    const eg = new THREE.SphereGeometry(0.22, 8, 6);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(eg),
      new THREE.LineBasicMaterial({
        color: isOn ? 0xc04828 : 0x2a0e08,
        transparent: true, opacity: 0.5,
      }),
    );
    edges.position.y = ob.H * 0.37;
    g.add(edges);
  } else if (ob.shape === "appliance") {
    const boxGeo = new THREE.BoxGeometry(ob.W, ob.H, ob.D || ob.W);
    const m = new THREE.Mesh(boxGeo, new THREE.MeshLambertMaterial({
      color: isOn ? 0x1e1840 : 0x0e0e18,
    }));
    m.castShadow = true;
    m.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(boxGeo),
      new THREE.LineBasicMaterial({ color: isOn ? 0x4838a8 : 0x14121c }),
    ));
    g.add(m);
    const ventGeo = new THREE.BoxGeometry(ob.W * 0.8, 0.04, (ob.D || ob.W) * 0.3);
    const vent = new THREE.Mesh(ventGeo, new THREE.MeshBasicMaterial({
      color: isOn ? 0xff8800 : 0x220d00,
    }));
    vent.position.set(0, ob.H / 2 + 0.02, 0);
    g.add(vent);
    const led = new THREE.Mesh(
      new THREE.SphereGeometry(0.025, 6, 6),
      new THREE.MeshBasicMaterial({ color: isOn ? 0x00ff88 : 0x1a2020 }),
    );
    led.position.set(ob.W * 0.4, ob.H / 2 + 0.02, 0);
    g.add(led);
  } else if (ob.shape === "cfan") {
    const acol = isOn ? 0x334455 : 0x1a2230;
    const mount = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, 0.3, 8),
      new THREE.MeshLambertMaterial({ color: acol }),
    );
    mount.position.y = 0.15;
    g.add(mount);
    const motor = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 0.12, 16),
      new THREE.MeshLambertMaterial({ color: isOn ? 0x445566 : 0x222e38 }),
    );
    motor.position.y = -0.06;
    g.add(motor);
    const bg = new THREE.Group();
    bg.userData.isBlade = true;
    for (let i = 0; i < 4; i++) {
      const piv = new THREE.Group();
      piv.rotation.y = i * Math.PI / 2;
      const bl = new THREE.Mesh(
        new THREE.BoxGeometry(ob.W / 2, 0.022, 0.14),
        new THREE.MeshLambertMaterial({ color: isOn ? 0x8a6030 : 0x443020 }),
      );
      bl.position.x = ob.W / 4;
      piv.add(bl);
      bg.add(piv);
    }
    bg.position.y = -0.12;
    g.add(bg);
    g.userData.fanBlades = bg;
    const led = new THREE.Mesh(
      new THREE.SphereGeometry(0.025, 6, 6),
      new THREE.MeshBasicMaterial({ color: isOn ? 0x00ff60 : 0x1a2020 }),
    );
    led.position.set(0.08, -0.15, 0);
    g.add(led);
    const sMat = new THREE.MeshBasicMaterial({
      color: ob.season === "winter" ? 0x2060ff : 0xff8800,
      transparent: true, opacity: 0.8,
    });
    const sind = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.01, 4, 12), sMat);
    sind.rotation.x = Math.PI / 2;
    sind.position.y = -0.08;
    g.add(sind);
    g.position.set(ob.x, geo.H - 0.15, ob.z);
    g.userData = { ...g.userData, isObs: true, oid: ob.id };
    return g;
  } else if (ob.shape === "tfan") {
    const acol = isOn ? 0x223344 : 0x121820;
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.14, 0.05, 16),
      new THREE.MeshLambertMaterial({ color: acol }),
    );
    g.add(base);
    const stand = new THREE.Mesh(
      new THREE.CylinderGeometry(0.024, 0.024, ob.H * 0.65, 8),
      new THREE.MeshLambertMaterial({ color: isOn ? 0x334455 : 0x181e28 }),
    );
    stand.position.y = ob.H * 0.325;
    g.add(stand);
    const head = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.11, 0.08, 16),
      new THREE.MeshLambertMaterial({ color: isOn ? 0x445566 : 0x202830 }),
    );
    head.rotation.x = Math.PI / 2;
    head.position.y = ob.H * 0.65;
    g.add(head);
    const bg = new THREE.Group();
    bg.userData.isBlade = true;
    for (let i = 0; i < 3; i++) {
      const piv = new THREE.Group();
      piv.rotation.z = i * Math.PI * 2 / 3;
      const bl = new THREE.Mesh(
        new THREE.BoxGeometry(0.09, 0.005, 0.05),
        new THREE.MeshLambertMaterial({
          color: isOn ? 0x88ccff : 0x1a2a38,
          transparent: true, opacity: isOn ? 0.7 : 0.3,
        }),
      );
      bl.position.x = 0.065;
      piv.add(bl);
      bg.add(piv);
    }
    bg.position.y = ob.H * 0.65;
    bg.rotation.x = Math.PI / 2 - 0.2;
    g.add(bg);
    g.userData.fanBlades = bg;
    const led = new THREE.Mesh(
      new THREE.SphereGeometry(0.02, 6, 6),
      new THREE.MeshBasicMaterial({ color: isOn ? 0x00ff60 : 0x1a2020 }),
    );
    led.position.set(0, ob.H * 0.65 + 0.1, -0.12);
    g.add(led);
  }

  g.position.set(ob.x, ob.H / 2 + yo, ob.z);
  g.userData = { ...g.userData, isObs: true, oid: ob.id };
  return g;
}
