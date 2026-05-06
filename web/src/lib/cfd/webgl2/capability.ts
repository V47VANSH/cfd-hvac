/**
 * WebGL2 capability detection.
 *
 * The Phase-2b turbo backend uses fragment-shader compute via ping-pong
 * textures. Required browser features:
 *   - WebGL2 context
 *   - EXT_color_buffer_float (render to FLOAT textures)
 *   - OES_texture_float_linear (linear interpolation on FLOAT textures —
 *     trilinear sampling for advection)
 *
 * If any are missing, the worker falls back to the JS solver
 * automatically and the user sees no error — just the standard JS path.
 */

export interface WebGL2Capabilities {
  available: boolean;
  reasonUnavailable?: string;
  /** Max 3D-equivalent texture size (we tile the 3D grid into a 2D atlas) */
  maxTextureSize: number;
  /** Whether linear filtering on FLOAT textures works (semi-Lagrangian needs it) */
  hasFloatLinear: boolean;
  /** Whether we can render to FLOAT framebuffer attachments */
  hasFloatRender: boolean;
  /** Vendor + renderer strings for diagnostics. */
  vendor: string;
  renderer: string;
}

let cached: WebGL2Capabilities | null = null;

export function detectWebGL2(): WebGL2Capabilities {
  if (cached) return cached;
  if (typeof document === "undefined") {
    cached = unavailable("no DOM (probably running in worker — main-thread detection only for now)");
    return cached;
  }
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  if (!gl) {
    cached = unavailable("WebGL2 context not available");
    return cached;
  }
  const hasFloatRender = !!gl.getExtension("EXT_color_buffer_float");
  const hasFloatLinear = !!gl.getExtension("OES_texture_float_linear");
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const vendor   = debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)   as string : "?";
  const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string : "?";
  const maxSize  = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  if (!hasFloatRender) {
    cached = unavailable("EXT_color_buffer_float missing");
    Object.assign(cached, { vendor, renderer, maxTextureSize: maxSize });
    return cached;
  }
  cached = {
    available: true,
    maxTextureSize: maxSize,
    hasFloatLinear,
    hasFloatRender,
    vendor, renderer,
  };
  return cached;
}

function unavailable(reason: string): WebGL2Capabilities {
  return {
    available: false, reasonUnavailable: reason,
    maxTextureSize: 0, hasFloatLinear: false, hasFloatRender: false,
    vendor: "", renderer: "",
  };
}
