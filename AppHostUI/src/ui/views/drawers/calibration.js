// Output calibration drawer: the interactive sweep wizard, the manual point
// table, the compiled preview and the flash upload.
//
// The wizard is a separate view (drawers/calibration-wizard.js) mounted into
// this drawer's [data-el="wizard"] slot. Both write into the same point table
// (device/calibration-service.js), so everything below the wizard -- compile,
// preview, validation, write to flash -- is shared and unchanged.

HV.define("ui/views/drawers/calibration", function (require, exports) {
"use strict";

const { h, qs, setChecked, setClass, setDisabled, setHidden, setText, setValueIfIdle } = require("core/dom");
const { formatCurrentMa, formatSig, formatVoltageMv } = require("core/format");
const { registerView } = require("core/scheduler");
const { onLanguageChange, t } = require("i18n/index");
const { CAL_IMAGE_BYTES, CAL_I_POINTS, CAL_I_STEP_MA, CAL_V_POINTS, CAL_V_STEP_MV, calEvalCurrent, calEvalVoltage } = require("protocol/index");
const { mountCalibrationWizard } = require("ui/views/drawers/calibration-wizard");
const { renderValidation } = require("ui/components/validation");

function signed(value, unit) {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatSig(Math.abs(value))} ${unit}`;
}

function deltaClass(value, deadband) {
  if (Math.abs(value) <= deadband) return "cal-delta-zero";
  return value > 0 ? "cal-delta-pos" : "cal-delta-neg";
}

function mountCalibrationDrawer({ root, device, cal, run, sweep }) {
  const state = qs(root, '[data-el="state"]');
  const lockNote = qs(root, '[data-el="lockNote"]');
  const statusTable = qs(root, '[data-el="statusTable"]');
  const statusCrc = qs(root, '[data-el="statusCrc"]');
  const statusApplied = qs(root, '[data-el="statusApplied"]');
  const enableToggle = qs(root, '[data-el="enable"]');
  const voltageRows = qs(root, '[data-el="voltageRows"]');
  const currentRows = qs(root, '[data-el="currentRows"]');
  const addVoltage = qs(root, '[data-el="addVoltage"]');
  const addCurrent = qs(root, '[data-el="addCurrent"]');
  const radiusV = qs(root, '[data-el="radiusV"]');
  const radiusI = qs(root, '[data-el="radiusI"]');
  const preview = qs(root, '[data-el="preview"]');
  const validation = qs(root, '[data-el="validation"]');
  const compileButton = qs(root, '[data-el="compile"]');
  const writeButton = qs(root, '[data-el="write"]');
  const progress = qs(root, '[data-el="progress"]');
  const progressBar = qs(root, '[data-el="progressBar"]');
  const progressText = qs(root, '[data-el="progressText"]');

  let rowSignature = "";
  let previewSignature = "";
  const rowInputs = new Map();

  const wizardRoot = qs(root, '[data-el="wizard"]');
  mountCalibrationWizard({ root: wizardRoot, device, cal, run, sweep });

  function numberCell(kind, id, key, placeholder, extraClass = "") {
    const input = h(`input${extraClass}`, {
      type: "number",
      step: "0.1",
      placeholder,
      oninput: () => cal.patchPoint(kind, id, { [key]: input.value })
    });
    return input;
  }

  function buildRows() {
    rowInputs.clear();

    voltageRows.replaceChildren(
      ...cal.model.voltagePoints.map((point) => {
        const setV = numberCell("voltage", point.id, "setV", "500");
        const measuredV = numberCell("voltage", point.id, "measuredV", "509");
        const measuredI = numberCell("voltage", point.id, "measuredI", t("cal.optional"), ".optional-input");
        const remove = h(
          "button.icon-button.cal-remove-button",
          {
            type: "button",
            "aria-label": t("cal.removeVoltage"),
            onclick: () => cal.removePoint("voltage", point.id)
          },
          "×"
        );
        rowInputs.set(`v${point.id}`, { setV, measuredV, measuredI, remove });
        return h("div.cal-row", null, setV, measuredV, measuredI, remove);
      })
    );

    currentRows.replaceChildren(
      ...cal.model.currentPoints.map((point) => {
        const setI = numberCell("current", point.id, "setI", "100");
        const measuredI = numberCell("current", point.id, "measuredI", "102");
        const remove = h(
          "button.icon-button.cal-remove-button",
          {
            type: "button",
            "aria-label": t("cal.removeCurrent"),
            onclick: () => cal.removePoint("current", point.id)
          },
          "×"
        );
        rowInputs.set(`i${point.id}`, { setI, measuredI, remove });
        return h("div.cal-row.cal-row-i", null, setI, measuredI, remove);
      })
    );
  }

  function renderPreview() {
    const grid = cal.model.compiled;
    if (!grid) {
      setHidden(preview, true);
      preview.replaceChildren();
      return;
    }

    const latest = device.telemetry.latest;
    const rawV = Number.isFinite(latest.rawVSecMv) ? latest.rawVSecMv : latest.vSecMv;
    const rawI = Number.isFinite(latest.rawISecMa) ? latest.rawISecMa : latest.iSecMa;
    const liveI = calEvalCurrent(grid, rawI);
    const liveV = calEvalVoltage(grid, rawV, liveI);

    const header = Array.from({ length: CAL_I_POINTS }, (_, i) => `<th>${formatSig(i * CAL_I_STEP_MA)} mA</th>`).join("");
    const voltageBody = Array.from({ length: CAL_V_POINTS }, (_, vIndex) => {
      const cells = Array.from({ length: CAL_I_POINTS }, (_, iIndex) => {
        const dV = grid.dv[vIndex * CAL_I_POINTS + iIndex] * 0.1;
        return `<td class="${deltaClass(dV, 0.05)}">${signed(dV, "V")}</td>`;
      }).join("");
      return `<tr><th>${formatSig((vIndex * CAL_V_STEP_MV) / 1000)} V</th>${cells}</tr>`;
    }).join("");
    const currentBody = Array.from({ length: CAL_I_POINTS }, (_, iIndex) => {
      const raw = iIndex * CAL_I_STEP_MA;
      const dI = grid.di[iIndex] * 0.1;
      return `<tr><td>${formatSig(raw)} mA</td><td>${formatSig(raw + dI)} mA</td><td class="${deltaClass(
        dI,
        0.05
      )}">${signed(dI, "mA")}</td></tr>`;
    }).join("");

    // Numbers only, generated here -- safe to build as markup, and far cheaper
    // than 4600 individually created cells.
    preview.innerHTML = `
      <details class="cal-preview-details" open>
        <summary>
          <span>${t("cal.previewTitle")}</span>
          <strong>${t("cal.previewCounts", {
            v: cal.model.compiledCounts.voltage,
            i: cal.model.compiledCounts.current
          })}</strong>
        </summary>
        <div class="cal-preview-content">
          <div class="cal-preview-summary">
            <span>${t("cal.previewImage", {
              bytes: CAL_IMAGE_BYTES,
              v: CAL_V_POINTS,
              i: CAL_I_POINTS,
              vstep: formatSig(CAL_V_STEP_MV / 1000),
              istep: formatSig(CAL_I_STEP_MA)
            })}</span>
            <span>${t("cal.previewMax", { max: formatSig(grid.maxAbsV) })}</span>
            <span>${t("cal.previewLive", {
              rawV: formatVoltageMv(rawV),
              rawI: formatCurrentMa(rawI),
              calV: formatVoltageMv(liveV),
              calI: formatCurrentMa(liveI)
            })}</span>
          </div>
          <div class="cal-preview-section">
            <h3>${t("cal.previewVoltageTable")}</h3>
            <div class="cal-preview-scroll">
              <table class="cal-preview-matrix">
                <thead><tr><th>${t("cal.previewAxis")}</th>${header}</tr></thead>
                <tbody>${voltageBody}</tbody>
              </table>
            </div>
          </div>
          <div class="cal-preview-section">
            <h3>${t("cal.previewCurrentTable")}</h3>
            <table>
              <thead><tr><th>${t("cal.rawIsec")}</th><th>${t("cal.calIsec")}</th><th>dI</th></tr></thead>
              <tbody>${currentBody}</tbody>
            </table>
          </div>
        </div>
      </details>`;
    setHidden(preview, false);
  }

  addVoltage.addEventListener("click", () => cal.addVoltagePoint());
  addCurrent.addEventListener("click", () => cal.addCurrentPoint());
  radiusV.addEventListener("input", () => cal.setRadius("voltage", Number.parseFloat(radiusV.value)));
  radiusI.addEventListener("input", () => cal.setRadius("current", Number.parseFloat(radiusI.value)));
  compileButton.addEventListener("click", () => cal.compile());
  writeButton.addEventListener("click", () => void cal.writeToFlash());
  enableToggle.addEventListener("change", () => void cal.setEnabled(enableToggle.checked));
  onLanguageChange(() => {
    rowSignature = "";
    previewSignature = "";
  });

  if (cal.model.voltagePoints.length === 0) cal.addVoltagePoint();
  if (cal.model.currentPoints.length === 0) cal.addCurrentPoint();

  registerView("calibration-drawer", () => {
    const connected = device.isConnected();
    const live = device.isOutputLive();
    const busy = cal.model.uploadBusy || device.configBusy || device.calBusy;
    const info = device.calInfo;

    const signature = `${cal.model.voltagePoints.map((p) => p.id).join(",")}|${cal.model.currentPoints
      .map((p) => p.id)
      .join(",")}`;
    if (signature !== rowSignature) {
      rowSignature = signature;
      buildRows();
    }

    for (const point of cal.model.voltagePoints) {
      const row = rowInputs.get(`v${point.id}`);
      if (!row) continue;
      setValueIfIdle(row.setV, point.setV);
      setValueIfIdle(row.measuredV, point.measuredV);
      setValueIfIdle(row.measuredI, point.measuredI);
    }
    for (const point of cal.model.currentPoints) {
      const row = rowInputs.get(`i${point.id}`);
      if (!row) continue;
      setValueIfIdle(row.setI, point.setI);
      setValueIfIdle(row.measuredI, point.measuredI);
    }
    setValueIfIdle(radiusV, cal.model.radiusV);
    setValueIfIdle(radiusI, cal.model.radiusI);

    setText(
      state,
      cal.model.uploadBusy
        ? t("cal.stateUploading")
        : !connected
          ? t("cal.stateOffline")
          : sweep.isActive()
            ? t("cal.wiz.stateRunning")
            : live
              ? t("cal.stateLive")
              : info && info.valid
                ? t("cal.stateValid")
                : t("cal.stateEmpty")
    );
    // The wizard deliberately holds the output live, so the "locked" note only
    // applies when something *else* is driving it.
    setHidden(lockNote, !live || sweep.isActive());

    setText(statusTable, info ? (info.valid ? `${info.vPoints} × ${info.iPoints}` : t("cal.noTable")) : "--");
    setText(statusCrc, info && info.valid ? `0x${info.crc.toString(16).padStart(8, "0")}` : "--");
    const enabled = cal.isEnabled();
    setText(statusApplied, enabled ? t("cal.enabled") : t("cal.disabled"));
    setClass(statusApplied, "is-ok", enabled);
    setChecked(enableToggle, enabled);

    const previewKey = cal.model.compiled ? `${rowSignature}|${cal.model.compiled.maxAbsV}` : "";
    if (previewKey !== previewSignature) {
      previewSignature = previewKey;
      renderPreview();
    }

    renderValidation(validation, cal.validate().errors);

    // Entering points and compiling the table are host-side work: they stay
    // available offline so a bench sheet can be prepared before connecting.
    // Only touching flash (write / enable) needs a live link. A running sweep
    // owns the point table even in the moments its output is down (the point's
    // run timer), so it locks the manual editor for its whole run.
    const sweeping = sweep.isActive();
    const editLocked = live || sweeping || cal.model.uploadBusy;
    setDisabled(enableToggle, !connected || live || busy || sweeping);
    setDisabled(writeButton, !connected || live || busy || sweeping);
    setDisabled(compileButton, editLocked);
    setDisabled(addVoltage, editLocked);
    setDisabled(addCurrent, editLocked);
    for (const row of rowInputs.values()) {
      for (const node of Object.values(row)) setDisabled(node, editLocked);
    }
    setDisabled(radiusV, editLocked);
    setDisabled(radiusI, editLocked);

    const showProgress = cal.model.uploadBusy || cal.model.progress.done > 0;
    setHidden(progress, !showProgress);
    if (cal.model.progress.total > 0) {
      const pct = Math.max(0, Math.min(100, (cal.model.progress.done / cal.model.progress.total) * 100));
      progressBar.style.width = `${pct.toFixed(1)}%`;
      setText(progressText, t(`cal.progress.${cal.model.progress.label}`, { pct: Math.round(pct) }));
    }
  });

  return { refreshInfo: () => cal.refreshInfo(), stop: () => run.stop() };
}

exports.mountCalibrationDrawer = mountCalibrationDrawer;
});
