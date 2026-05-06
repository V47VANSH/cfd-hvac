/**
 * CFD Web Worker — supports two backends behind a feature flag:
 *
 *   "legacy" — the original v6-derived collocated grid solver. Stable,
 *              reference baseline. Used when MAC is disabled.
 *   "mac"    — the Phase-2 MAC + multigrid solver with semi-Lagrangian
 *              advection, Smagorinsky LES, RH + CO₂ scalars,
 *              view-factor Tmrt, and CFL-adaptive timestep.
 *
 * The init message picks a backend; both keep the same snapshot wire
 * format (T, Vx, Vy, Vz cell-centred), so consumers (overlays, comfort
 * panel, optimizer) don't care which solver produced the fields.
 */

import { makeFields, NCELLS, NX as LEG_NX, NY as LEG_NY, NZ as LEG_NZ, type GridFields } from "@/lib/cfd/grid";
import { T_AMB, DT, MAX_STEPS } from "@/lib/cfd/constants";
import { voxelizeObstacles, voxelizeBlocks, voxelizeSTL } from "@/lib/cfd/voxelize";
import {
  injectHeatSources, injectACJets, injectFans, injectInfiltration, setACCold,
} from "@/lib/cfd/sources";
import { step as legacyStep, metrics, type FieldMetrics } from "@/lib/cfd/solver";

import {
  NX as MAC_NX, NY as MAC_NY, NZ as MAC_NZ, NCELLS as MAC_NCELLS,
  CK as MAC_CK, makeMACFields, cellCentredVelocity, type MACFields,
} from "@/lib/cfd/mac-grid";
import { voxelizeObstaclesMAC, voxelizeBlocksMAC, voxelizeSTLMAC, buildFaceMasks } from "@/lib/cfd/voxelize-mac";
import {
  injectHeatSourcesMAC, injectScalarSourcesMAC, injectACJetsMAC, setACSupplyT, injectInfiltrationMAC,
  bakeInitialVelocity,
} from "@/lib/cfd/sources-mac";
import { stepMAC, makeScratch, type SolverScratch } from "@/lib/cfd/solver-mac";
import { adaptiveTimestep } from "@/lib/cfd/timestep";
import { computeViewFactorTmrt } from "@/lib/cfd/radiation";
import { loadCalibration, getCalibrationSync, type Calibration } from "@/lib/cfd/calibration";
import { createWebGL2Backend, type WebGL2Backend } from "@/lib/cfd/webgl2/context";
import { WebGL2Runtime } from "@/lib/cfd/webgl2/runtime";

import type { Scene } from "@/lib/io/schema";

type Backend = "legacy" | "mac" | "mac-webgl2";

// ── Worker state ────────────────────────────────────────────────────────
let backend: Backend = "mac";
let scene: Scene | null = null;
let running = false;
let stepCount = 0;
/** Accumulated simulated time, seconds. Wall-clock-independent — the user
 *  cares about "5 minutes of sim", not "5 minutes of CPU". */
let elapsedSimS = 0;
/** Target simulated duration. The sim auto-stops once elapsedSimS reaches
 *  this. Defaults to 5 minutes. */
let targetDurationS = 300;
let acPositions: { x: number; z: number; wall: "S" | "N" | "E" | "W" }[] = [];

/** Lookup table: AC index → live tunable parameters from the scene.
 *  Rebuilt on every scene rebuild so per-AC settings are honoured. */
