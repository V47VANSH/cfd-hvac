/**
 * Lazy-loaded PDF export. The html2pdf.js bundle is ~250 KB gzipped, so we
 * only pull it in on the first export click — keeping the cold-cache initial
 * bundle under the 2 MB Tier 1 budget (PLAN.md §"Performance Budget").
 */

import { sceneHash } from "@/lib/io/schema";
import type { CapturedSnapshot } from "@/lib/comparison/captureSnapshot";
import { buildReportHTML } from "./buildReport";

interface Html2PdfApi {
  from(html: HTMLElement | string): Html2PdfApi;
  set(opts: Record<string, unknown>): Html2PdfApi;
  save(filename?: string): Promise<void>;
}

export async function exportComfortPDF(
  capture: CapturedSnapshot,
  filename = "cfd_comfort_report.pdf",
): Promise<void> {
  const hash = await sceneHash(capture.scene);
  const html = buildReportHTML({ capture, sceneHash: hash });

  // Dynamic import keeps html2pdf.js out of the initial bundle.
  const mod = (await import("html2pdf.js")) as { default: () => Html2PdfApi };
  const html2pdf = mod.default;

  // html2canvas needs the element to be in the visible flow with real
  // dimensions. We mount on-screen at (0, 0) with opacity 0 so the user
  // doesn't see a flash, but html2canvas walks the DOM normally and the
  // CSS engine has computed layout for every node.
  //
  // Earlier the element was positioned at left: -10000px, which made
  // html2canvas's clipping-aware path skip rendering — the resulting
  // PDF was blank. opacity:0 + visibility hidden is NOT a fix because
  // html2canvas honours visibility:hidden. opacity:0 alone works.
  const root = document.createElement("div");
  root.innerHTML = html;
  root.style.cssText = [
    "position: fixed",
    "top: 0",
    "left: 0",
    "width: 794px",            // A4 @ 96 DPI
    "background: #ffffff",
    "z-index: -2147483648",    // behind everything
    "opacity: 0",
    "pointer-events: none",
  ].join(";");
  document.body.appendChild(root);

  // Force a reflow so the browser computes layout before html2canvas reads it.
  // (Reading offsetHeight is the standard "flush layout" trick.)
  void root.offsetHeight;

  try {
    await html2pdf()
      .from(root)
      .set({
        margin:       [10, 10, 12, 10],
        filename,
        image:        { type: "jpeg", quality: 0.92 },
        html2canvas:  { scale: 2, backgroundColor: "#ffffff", useCORS: true },
        jsPDF:        { unit: "mm", format: "a4", orientation: "portrait" },
        pagebreak:    { mode: ["avoid-all", "css", "legacy"] },
      })
      .save(filename);
  } finally {
    root.remove();
  }
}
