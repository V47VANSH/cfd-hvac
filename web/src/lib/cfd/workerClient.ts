/**
 * Browser-side wrapper around the CFD Web Worker.
 *
 * The worker module URL pattern below is recognized by Next.js / Webpack
 * and produces a separate JS bundle for the worker.
 */

import type { Scene } from "@/lib/io/schema";
import type { FieldMetrics } from "@/lib/cfd/solver";

export interface CFDSnapshot {
  step: number;
  metrics: FieldMetrics;
  T:  Float32Array;
  Vx: Float32Array;
  Vy: Float32Array;
  Vz: Float32Array;
}

export interface CFDClient {
  init(scene: Scene, ac: { x: number; z: number; wall: "S" | "N" | "E" | "W" }[]): void;
  start(): void;
  stop(): void;
  reset(): void;
  onSnapshot(cb: (snap: CFDSnapshot) => void): void;
  onDone(cb: (step: number) => void): void;
  dispose(): void;
}

export function createCFDClient(): CFDClient {
  const worker = new Worker(
    new URL("@/workers/cfd.worker.ts", import.meta.url),
    { type: "module" },
  );

  let snapCb: ((snap: CFDSnapshot) => void) | null = null;
  let doneCb: ((step: number) => void) | null = null;

  worker.onmessage = (e: MessageEvent) => {
    const ev = e.data;
    if (ev.kind === "snapshot") {
      snapCb?.({
        step: ev.step,
        metrics: ev.metrics,
        T:  new Float32Array(ev.T),
        Vx: new Float32Array(ev.Vx),
        Vy: new Float32Array(ev.Vy),
        Vz: new Float32Array(ev.Vz),
      });
    } else if (ev.kind === "done") {
      doneCb?.(ev.step);
    }
  };

  return {
    init(scene, ac) {
      worker.postMessage({ kind: "init", scene, ac });
    },
    start() { worker.postMessage({ kind: "start" }); },
    stop()  { worker.postMessage({ kind: "stop"  }); },
    reset() { worker.postMessage({ kind: "reset" }); },
    onSnapshot(cb) { snapCb = cb; },
    onDone(cb)     { doneCb = cb; },
    dispose() { worker.terminate(); },
  };
}