interface ACTunables {
  supply_temp_C: number;
  kw: number;
  // Geometry / aim
  throw_m: number;
  yaw_deg: number;
  pitch_deg: number;
  flow_cfm: number;
  /** Mounting height above floor, m. undefined → solver uses 0.88·H default. */
  mounting_height_m?: number;
  // Swing
  swing_h: boolean;
  swing_v: boolean;
  swing_period: number;
  swing_h_amp: number;
  swing_v_amp: number;
}
let acTunables: ACTunables[] = [];
function buildSupplyTempTable(s: Scene, ac: typeof acPositions): void {
  acTunables = ac.map((a) => {
    const u = s.ac_units.find((x) => x.x === a.x && x.z === a.z && x.wall === a.wall);
    return {
      supply_temp_C:  u?.supply_temp_C       ?? 14,
      kw:             u?.kw                  ?? 1.5,
      throw_m:        u?.throw_distance_m    ?? 4,
      yaw_deg:        u?.airflow_angle_deg   ?? 0,
      pitch_deg:      u?.vertical_angle_deg  ?? -5,
      flow_cfm:       u?.flow_rate_cfm       ?? 350,
      mounting_height_m: u?.mounting_height_m,
      swing_h:        u?.swing_horizontal    ?? false,
      swing_v:        u?.swing_vertical      ?? false,
      swing_period:   Math.max(1, u?.swing_period_s ?? 6),
      swing_h_amp:    u?.swing_h_amp_deg     ?? 30,
      swing_v_amp:    u?.swing_v_amp_deg     ?? 20,
    };
  });
}
function acWithSupply(): {
  x: number;
  z: number;
  wall: "S" | "N" | "E" | "W";
  supply_temp_C: number;
  kw: number;
  mounting_height_m?: number;
  throw_distance_m?: number;
  airflow_angle_deg?: number;
  vertical_angle_deg?: number;
}[] {
  return acPositions.map((a, i) => ({
    x: a.x, z: a.z, wall: a.wall,
    supply_temp_C: acTunables[i]?.supply_temp_C ?? 14,
    kw:            acTunables[i]?.kw            ?? 1.5,
    mounting_height_m: acTunables[i]?.mounting_height_m,
    throw_distance_m: acTunables[i]?.throw_m,
    airflow_angle_deg: acTunables[i]?.yaw_deg,
    vertical_angle_deg: acTunables[i]?.pitch_deg,
  }));
}

/** Returns true if any AC has swing enabled — drives the periodic
 *  recompute of fu/fv/fw in the tick loop. */
function anySwingEnabled(): boolean {
  return acTunables.some((t) => t.swing_h || t.swing_v);
}

/** Rebuild fu/fv/fw using the current swing-modulated yaw/pitch for each
 *  AC. Called periodically by the tick loop while the sim is running. */
function rebuildJetForcing(simTimeS: number): void {
  if (!scene) return;
  macFields.fu.fill(0);
  macFields.fv.fill(0);
  macFields.fw.fill(0);
  const specs = acPositions.map((a, i) => {
    const t = acTunables[i];
    if (!t) return { x: a.x, z: a.z, wall: a.wall };
    const phase = (2 * Math.PI * simTimeS) / t.swing_period;
    const yawSwing   = t.swing_h ? Math.sin(phase)              * t.swing_h_amp : 0;
    const pitchSwing = t.swing_v ? Math.sin(phase + Math.PI / 3) * t.swing_v_amp : 0;
    return {
      x: a.x, z: a.z, wall: a.wall,
      kw: t.kw,
      throwDistance: t.throw_m,
      airflowAngleDeg: t.yaw_deg + yawSwing,
      verticalAngleDeg: t.pitch_deg + pitchSwing,
      flowRateM3s: t.flow_cfm * 0.000472,
      mountingHeightM: t.mounting_height_m,
    };
  });
  injectACJetsMAC(macFields, scene.geometry, specs);
}

// Legacy backend state
let legacyFields: GridFields = makeFields();

// MAC backend state
let macFields: MACFields = makeMACFields();
let macScratch: SolverScratch | null = null;
let calibration: Calibration = getCalibrationSync();

// WebGL2 backend state — null when unsupported / not requested. The
// worker creates one OffscreenCanvas + WebGL2 context on first use of
// the "mac-webgl2" backend; if creation throws, we silently fall back
// to the JS MAC path and log a warning.
let gl2: WebGL2Backend | null = null;
let gl2Runtime: WebGL2Runtime | null = null;

// ── Wire types ──────────────────────────────────────────────────────────
export type WorkerCommand =
  | { kind: "init"; scene: Scene; ac: typeof acPositions; backend?: Backend; durationS?: number }
  | { kind: "start" }
  | { kind: "stop" }
  | { kind: "reset" }
  | { kind: "tick" }
  | { kind: "setDuration"; durationS: number };

