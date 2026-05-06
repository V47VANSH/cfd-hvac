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

const VORT_STOPS: RGB[] = [
  [  8,  18,  44],
  [ 24, 112, 210],
  [ 52, 220, 190],
  [232, 220,  64],
  [240,  88, 160],
  [255, 245, 255],
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

/** Map normalized vorticity magnitude [0..1] to RGB. */
export const vortRGB = (w: number): RGB => lerp(VORT_STOPS, w);

export const T_MIN = 16;
export const T_MAX = 45;
export const SPEED_MAX = 4.5;
export const VORT_MAX = 6.0;

// ── Comfort palettes ─────────────────────────────────────────────────────

/**
 * Diverging palette for PMV [-3..+3]: cold blue → neutral grey → hot red.
 * Centred on the neutral band (-0.5..+0.5 ≈ ASHRAE 55 acceptable).
 */
const PMV_STOPS: RGB[] = [
  [ 32,  72, 200],   // -3 cold
  [ 96, 168, 232],   // -1.5
  [220, 232, 232],   //  0  neutral
  [240, 168,  88],   // +1.5
  [216,  32,  32],   // +3 hot
];

/**
 * Monotonic palette for PPD (% dissatisfied): green (good) → yellow → red.
 * 0 = perfect (5 % minimum), 100 = nobody is comfortable.
 */
const PPD_STOPS: RGB[] = [
  [ 56, 168,  72],   //  0
  [216, 200,  64],   // 30
  [232, 120,  40],   // 60
  [200,  24,  24],   // 100
];

/**
 * Monotonic palette for Draft Risk (%): cyan (no draft) → orange → magenta.
 * Same scale as PPD (0..100).
 */
const DR_STOPS: RGB[] = [
  [ 24,  88, 144],   //  0  no draft
  [ 80, 196, 232],   // 25
  [232, 168,  72],   // 50
  [216,  56, 144],   // 100 strong draft
];

/** Map normalized PMV [(-3..+3) → 0..1] to RGB. */
export const pmvRGB = (pmv: number): RGB =>
  lerp(PMV_STOPS, (Math.max(-3, Math.min(3, pmv)) + 3) / 6);
/** Map PPD percent [0..100] to RGB. */
export const ppdRGB = (ppd: number): RGB =>
  lerp(PPD_STOPS, Math.max(0, Math.min(100, ppd)) / 100);
/** Map Draft Risk percent [0..100] to RGB. */
export const drRGB  = (dr: number): RGB =>
  lerp(DR_STOPS,  Math.max(0, Math.min(100, dr)) / 100);

export const PMV_MIN = -3;
export const PMV_MAX =  3;
export const PPD_MAX = 100;
export const DR_MAX  = 100;
