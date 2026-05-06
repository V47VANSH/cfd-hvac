/**
 * GPU field storage — one Float32 R-channel texture per simulation field,
 * each backed by a framebuffer for render-to-texture.
 *
 * Ping-pong: every field has TWO textures so the kernel can read from one
 * and write to the other in the same pass without aliasing. A "swap"
 * after each pass exchanges them.
 */

import type { AtlasLayout, FieldKind } from "./atlas";
import { atlasFor } from "./atlas";

export interface PingPongField {
  kind: FieldKind;
  layout: AtlasLayout;
  /** Read-from texture in the next pass */
  read:  WebGLTexture;
  /** Write-to texture in the next pass; bound to its own framebuffer */
  write: WebGLTexture;
  fbRead:  WebGLFramebuffer;
  fbWrite: WebGLFramebuffer;
  /** Swap read↔write — call after each pass that wrote to this field. */
  swap(): void;
  /** Upload CPU data to the read texture. */
  upload(data: Float32Array): void;
  /** Read GPU contents back into a Float32Array (length = atlas size). */
  readback(out: Float32Array): void;
  dispose(): void;
}

export function createField(
  gl: WebGL2RenderingContext, kind: FieldKind, nx: number, ny: number, nz: number,
  hasFloatLinear: boolean,
): PingPongField {
  const layout = atlasFor(kind, nx, ny, nz);
  const tA = makeTex(gl, layout.texWidth, layout.texHeight, hasFloatLinear);
  const tB = makeTex(gl, layout.texWidth, layout.texHeight, hasFloatLinear);
  const fA = makeFB(gl, tA);
  const fB = makeFB(gl, tB);

  let read = tA, write = tB, fbRead = fA, fbWrite = fB;
  return {
    kind, layout,
    get read()    { return read; },
    get write()   { return write; },
    get fbRead()  { return fbRead; },
    get fbWrite() { return fbWrite; },
    swap() {
      [read, write]     = [write, read];
      [fbRead, fbWrite] = [fbWrite, fbRead];
    },
    upload(data) {
      if (data.length < layout.texWidth * layout.texHeight) {
        throw new Error(`upload too small: ${data.length} < ${layout.texWidth * layout.texHeight}`);
      }
      gl.bindTexture(gl.TEXTURE_2D, read);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0,
        layout.texWidth, layout.texHeight,
        gl.RED, gl.FLOAT, data,
      );
      gl.bindTexture(gl.TEXTURE_2D, null);
    },
    readback(out) {
      if (out.length < layout.texWidth * layout.texHeight) {
        throw new Error(`readback too small`);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbRead);
      gl.readPixels(0, 0, layout.texWidth, layout.texHeight, gl.RED, gl.FLOAT, out);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    },
    dispose() {
      gl.deleteTexture(tA);
      gl.deleteTexture(tB);
      gl.deleteFramebuffer(fA);
      gl.deleteFramebuffer(fB);
    },
  };
}

function makeTex(
  gl: WebGL2RenderingContext, w: number, h: number, hasFloatLinear: boolean,
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("createTexture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // Single-channel float — R32F is renderable when EXT_color_buffer_float
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, null);
  const filter = hasFloatLinear ? gl.LINEAR : gl.NEAREST;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

function makeFB(gl: WebGL2RenderingContext, tex: WebGLTexture): WebGLFramebuffer {
  const fb = gl.createFramebuffer();
  if (!fb) throw new Error("createFramebuffer");
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`framebuffer incomplete: 0x${status.toString(16)}`);
  }
  return fb;
}
