/**
 * WebGL2 MAC solver runtime.
 *
 * Owns: GL context, all field textures (T, u, v, w, p, rhs, fu, fv, fw,
 * wall, uwall, vwall, wwall), the kernel programs, and the fullscreen
 * triangle. Exposes:
 *   - upload(scene)  — push CPU MAC fields to GPU
 *   - step(dt, cal) — run one MAC substep entirely on GPU
 *   - readback()     — copy T, u, v, w from GPU → CPU (for snapshot)
 *
 * The runtime is constructed once per scene; calling rebuild() with new
 * dimensions tears down the GPU resources and starts fresh. Same MAC
 * grid sizing as the JS solver.
 */

import {
  NX, NY, NZ,
  type MACFields, type RoomDims, cellSize,
} from "../mac-grid";
import type { Calibration } from "../calibration";
import type { WebGL2Backend } from "./context";
import { atlasFor } from "./atlas";
import { createField, type PingPongField } from "./fields";
import { createProgram, createFullscreenQuad, type ShaderProgram, type FullscreenQuad } from "./program";
import * as Kernels from "./kernels";

const JACOBI_ITERS = 40;     // Phase 2b v1 — replace with multigrid in v2

export class WebGL2Runtime {
  readonly gl: WebGL2RenderingContext;
  readonly hasFloatLinear: boolean;
  readonly quad: FullscreenQuad;

  // Fields
  readonly T:    PingPongField;
  readonly u:    PingPongField;
  readonly v:    PingPongField;
  readonly w:    PingPongField;
  readonly p:    PingPongField;
  readonly rhs:  PingPongField;
  readonly fu:   PingPongField;
  readonly fv:   PingPongField;
  readonly fw:   PingPongField;
  readonly wall:  PingPongField;
  readonly uwall: PingPongField;
  readonly vwall: PingPongField;
  readonly wwall: PingPongField;

  // Programs
  private p_apply_u: ShaderProgram;
  private p_apply_v: ShaderProgram;
  private p_apply_w: ShaderProgram;
  private p_advect_u: ShaderProgram;
  private p_advect_v: ShaderProgram;
  private p_advect_w: ShaderProgram;
  private p_advect_T: ShaderProgram;
  private p_buoy:    ShaderProgram;
  private p_div:     ShaderProgram;
  private p_jac:     ShaderProgram;
  private p_grad_u:  ShaderProgram;
  private p_grad_v:  ShaderProgram;
  private p_grad_w:  ShaderProgram;
  private p_bc_T:    ShaderProgram;
  private p_clamp:   ShaderProgram;

  // Scratch CPU buffers for upload conversion (avoids per-step alloc)
  private scratchT_cpu: Float32Array;