export type WorkerEvent =
  | { kind: "ready" }
  | {
      kind: "snapshot";
      step: number;
      elapsedS: number;
      durationS: number;
      backend: Backend;
      metrics: FieldMetrics;
      T:  ArrayBuffer;
      Vx: ArrayBuffer;
      Vy: ArrayBuffer;
      Vz: ArrayBuffer;
      // Wall mask (Uint8 payload) — populated when backend === "mac";
      // viz uses it to skip cells outside the L-shape / inside obstacles.
      wall?: ArrayBuffer;
      // MAC-only payload (transferred only when backend === "mac")
      RH?:   ArrayBuffer;
      CO2?:  ArrayBuffer;
      Tmrt?: ArrayBuffer;
    }
  | { kind: "done"; step: number; elapsedS: number };

// ── Scene rebuild ───────────────────────────────────────────────────────
function rebuildScene(s: Scene, ac: typeof acPositions) {
  buildSupplyTempTable(s, ac);
  if (backend === "legacy") rebuildLegacy(s, ac);
  else                       rebuildMAC(s, ac);
  // After CPU MAC fields are set up, push them to GPU when we're on the
  // WebGL2 path. This is the bridge — voxelization + sources stay on CPU
  // (they're cheap, only run on scene change), and the per-step solver
  // runs entirely on GPU.
  if (backend === "mac-webgl2") {
    if (!gl2) {
      gl2 = createWebGL2Backend();
      if (!gl2) {
        console.warn("[cfd worker] WebGL2 backend unavailable — falling back to JS MAC");
        backend = "mac";
      }
    }
    if (gl2) {
      try {
        if (gl2Runtime) gl2Runtime.dispose();
        gl2Runtime = new WebGL2Runtime(gl2, s.geometry);
        gl2Runtime.uploadFromMAC(macFields);
      } catch (err) {
        console.warn("[cfd worker] WebGL2 runtime init failed; falling back to JS MAC:", err);
        backend = "mac";
        gl2Runtime = null;
      }
    }
  }
}

function rebuildLegacy(s: Scene, ac: typeof acPositions) {
  legacyFields = makeFields();
  legacyFields.T.fill(T_AMB);
  voxelizeObstacles(legacyFields, s.geometry, s.obstacles);
  voxelizeBlocks(legacyFields, s.geometry, s.geometry.extensions);
  voxelizeSTL(legacyFields, s.geometry, s.geometry.stl);
  injectHeatSources(legacyFields, s.geometry, s.obstacles);
  // Augment AC list with mounting_height_m from the scene so the legacy
  // jet sits at the right Y for STL-room scenes (where bbox H may be
  // tall due to a chimney).
  const acAug = ac.map((a) => {
    const u = s.ac_units.find((x) => x.x === a.x && x.z === a.z && x.wall === a.wall);
    return { ...a, mounting_height_m: u?.mounting_height_m };
  });
  injectACJets(legacyFields, s.geometry, acAug);
  injectFans(legacyFields, s.geometry, s.obstacles);
  injectInfiltration(legacyFields, s.geometry, s.openings);
}

function rebuildMAC(s: Scene, ac: typeof acPositions) {
  macFields = makeMACFields();
  // Use a higher initial T so the simulation starts hot (same convention
  // as the legacy backend) — the boundary BCs and AC then bring it down.
  macFields.T.fill(s.environment.outdoor_temp_C - 2);
  macFields.RH.fill(s.environment.RH_outdoor_pct / 100);
  macFields.CO2.fill(420);
  voxelizeObstaclesMAC(macFields, s.geometry, s.obstacles);
  voxelizeBlocksMAC(macFields, s.geometry, s.geometry.extensions);
  voxelizeSTLMAC(macFields, s.geometry, s.geometry.stl);
  buildFaceMasks(macFields);
  injectHeatSourcesMAC(macFields, s.geometry, s.obstacles);
  injectScalarSourcesMAC(macFields, s.geometry, s.obstacles);
  // AC jet specs from the scene (each AC carries its own throw / angle / flow)
  const acSpecs = ac.map((a) => {
    const u = s.ac_units.find((x) => x.x === a.x && x.z === a.z && x.wall === a.wall);
    return {
      x: a.x, z: a.z, wall: a.wall,
      kw:               u?.kw,
      throwDistance:   u?.throw_distance_m,
      airflowAngleDeg: u?.airflow_angle_deg,
      verticalAngleDeg: u?.vertical_angle_deg,
      flowRateM3s:     u?.flow_rate_cfm ? u.flow_rate_cfm * 0.000472 : undefined,
      mountingHeightM: u?.mounting_height_m,
    };
  });
  injectACJetsMAC(macFields, s.geometry, acSpecs);
  injectInfiltrationMAC(macFields, s.geometry, s.openings, s.environment.outdoor_temp_C, s.environment.RH_outdoor_pct / 100);
  // Pre-load 70 % of the persistent forcing into the live velocity field
  // so the AC jet is already developed at t=0 instead of taking ~10
  // sim-seconds to ramp up via the relax step.
  bakeInitialVelocity(macFields, 0.7);
  if (!macScratch) macScratch = makeScratch(s.geometry);
  computeViewFactorTmrt(macFields);
}

