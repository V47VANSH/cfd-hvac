/**
 * MAC solver — cavity sanity test, mirroring the legacy regression.
 *
 * A cubic room with a single hot wall opening (acts as solar gain) is
 * stepped for a fixed time. The MAC solver must:
 *   - Stay numerically stable (no NaNs or Infs).
 *   - Reach a sensible mean temperature between supply and ambient.
 *   - Produce a non-trivial standard deviation (something happened).
 *
 * Annex 20 quantitative validation lives in Tier 2; this is the JS-side
 * smoke test that catches catastrophic regressions in the new numerics.
 */

import { describe, it, expect } from "vitest";
import { NCELLS, makeMACFields, type RoomDims } from "../mac-grid";
import { voxelizeObstaclesMAC, buildFaceMasks } from "../voxelize-mac";
import { stepMAC, makeScratch } from "../solver-mac";
import { adaptiveTimestep } from "../timestep";
import { DEFAULT_CALIBRATION } from "../calibration";
import type { Opening } from "@/lib/io/schema";

const room: RoomDims = { L: 3, W: 3, H: 3 };

describe("MAC solver — cavity sanity", () => {
  it("reaches a stable mean temperature with a single hot opening", () => {
    const f = makeMACFields();
    f.T.fill(28);
    voxelizeObstaclesMAC(f, room, []);
    buildFaceMasks(f);
    const scratch = makeScratch(room);
    const openings: Opening[] = [{
      id: 1, wall: "S", type: "win",
      u: 1.5, v: 1.5, uw: 1.5, vh: 1.5, open: true,
    }];
    // Run ~5 sim seconds (60 substeps × ~0.08 s)
    for (let i = 0; i < 60; i++) {
      const dt = adaptiveTimestep(f, room);
      stepMAC({
        fields: f, room, openings,
        Tout: 35, RHout: 0.6, dt,
        cal: DEFAULT_CALIBRATION,
        scratch,
      });
    }
    let sum = 0, n = 0;
    for (let k = 0; k < NCELLS; k++) {
      if (f.wall[k]) continue;
      sum += f.T[k]; n++;
      expect(Number.isFinite(f.T[k])).toBe(true);
    }
    const mean = sum / n;
    expect(mean).toBeGreaterThan(20);
    expect(mean).toBeLessThan(48);
  }, 20000);

  it("develops nonzero thermal variance (solver does something)", () => {
    const f = makeMACFields();
    f.T.fill(28);
    voxelizeObstaclesMAC(f, room, []);
    buildFaceMasks(f);
    const scratch = makeScratch(room);
    const openings: Opening[] = [{
      id: 1, wall: "S", type: "win",
      u: 1.5, v: 1.5, uw: 1.5, vh: 1.5, open: true,
    }];
    for (let i = 0; i < 60; i++) {
      const dt = adaptiveTimestep(f, room);
      stepMAC({
        fields: f, room, openings,
        Tout: 38, RHout: 0.6, dt,
        cal: DEFAULT_CALIBRATION,
        scratch,
      });
    }
    let s = 0, s2 = 0, n = 0;
    for (let k = 0; k < NCELLS; k++) {
      if (f.wall[k]) continue;
      s += f.T[k]; s2 += f.T[k] * f.T[k]; n++;
    }
    const mean = s / n;
    const std = Math.sqrt(Math.max(0, s2 / n - mean * mean));
    expect(std).toBeGreaterThan(0.5);
  }, 20000);
});
