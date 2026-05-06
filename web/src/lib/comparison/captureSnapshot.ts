/**
 * A frozen snapshot of the simulation at a moment in time, suitable for the
 * Comparison view and the PDF report. Holds:
 *   - the Scene (deep-cloned via JSON round-trip so edits to the live scene
 *     don't mutate captured data)
 *   - the worker fields (T, Vx, Vy, Vz) — typed arrays kept by reference
 *     because the worker already transferred fresh copies
 *   - a canvas PNG of the 3D viewport at capture time
 *   - basic metadata (label, ISO timestamp)
 *
 * Pure data — no React, no Three.js dependencies.
 */

import type { Scene } from "@/lib/io/schema";
import type { CFDSnapshot } from "@/lib/cfd/workerClient";
import type { FieldMetrics } from "@/lib/cfd/solver";
import { calcHeatLoad, type HeatLoad } from "@/lib/ashrae/heatLoad";
import {
  buildComfortReport, makeComfortContext, type ComfortReport,
} from "@/lib/comfort";

export interface CapturedSnapshot {
  label:       string;
  capturedAt:  string;
  scene:       Scene;
  fields: {
    T:  Float32Array;
    Vx: Float32Array;
    Vy: Float32Array;
    Vz: Float32Array;
  };
  metrics:    FieldMetrics;
  comfort:    ComfortReport;
  heatLoad:   HeatLoad;
  /** PNG data URL of the room render */
  canvasPNG?: string;
  step:       number;
}

export function captureSnapshot(
  scene: Scene,
  snap:  CFDSnapshot,
  canvas: HTMLCanvasElement | null,
  label: string,
): CapturedSnapshot {
  const sceneClone: Scene = JSON.parse(JSON.stringify(scene));
  const env = scene.environment;
  const ctx = makeComfortContext(snap.T, env.RH_outdoor_pct, env.met, env.clo);
  const comfort = buildComfortReport(snap.T, snap.Vx, snap.Vy, snap.Vz, scene.geometry.H, ctx);
  return {
    label,
    capturedAt: new Date().toISOString(),
    scene: sceneClone,
    fields: { T: snap.T, Vx: snap.Vx, Vy: snap.Vy, Vz: snap.Vz },
    metrics: snap.metrics,
    comfort,
    heatLoad: calcHeatLoad(scene),
    canvasPNG: canvas ? canvas.toDataURL("image/png") : undefined,
    step: snap.step,
  };
}