  constructor(readonly backend: WebGL2Backend, _room: RoomDims) {
    this.gl = backend.gl;
    this.hasFloatLinear = backend.hasFloatLinear;
    const gl = this.gl;
    this.quad = createFullscreenQuad(gl);

    // Allocate all fields at the JS MAC grid resolution
    this.T    = createField(gl, "scalar", NX, NY, NZ, this.hasFloatLinear);
    this.u    = createField(gl, "u",      NX, NY, NZ, this.hasFloatLinear);
    this.v    = createField(gl, "v",      NX, NY, NZ, this.hasFloatLinear);
    this.w    = createField(gl, "w",      NX, NY, NZ, this.hasFloatLinear);
    this.p    = createField(gl, "scalar", NX, NY, NZ, this.hasFloatLinear);
    this.rhs  = createField(gl, "scalar", NX, NY, NZ, this.hasFloatLinear);
    this.fu   = createField(gl, "u",      NX, NY, NZ, this.hasFloatLinear);
    this.fv   = createField(gl, "v",      NX, NY, NZ, this.hasFloatLinear);
    this.fw   = createField(gl, "w",      NX, NY, NZ, this.hasFloatLinear);
    this.wall  = createField(gl, "scalar", NX, NY, NZ, this.hasFloatLinear);
    this.uwall = createField(gl, "u",      NX, NY, NZ, this.hasFloatLinear);
    this.vwall = createField(gl, "v",      NX, NY, NZ, this.hasFloatLinear);
    this.wwall = createField(gl, "w",      NX, NY, NZ, this.hasFloatLinear);

    const sLayout = atlasFor("scalar", NX, NY, NZ);
    const uLayout = atlasFor("u",      NX, NY, NZ);
    const vLayout = atlasFor("v",      NX, NY, NZ);
    const wLayout = atlasFor("w",      NX, NY, NZ);

    this.p_apply_u = createProgram(gl, Kernels.APPLY_FORCING(NX, NY, NZ, uLayout.texWidth, uLayout.texHeight),
      ["u_vel", "u_force", "u_relax"]);
    this.p_apply_v = createProgram(gl, Kernels.APPLY_FORCING(NX, NY, NZ, vLayout.texWidth, vLayout.texHeight),
      ["u_vel", "u_force", "u_relax"]);
    this.p_apply_w = createProgram(gl, Kernels.APPLY_FORCING(NX, NY, NZ, wLayout.texWidth, wLayout.texHeight),
      ["u_vel", "u_force", "u_relax"]);

    this.p_advect_u = createProgram(gl, Kernels.ADVECT_VEL(NX, NY, NZ, uLayout.texWidth, uLayout.texHeight, "u"),
      ["u_uTex", "u_vTex", "u_wTex", "u_dt", "u_dx", "u_dy", "u_dz"]);
    this.p_advect_v = createProgram(gl, Kernels.ADVECT_VEL(NX, NY, NZ, vLayout.texWidth, vLayout.texHeight, "v"),
      ["u_uTex", "u_vTex", "u_wTex", "u_dt", "u_dx", "u_dy", "u_dz"]);
    this.p_advect_w = createProgram(gl, Kernels.ADVECT_VEL(NX, NY, NZ, wLayout.texWidth, wLayout.texHeight, "w"),
      ["u_uTex", "u_vTex", "u_wTex", "u_dt", "u_dx", "u_dy", "u_dz"]);

    this.p_advect_T = createProgram(gl, Kernels.ADVECT_SCALAR(NX, NY, NZ, sLayout.texWidth, sLayout.texHeight),
      ["u_uTex", "u_vTex", "u_wTex", "u_field", "u_wall",
       "u_dt", "u_dx", "u_dy", "u_dz", "u_clipMin", "u_clipMax"]);

    this.p_buoy = createProgram(gl, Kernels.BUOYANCY(NX, NY, NZ, vLayout.texWidth, vLayout.texHeight),
      ["u_v", "u_T", "u_vwall", "u_beta", "u_g", "u_dt", "u_Tamb", "u_damp", "u_clamp"]);

    this.p_div = createProgram(gl, Kernels.DIVERGENCE(NX, NY, NZ, sLayout.texWidth, sLayout.texHeight),
      ["u_uTex", "u_vTex", "u_wTex", "u_wall", "u_dx", "u_dy", "u_dz", "u_dt"]);

    this.p_jac = createProgram(gl, Kernels.PRESSURE_JACOBI(NX, NY, NZ, sLayout.texWidth, sLayout.texHeight),
      ["u_p", "u_rhs", "u_wall", "u_dx", "u_dy", "u_dz"]);

    this.p_grad_u = createProgram(gl, Kernels.GRADIENT_U(NX, NY, NZ, uLayout.texWidth, uLayout.texHeight),
      ["u_u", "u_p", "u_uwall", "u_dx", "u_dt"]);
    this.p_grad_v = createProgram(gl, Kernels.GRADIENT_V(NX, NY, NZ, vLayout.texWidth, vLayout.texHeight),
      ["u_v", "u_p", "u_vwall", "u_dy", "u_dt"]);
    this.p_grad_w = createProgram(gl, Kernels.GRADIENT_W(NX, NY, NZ, wLayout.texWidth, wLayout.texHeight),
      ["u_w", "u_p", "u_wwall", "u_dz", "u_dt"]);

    this.p_bc_T = createProgram(gl, Kernels.BOUNDARY_T(NX, NY, NZ, sLayout.texWidth, sLayout.texHeight),
      ["u_T", "u_Tfloor", "u_Tceiling", "u_Twall", "u_kWall"]);

    this.p_clamp = createProgram(gl, Kernels.CLAMP_SCALAR(NX, NY, NZ, sLayout.texWidth, sLayout.texHeight),
      ["u_src", "u_min", "u_max"]);

    this.scratchT_cpu = new Float32Array(sLayout.texWidth * sLayout.texHeight);
  }

