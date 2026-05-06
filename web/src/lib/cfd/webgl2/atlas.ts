/**
 * Texture-atlas mapping for the 3D MAC fields.
 *
 * Each 3D field is laid out as a 2D atlas with each z-slab placed in a
 * row of (NX × NY) texels. For NX=36, NY=14, NZ=28 the atlas is
 * 36×392 = 14112 texels — comfortably small. The high-accuracy
 * 96×36×72 grid → 96×2592 = 248k texels, still well under
 * `MAX_TEXTURE_SIZE` (typically 8192–16384).
 *
 * GL coordinate convention (cell-centred fields):
 *   - texel (px, py) corresponds to (ix, iy, iz) where
 *       iz = floor(py / NY)
 *       iy = py mod NY
 *       ix = px
 *   - sampling between texels uses GL_LINEAR (when EXT_color_buffer_float
 *     + OES_texture_float_linear are both available).
 *
 * For face-centred fields the atlas grows by 1 in the appropriate
 * direction:
 *   - u-faces: (NX+1) × NY × NZ → (NX+1) × (NY·NZ) texels
 *   - v-faces:  NX × (NY+1) × NZ → NX × ((NY+1)·NZ) texels
 *   - w-faces:  NX × NY × (NZ+1) → NX × (NY·(NZ+1)) texels
 */

export interface AtlasLayout {
  /** Logical 3D dimensions */
  nx: number; ny: number; nz: number;
  /** 2D texture dimensions */
  texWidth: number;
  texHeight: number;
}

export type FieldKind = "scalar" | "u" | "v" | "w";

export function atlasFor(kind: FieldKind, nx: number, ny: number, nz: number): AtlasLayout {
  switch (kind) {
    case "scalar": return { nx,     ny,     nz,     texWidth: nx,     texHeight: ny      * nz       };
    case "u":      return { nx,     ny,     nz,     texWidth: nx + 1, texHeight: ny      * nz       };
    case "v":      return { nx,     ny,     nz,     texWidth: nx,     texHeight: (ny + 1) * nz       };
    case "w":      return { nx,     ny,     nz,     texWidth: nx,     texHeight: ny      * (nz + 1) };
  }
}

/** Convert a logical (ix, iy, iz) to atlas texel (px, py) for any field kind. */
export function cellToAtlas(
  layout: AtlasLayout, ix: number, iy: number, iz: number,
): { px: number; py: number } {
  return { px: ix, py: iz * layout.ny + iy };
}

