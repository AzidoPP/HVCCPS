// Interactive calibration sweep: the operator's scan plan plus the per-point
// state machine that drives the output and captures the RAW reading.
//
// Why this exists: collecting the point table by hand means measuring every
// point first and typing the whole sheet in afterwards. Here the host drives
// one setpoint at a time -- a fresh power-on per point, which is what the bench
// asked for -- waits for the RAW reading to stop moving, pre-fills it, and asks
// for the meter value before moving on.
//
// The points land in the very same calibration model the manual table edits, so
// compiling the residual grid, previewing it and burning it to flash are
// untouched.
//
// Command frames go out through device.sendFrame(), NOT through run-service:
// run-service owns the staged setpoints that the command bar and localStorage
// share, and a sweep must not overwrite them.

HV.define("device/calibration-sweep", function (require, exports) {
"use strict";

const { bus, EVENTS } = require("core/bus");
const { notify, notifyError, notifyFailure } = require("core/notify");
const { requestRender } = require("core/scheduler");
const { readJson, writeJson } = require("core/storage");
const {
  buildCommandFrame,
  CAL_I_MAX_MA,
  CAL_MAX_DI_MA,
  CAL_MAX_DV_MV,
  CAL_V_MAX_MV,
  controlModeKey,
  MAX_CC_MA,
  MAX_CP_W,
  MAX_CV_V,
  RUN_CONTINUOUS
} = require("protocol/index");

const STORAGE_AREA = "app";
const STORAGE_KEY = "cal.sweep.v1";

const SECTION = Object.freeze({ VOLTAGE: "voltage", CURRENT: "current" });
const PHASE = Object.freeze({ IDLE: "idle", RUN: "run", DONE: "done" });

/** Stability window: the operator reads a meter while this is held flat. */
const SETTLE_WINDOW_MS = 600;
const POLL_MS = 50;
/** Gate-down gap between points, so every point is a real fresh power-on. */
const RESTART_GAP_MS = 200;
const V_FLOOR_MV = 2000; // 2 V
const I_FLOOR_MA = 0.5;
const MAX_POINTS = 21;
const MAX_METER_V = (CAL_V_MAX_MV + CAL_MAX_DV_MV) / 1000;
const MAX_METER_I = CAL_I_MAX_MA + CAL_MAX_DI_MA;

function defaultConfig() {
  return {
    voltageEnabled: true,
    voltageCount: 5,
    voltageStartV: 200,
    voltageEndV: 1000,
    voltageCcMa: 80,
    voltageCpW: 120,
    currentEnabled: true,
    currentCount: 5,
    currentStartMa: 20,
    currentEndMa: 150,
    currentCvV: 800,
    currentCpW: 120,
    holdSeconds: 30,
    settleMs: 2000,
    settleTimeoutMs: 10000,
    tolerancePct: 0.5,
    disableCalFirst: true,
    clearFirst: true
  };
}

function sanitizeConfig(raw) {
  const base = defaultConfig();
  if (!raw || typeof raw !== "object") return base;
  const number = (value, fallback) => (Number.isFinite(value) ? value : fallback);
  return {
    voltageEnabled: raw.voltageEnabled !== false,
    voltageCount: number(raw.voltageCount, base.voltageCount),
    voltageStartV: number(raw.voltageStartV, base.voltageStartV),
    voltageEndV: number(raw.voltageEndV, base.voltageEndV),
    voltageCcMa: number(raw.voltageCcMa, base.voltageCcMa),
    voltageCpW: number(raw.voltageCpW, base.voltageCpW),
    currentEnabled: raw.currentEnabled !== false,
    currentCount: number(raw.currentCount, base.currentCount),
    currentStartMa: number(raw.currentStartMa, base.currentStartMa),
    currentEndMa: number(raw.currentEndMa, base.currentEndMa),
    currentCvV: number(raw.currentCvV, base.currentCvV),
    currentCpW: number(raw.currentCpW, base.currentCpW),
    holdSeconds: number(raw.holdSeconds, base.holdSeconds),
    settleMs: number(raw.settleMs, base.settleMs),
    settleTimeoutMs: number(raw.settleTimeoutMs, base.settleTimeoutMs),
    tolerancePct: number(raw.tolerancePct, base.tolerancePct),
    disableCalFirst: raw.disableCalFirst !== false,
    clearFirst: raw.clearFirst !== false
  };
}

function interpolate(start, end, count) {
  const n = Math.max(1, Math.trunc(count));
  if (n === 1) return [start];
  const step = (end - start) / (n - 1);
  return Array.from({ length: n }, (_, index) => start + step * index);
}

/** Evenly spaced scan plan: the voltage section first, then the current one. */
function planPoints(config) {
  const points = [];
  if (config.voltageEnabled) {
    const values = interpolate(config.voltageStartV, config.voltageEndV, config.voltageCount);
    values.forEach((volts, index) => {
      points.push({
        section: SECTION.VOLTAGE,
        index,
        count: values.length,
        cvMv: Math.round(volts * 1000),
        ccMa: Math.round(config.voltageCcMa),
        cpMw: Math.round(config.voltageCpW * 1000),
        target: volts,
        targetUnit: "V"
      });
    });
  }
  if (config.currentEnabled) {
    const values = interpolate(config.currentStartMa, config.currentEndMa, config.currentCount);
    values.forEach((milliamps, index) => {
      points.push({
        section: SECTION.CURRENT,
        index,
        count: values.length,
        cvMv: Math.round(config.currentCvV * 1000),
        ccMa: Math.round(milliamps),
        cpMw: Math.round(config.currentCpW * 1000),
        target: milliamps,
        targetUnit: "mA"
      });
    });
  }
  return points;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function inRange(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function readRawVoltageMv(latest) {
  return Number.isFinite(latest.rawVSecMv) ? latest.rawVSecMv : latest.vSecMv;
}

function readRawCurrentMa(latest) {
  return Number.isFinite(latest.rawISecMa) ? latest.rawISecMa : latest.iSecMa;
}

function emptySummary() {
  return {
    count: 0,
    v: 0,
    i: 0,
    maxReadbackV: 0,
    maxReadbackI: 0,
    maxProgV: 0,
    unstable: 0,
    foreign: 0,
    notCc: 0
  };
}

function createCalibrationSweepService(device, cal) {
  const model = {
    phase: PHASE.IDLE,
    step: "settle",
    config: sanitizeConfig(readJson(STORAGE_AREA, STORAGE_KEY, null)),
    points: [],
    planPreview: [],
    planCount: 0,
    cursor: 0,
    busy: false,
    sample: null,
    errors: [],
    resetToken: 0,
    records: [],
    summary: emptySummary()
  };

  let abort = false;
  let exitReason = "finish";
  let resume = null;
  const timers = new Set();

  model.planPreview = planPoints(model.config);
  model.planCount = model.planPreview.length;

  // ---- small async plumbing ------------------------------------------------

  function sleep(ms) {
    return new Promise((resolve) => {
      const id = window.setTimeout(() => {
        timers.delete(id);
        resolve();
      }, ms);
      timers.add(id);
    });
  }

  function cancelTimers() {
    for (const id of timers) window.clearTimeout(id);
    timers.clear();
  }

  /** The runner parks here; every operator button resolves it. */
  function waitAction() {
    return new Promise((resolve) => {
      resume = resolve;
    });
  }

  function signal(action) {
    const resolve = resume;
    resume = null;
    if (resolve) resolve(action);
  }

  // ---- configuration -------------------------------------------------------

  function validateConfig() {
    const cfg = model.config;
    const errors = [];
    if (!cfg.voltageEnabled && !cfg.currentEnabled) {
      errors.push({ key: "cal.wiz.validate.noSection" });
    }
    if (cfg.voltageEnabled) {
      if (!inRange(cfg.voltageCount, 2, MAX_POINTS)) errors.push({ key: "cal.wiz.validate.count", params: { max: MAX_POINTS } });
      if (!inRange(cfg.voltageStartV, 0, MAX_CV_V) || !inRange(cfg.voltageEndV, 0, MAX_CV_V)) {
        errors.push({ key: "cal.wiz.validate.voltage", params: { max: MAX_CV_V } });
      }
      if (!inRange(cfg.voltageCcMa, 0, MAX_CC_MA)) errors.push({ key: "cal.wiz.validate.cc", params: { max: MAX_CC_MA } });
      if (!inRange(cfg.voltageCpW, 0, MAX_CP_W)) errors.push({ key: "cal.wiz.validate.cp", params: { max: MAX_CP_W } });
    }
    if (cfg.currentEnabled) {
      if (!inRange(cfg.currentCount, 2, MAX_POINTS)) errors.push({ key: "cal.wiz.validate.count", params: { max: MAX_POINTS } });
      if (!inRange(cfg.currentStartMa, 0, MAX_CC_MA) || !inRange(cfg.currentEndMa, 0, MAX_CC_MA)) {
        errors.push({ key: "cal.wiz.validate.cc", params: { max: MAX_CC_MA } });
      }
      if (!inRange(cfg.currentCvV, 0, MAX_CV_V)) errors.push({ key: "cal.wiz.validate.voltage", params: { max: MAX_CV_V } });
      if (!inRange(cfg.currentCpW, 0, MAX_CP_W)) errors.push({ key: "cal.wiz.validate.cp", params: { max: MAX_CP_W } });
    }
    if (!inRange(cfg.holdSeconds, 5, 600)) errors.push({ key: "cal.wiz.validate.hold", params: { min: 5, max: 600 } });
    if (!inRange(cfg.settleMs, 200, 5000)) errors.push({ key: "cal.wiz.validate.settle", params: { min: 200, max: 5000 } });
    if (!inRange(cfg.settleTimeoutMs, 500, 60000)) {
      errors.push({ key: "cal.wiz.validate.timeout", params: { min: 500, max: 60000 } });
    }
    if (!inRange(cfg.tolerancePct, 0.05, 10)) errors.push({ key: "cal.wiz.validate.tolerance", params: { min: 0.05, max: 10 } });
    return { ok: errors.length === 0, errors };
  }

  function patchConfig(changes, { persistNow = true } = {}) {
    model.config = sanitizeConfig({ ...model.config, ...changes });
    if (persistNow) writeJson(STORAGE_AREA, STORAGE_KEY, model.config);
    model.planPreview = planPoints(model.config);
    model.planCount = model.planPreview.length;
    requestRender();
  }

  function isActive() {
    return model.phase === PHASE.RUN;
  }

  // ---- output driving ------------------------------------------------------

  async function sendCommand(enable, disable, point) {
    const seconds = Math.round(model.config.holdSeconds);
    await device.sendFrame(
      buildCommandFrame(enable, disable, false, point.cvMv, point.ccMa, point.cpMw, seconds, 0),
      "command"
    );
  }

  /** DISABLE for the wizard's own reasons: nothing else here may leave it live. */
  async function stopOutput() {
    if (!device.isConnected()) return;
    const latest = device.telemetry.latest;
    try {
      await device.sendFrame(
        buildCommandFrame(false, true, false, latest.cvTargetMv, latest.ccTargetMa, latest.cpTargetMw, 0, 0),
        "command"
      );
    } catch (_) {
      /* The point's own run timer still stops the output. */
    }
  }

  function readLive(point) {
    const latest = device.telemetry.latest;
    const isVoltage = point.section === SECTION.VOLTAGE;
    return {
      rawValue: isVoltage ? readRawVoltageMv(latest) : readRawCurrentMa(latest),
      state: {
        rawV: readRawVoltageMv(latest) / 1000,
        rawI: readRawCurrentMa(latest),
        calV: latest.vSecMv / 1000,
        calI: latest.iSecMa,
        mode: controlModeKey(latest.controlMode, !!latest.powerEnable, !!latest.fixedDutyActive),
        outputLive: !!latest.powerEnable,
        remainingS: latest.runSecondsRemaining === RUN_CONTINUOUS ? -1 : latest.runSecondsRemaining
      }
    };
  }

  function makeSample(point, extra) {
    const live = readLive(point);
    return {
      rawV: round1(live.state.rawV),
      rawI: round1(live.state.rawI),
      calV: round1(live.state.calV),
      calI: round1(live.state.calI),
      mode: live.state.mode,
      stable: false,
      timedOut: false,
      foreign: false,
      invalid: false,
      reason: "",
      ...extra
    };
  }

  /** Drive one point exactly like a bench power-on: gate down, set, gate up. */
  async function drivePoint(point) {
    model.busy = true;
    model.step = "settle";
    model.sample = null;
    model.errors = [];
    requestRender();
    try {
      await sendCommand(false, true, point);
      if (abort) return false;
      await sleep(RESTART_GAP_MS);
      if (abort) return false;
      await sendCommand(true, false, point);
      if (abort) return false;
      return await collectSample(point);
    } finally {
      model.busy = false;
      requestRender();
    }
  }

  /**
   * Wait out the settle delay, then hold the reading still inside a 600 ms
   * window. The mean of that window is what gets stored: a single instant
   * sample of a converter that never stops switching is a coin flip.
   */
  async function collectSample(point) {
    const isVoltage = point.section === SECTION.VOLTAGE;
    const floor = isVoltage ? V_FLOOR_MV : I_FLOOR_MA;

    await sleep(Math.round(model.config.settleMs));
    if (abort) return false;

    const samples = [];
    const startedAt = performance.now();
    for (;;) {
      if (abort) return false;
      if (!device.isConnected()) {
        model.sample = makeSample(point, { invalid: true, reason: "link" });
        return false;
      }
      const latest = device.telemetry.latest;
      if (!latest.powerEnable) {
        const tripped = !!latest.ocpTripped || !!latest.otpTripped;
        model.sample = makeSample(point, { invalid: true, reason: tripped ? "trip" : "dropped" });
        return false;
      }

      const now = performance.now();
      samples.push({ t: now, v: isVoltage ? readRawVoltageMv(latest) : readRawCurrentMa(latest) });
      while (samples.length > 1 && samples[0].t < now - SETTLE_WINDOW_MS) samples.shift();

      const values = samples.map((entry) => entry.v);
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const span = Math.max(...values) - Math.min(...values);
      const tolerance = Math.max(floor, Math.abs(mean) * (model.config.tolerancePct / 100));
      const heldLongEnough = now - samples[0].t >= SETTLE_WINDOW_MS * 0.8;
      const stable = heldLongEnough && span <= tolerance;
      const timedOut = now - startedAt >= model.config.settleTimeoutMs;

      if (stable || timedOut) {
        const foreign =
          latest.cvTargetMv !== point.cvMv || latest.ccTargetMa !== point.ccMa || latest.cpTargetMw !== point.cpMw;
        const raw = mean * (isVoltage ? 1 / 1000 : 1);
        model.sample = makeSample(point, {
          [isVoltage ? "rawV" : "rawI"]: round1(raw),
          stable,
          timedOut: !stable && timedOut,
          foreign
        });
        return true;
      }
      await sleep(POLL_MS);
    }
  }

  // ---- recording -----------------------------------------------------------

  function validateMeter(point, meterV, meterI) {
    const errors = [];
    const isVoltage = point.section === SECTION.VOLTAGE;
    if (isVoltage) {
      if (!inRange(meterV, 0, MAX_METER_V)) errors.push({ key: "cal.wiz.validate.meterV", params: { max: MAX_METER_V } });
      if (meterI !== null && !inRange(meterI, 0, CAL_I_MAX_MA)) {
        errors.push({ key: "cal.wiz.validate.meterI", params: { max: CAL_I_MAX_MA } });
      }
    } else if (!inRange(meterI, 0, MAX_METER_I)) {
      errors.push({ key: "cal.wiz.validate.meterI", params: { max: MAX_METER_I } });
    }
    return errors;
  }

  /** Write the current point into the calibration model and advance. */
  function commit(meterVInput, meterIInput) {
    const point = model.points[model.cursor];
    const sample = model.sample;
    if (!point || !sample || sample.invalid) return false;

    const hasMeterI = meterIInput !== null && meterIInput !== undefined && String(meterIInput).trim() !== "";
    const meterV = Number.parseFloat(meterVInput);
    const meterI = hasMeterI ? Number.parseFloat(meterIInput) : null;
    const errors = validateMeter(point, meterV, meterI);
    if (errors.length > 0) {
      model.errors = errors;
      requestRender();
      return false;
    }

    const isVoltage = point.section === SECTION.VOLTAGE;
    const raw = isVoltage ? sample.rawV : sample.rawI;
    const meter = isVoltage ? meterV : meterI;
    let row;
    if (isVoltage) {
      row = cal.addVoltagePoint({ setV: round1(raw), measuredV: round1(meterV), measuredI: meterI === null ? "" : round1(meterI) });
    } else {
      row = cal.addCurrentPoint({ setI: round1(raw), measuredI: round1(meterI) });
    }
    model.records.push({
      index: point.index,
      section: point.section,
      rowId: row.id,
      target: point.target,
      targetUnit: point.targetUnit,
      raw,
      meter,
      meterI,
      readbackDelta: meter - raw,
      progDelta: meter - point.target,
      mode: sample.mode,
      stable: sample.stable,
      timedOut: sample.timedOut,
      foreign: sample.foreign,
      notCc: !isVoltage && sample.mode !== "cc"
    });

    model.cursor += 1;
    model.sample = null;
    model.errors = [];
    model.resetToken += 1;
    requestRender();
    signal("commit");
    return true;
  }

  function retryCurrent() {
    if (model.phase !== PHASE.RUN) return;
    model.sample = null;
    model.errors = [];
    model.resetToken += 1;
    signal("retry");
  }

  /** Step back one point: drop its recorded row so the redo cannot duplicate. */
  function previous() {
    if (model.phase !== PHASE.RUN || model.cursor === 0) return;
    const index = model.cursor - 1;
    const last = model.records[model.records.length - 1];
    if (last && last.index === index) {
      cal.removePoint(last.section === SECTION.VOLTAGE ? "voltage" : "current", last.rowId);
      model.records.pop();
    }
    model.cursor = index;
    model.sample = null;
    model.errors = [];
    model.resetToken += 1;
    signal("retry");
  }

  function skip() {
    if (model.phase !== PHASE.RUN) return;
    model.cursor += 1;
    model.sample = null;
    model.errors = [];
    model.resetToken += 1;
    signal("skip");
  }

  // ---- run loop ------------------------------------------------------------

  function summarize() {
    const summary = emptySummary();
    for (const record of model.records) {
      summary.count += 1;
      if (record.section === SECTION.VOLTAGE) {
        summary.v += 1;
        summary.maxReadbackV = Math.max(summary.maxReadbackV, Math.abs(record.readbackDelta));
        summary.maxProgV = Math.max(summary.maxProgV, Math.abs(record.progDelta));
      } else {
        summary.i += 1;
        summary.maxReadbackI = Math.max(summary.maxReadbackI, Math.abs(record.readbackDelta));
        if (record.notCc) summary.notCc += 1;
      }
      if (!record.stable) summary.unstable += 1;
      if (record.foreign) summary.foreign += 1;
    }
    return summary;
  }

  function finalize() {
    model.summary = summarize();
    if (model.records.length === 0) {
      notifyError("cal.wiz.msgNoPoints");
      return;
    }
    if (cal.compile({ announce: false })) notify("cal.wiz.msgDone", { count: model.records.length });
    else notifyError("cal.wiz.msgCompileFailed");
  }

  async function runner() {
    try {
      while (!abort && model.cursor < model.points.length) {
        let rerun = true;
        while (rerun && !abort) {
          rerun = false;
          // Re-read every pass: "previous" moves the cursor under this loop.
          const point = model.points[model.cursor];
          if (!point) break;
          const usable = await drivePoint(point);
          if (abort) break;
          model.step = usable ? "prompt" : "failed";
          requestRender();
          const action = await waitAction();
          if (action === "retry") rerun = true;
        }
      }
    } catch (error) {
      exitReason = "error";
      notifyFailure("cal.wiz.msgFailed", error);
    } finally {
      await stopOutput();
      if (exitReason === "finish") finalize();
      else notify("cal.wiz.msgStopped", { count: model.records.length });
      model.phase = exitReason === "finish" ? PHASE.DONE : PHASE.IDLE;
      model.step = "settle";
      model.busy = false;
      model.sample = null;
      model.errors = [];
      requestRender();
    }
  }

  /** Start a scan. Returns false when it refused to run (the caller toasts). */
  function start() {
    if (model.phase === PHASE.RUN) return false;
    const check = validateConfig();
    if (!check.ok) {
      const first = check.errors[0];
      bus.emit(EVENTS.TOAST, { level: "error", key: first.key, params: first.params });
      return false;
    }
    if (!device.isConnected()) {
      bus.emit(EVENTS.TOAST, { level: "error", key: "msg.connectFirst" });
      return false;
    }

    if (model.config.clearFirst) cal.clearPoints();
    model.points = planPoints(model.config);
    if (model.points.length === 0) {
      bus.emit(EVENTS.TOAST, { level: "error", key: "cal.wiz.msgNoSection" });
      return false;
    }

    model.records = [];
    model.summary = emptySummary();
    model.cursor = 0;
    model.sample = null;
    model.errors = [];
    model.resetToken += 1;
    model.busy = false;
    model.phase = PHASE.RUN;
    model.step = "settle";
    abort = false;
    exitReason = "finish";
    requestRender();
    notify("cal.wiz.msgStarted", { count: model.points.length });
    void runner();
    return true;
  }

  /** Stop collecting but keep what was measured (the drawer was closed).
   *  When a scan is running the runner's finally block owns the wrap-up; all
   *  this has to do is abort it as fast as possible. */
  function stop() {
    abort = true;
    exitReason = "abort";
    signal("abort");
    cancelTimers();
    if (model.phase === PHASE.RUN) return;
    if (device.isConnected() && device.isOutputLive()) void stopOutput();
  }

  /** Operator pressed "finish": stop and compile what is there. */
  function finish() {
    if (model.phase !== PHASE.RUN) return;
    exitReason = "finish";
    abort = true;
    signal("finish");
    cancelTimers();
    requestRender();
  }

  /** Back to the plan form after a finished scan ("restart" on the summary). */
  function reset() {
    if (model.phase === PHASE.RUN) return;
    model.phase = PHASE.IDLE;
    model.step = "settle";
    model.cursor = 0;
    model.points = [];
    model.sample = null;
    model.errors = [];
    model.records = [];
    model.summary = emptySummary();
    model.resetToken += 1;
    requestRender();
  }

  return {
    model,
    validateConfig,
    planPoints,
    patchConfig,
    isActive,
    start,
    commit,
    retryCurrent,
    previous,
    skip,
    finish,
    stop,
    reset
  };
}

exports.createCalibrationSweepService = createCalibrationSweepService;
exports.planPoints = planPoints;
exports.interpolate = interpolate;
exports.defaultConfig = defaultConfig;
exports.SECTION = SECTION;
exports.PHASE = PHASE;
exports.MAX_POINTS = MAX_POINTS;
});
