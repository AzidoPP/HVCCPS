// Interactive calibration wizard: scan plan, one point at a time.
//
// This view owns the wizard's DOM only. Everything it touches lives in
// device/calibration-sweep.js (the state machine) and device/calibration-service.js
// (the point table the manual editor also uses). Nothing here talks to the
// serial port directly.
//
// The panel is built in JS rather than declared in index.html because every
// block is conditional: the config form, the running point and the finished
// summary never share the screen. Labels still carry data-i18n so a language
// switch keeps working through the normal apply() pass.

HV.define("ui/views/drawers/calibration-wizard", function (require, exports) {
"use strict";

const { bus, EVENTS } = require("core/bus");
const { h, setChecked, setClass, setDisabled, setHidden, setText, setValueIfIdle } = require("core/dom");
const { formatSig } = require("core/format");
const { registerView } = require("core/scheduler");
const { t } = require("i18n/index");
const { controlModeKey, MAX_CC_MA, MAX_CP_W, MAX_CV_V, RUN_CONTINUOUS } = require("protocol/index");
const { PHASE, SECTION } = require("device/calibration-sweep");
const { confirmAction } = require("ui/components/confirm");
const { renderValidation } = require("ui/components/validation");

function parseInput(value) {
  const text = String(value).trim();
  return text === "" ? NaN : Number.parseFloat(text);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function signed(value) {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatSig(Math.abs(value))}`;
}

function mountCalibrationWizard({ root, device, cal, run, sweep }) {
  const inputs = {};
  /** Which section toggle owns each input, so "voltage段" can grey its own fields. */
  const scopes = {};
  let planSignature = "";
  let warnSignature = "";
  let summarySignature = "";
  let renderedResetToken = sweep.model.resetToken;

  function numberField(key, labelKey, attrs = {}) {
    const input = h("input", {
      type: "number",
      min: attrs.min,
      max: attrs.max,
      step: attrs.step === undefined ? "1" : attrs.step,
      oninput: () => sweep.patchConfig({ [key]: parseInput(input.value) })
    });
    inputs[key] = input;
    scopes[key] = key.startsWith("voltage") ? "voltage" : key.startsWith("current") ? "current" : null;
    return h("label.field", null, h("span", { "data-i18n": labelKey }, t(labelKey)), input);
  }

  function checkboxField(key, labelKey) {
    const input = h("input", { type: "checkbox", onchange: () => sweep.patchConfig({ [key]: input.checked }) });
    inputs[key] = input;
    scopes[key] = null;
    return h("label.check-line.boxed", null, input, h("span", { "data-i18n": labelKey }, t(labelKey)));
  }

  // ---- A. plan -------------------------------------------------------------

  const planList = h("div.cal-wiz-plan");
  const configValidation = h("div.validation-line", { hidden: true });
  const startButton = h("button.start-button", { type: "button", onclick: () => void onStart() });
  const planCount = h("span.cal-wiz-note");

  const configBlock = h(
    "div.cal-wiz-step",
    null,
    h(
      "div.cal-wiz-grid",
      null,
      h(
        "fieldset.cal-wiz-section",
        null,
        h("legend", null, h("span", { "data-i18n": "cal.wiz.voltageSection" }, t("cal.wiz.voltageSection"))),
        checkboxField("voltageEnabled", "cal.wiz.sectionEnabled"),
        numberField("voltageCount", "cal.wiz.count", { min: 2, max: 21, step: 1 }),
        numberField("voltageStartV", "cal.wiz.startV", { min: 0, max: MAX_CV_V, step: 10 }),
        numberField("voltageEndV", "cal.wiz.endV", { min: 0, max: MAX_CV_V, step: 10 }),
        numberField("voltageCcMa", "cal.wiz.ccLimit", { min: 0, max: MAX_CC_MA, step: 1 }),
        numberField("voltageCpW", "cal.wiz.cpLimit", { min: 0, max: MAX_CP_W, step: 10 })
      ),
      h(
        "fieldset.cal-wiz-section",
        null,
        h("legend", null, h("span", { "data-i18n": "cal.wiz.currentSection" }, t("cal.wiz.currentSection"))),
        checkboxField("currentEnabled", "cal.wiz.sectionEnabled"),
        numberField("currentCount", "cal.wiz.count", { min: 2, max: 21, step: 1 }),
        numberField("currentStartMa", "cal.wiz.startI", { min: 0, max: MAX_CC_MA, step: 1 }),
        numberField("currentEndMa", "cal.wiz.endI", { min: 0, max: MAX_CC_MA, step: 1 }),
        numberField("currentCvV", "cal.wiz.holdV", { min: 0, max: MAX_CV_V, step: 10 }),
        numberField("currentCpW", "cal.wiz.cpLimit", { min: 0, max: MAX_CP_W, step: 10 })
      )
    ),
    h(
      "div.inline-grid",
      null,
      numberField("holdSeconds", "cal.wiz.hold", { min: 5, max: 600, step: 5 }),
      numberField("settleMs", "cal.wiz.settle", { min: 200, max: 5000, step: 100 })
    ),
    h(
      "details.cal-advanced",
      null,
      h("summary", { "data-i18n": "cal.wiz.advanced" }, t("cal.wiz.advanced")),
      h(
        "div.inline-grid",
        null,
        numberField("settleTimeoutMs", "cal.wiz.timeout", { min: 500, max: 60000, step: 500 }),
        numberField("tolerancePct", "cal.wiz.tolerance", { min: 0.05, max: 10, step: 0.05 })
      ),
      h("p.hint", { "data-i18n": "cal.wiz.advancedHint" }, t("cal.wiz.advancedHint"))
    ),
    checkboxField("disableCalFirst", "cal.wiz.disableCalFirst"),
    checkboxField("clearFirst", "cal.wiz.clearFirst"),
    h("p.hint", { "data-i18n": "cal.wiz.existingHint" }, t("cal.wiz.existingHint")),
    h(
      "details.cal-wiz-planbox",
      null,
      h("summary", { "data-i18n": "cal.wiz.planTitle" }, t("cal.wiz.planTitle")),
      planList
    ),
    configValidation,
    h("div.cal-wiz-actions", null, startButton, planCount)
  );

  // ---- B. running point ----------------------------------------------------

  const runSection = h("strong.cal-wiz-runSection");
  const runOutput = h("span.cal-wiz-chip");
  const runRemaining = h("span.cal-wiz-chip");
  const runTarget = h("span.cal-wiz-target");
  const runLiveRaw = h("strong");
  const runLiveRawI = h("strong");
  const runLiveCal = h("span");
  const runLiveMode = h("span.cal-wiz-chip");
  const runSample = h("strong.cal-wiz-sample");
  const runWarnList = h("div.cal-wiz-warn", { hidden: true });
  const meterV = h("input", { type: "number", step: "0.1", min: "0", onkeydown: onMeterKey });
  const meterI = h("input", { type: "number", step: "0.1", min: "0", onkeydown: onMeterKey });
  const runValidation = h("div.validation-line", { hidden: true });
  const commitButton = h("button.start-button", { type: "button", onclick: () => commitEntry() });
  const prevButton = h("button.small-button", { type: "button", onclick: () => sweep.previous() });
  const retryButton = h("button.small-button", { type: "button", onclick: () => sweep.retryCurrent() });
  const skipButton = h("button.small-button", { type: "button", onclick: () => sweep.skip() });
  const finishButton = h("button.secondary-button", { type: "button", onclick: () => sweep.finish() });

  const runBlock = h(
    "div.cal-wiz-step",
    null,
    h("div.cal-wiz-runhead", null, runSection, runOutput, runRemaining),
    h("div.cal-wiz-targetline", null, runTarget),
    h(
      "div.cal-wiz-live",
      null,
      h("span", { "data-i18n": "cal.wiz.liveRawV" }, t("cal.wiz.liveRawV")),
      runLiveRaw,
      h("span", { "data-i18n": "cal.wiz.liveRawI" }, t("cal.wiz.liveRawI")),
      runLiveRawI,
      h("span", { "data-i18n": "cal.wiz.liveCal" }, t("cal.wiz.liveCal")),
      runLiveCal,
      h("span", { "data-i18n": "cal.wiz.liveMode" }, t("cal.wiz.liveMode")),
      runLiveMode
    ),
    h(
      "div.cal-wiz-sampleline",
      null,
      h("span", { "data-i18n": "cal.wiz.captured" }, t("cal.wiz.captured")),
      runSample
    ),
    runWarnList,
    h(
      "div.inline-grid",
      null,
      h("label.field", null, h("span", { "data-i18n": "cal.wiz.meterV" }, t("cal.wiz.meterV")), meterV),
      h("label.field", null, h("span", { "data-i18n": "cal.wiz.meterI" }, t("cal.wiz.meterI")), meterI)
    ),
    h("p.hint", { "data-i18n": "cal.wiz.enterHint" }, t("cal.wiz.enterHint")),
    runValidation,
    h("div.cal-wiz-actions", null, commitButton, prevButton, retryButton, skipButton, finishButton)
  );

  // ---- C. summary ----------------------------------------------------------

  const doneStats = h("div.cal-wiz-stats");
  const voltageHead = h("thead");
  const voltageBody = h("tbody");
  const currentHead = h("thead");
  const currentBody = h("tbody");
  const doneBlock = h(
    "div.cal-wiz-step",
    null,
    h("h3", { "data-i18n": "cal.wiz.doneTitle" }, t("cal.wiz.doneTitle")),
    doneStats,
    h(
      "div.cal-wiz-summary",
      null,
      h("h3", { "data-i18n": "cal.wiz.doneVoltage" }, t("cal.wiz.doneVoltage")),
      h("table", null, voltageHead, voltageBody),
      h("h3", { "data-i18n": "cal.wiz.doneCurrent" }, t("cal.wiz.doneCurrent")),
      h("table", null, currentHead, currentBody)
    ),
    h(
      "div.cal-wiz-actions",
      null,
      h(
        "button.secondary-button",
        { type: "button", "data-i18n": "cal.wiz.restart", onclick: () => sweep.reset() },
        t("cal.wiz.restart")
      )
    )
  );

  root.append(configBlock, runBlock, doneBlock);

  // ---- actions -------------------------------------------------------------

  async function waitOutputOff(timeoutMs = 2000) {
    const deadline = performance.now() + timeoutMs;
    while (device.isOutputLive() && performance.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    return !device.isOutputLive();
  }

  async function onStart() {
    if (!device.isConnected()) {
      toastError("msg.connectFirst");
      return;
    }
    if (device.isOutputLive()) {
      const proceed = await confirmAction({
        titleKey: "cal.wiz.confirm.liveTitle",
        bodyKey: "cal.wiz.confirm.liveBody",
        confirmKey: "cal.wiz.confirm.liveOk"
      });
      if (!proceed) return;
      await run.stop();
      await waitOutputOff();
    }
    // Calibration corrects the feedback the loop regulates, so collecting with
    // it enabled would measure the corrected value. The operator opts out.
    if (sweep.model.config.disableCalFirst && cal.isEnabled()) {
      await cal.setEnabled(false);
      await waitOutputOff();
    }
    sweep.start();
  }

  function toastError(key) {
    bus.emit(EVENTS.TOAST, { level: "error", key });
  }

  function commitEntry() {
    if (sweep.commit(meterV.value, meterI.value)) {
      meterV.value = "";
      meterI.value = "";
    }
  }

  function onMeterKey(event) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    commitEntry();
  }

  // ---- rendering -----------------------------------------------------------

  function renderPlan() {
    const signature = sweep.model.planPreview
      .map((point) => `${point.section}:${point.cvMv}:${point.ccMa}:${point.cpMw}`)
      .join("|");
    if (signature === planSignature) return;
    planSignature = signature;
    planList.replaceChildren(
      ...sweep.model.planPreview.map((point, index) =>
        h(
          "div.cal-wiz-plan-row",
          null,
          h("span.cal-wiz-plan-index", null, `${index + 1}.`),
          h(
            "span",
            null,
            point.section === SECTION.VOLTAGE
              ? t("cal.wiz.planVoltage", { v: formatSig(point.target) })
              : t("cal.wiz.planCurrent", { i: formatSig(point.target) })
          ),
          h(
            "span.cal-wiz-plan-aux",
            null,
            point.section === SECTION.VOLTAGE
              ? `CC ${formatSig(point.ccMa)} mA / CP ${formatSig(point.cpMw / 1000)} W`
              : `CV ${formatSig(point.cvMv / 1000)} V / CP ${formatSig(point.cpMw / 1000)} W`
          )
        )
      )
    );
  }

  function renderWarnings(list) {
    const signature = list.join("|");
    if (signature === warnSignature) return;
    warnSignature = signature;
    setHidden(runWarnList, list.length === 0);
    runWarnList.replaceChildren(...list.map((key) => h("div.cal-wiz-warn-line", { "data-i18n": key }, t(key))));
  }

  function renderSummary() {
    const records = sweep.model.records;
    const signature = records
      .map((record) => `${record.rowId}:${record.raw}:${record.meter}:${record.mode}:${record.stable}`)
      .join("|");
    if (signature === summarySignature) return;
    summarySignature = signature;

    const voltage = records.filter((record) => record.section === SECTION.VOLTAGE);
    const current = records.filter((record) => record.section === SECTION.CURRENT);

    voltageHead.replaceChildren(
      h(
        "tr",
        null,
        ...["cal.wiz.colTargetV", "cal.wiz.colRawV", "cal.wiz.colMeterV", "cal.wiz.colReadbackV", "cal.wiz.colProgV", "cal.wiz.colNote"].map((key) =>
          h("th", { "data-i18n": key }, t(key))
        )
      )
    );
    voltageBody.replaceChildren(
      ...voltage.map((record) =>
        h(
          "tr",
          null,
          h("td", null, formatSig(record.target)),
          h("td", null, formatSig(record.raw)),
          h("td", null, formatSig(record.meter)),
          h("td", { class: recordNoteClass(record) }, signed(record.readbackDelta)),
          h("td", null, signed(record.progDelta)),
          h("td", null, recordNote(record))
        )
      )
    );

    currentHead.replaceChildren(
      h(
        "tr",
        null,
        ...["cal.wiz.colTargetI", "cal.wiz.colRawI", "cal.wiz.colMeterI", "cal.wiz.colReadbackI", "cal.wiz.colMode", "cal.wiz.colNote"].map((key) =>
          h("th", { "data-i18n": key }, t(key))
        )
      )
    );
    currentBody.replaceChildren(
      ...current.map((record) =>
        h(
          "tr",
          null,
          h("td", null, formatSig(record.target)),
          h("td", null, formatSig(record.raw)),
          h("td", null, formatSig(record.meter)),
          h("td", { class: recordNoteClass(record) }, signed(record.readbackDelta)),
          h("td", null, t(`mode.${record.mode}`)),
          h("td", null, recordNote(record))
        )
      )
    );
  }

  function recordNoteClass(record) {
    if (!record.stable) return "cal-delta-neg";
    return Math.abs(record.readbackDelta) <= 0.05 ? "cal-delta-zero" : "cal-delta-pos";
  }

  function recordNote(record) {
    const notes = [];
    if (!record.stable) notes.push(t("cal.wiz.noteUnstable"));
    if (record.foreign) notes.push(t("cal.wiz.noteForeign"));
    if (record.notCc) notes.push(t("cal.wiz.noteNotCc"));
    return notes.join(" / ");
  }

  function syncConfig() {
    const config = sweep.model.config;
    for (const [key, input] of Object.entries(inputs)) {
      if (typeof config[key] === "boolean") setChecked(input, config[key]);
      else setValueIfIdle(input, config[key]);
      const scope = scopes[key];
      setDisabled(input, scope ? !config[`${scope}Enabled`] : false);
    }
    renderPlan();
    renderValidation(configValidation, sweep.validateConfig().errors);
    setDisabled(startButton, !device.isConnected() || device.calBusy);
    setText(planCount, t("cal.wiz.planCount", { count: sweep.model.planCount }));
    setText(startButton, device.isConnected() ? t("cal.wiz.start") : t("cal.wiz.startOffline"));
  }

  function syncRun() {
    const model = sweep.model;
    const point = model.points[model.cursor];
    const sample = model.sample;
    const latest = device.telemetry.latest;
    if (!point) return;

    const sectionKey = point.section === SECTION.VOLTAGE ? "cal.wiz.section.voltage" : "cal.wiz.section.current";
    setText(
      runSection,
      t("cal.wiz.progress", {
        index: model.cursor + 1,
        count: model.points.length,
        section: t(sectionKey),
        local: point.index + 1,
        localCount: point.count
      })
    );
    setText(
      runTarget,
      t("cal.wiz.target", {
        cv: formatSig(point.cvMv / 1000),
        cc: formatSig(point.ccMa),
        cp: formatSig(point.cpMw / 1000)
      })
    );

    const live = !!latest.powerEnable;
    setText(runOutput, live ? t("cal.wiz.outputLive") : t("cal.wiz.outputOff"));
    setClass(runOutput, "is-live", live);
    setClass(runOutput, "is-off", !live);
    const remaining = latest.runSecondsRemaining === RUN_CONTINUOUS ? -1 : latest.runSecondsRemaining;
    setHidden(runRemaining, !live || remaining < 0);
    setText(runRemaining, remaining < 0 ? "" : t("cal.wiz.remaining", { s: remaining }));

    const rawV = Number.isFinite(latest.rawVSecMv) ? latest.rawVSecMv : latest.vSecMv;
    const rawI = Number.isFinite(latest.rawISecMa) ? latest.rawISecMa : latest.iSecMa;
    setText(runLiveRaw, `${formatSig(rawV / 1000)} V`);
    setText(runLiveRawI, `${formatSig(rawI)} mA`);
    setText(runLiveCal, `${formatSig(latest.vSecMv / 1000)} V / ${formatSig(latest.iSecMa)} mA`);
    setText(runLiveMode, t(`mode.${controlModeKey(latest.controlMode, live, !!latest.fixedDutyActive)}`));

    if (!sample) {
      setText(runSample, t("cal.wiz.capturing"));
      setClass(runSample, "is-busy", true);
    } else if (sample.invalid) {
      setText(runSample, t("cal.wiz.capturedNone"));
      setClass(runSample, "is-busy", false);
    } else {
      const value = point.section === SECTION.VOLTAGE ? `${formatSig(sample.rawV)} V` : `${formatSig(sample.rawI)} mA`;
      setText(runSample, t(sample.stable ? "cal.wiz.capturedStable" : "cal.wiz.capturedTimeout", { value }));
      setClass(runSample, "is-busy", false);
    }

    // Only genuine problems here: "settling" is the normal state and the sample
    // line already says so, and the output being briefly down right after the
    // enable frame is not a fault either -- a real dropout comes back as an
    // invalid sample from the capture loop.
    const warnings = [];
    if (sample && sample.invalid) warnings.push(`cal.wiz.warn_${sample.reason}`);
    if (sample && !sample.invalid && sample.timedOut) warnings.push("cal.wiz.warnTimeout");
    if (sample && sample.foreign) warnings.push("cal.wiz.warnForeign");
    if (!live && model.step === "prompt") warnings.push("cal.wiz.warnOutputStopped");
    renderWarnings(warnings.filter(Boolean));

    if (renderedResetToken !== model.resetToken) {
      renderedResetToken = model.resetToken;
      meterV.value = "";
      meterI.value = "";
    }
    const isVoltage = point.section === SECTION.VOLTAGE;
    meterV.placeholder = isVoltage ? "" : t("cal.wiz.notUsed");
    const editable = model.step === "prompt" && !!sample && !sample.invalid;
    setDisabled(meterV, !editable || !isVoltage);
    setDisabled(meterI, !editable);
    setDisabled(commitButton, !editable);
    setText(commitButton, t("cal.wiz.commit"));
    setDisabled(prevButton, model.busy || model.cursor === 0);
    setText(prevButton, t("cal.wiz.prev"));
    setDisabled(retryButton, model.busy);
    setText(retryButton, t("cal.wiz.retry"));
    setDisabled(skipButton, model.busy);
    setText(skipButton, t("cal.wiz.skip"));
    setDisabled(finishButton, false);
    setText(finishButton, t("cal.wiz.finish"));
    renderValidation(runValidation, model.errors);
  }

  function syncDone() {
    const summary = sweep.model.summary;
    setText(
      doneStats,
      t("cal.wiz.stats", {
        count: summary.count,
        v: summary.v,
        i: summary.i,
        maxV: formatSig(summary.maxReadbackV),
        maxI: formatSig(summary.maxReadbackI),
        maxProg: formatSig(summary.maxProgV),
        unstable: summary.unstable,
        foreign: summary.foreign,
        notCc: summary.notCc
      })
    );
    renderSummary();
  }

  registerView("calibration-wizard", () => {
    const model = sweep.model;
    const running = model.phase === PHASE.RUN;
    const done = model.phase === PHASE.DONE;
    setHidden(configBlock, running || done);
    setHidden(runBlock, !running);
    setHidden(doneBlock, !done);
    if (running) syncRun();
    else if (done) syncDone();
    else syncConfig();
  });

  window.addEventListener("beforeunload", (event) => {
    if (!sweep.isActive()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  return {};
}

exports.mountCalibrationWizard = mountCalibrationWizard;
});
