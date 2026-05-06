"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "cfd-tour-dismissed";

interface Step {
  title: string;
  body: string;
  /** CSS pixels from the left edge of the viewport (0 = centred) */
  posX?: number;
  /** CSS pixels from the top of the viewport */
  posY?: number;
}

const STEPS: Step[] = [
  {
    title: "Welcome — let's place an AC",
    body: "This is a fast, browser-only HVAC tool. The default scene is a 4×3×2.7 m room. Click ❄ AC Unit in the toolbar, then click any wall to drop an AC.",
    posY: 70,
  },
  {
    title: "Run the simulation",
    body: "Hit ▶ Run CFD to start. The room walls and floor will light up with the temperature field; arrows + particles show airflow. Default duration is 5 min of simulated time — pick something else with the ⏱ Run for selector if you want.",
    posY: 70,
  },
  {
    title: "Optimize for occupant comfort",
    body: "Drop a 🧑 Human into the room (Heat Sources → Human). Then click ★ Optimize AC for a single-AC sweep, or ⚙ Multi-AC for joint NSGA-II optimization that minimises BOTH discomfort and annual energy.",
    posY: 70,
  },
];

export function OnboardingTour() {
  const [step, setStep] = useState<number>(-1);

  // Show on first visit only (localStorage)
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (!window.localStorage.getItem(STORAGE_KEY)) setStep(0);
    } catch {
      // private mode / disabled storage — just don't show
    }
  }, []);

  if (step < 0 || step >= STEPS.length) return null;

  const s = STEPS[step];
  const next = () => {
    if (step + 1 < STEPS.length) setStep(step + 1);
    else dismiss();
  };
  const dismiss = () => {
    try { window.localStorage.setItem(STORAGE_KEY, "1"); } catch { /* no-op */ }
    setStep(-1);
  };

  return (
    <div
      className="fixed left-1/2 z-[150] -translate-x-1/2 rounded-lg border border-[var(--color-accent-blue-2)] bg-[rgba(8,16,28,0.97)] px-4 py-3 shadow-2xl"
      style={{ top: s.posY ?? 70, maxWidth: 460 }}
    >
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="text-[8.5px] uppercase tracking-[0.18em] text-[var(--color-ink-7)]">
          Tip {step + 1} of {STEPS.length}
        </span>
        <button
          onClick={dismiss}
          className="text-[10px] text-[var(--color-ink-7)] hover:text-[var(--color-accent-red)]"
        >
          Skip ✕
        </button>
      </div>
      <h4 className="mb-1 text-[12px] font-semibold text-[var(--color-accent-blue)]">
        {s.title}
      </h4>
      <p className="mb-2 text-[10.5px] leading-relaxed text-[var(--color-ink-3)]">
        {s.body}
      </p>
      <div className="flex justify-end gap-2">
        {step > 0 && (
          <button
            onClick={() => setStep(step - 1)}
            className="rounded border border-[#142234] bg-[#070f1e] px-2 py-0.5 text-[10px] text-[#4878a0] hover:bg-[#0b182e]"
          >
            ← Back
          </button>
        )}
        <button
          onClick={next}
          className="rounded border border-[var(--color-accent-blue-2)] bg-[#0c2040] px-3 py-0.5 text-[10px] font-semibold text-[var(--color-accent-blue)] hover:bg-[#0e2548]"
        >
          {step + 1 === STEPS.length ? "Got it" : "Next →"}
        </button>
      </div>
    </div>
  );
}
