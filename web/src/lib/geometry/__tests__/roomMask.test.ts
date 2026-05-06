import { describe, expect, it } from "vitest";
import { computeRoomMask, isInsideRoom, type MaskGrid } from "../roomMask";
import type { STLObject } from "@/lib/io/schema";

const grid: MaskGrid = { NX: 36, NY: 14, NZ: 28, L: 4, W: 4, H: 3 };

function quad(
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
): number[] {
  return [...a, ...b, ...c, ...a, ...c, ...d];
}

function testRoomWithLowInternalPanel(): STLObject {
  const tris = [
    // Full-height perimeter walls.
    ...quad([-2, 0, -2], [ 2, 0, -2], [ 2, 3, -2], [-2, 3, -2]),
    ...quad([-2, 0,  2], [-2, 3,  2], [ 2, 3,  2], [ 2, 0,  2]),
    ...quad([-2, 0, -2], [-2, 3, -2], [-2, 3,  2], [-2, 0,  2]),
    ...quad([ 2, 0, -2], [ 2, 0,  2], [ 2, 3,  2], [ 2, 3, -2]),
    // Low internal vertical face. Old masking treated this as a full-height
    // wall column and split the CFD volume.
    ...quad([0, 0, -1.4], [0, 0, 1.4], [0, 0.7, 1.4], [0, 0.7, -1.4]),
  ];
  return {
    id: 1,
    name: "synthetic-room",
    x: 0, y: 0, z: 0,
    scale: 1,
    triCount: tris.length / 9,
    positions: new Float32Array(tris),
    role: "room",
  };
}

describe("STL room mask", () => {
  it("does not extrude low internal STL features into fake full-height walls", () => {
    const stl = testRoomWithLowInternalPanel();
    const mask = computeRoomMask(grid, stl);
    let inside = 0;
    for (const v of mask) if (v) inside++;

    expect(inside).toBeGreaterThan(grid.NX * grid.NY * grid.NZ * 0.45);
    expect(isInsideRoom(grid, stl, -0.4, 1.5, 0)).toBe(true);
    expect(isInsideRoom(grid, stl,  0.4, 1.5, 0)).toBe(true);
    expect(isInsideRoom(grid, stl,  0.0, 1.5, 0)).toBe(true);
  });
});
