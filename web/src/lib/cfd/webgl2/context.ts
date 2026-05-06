/**
 * WebGL2 context bootstrap — works in both main thread and worker.
 *
 * Worker path uses OffscreenCanvas (broadly supported since 2022). Main
 * thread path is only used for capability detection in the UI; the actual
 * solver always runs in the worker, so a missing WebGL2 in the main
 * thread doesn't block the worker path.
 *
 * Required WebGL2 extensions:
 *   - EXT_color_buffer_float : render to FLOAT framebuffer
 *   - OES_texture_float_linear : LINEAR sampling on FLOAT (semi-Lagrangian
 *     advection needs trilinear interpolation)
 *
 * If either is missing, the worker falls back to the JS MAC solver — the
 * caller sees no error, just no GPU acceleration.
 */

export interface WebGL2Backend {
  gl: WebGL2RenderingContext;
  hasFloatLinear: boolean;
  vendor: string;
  renderer: string;
  /** Disposes underlying canvas; call after the worker shuts down. */
  dispose(): void;
}

export function createWebGL2Backend(): WebGL2Backend | null {
  // Use OffscreenCanvas where available (worker + main); fall back to
  // a regular DOM canvas only when in the main thread without OffscreenCanvas.
  const oc = typeof OffscreenCanvas !== "undefined";
  let canvas: OffscreenCanvas | HTMLCanvasElement;
  if (oc) {
    canvas = new OffscreenCanvas(1, 1);
  } else if (typeof document !== "undefined") {
    canvas = document.createElement("canvas");
  } else {
    return null;
  }
  const gl = canvas.getContext("webgl2", {
    antialias:        false,
    depth:            false,
    stencil:          false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference:  "high-performance",
  });
  if (!gl) return null;

  const ctx = gl as WebGL2RenderingContext;
  if (!ctx.getExtension("EXT_color_buffer_float")) {
    return null;
  }
  const hasFloatLinear = !!ctx.getExtension("OES_texture_float_linear");

  let vendor = "?", renderer = "?";
  const dbg = ctx.getExtension("WEBGL_debug_renderer_info") as { UNMASKED_VENDOR_WEBGL: number; UNMASKED_RENDERER_WEBGL: number } | null;
  if (dbg) {
    try {
      vendor   = ctx.getParameter(dbg.UNMASKED_VENDOR_WEBGL)   as string;
      renderer = ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string;
    } catch { /* some browsers block this */ }
  }

  return {
    gl: ctx,
    hasFloatLinear,
    vendor, renderer,
    dispose() {
      // OffscreenCanvas / HTMLCanvas have no explicit destroy; losing
      // references is enough. Force-clear with loseContext if possible.
      const lose = ctx.getExtension("WEBGL_lose_context") as { loseContext(): void } | null;
      if (lose) lose.loseContext();
    },
  };
}
