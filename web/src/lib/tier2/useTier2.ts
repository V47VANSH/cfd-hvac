"use client";

import { useEffect, useRef, useState } from "react";
import { fetchHealth, type Tier2Health } from "./client";

export type Tier2Status = "checking" | "available" | "unavailable";

/**
 * Polls Tier-2 ``/health`` every ``intervalMs``.
 *
 * Returns the latest status + the raw health object. The hook also
 * re-checks immediately when the window/tab gains focus, so a backend
 * brought up after the user already has the page open lights up
 * promptly without a refresh.
 */
export function useTier2(intervalMs = 30000) {
  const [status, setStatus] = useState<Tier2Status>("checking");
  const [health, setHealth] = useState<Tier2Health | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function poll() {
      const h = await fetchHealth();
      if (!mountedRef.current) return;
      if (h && h.status === "ok") {
        setStatus("available");
        setHealth(h);
      } else {
        setStatus("unavailable");
        setHealth(null);
      }
    }

    poll();
    timer = setInterval(poll, intervalMs);
    const onFocus = () => poll();
    window.addEventListener("focus", onFocus);

    return () => {
      mountedRef.current = false;
      if (timer) clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [intervalMs]);

  return { status, health };
}