/** GLSL helper code for 3D ↔ 2D atlas math, injected into every kernel. */
export const ATLAS_GLSL = /* glsl */ `
  // 3D logical dims (declared by the kernel via #defines NX, NY, NZ)
  // 2D atlas size in texels: ATLAS_W × ATLAS_H

  // Convert a cell index (ix, iy, iz) → atlas texel (px, py)
  ivec2 cellToAtlas(int ix, int iy, int iz) {
    return ivec2(ix, iz * NY + iy);
  }

  // Atlas texel → cell index
  ivec3 atlasToCell(ivec2 px) {
    int ix = px.x;
    int iz = px.y / NY;
    int iy = px.y - iz * NY;
    return ivec3(ix, iy, iz);
  }

  // Sample a cell-centred scalar at fractional cell position (cx, cy, cz)
  // using trilinear interpolation across z-slabs (which sit in different
  // rows of the atlas). This is the "z-blend" trick — sample two adjacent
  // z-slabs separately, then mix in the fragment shader.
  float sampleScalar3D(sampler2D tex, vec3 cell, float NX_f, float NY_f, float NZ_f) {
    cell.x = clamp(cell.x, 0.0, NX_f - 1.0001);
    cell.y = clamp(cell.y, 0.0, NY_f - 1.0001);
    cell.z = clamp(cell.z, 0.0, NZ_f - 1.0001);
    int iz0 = int(floor(cell.z));
    int iz1 = iz0 + 1;
    if (float(iz1) > NZ_f - 1.0) iz1 = iz0;
    float tz = cell.z - float(iz0);

    // 2D positions for the two z-slabs (in texel units, then normalised)
    vec2 atlasSize = vec2(ATLAS_W, ATLAS_H);
    vec2 inSlabXY = vec2(cell.x, cell.y);   // (ix, iy) in cell units, fractional

    vec2 uv0 = (inSlabXY + vec2(0.5, 0.5 + float(iz0) * NY_f)) / atlasSize;
    vec2 uv1 = (inSlabXY + vec2(0.5, 0.5 + float(iz1) * NY_f)) / atlasSize;

    float a = texture(tex, uv0).r;
    float b = texture(tex, uv1).r;
    return mix(a, b, tz);
  }

  // Sample a u-face scalar (face-centred in x, cell-centred in y/z) at
  // a fractional cell position. The face index runs 0..NX inclusive, so
  // cell.x ∈ [0, NX].
  float sampleU3D(sampler2D tex, vec3 cell, float NX_f, float NY_f, float NZ_f) {
    cell.x = clamp(cell.x, 0.0, NX_f);
    cell.y = clamp(cell.y, 0.0, NY_f - 1.0001);
    cell.z = clamp(cell.z, 0.0, NZ_f - 1.0001);
    int iz0 = int(floor(cell.z));
    int iz1 = iz0 + 1;
    if (float(iz1) > NZ_f - 1.0) iz1 = iz0;
    float tz = cell.z - float(iz0);
    vec2 atlasSize = vec2(float(int(NX_f) + 1), ATLAS_H);
    vec2 inSlabXY  = vec2(cell.x, cell.y);
    vec2 uv0 = (inSlabXY + vec2(0.5, 0.5 + float(iz0) * NY_f)) / atlasSize;
    vec2 uv1 = (inSlabXY + vec2(0.5, 0.5 + float(iz1) * NY_f)) / atlasSize;
    return mix(texture(tex, uv0).r, texture(tex, uv1).r, tz);
  }
  // v-face: face-centred in y, cell-centred in x/z
  float sampleV3D(sampler2D tex, vec3 cell, float NX_f, float NY_f, float NZ_f) {
    cell.x = clamp(cell.x, 0.0, NX_f - 1.0001);
    cell.y = clamp(cell.y, 0.0, NY_f);
    cell.z = clamp(cell.z, 0.0, NZ_f - 1.0001);
    int iz0 = int(floor(cell.z));
    int iz1 = iz0 + 1;
    if (float(iz1) > NZ_f - 1.0) iz1 = iz0;
    float tz = cell.z - float(iz0);
    float NYp1 = NY_f + 1.0;
    vec2 atlasSize = vec2(NX_f, NYp1 * NZ_f);
    vec2 inSlabXY  = vec2(cell.x, cell.y);
    vec2 uv0 = (inSlabXY + vec2(0.5, 0.5 + float(iz0) * NYp1)) / atlasSize;
    vec2 uv1 = (inSlabXY + vec2(0.5, 0.5 + float(iz1) * NYp1)) / atlasSize;
    return mix(texture(tex, uv0).r, texture(tex, uv1).r, tz);
  }
  // w-face: face-centred in z, cell-centred in x/y
  float sampleW3D(sampler2D tex, vec3 cell, float NX_f, float NY_f, float NZ_f) {
    cell.x = clamp(cell.x, 0.0, NX_f - 1.0001);
    cell.y = clamp(cell.y, 0.0, NY_f - 1.0001);
    cell.z = clamp(cell.z, 0.0, NZ_f);
    int iz0 = int(floor(cell.z));
    int iz1 = iz0 + 1;
    if (float(iz1) > NZ_f) iz1 = iz0;
    float tz = cell.z - float(iz0);
    vec2 atlasSize = vec2(NX_f, NY_f * (NZ_f + 1.0));
    vec2 inSlabXY  = vec2(cell.x, cell.y);
    vec2 uv0 = (inSlabXY + vec2(0.5, 0.5 + float(iz0) * NY_f)) / atlasSize;
    vec2 uv1 = (inSlabXY + vec2(0.5, 0.5 + float(iz1) * NY_f)) / atlasSize;
    return mix(texture(tex, uv0).r, texture(tex, uv1).r, tz);
  }
`;
