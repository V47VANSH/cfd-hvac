/**
 * CFD Web Worker.
 *
 * Owns the field arrays. Receives commands from the main thread, runs
 * physics substeps, and periodically posts back snapshots of T + V for
 * visualization. The worker is the single source of truth for the
 * simulation state while it's running.
 */

import { makeFields, NCELLS, NX, NY, NZ, type GridFields, type RoomDims } from "@/lib/cfd/grid";
import { T_AMB, MAX_STEPS } from "@/lib/cfd/constants";
import { voxelizeObstacles, voxelizeBlocks, voxelizeSTL } from "@/lib/cfd/voxelize";
import {
  injectHeatSources, injectACJets, injectFans, injectInfiltration, setACCold,
} from "@/lib/cfd/sources";
import { step, metrics, type FieldMetrics } from "@/lib/cfd/solver";
import type { Scene } from "@/lib/io/schema";

// ── Worker state ────────────────────────────────────────────────────────
let fields: GridFields = makeFields();
let scene: Scene | null = null;
let running = false;
let stepCount = 0;
let acPositions: { x: number; z: number; wall: "S" | "N" | "E" | "W" }[] = [];

// ── Command channel ─────────────────────────────────────────────────────
export type WorkerCommand =
  | { kind: "init"; scene: Scene; ac: typeof acPositions }
  | { kind: "start" }
  | { kind: "stop" }
  | { kind: "reset" }
  | { kind: "tick" };          // run one batch of substeps

export type WorkerEvent =
  | { kind: "ready" }
  | {
      kind: "snapshot";
      step: number;
      metrics: FieldMetrics;
      // transferable buffers
      T:  ArrayBuffer;
      Vx: ArrayBuffer;
      Vy: ArrayBuffer;
      Vz: ArrayBuffer;
    }
  | { kind: "done"; step: number };

function rebuildScene(s: Scene, ac: typeof acPositions) {
  fields = makeFields();
  fields.T.fill(T_AMB);
  voxelizeObstacles(fields, s.geometry, s.obstacles);
  voxelizeBlocks(fields, s.geometry, s.geometry.extensions);
  voxelizeSTL(fields, s.geometry, s.geometry.stl);
  injectHeatSources(fields, s.geometry, s.obstacles);
  injectACJets(fields, s.geometry, ac);
  injectFans(fields, s.geometry, s.obstacles);
  injectInfiltration(fields, s.geometry, s.openings);
}

function postSnapshot() {
  if (!scene) return;
  const m = metrics(fields, scene.environment.setpoint_C);
  // Transfer copies of T + V so the main thread can read them while
  // the worker keeps mutating its own buffers.
  const T  = new Float32Array(fields.T).buffer;
  const Vx = new Float32Array(fields.Vx).buffer;
  const Vy = new Float32Array(fields.Vy).buffer;
  const Vz = new Float32Array(fields.Vz).buffer;
  const ev: WorkerEvent = {
    kind: "snapshot",
    step: stepCount,
    metrics: m,
    T, Vx, Vy, Vz,
  };
  (self as unknown as Worker).postMessage(ev, [T, Vx, Vy, Vz]);
}

self.onmessage = (e: MessageEvent<WorkerCommand>) => {
  const cmd = e.data;
  switch (cmd.kind) {
    case "init": {
      scene = cmd.scene;
      acPositions = cmd.ac;
      rebuildScene(scene, acPositions);
      stepCount = 0;
      const ready: WorkerEvent = { kind: "ready" };
      (self as unknown as Worker).postMessage(ready);
      break;
    }
    case "start": {
      if (!scene) return;
      running = true;
      // self-driving tick loop — fire one batch immediately
      tick();
      break;
    }
    case "stop": {
      running = false;
      break;
    }
    case "reset": {
      if (!scene) return;
      rebuildScene(scene, acPositions);
      stepCount = 0;
      postSnapshot();
      break;
    }
    case "tick": {
      tick();
      break;
    }
  }
};

function tick() {
  if (!running || !scene) return;
  if (stepCount >= MAX_STEPS) {
    running = false;
    const done: WorkerEvent = { kind: "done", step: stepCount };
    (self as unknown as Worker).postMessage(done);
    return;
  }
  step({
    fields,
    room: scene.geometry,
    openings: scene.openings,
    Tout: scene.environment.outdoor_temp_C,
    n: 2,
  });
  setACCold(fields, scene.geometry, acPositions);
  stepCount += 2;
  if (stepCount % 10 === 0) postSnapshot();
  // queue the next batch, allowing other messages to interleave
  setTimeout(tick, 0);
}

// Touch the constants to keep tree-shaking honest
void NCELLS; void NX; void NY; void NZ;

const ready: WorkerEvent = { kind: "ready" };
(self as unknown as Worker).postMessage(ready);
