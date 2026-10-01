// Output calibration workflow: the operator's point table, the compiled
// residual grid and the flash upload. The drawer renders this model; it never
// owns the numbers itself.

HV.define("device/calibration-service", function (require, exports) {
"use strict";

const { bus, EVENTS } = require("core/bus");
const { notify, notifyFailure } = require("core/notify");
const { requestRender } = require("core/scheduler");
const { t } = require("i18n/index");
const { buildCalImage, buildCalUploadFrames, CAL_DEFAULT_RI_MA, CAL_DEFAULT_RV_V, CAL_I_MAX_MA, CAL_MAX_DI_MA, CAL_MAX_DV_MV, CAL_STATUS, CAL_V_MAX_MV, compileCalibration } = require("protocol/index");

function calStatusText(status) {
  const key = CAL_STATUS[status];
  return key ? t(`status.cal.${key}`) : t("status.cal.unknown", { code: status });
}

let nextId = 1;

function createCalibrationService(device, config) {
  const model = {
    voltagePoints: [],
    currentPoints: [],
    radiusV: CAL_DEFAULT_RV_V,
    radiusI: CAL_DEFAULT_RI_MA,
    compiled: null,
    compiledImage: null,
    compiledCounts: { voltage: 0, current: 0 },
    uploadBusy: false,
    progress: { done: 0, total: 0, label: "" }
  };

  function invalidate() {
    model.compiled = null;
    model.compiledImage = null;
    requestRender();
  }

  function addVoltagePoint(point = {}) {
    const row = { id: nextId++, setV: point.setV ?? "", measuredV: point.measuredV ?? "", measuredI: point.measuredI ?? "" };
    model.voltagePoints.push(row);
    invalidate();
    return row;
  }

  function addCurrentPoint(point = {}) {
    const row = { id: nextId++, setI: point.setI ?? "", measuredI: point.measuredI ?? "" };
    model.currentPoints.push(row);
    invalidate();
    return row;
  }

  /** Drop every point. The sweep wizard's "clear before start" option; the
   *  manual table shows the same lists, so both views stay in step. */
  function clearPoints() {
    model.voltagePoints.length = 0;
    model.currentPoints.length = 0;
    invalidate();
  }

  function patchPoint(kind, id, changes) {
    const list = kind === "voltage" ? model.voltagePoints : model.currentPoints;
    const row = list.find((item) => item.id === id);
    if (!row) return;
    Object.assign(row, changes);
    invalidate();
  }

  function removePoint(kind, id) {
    const list = kind === "voltage" ? model.voltagePoints : model.currentPoints;
    const index = list.findIndex((item) => item.id === id);
    if (index >= 0) list.splice(index, 1);
    invalidate();
  }

  function setRadius(which, value) {
    if (which === "voltage") model.radiusV = value;
    else model.radiusI = value;
    invalidate();
  }

  function num(value) {
    if (value === "" || value === null || value === undefined) return NaN;
    return Number.parseFloat(value);
  }

  /** @returns {{errors: Array<{key,params}>, voltagePoints: [], currentPoints: []}} */
  function readPoints() {
    const errors = [];
    const voltagePoints = [];
    const currentPoints = [];

    model.voltagePoints.forEach((row, index) => {
      const blank = String(row.setV).trim() === "" && String(row.measuredV).trim() === "" && String(row.measuredI).trim() === "";
      if (blank) return;
      const setV = num(row.setV);
      const measuredV = num(row.measuredV);
      const hasCurrent = String(row.measuredI).trim() !== "";
      const measuredI = hasCurrent ? num(row.measuredI) : null;
      const line = index + 1;
      if (!Number.isFinite(setV) || setV < 0 || setV > CAL_V_MAX_MV / 1000) {
        errors.push({ key: "validate.calRawV", params: { row: line, max: CAL_V_MAX_MV / 1000 } });
      }
      if (!Number.isFinite(measuredV) || measuredV < 0 || measuredV > (CAL_V_MAX_MV + CAL_MAX_DV_MV) / 1000) {
        errors.push({ key: "validate.calMeterV", params: { row: line } });
      }
      if (hasCurrent && (!Number.isFinite(measuredI) || measuredI < 0 || measuredI > CAL_I_MAX_MA)) {
        errors.push({ key: "validate.calMeterI", params: { row: line, max: CAL_I_MAX_MA } });
      }
      if (Number.isFinite(setV) && Number.isFinite(measuredV)) voltagePoints.push({ setV, measuredV, measuredI });
    });

    model.currentPoints.forEach((row, index) => {
      const blank = String(row.setI).trim() === "" && String(row.measuredI).trim() === "";
      if (blank) return;
      const setI = num(row.setI);
      const measuredI = num(row.measuredI);
      const line = index + 1;
      if (!Number.isFinite(setI) || setI < 0 || setI > CAL_I_MAX_MA) {
        errors.push({ key: "validate.calRawI", params: { row: line, max: CAL_I_MAX_MA } });
      }
      if (!Number.isFinite(measuredI) || measuredI < 0 || measuredI > CAL_I_MAX_MA + CAL_MAX_DI_MA) {
        errors.push({ key: "validate.calMeasuredI", params: { row: line } });
      }
      if (Number.isFinite(setI) && Number.isFinite(measuredI)) currentPoints.push({ setI, measuredI });
    });

    if (!Number.isFinite(model.radiusV) || model.radiusV < 10) errors.push({ key: "validate.calRadiusV" });
    if (!Number.isFinite(model.radiusI) || model.radiusI < 5) errors.push({ key: "validate.calRadiusI" });

    return { errors, voltagePoints, currentPoints };
  }

  function validate() {
    return readPoints();
  }

  function compile({ announce = true } = {}) {
    const form = readPoints();
    if (form.errors.length > 0) {
      const first = form.errors[0];
      bus.emit(EVENTS.TOAST, { level: "error", key: first.key, params: first.params });
      return null;
    }
    const grid = compileCalibration(form.voltagePoints, form.currentPoints, {
      radiusV: model.radiusV || CAL_DEFAULT_RV_V,
      radiusI: model.radiusI || CAL_DEFAULT_RI_MA
    });
    model.compiled = grid;
    model.compiledImage = buildCalImage(grid);
    model.compiledCounts = { voltage: form.voltagePoints.length, current: form.currentPoints.length };
    if (announce) notify("msg.calCompiled");
    requestRender();
    return model.compiled;
  }

  async function refreshInfo({ announce = false } = {}) {
    if (!device.isConnected()) return null;
    try {
      const response = await device.requestCalInfoFrame();
      if (response.status !== 0) throw new Error(calStatusText(response.status));
      if (announce) notify("msg.calInfoSynced");
      return response;
    } catch (error) {
      notifyFailure("msg.calInfoFailed", error);
      return null;
    }
  }

  async function upload(image) {
    const frames = buildCalUploadFrames(image);
    model.uploadBusy = true;
    model.progress = { done: 0, total: frames.length, label: "upload" };
    requestRender();
    try {
      for (let i = 0; i < frames.length; i += 1) {
        model.progress = {
          done: i,
          total: frames.length,
          label: i === 0 ? "begin" : i === frames.length - 1 ? "commit" : "data"
        };
        requestRender();
        const response = await device.calRequest(frames[i]);
        if (response.status !== 0) {
          throw new Error(`${model.progress.label}: ${calStatusText(response.status)}`);
        }
      }
      model.progress = { done: frames.length, total: frames.length, label: "done" };
      await refreshInfo();
      notify("msg.calWritten");
    } finally {
      model.uploadBusy = false;
      window.setTimeout(() => {
        if (!model.uploadBusy) {
          model.progress = { done: 0, total: 0, label: "" };
          requestRender();
        }
      }, 900);
      requestRender();
    }
  }

  async function writeToFlash() {
    if (!device.isConnected()) {
      bus.emit(EVENTS.TOAST, { level: "error", key: "msg.connectFirst" });
      return false;
    }
    if (device.isOutputLive()) {
      bus.emit(EVENTS.TOAST, { level: "error", key: "msg.stopBeforeCal" });
      return false;
    }
    try {
      if (!model.compiledImage && !compile({ announce: false })) return false;
      await upload(model.compiledImage);
      return true;
    } catch (error) {
      notifyFailure("msg.calWriteFailed", error);
      return false;
    }
  }

  async function setEnabled(enabled) {
    if (!device.isConnected()) {
      bus.emit(EVENTS.TOAST, { level: "error", key: "msg.connectFirst" });
      return false;
    }
    if (device.isOutputLive()) {
      bus.emit(EVENTS.TOAST, { level: "error", key: "msg.stopBeforeCal" });
      return false;
    }
    try {
      await config.commitField("calEnable", enabled ? 1 : 0);
      await refreshInfo();
      notify(enabled ? "msg.calEnabled" : "msg.calDisabled");
      return true;
    } catch (error) {
      notifyFailure("msg.calEnableFailed", error);
      return false;
    }
  }

  /** Effective enable state: device report first, config draft as fallback. */
  function isEnabled() {
    const info = device.calInfo;
    if (info) return !!info.enable;
    const cfg = config.model.deviceActive || config.model.deviceDraft || config.getForm();
    return Number(cfg.calEnable) !== 0;
  }

  return {
    model,
    addVoltagePoint,
    addCurrentPoint,
    clearPoints,
    patchPoint,
    removePoint,
    setRadius,
    validate,
    compile,
    refreshInfo,
    writeToFlash,
    setEnabled,
    isEnabled
  };
}

exports.calStatusText = calStatusText;
exports.createCalibrationService = createCalibrationService;
});
