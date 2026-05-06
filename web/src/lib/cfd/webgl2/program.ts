/**
 * Shader compilation + program-cache helpers.
 *
 * Every kernel uses the same vertex shader (a fullscreen triangle); only
 * the fragment shader differs. We share a single VBO + VAO for the
 * fullscreen triangle across all programs.
 */

const FS_HEADER = "#version 300 es\nprecision highp float;\nprecision highp sampler2D;\n";
const VS_FULLSCREEN = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

export interface ShaderProgram {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

export function createProgram(
  gl: WebGL2RenderingContext, fragSource: string,
  uniformNames: string[],
): ShaderProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VS_FULLSCREEN, "fullscreen-vs");
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FS_HEADER + fragSource, "kernel-fs");
  const program = gl.createProgram();
  if (!program) throw new Error("createProgram failed");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  // Bind the fullscreen-triangle VBO to attribute 0
  gl.bindAttribLocation(program, 0, "a_pos");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "";
    gl.deleteProgram(program);
    throw new Error("link failed: " + log);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  for (const n of uniformNames) {
    uniforms[n] = gl.getUniformLocation(program, n);
  }
  return { program, uniforms };
}

function compileShader(
  gl: WebGL2RenderingContext, type: number, source: string, label: string,
): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error(`createShader failed (${label})`);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? "";
    gl.deleteShader(sh);
    throw new Error(`shader compile failed (${label}):\n${log}\n--- source ---\n${source}`);
  }
  return sh;
}

/** Create the shared fullscreen-triangle VAO + VBO for all kernel passes. */
export interface FullscreenQuad {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  draw(gl: WebGL2RenderingContext): void;
}

export function createFullscreenQuad(gl: WebGL2RenderingContext): FullscreenQuad {
  const vao = gl.createVertexArray();
  const vbo = gl.createBuffer();
  if (!vao || !vbo) throw new Error("VAO/VBO alloc failed");
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  // A single triangle that covers the [-1,1]² clip space (clipped on the
  // edges — saves the third vertex of a strip without quality loss).
  const verts = new Float32Array([-1, -1,  3, -1,  -1, 3]);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return {
    vao, vbo,
    draw(gl) {
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    },
  };
}