// ── Snapshot publisher ──────────────────────────────────────────────────
function postSnapshot() {
  if (!scene) return;
  if (backend === "legacy") postLegacySnapshot();
  else                      postMACSnapshot();
}

function postLegacySnapshot() {
  const m = metrics(legacyFields, scene!.environment.setpoint_C);
  const T  = new Float32Array(legacyFields.T).buffer;
  const Vx = new Float32Array(legacyFields.Vx).buffer;
  const Vy = new Float32Array(legacyFields.Vy).buffer;
  const Vz = new Float32Array(legacyFields.Vz).buffer;
  // Wall mask copy so the viz layer (arrows / particles / overlays) can
  // skip cells outside the L-shape — same wire format as MAC snapshot.
  const wallCopy = new Uint8Array(legacyFields.wall);
  const wallBuf = wallCopy.buffer;
  const ev: WorkerEvent = {
    kind: "snapshot", step: stepCount, elapsedS: elapsedSimS, durationS: targetDurationS,
    backend: "legacy",
    metrics: m, T, Vx, Vy, Vz, wall: wallBuf,
  };
  (self as unknown as Worker).postMessage(ev, [T, Vx, Vy, Vz, wallBuf]);
}

function postMACSnapshot() {
  // Convert MAC face velocities into cell-centred Vx/Vy/Vz for the wire.
  const Vx = new Float32Array(MAC_NCELLS);
  const Vy = new Float32Array(MAC_NCELLS);
  const Vz = new Float32Array(MAC_NCELLS);
  for (let iz = 0; iz < MAC_NZ; iz++)
    for (let iy = 0; iy < MAC_NY; iy++)
      for (let ix = 0; ix < MAC_NX; ix++) {
        const k = MAC_CK(ix, iy, iz);
        const v = cellCentredVelocity(macFields, ix, iy, iz);
        Vx[k] = v.vx; Vy[k] = v.vy; Vz[k] = v.vz;
      }
  // Defence in depth: any non-finite value (NaN/Inf) in the snapshot
  // crashes the colormap downstream. Replace with safe defaults — much
  // better than a UI explosion if a future numerics bug slips through.
  const Tcopy = new Float32Array(macFields.T);
  const RHcopy = new Float32Array(macFields.RH);
  const CO2copy = new Float32Array(macFields.CO2);
  const TmrtCopy = new Float32Array(macFields.Tmrt);
  const Tamb = scene!.environment.outdoor_temp_C;
  sanitize(Tcopy,   Tamb);
  sanitize(RHcopy,  0.5);
  sanitize(CO2copy, 420);
  sanitize(TmrtCopy, Tamb);
  sanitize(Vx, 0); sanitize(Vy, 0); sanitize(Vz, 0);

  const m = macMetrics(macFields, Vx, Vy, Vz, scene!.environment.setpoint_C);
  // Diagnostic: when results look bogus (Mean Temp = 0 in the sidebar)
  // this prints the actual field statistics so we can tell whether the
  // wall mask captured everything (n=0 → mean=0 by the n>0 guard) or the
  // T field genuinely went to zero. Logs on snapshot ticks (~1/sec).
  if (stepCount % 60 === 0) {
    let nWall = 0; for (let k = 0; k < MAC_NCELLS; k++) if (macFields.wall[k]) nWall++;
    let nNZ = 0, sumT = 0; for (let k = 0; k < MAC_NCELLS; k++) {
      if (macFields.T[k] !== 0) nNZ++; sumT += macFields.T[k];
    }
    console.log("[cfd] step=%d wall_cells=%d/%d  T_nonzero=%d/%d  meanT_all=%s  metrics=%o",
      stepCount, nWall, MAC_NCELLS, nNZ, MAC_NCELLS, (sumT / MAC_NCELLS).toFixed(2), m);
  }
  const T   = Tcopy.buffer;
  const RH  = RHcopy.buffer;
  const CO2 = CO2copy.buffer;
  const TmrtBuf = TmrtCopy.buffer;
  const VxBuf = Vx.buffer, VyBuf = Vy.buffer, VzBuf = Vz.buffer;
  // Wall-mask copy (Uint8) so the viz layer can skip outside-L-shape
  // cells. Tiny payload (~14 KB at default grid) — not worth lazy.
  const wallCopy = new Uint8Array(macFields.wall);
  const wallBuf = wallCopy.buffer;
  const ev: WorkerEvent = {
    kind: "snapshot", step: stepCount, elapsedS: elapsedSimS, durationS: targetDurationS,
    backend,
    metrics: m,
    T, Vx: VxBuf, Vy: VyBuf, Vz: VzBuf,
    RH, CO2, Tmrt: TmrtBuf, wall: wallBuf,
  };
  (self as unknown as Worker).postMessage(ev, [T, VxBuf, VyBuf, VzBuf, RH, CO2, TmrtBuf, wallBuf]);
}

