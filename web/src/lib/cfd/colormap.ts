/**
 * Color maps for thermal and velocity fields.
 * Ported verbatim from v6 (lines 294-305).
 */

export type RGB = [number, number, number];

const TEMP_STOPS: RGB[] = [
  [  0,  80, 200],
  [  0, 184, 228],
  [  0, 216, 136],
  [232, 216,   0],
  [248, 112,  32],
  [232,   0,   0],
];

const SPEED_STOPS: RGB[] = [
  [  0,  20,  60],
  [  0,  80, 180],
  [  0, 190, 255],
  [200, 240, 255],
];

function lerp(stops: RGB[], t: number): RGB {
  t = Math.max(0, Math.min(1, t));
  const si = t * (stops.length - 1);
  const i0 = Math.floor(si);
  const i1 = Math.min(i0 + 1, stops.length - 1);
  const f  = si - i0;
  return [
    stops[i0][0] * (1 - f) + stops[i1][0] * f,
    stops[i0][1] * (1 - f) + stops[i1][1] * f,
    stops[i0][2] * (1 - f) + stops[i1][2] * f,
  ];
}

/** Map normalized temperature [0..1] (16°C → 45°C) to RGB. */
export const tempRGB  = (t: number): RGB => lerp(TEMP_STOPS,  t);

/** Map normalized speed [0..1] (0 → 4.5 m/s) to RGB. */
export const speedRGB = (s: number): RGB => lerp(SPEED_STOPS, s);

export const T_MIN = 16;
export const T_MAX = 45;
export const SPEED_MAX = 4.5;
