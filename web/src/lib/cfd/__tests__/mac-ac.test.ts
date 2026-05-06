import { describe, expect, it } from "vitest";
import {
  NX, NY, NZ, CK, makeMACFields, cellCentredVelocity, type RoomDims,
} from "../mac-grid";
import { buildFaceMasks } from "../voxelize-mac";
import { applyACCooling, bakeInitialVelocity, injectACJetsMAC } from "../sources-mac";

const room: RoomDims = { L: 6, W: 6, H: 3 };

describe("MAC AC sources", () => {
  it("throws east and west wall jets horizontally into the room", () => {
    for (const [wall, sign, x] of [
      ["E", -1,  2.45],
      ["W",  1, -2.45],
    ] as const) {
      const f = makeMACFields();
      buildFaceMasks(f);
      injectACJetsMAC(f, room, [{
        x, z: 0, wall,
        mountingHeightM: 1.6,
        verticalAngleDeg: -5,
        flowRateM3s: 0.16,
      }]);
      bakeInitialVelocity(f, 1);

      let sumVx = 0;
      let sumAbsVy = 0;
      let n = 0;
      for (let iz = 0; iz < NZ; iz++)
        for (let iy = 0; iy < NY; iy++)
          for (let ix = 0; ix < NX; ix++) {
            const v = cellCentredVelocity(f, ix, iy, iz);
            const spd = Math.hypot(v.vx, v.vy, v.vz);
            if (spd < 0.25) continue;
            sumVx += v.vx;
            sumAbsVy += Math.abs(v.vy);
            n++;
          }

      expect(n).toBeGreaterThan(0);
      expect((sumVx / n) * sign).toBeGreaterThan(0.35);
      expect(Math.abs(sumVx)).toBeGreaterThan(sumAbsVy * 2.5);
    }
  });

  it("uses the fluid-side throw direction when an east/west wall label is stale", () => {
    const f = makeMACFields();
    buildFaceMasks(f);
    injectACJetsMAC(f, room, [{
      x: 2.45, z: 0,
      wall: "W",
      mountingHeightM: 1.6,
      verticalAngleDeg: -5,
      flowRateM3s: 0.16,
    }]);
    bakeInitialVelocity(f, 1);

    let sumVx = 0;
    let n = 0;
    for (let iz = 0; iz < NZ; iz++)
      for (let iy = 0; iy < NY; iy++)
        for (let ix = 0; ix < NX; ix++) {
          const v = cellCentredVelocity(f, ix, iy, iz);
          if (Math.hypot(v.vx, v.vy, v.vz) < 0.25) continue;
          sumVx += v.vx;
          n++;
        }

    expect(n).toBeGreaterThan(0);
    expect(sumVx / n).toBeLessThan(-0.35);
  });

  it("applies AC cooling downstream of the louvre instead of as a falling blob", () => {
    const f = makeMACFields();
    f.T.fill(30);
    buildFaceMasks(f);

    applyACCooling(f, room, [{
      x: 0, z: 0, wall: "E",
      kw: 8,
      supply_temp_C: 14,
      mounting_height_m: 1.5,
      throw_distance_m: 4,
      vertical_angle_deg: 0,
    }], 2);

    let downstreamCooling = 0;
    let behindCooling = 0;
    for (let iz = 0; iz < NZ; iz++)
      for (let iy = 0; iy < NY; iy++)
        for (let ix = 0; ix < NX; ix++) {
          const x = (ix + 0.5) * room.L / NX - room.L / 2;
          const y = (iy + 0.5) * room.H / NY;
          const z = (iz + 0.5) * room.W / NZ - room.W / 2;
          if (Math.abs(y - 1.5) > 0.8 || Math.abs(z) > 0.9) continue;
          const cooling = 30 - f.T[CK(ix, iy, iz)];
          if (x < -0.25) downstreamCooling += cooling;
          if (x >  0.25) behindCooling += cooling;
        }

    expect(downstreamCooling).toBeGreaterThan(0.1);
    expect(downstreamCooling).toBeGreaterThan(behindCooling * 4 + 0.1);
  });
});