function sanitize(a: Float32Array, fill: number): void {
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (!Number.isFinite(v)) a[i] = fill;
  }
}

function macMetrics(
  f: MACFields, Vx: Float32Array, Vy: Float32Array, Vz: Float32Array, Tset: number,
): FieldMetrics {
  let s = 0, s2 = 0, h = 0, n = 0, maxSpd = 0;
  for (let k = 0; k < MAC_NCELLS; k++) {
    if (f.wall[k]) continue;
    let T = f.T[k];
    if (!Number.isFinite(T)) T = Tset;
    s += T; s2 += T * T;
    if (T > Tset + 4) h++;
    n++;
    const sp = Math.sqrt(Vx[k] ** 2 + Vy[k] ** 2 + Vz[k] ** 2);
    if (Number.isFinite(sp) && sp > maxSpd) maxSpd = sp;
  }
  const mean = n > 0 ? s / n : 0;
  const variance = n > 0 ? s2 / n - mean * mean : 0;
  const std = Math.sqrt(Math.max(0, variance));
  return {
    mean: Number.isFinite(mean) ? mean : Tset,
    std:  Number.isFinite(std)  ? std  : 0,
    hot:  n > 0 ? (h / n) * 100 : 0,
    maxSpd,
  };
}

// ── Command channel ─────────────────────────────────────────────────────
self.onmessage = (e: MessageEvent<WorkerCommand>) => {
  const cmd = e.data;
  switch (cmd.kind) {
    case "init": {
      scene = cmd.scene;
      acPositions = cmd.ac;
      if (cmd.backend) backend = cmd.backend;
      if (typeof cmd.durationS === "number" && cmd.durationS > 0) targetDurationS = cmd.durationS;
      // Best-effort calibration load on the MAC path. Falls back to defaults.
      if (backend === "mac" || backend === "mac-webgl2") {
        loadCalibration().then((c) => { calibration = c; });
      }
      rebuildScene(scene, acPositions);
      stepCount = 0;
      elapsedSimS = 0;
      const ready: WorkerEvent = { kind: "ready" };
      (self as unknown as Worker).postMessage(ready);
      break;
    }
    case "start": {
      if (!scene) return;
      running = true;
      tick();
      break;
    }
    case "stop":  { running = false; break; }
    case "reset": {
      if (!scene) return;
      rebuildScene(scene, acPositions);
      stepCount = 0;
      elapsedSimS = 0;
      postSnapshot();
      break;
    }
    case "tick":  { tick(); break; }
    case "setDuration": {
      if (cmd.durationS > 0) targetDurationS = cmd.durationS;
      break;
    }
  }
};

