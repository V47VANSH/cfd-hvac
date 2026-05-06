"use client";

import { useEffect, useRef, useState } from "react";
import { createCFDClient, type CFDClient, type CFDSnapshot } from "./workerClient";
import type { Scene } from "@/lib/io/schema";
import type { FieldMetrics } from "./solver";

/**
 * Hook that owns the CFD worker for a component tree.
 *
 * - React state for things the UI displays (metrics, simStep, simRunning).
 * - A ref to the latest snapshot for things that need imperative access
 *   (Three.js overlays, particles).
 * - A subscribe() function for components that want to re-run side effects
 *   on each new snapshot.
 */
export function useCFDSim() {
  const clientRef = useRef<CFDClient | null>(null);
  const snapshotRef = useRef<CFDSnapshot | null>(null);
  const subsRef = useRef<Set<(s: CFDSnapshot) => void>>(new Set());
  const [metrics, setMetrics] = useState<FieldMetrics | null>(null);
  const [simStep, setSimStep] = useState(0);
  const [simRunning, setSimRunning] = useState(false);

  useEffect(() => {
    const client = createCFDClient();
    client.onSnapshot((snap) => {
      snapshotRef.current = snap;
      setMetrics(snap.metrics);
      setSimStep(snap.step);
      for (const cb of subsRef.current) cb(snap);
    });
    client.onDone((step) => {
      setSimRunning(false);
      setSimStep(step);
    });
    clientRef.current = client;
    return () => { client.dispose(); clientRef.current = null; };
  }, []);

  function start(scene: Scene, ac: { x: number; z: number; wall: "S"|"N"|"E"|"W" }[]) {
    const c = clientRef.current; if (!c) return;
    c.init(scene, ac);
    c.start();
    setSimRunning(true);
    setSimStep(0);
  }
  function stop() {
    clientRef.current?.stop();
    setSimRunning(false);
  }
  function reset() {
    clientRef.current?.reset();
    snapshotRef.current = null;
    setMetrics(null);
    setSimStep(0);
  }
  function subscribe(cb: (s: CFDSnapshot) => void): () => void {
    subsRef.current.add(cb);
    return () => { subsRef.current.delete(cb); };
  }

  return {
    metrics, simStep, simRunning,
    start, stop, reset, subscribe,
    snapshotRef,
  };
}
