/**
 * Browser-side wrapper around the CFD Web Worker.
 *
 * The worker module URL pattern below is recognized by Next.js / Webpack
 * and produces a separate JS bundle for the worker.
 */

import type { Scene } from "@/lib/io/schema";
import type { FieldMetrics } from "@/lib/cfd/solver";

export type CFDBackend = "legacy" | "mac" | "mac-webgl2";

export interface CFDSnapshot {
  step: number;
  /** Accumulated simulated time, seconds. */
  elapsedS: number;
  /** Configured duration target, seconds. */
  durationS: number;
  backend: CFDBackend;
  metrics: FieldMetrics;
  T:  Float32Array;
  Vx: Float32Array;
  Vy: Float32Array;
  Vz: Float32Array;
  /** MAC-only — populated when the worker ran the new solver. */
  RH?:   Float32Array;
  CO2?:  Float32Array;
  Tmrt?: Float32Array;
}

export interface CFDClient {
  init(
    scene: Scene,
    ac: { x: number; z: number; wall: "S" | "N" | "E" | "W" }[],
    backend?: CFDBackend,
    durationS?: number,
  ): void;
  start(): void;
  stop(): void;
  reset(): void;
  setDuration(durationS: number): void;
  onSnapshot(cb: (snap: CFDSnapshot) => void): void;
  onDone(cb: (step: number, elapsedS: number) => void): void;
  dispose(): void;
}

export function createCFDClient(): CFDClient {
  const worker = new Worker(
    new URL("@/workers/cfd.worker.ts", import.meta.url),
    { type: "module" },
  );

  let snapCb: ((snap: CFDSnapshot) => void) | null = null;
  let doneCb: ((step: number, elapsedS: number) => void) | null = null;

  worker.onmessage = (e: MessageEvent) => {
    const ev = e.data;
    if (ev.kind === "snapshot") {
      snapCb?.({
        step: ev.step,
        elapsedS: ev.elapsedS ?? 0,
        durationS: ev.durationS ?? 0,
        backend: ev.backend ?? "legacy",
        metrics: ev.metrics,
        T:  new Float32Array(ev.T),
        Vx: new Float32Array(ev.Vx),
        Vy: new Float32Array(ev.Vy),
        Vz: new Float32Array(ev.Vz),
        RH:   ev.RH   ? new Float32Array(ev.RH)   : undefined,
        CO2:  ev.CO2  ? new Float32Array(ev.CO2)  : undefined,
        Tmrt: ev.Tmrt ? new Float32Array(ev.Tmrt) : undefined,
      });
    } else if (ev.kind === "done") {
      doneCb?.(ev.step, ev.elapsedS ?? 0);
    }
  };

  return {
    init(scene, ac, backend, durationS) {
      worker.postMessage({ kind: "init", scene, ac, backend, durationS });
    },
    start() { worker.postMessage({ kind: "start" }); },
    stop()  { worker.postMessage({ kind: "stop"  }); },
    reset() { worker.postMessage({ kind: "reset" }); },
    setDuration(durationS) { worker.postMessage({ kind: "setDuration", durationS }); },
    onSnapshot(cb) { snapCb = cb; },
    onDone(cb)     { doneCb = cb; },
    dispose() { worker.terminate(); },
  };
}