  /** Push CPU MAC fields onto the GPU. Call after voxelization + sources. */
  uploadFromMAC(f: MACFields): void {
    this.T.upload(f.T);
    this.u.upload(f.u);
    this.v.upload(f.v);
    this.w.upload(f.w);
    this.fu.upload(f.fu);
    this.fv.upload(f.fv);
    this.fw.upload(f.fw);
    // wall masks: convert Uint8 → Float32 for GPU upload
    this.uploadMask(this.wall.layout.texWidth, this.wall.layout.texHeight, f.wall, this.wall);
    this.uploadMask(this.uwall.layout.texWidth, this.uwall.layout.texHeight, f.uwall, this.uwall);
    this.uploadMask(this.vwall.layout.texWidth, this.vwall.layout.texHeight, f.vwall, this.vwall);
    this.uploadMask(this.wwall.layout.texWidth, this.wwall.layout.texHeight, f.wwall, this.wwall);
    // Pressure starts at zero
    this.scratchT_cpu.fill(0);
    this.p.upload(this.scratchT_cpu);
  }

  private uploadMask(w: number, h: number, src: Uint8Array, dst: PingPongField): void {
    const tmp = new Float32Array(w * h);
    for (let i = 0; i < src.length; i++) tmp[i] = src[i] ? 1 : 0;
    dst.upload(tmp);
  }

  /** Run one MAC substep on the GPU. */
  step(dt: number, room: RoomDims, cal: Calibration): void {
    const { dx, dy, dz } = cellSize(room);
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    // 1. Apply forcing (relax velocity toward fu/fv/fw)
    this.runApplyForcing(this.p_apply_u, this.u, this.fu, cal.forceRelax);
    this.runApplyForcing(this.p_apply_v, this.v, this.fv, cal.forceRelax);
    this.runApplyForcing(this.p_apply_w, this.w, this.fw, cal.forceRelax);

    // 2. Buoyancy on v-faces
    this.runBuoyancy(cal, dt);

    // 3. Velocity advection (semi-Lagrangian; out-of-place via ping-pong)
    this.runAdvectVel(this.p_advect_u, this.u, dt, dx, dy, dz);
    this.runAdvectVel(this.p_advect_v, this.v, dt, dx, dy, dz);
    this.runAdvectVel(this.p_advect_w, this.w, dt, dx, dy, dz);

    // 4. Boundary T blend
    this.runBoundaryT(room, 0.015);

    // 5. Scalar advection (T)
    this.runAdvectScalar(dt, dx, dy, dz);

    // 6. Pressure projection
    //    a. divergence
    this.runDivergence(dt, dx, dy, dz);
    //    b. Jacobi (clear p first, then iterate)
    this.clearScalar(this.p);
    for (let i = 0; i < JACOBI_ITERS; i++) this.runJacobi(dx, dy, dz);
    //    c. subtract gradient
    this.runGradient(this.p_grad_u, this.u, dx, dt);
    this.runGradient(this.p_grad_v, this.v, dy, dt);
    this.runGradient(this.p_grad_w, this.w, dz, dt);
  }

  /** Read T, u, v, w (cell-centred) into CPU MAC fields for the snapshot. */
  readbackTo(f: MACFields): void {
    f.T.set(this.readbackField(this.T));
    f.u.set(this.readbackField(this.u));
    f.v.set(this.readbackField(this.v));
    f.w.set(this.readbackField(this.w));
  }

  private readbackField(field: PingPongField): Float32Array {
    const out = new Float32Array(field.layout.texWidth * field.layout.texHeight);
    field.readback(out);
    return out;
  }

