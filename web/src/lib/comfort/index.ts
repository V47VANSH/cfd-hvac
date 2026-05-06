export { pmv, type PMVInputs } from "./pmv";
export { ppd } from "./ppd";
export { draftRisk } from "./draftRisk";
export { operativeT } from "./operativeT";
export {
  SAMPLE_HEIGHTS_M, type SampleHeight,
  iyForHeight, extractSlab, type Slab,
} from "./sampleHeights";
export {
  type ComfortContext, makeComfortContext,
  pmvAt, ppdAt, drAt, operativeTAt,
  type HeightSummary, summarizeHeight, verticalDeltaT,
  type ComfortReport, buildComfortReport,
} from "./comfortField";