// ── Tick ────────────────────────────────────────────────────────────────
//
// Stop conditions (whichever fires first):
//   1. elapsedSimS ≥ targetDurationS  — user asked for X minutes of sim
//   2. stepCount   ≥ MAX_STEPS_HARD  — absolute safety so we never loop forever
//
const MAX_STEPS_HARD = 50_000;

function tick() {
  if (!running || !scene) return;
  if (elapsedSimS >= targetDurationS || stepCount >= MAX_STEPS_HARD) {
    running = false;
    const done: WorkerEvent = { kind: "done", step: stepCount, elapsedS: elapsedSimS };
    (self as unknown as Worker).postMessage(done);
    postSnapshot();   // emit one final frame so the UI shows the end state
    return;
  }

  if (backend === "legacy") {
    legacyStep({
      fields: legacyFields,
      room: scene.geometry,
      openings: scene.openings,
      Tout: scene.environment.outdoor_temp_C,
      n: 2,
    });
    setACCold(legacyFields, scene.geometry, acWithSupply());
    stepCount += 2;
    elapsedSimS += 2 * DT;
  } else if (backend === "mac-webgl2" && gl2Runtime) {
    // WebGL2 MAC path — runs the same numerics on GPU. We readback to
    // the CPU MAC fields once per snapshot so all the existing
    // visualization + comfort + report code paths still work.
    for (let s = 0; s < 2; s++) {
      const dt = adaptiveTimestep(macFields, scene.geometry);
      gl2Runtime.step(dt, scene.geometry, calibration);
      stepCount++;
      elapsedSimS += dt;
    }
    // Periodic CPU sync — the snapshot publisher reads macFields. We
    // sync only on snapshot frames to avoid the readback stall.
    if (stepCount % 10 < 2) {
      gl2Runtime.readbackTo(macFields);
      // AC supply T clamp + view-factor Tmrt are cheap CPU ops, run on
      // the freshly-readback fields.
      setACSupplyT(macFields, scene.geometry, acWithSupply(), 0.05);
      computeViewFactorTmrt(macFields);
      // Push T back to the GPU so the next steps see the clamped supply.
      // (u/v/w stay where they are — gradient subtraction wrote them.)
      gl2Runtime.T.upload(macFields.T);
    }
    if (anySwingEnabled() && stepCount % 5 === 0) {
      rebuildJetForcing(elapsedSimS);
      // Push fresh forcing arrays to GPU
      gl2Runtime.fu.upload(macFields.fu);
      gl2Runtime.fv.upload(macFields.fv);
      gl2Runtime.fw.upload(macFields.fw);
    }
  } else {
    // MAC: take 2 substeps with adaptive dt
    for (let s = 0; s < 2; s++) {
      const dt = adaptiveTimestep(macFields, scene.geometry);
      stepMAC({
        fields:   macFields,
        room:     scene.geometry,
        openings: scene.openings,
        Tout:     scene.environment.outdoor_temp_C,
        RHout:    scene.environment.RH_outdoor_pct / 100,
        dt,
        cal:      calibration,
        scratch:  macScratch!,
      });
      // dt is the per-substep adaptive timestep; pass it through so
      // the AC's energy budget (kW × dt) is correctly sized.
      setACSupplyT(macFields, scene.geometry, acWithSupply(), dt);
      stepCount++;
      elapsedSimS += dt;
    }
    // View-factor Tmrt every 5 steps (cheap but not free)
    if (stepCount % 10 < 2) computeViewFactorTmrt(macFields);
    // AC swing — rebuild jet forcing every ~5 substeps when any AC is
    // swinging. Cheap (~1 ms on the default grid) and gives smooth
    // sweeping motion at the visible 0.4 s sub-period level.
    if (anySwingEnabled() && stepCount % 5 === 0) {
      rebuildJetForcing(elapsedSimS);
    }
  }

  if (stepCount % 10 === 0) postSnapshot();
  setTimeout(tick, 0);
}

void MAX_STEPS;   // legacy export kept for tree-shake stability

// Touch the constants to keep tree-shaking honest
void NCELLS; void LEG_NX; void LEG_NY; void LEG_NZ;
void MAC_NX; void MAC_NY; void MAC_NZ; void MAC_NCELLS;

const ready: WorkerEvent = { kind: "ready" };
(self as unknown as Worker).postMessage(ready);