  dispose(): void {
    [this.T, this.u, this.v, this.w, this.p, this.rhs, this.fu, this.fv, this.fw,
     this.wall, this.uwall, this.vwall, this.wwall].forEach((f) => f.dispose());
  }

  // ── Kernel wrappers ─────────────────────────────────────────────

  private runApplyForcing(prog: ShaderProgram, vel: PingPongField, force: PingPongField, relax: number): void {
    const gl = this.gl;
    gl.useProgram(prog.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, vel.fbWrite);
    gl.viewport(0, 0, vel.layout.texWidth, vel.layout.texHeight);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, vel.read);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, force.read);
    gl.uniform1i(prog.uniforms.u_vel,   0);
    gl.uniform1i(prog.uniforms.u_force, 1);
    gl.uniform1f(prog.uniforms.u_relax, relax);
    this.quad.draw(gl);
    vel.swap();
  }

  private runBuoyancy(cal: Calibration, dt: number): void {
    const gl = this.gl;
    const prog = this.p_buoy;
    gl.useProgram(prog.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.v.fbWrite);
    gl.viewport(0, 0, this.v.layout.texWidth, this.v.layout.texHeight);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.v.read);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.T.read);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.vwall.read);
    gl.uniform1i(prog.uniforms.u_v,     0);
    gl.uniform1i(prog.uniforms.u_T,     1);
    gl.uniform1i(prog.uniforms.u_vwall, 2);
    gl.uniform1f(prog.uniforms.u_beta,  cal.beta);
    gl.uniform1f(prog.uniforms.u_g,     9.81);
    gl.uniform1f(prog.uniforms.u_dt,    dt);
    gl.uniform1f(prog.uniforms.u_Tamb,  cal.Tamb);
    gl.uniform1f(prog.uniforms.u_damp,  0.985);
    gl.uniform1f(prog.uniforms.u_clamp, 3.0);
    this.quad.draw(gl);
    this.v.swap();
  }

  private runAdvectVel(prog: ShaderProgram, target: PingPongField, dt: number, dx: number, dy: number, dz: number): void {
    const gl = this.gl;
    gl.useProgram(prog.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbWrite);
    gl.viewport(0, 0, target.layout.texWidth, target.layout.texHeight);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.u.read);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.v.read);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.w.read);
    gl.uniform1i(prog.uniforms.u_uTex, 0);
    gl.uniform1i(prog.uniforms.u_vTex, 1);
    gl.uniform1i(prog.uniforms.u_wTex, 2);
    gl.uniform1f(prog.uniforms.u_dt, dt);
    gl.uniform1f(prog.uniforms.u_dx, dx);
    gl.uniform1f(prog.uniforms.u_dy, dy);
    gl.uniform1f(prog.uniforms.u_dz, dz);
    this.quad.draw(gl);
    target.swap();
  }

  private runAdvectScalar(dt: number, dx: number, dy: number, dz: number): void {
    const gl = this.gl;
    const prog = this.p_advect_T;
    gl.useProgram(prog.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.T.fbWrite);
    gl.viewport(0, 0, this.T.layout.texWidth, this.T.layout.texHeight);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.u.read);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.v.read);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.w.read);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.T.read);
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.wall.read);
    gl.uniform1i(prog.uniforms.u_uTex,  0);
    gl.uniform1i(prog.uniforms.u_vTex,  1);
    gl.uniform1i(prog.uniforms.u_wTex,  2);
    gl.uniform1i(prog.uniforms.u_field, 3);
    gl.uniform1i(prog.uniforms.u_wall,  4);
    gl.uniform1f(prog.uniforms.u_dt, dt);
    gl.uniform1f(prog.uniforms.u_dx, dx);
    gl.uniform1f(prog.uniforms.u_dy, dy);
    gl.uniform1f(prog.uniforms.u_dz, dz);
    gl.uniform1f(prog.uniforms.u_clipMin, 10);
    gl.uniform1f(prog.uniforms.u_clipMax, 55);
    this.quad.draw(gl);
    this.T.swap();
  }

  private runBoundaryT(room: RoomDims, kWall: number): void {
    const gl = this.gl;
    const prog = this.p_bc_T;
    gl.useProgram(prog.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.T.fbWrite);
    gl.viewport(0, 0, this.T.layout.texWidth, this.T.layout.texHeight);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.T.read);
    gl.uniform1i(prog.uniforms.u_T, 0);
    // Match the JS solver's softened targets
    const Tfloor = Math.min(28, 26);
    const Tceiling = 26;
    const Twall = 30;
    void room;
    gl.uniform1f(prog.uniforms.u_Tfloor,  Tfloor);
    gl.uniform1f(prog.uniforms.u_Tceiling, Tceiling);
    gl.uniform1f(prog.uniforms.u_Twall,    Twall);
    gl.uniform1f(prog.uniforms.u_kWall,    kWall);
    this.quad.draw(gl);
    this.T.swap();
  }

  private runDivergence(dt: number, dx: number, dy: number, dz: number): void {
    const gl = this.gl;
    const prog = this.p_div;
    gl.useProgram(prog.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.rhs.fbWrite);
    gl.viewport(0, 0, this.rhs.layout.texWidth, this.rhs.layout.texHeight);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.u.read);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.v.read);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.w.read);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.wall.read);
    gl.uniform1i(prog.uniforms.u_uTex, 0);
    gl.uniform1i(prog.uniforms.u_vTex, 1);
    gl.uniform1i(prog.uniforms.u_wTex, 2);
    gl.uniform1i(prog.uniforms.u_wall, 3);
    gl.uniform1f(prog.uniforms.u_dx, dx);
    gl.uniform1f(prog.uniforms.u_dy, dy);
    gl.uniform1f(prog.uniforms.u_dz, dz);
    gl.uniform1f(prog.uniforms.u_dt, dt);
    this.quad.draw(gl);
    this.rhs.swap();
  }

  private runJacobi(dx: number, dy: number, dz: number): void {
    const gl = this.gl;
    const prog = this.p_jac;
    gl.useProgram(prog.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.p.fbWrite);
    gl.viewport(0, 0, this.p.layout.texWidth, this.p.layout.texHeight);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.p.read);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.rhs.read);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.wall.read);
    gl.uniform1i(prog.uniforms.u_p,    0);
    gl.uniform1i(prog.uniforms.u_rhs,  1);
    gl.uniform1i(prog.uniforms.u_wall, 2);
    gl.uniform1f(prog.uniforms.u_dx, dx);
    gl.uniform1f(prog.uniforms.u_dy, dy);
    gl.uniform1f(prog.uniforms.u_dz, dz);
    this.quad.draw(gl);
    this.p.swap();
  }

  private runGradient(prog: ShaderProgram, target: PingPongField, dxOrDyOrDz: number, dt: number): void {
    const gl = this.gl;
    gl.useProgram(prog.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbWrite);
    gl.viewport(0, 0, target.layout.texWidth, target.layout.texHeight);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, target.read);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.p.read);
    // Bind the appropriate face wall
    const wall = target === this.u ? this.uwall : target === this.v ? this.vwall : this.wwall;
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, wall.read);
    const dirName = target === this.u ? "u_u" : target === this.v ? "u_v" : "u_w";
    const wallName = target === this.u ? "u_uwall" : target === this.v ? "u_vwall" : "u_wwall";
    const stepName = target === this.u ? "u_dx" : target === this.v ? "u_dy" : "u_dz";
    gl.uniform1i(prog.uniforms[dirName],  0);
    gl.uniform1i(prog.uniforms.u_p,       1);
    gl.uniform1i(prog.uniforms[wallName], 2);
    gl.uniform1f(prog.uniforms[stepName], dxOrDyOrDz);
    gl.uniform1f(prog.uniforms.u_dt,      dt);
    this.quad.draw(gl);
    target.swap();
  }

  private clearScalar(field: PingPongField): void {
    // Render zero into the read texture (we want the next Jacobi pass to
    // start from p=0). Easiest path: bind the read fb and clear to (0,0,0,0).
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, field.fbRead);
    gl.viewport(0, 0, field.layout.texWidth, field.layout.texHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}
