// Command bar -- the single source of truth for output state and setpoints.
//
// Why this view exists at all:
//   The old console reported "output live" in three places at once (a red
//   alarm strip under the top bar, a second strip inside the plot panel, and a
//   top-bar pill), and two of them were inserted into the document only while
//   the output was running -- so starting the output pushed the telemetry chart
//   down the page. This bar replaces all three. It is ALWAYS mounted, always
//   the same height, and it is the only thing that changes appearance when the
//   output goes live.
//
// Mental model: a bench supply front panel. Setpoints sit right next to the
// output button and stay editable in both states; the primary button reads
// "Start Output" when the output is off and "Update Targets" while it runs;
// STOP never moves and is always reachable.

HV.define("ui/views/command-bar", function (require, exports) {
"use strict";

const { formatPowerMw, formatSig } = require("core/format");
const { qs, setClass, setDisabled, setText, setValueIfIdle } = require("core/dom");
const { registerView, requestRender } = require("core/scheduler");
const { t } = require("i18n/index");
const { controlModeKey, RUN_CONTINUOUS } = require("protocol/index");
const { outputPowerMw } = require("device/metrics");
const { START_MODE } = require("device/run-service");
const { confirmAction } = require("ui/components/confirm");

function mountCommandBar({ root, device, run, history, sweep }) {
  const lamp = qs(root, '[data-el="lamp"]');
  const stateLabel = qs(root, '[data-el="stateLabel"]');
  const stateMeta = qs(root, '[data-el="stateMeta"]');
  const readMode = qs(root, '[data-el="readMode"]');
  const readTime = qs(root, '[data-el="readTime"]');
  const readPower = qs(root, '[data-el="readPower"]');
  const primary = qs(root, '[data-el="primary"]');
  const stop = qs(root, '[data-el="stop"]');

  const inputs = {
    cvV: qs(root, '[data-el="cv"]'),
    ccMa: qs(root, '[data-el="cc"]'),
    cpW: qs(root, '[data-el="cp"]')
  };

  for (const [key, input] of Object.entries(inputs)) {
    input.addEventListener("input", () => {
      run.patch({ [key]: Number.parseFloat(input.value) });
      history.get()?.schedule();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      input.blur();
      void triggerPrimary();
    });
  }

  async function triggerPrimary() {
    // A calibration sweep drives the setpoints itself; letting the command bar
    // push its staged targets on top would silently move the point being
    // measured. STOP below stays live -- an emergency stop must never be
    // blocked by a wizard.
    if (sweep.isActive()) return;

    if (device.isOutputLive()) {
      await run.updateTargets();
      requestRender();
      return;
    }

    // Fixed duty drives the bridge open-loop: none of CC/CV/CP can pull it
    // back if the load is wrong. That is worth one extra deliberate click.
    const form = run.getForm();
    if (form.mode === START_MODE.FIXED_DUTY) {
      const proceed = await confirmAction({
        titleKey: "confirm.fixedDuty.title",
        bodyKey: "confirm.fixedDuty.body",
        params: { duty: formatSig(form.fixedDutyPct) },
        confirmKey: "confirm.fixedDuty.confirm"
      });
      if (!proceed) {
        requestRender();
        return;
      }
    }

    await run.start();
    requestRender();
  }

  primary.addEventListener("click", () => void triggerPrimary());
  stop.addEventListener("click", () => void run.stop().then(requestRender));

  registerView("command-bar", () => {
    const connected = device.isConnected();
    const latest = device.telemetry.latest;
    const live = !!latest.powerEnable;
    const tripped = !!latest.ocpTripped || !!latest.otpTripped;
    const form = run.getForm();

    // ---- setpoint inputs (never rewritten while being typed into) ----
    setValueIfIdle(inputs.cvV, Number.isFinite(form.cvV) ? form.cvV : "");
    setValueIfIdle(inputs.ccMa, Number.isFinite(form.ccMa) ? form.ccMa : "");
    setValueIfIdle(inputs.cpW, Number.isFinite(form.cpW) ? form.cpW : "");

    // ---- state segment ----
    setClass(root, "is-live", live);
    setClass(root, "is-fault", !live && tripped);
    setClass(root, "is-offline", !connected);
    setClass(lamp, "is-live", live);
    setClass(lamp, "is-fault", !live && tripped);

    if (live) {
      setText(stateLabel, t("cmd.outputLive"));
      setText(stateMeta, latest.fixedDutyActive ? t("cmd.metaFixedDuty") : t("cmd.metaClosedLoop"));
    } else if (tripped) {
      setText(stateLabel, t("cmd.tripped"));
      setText(stateMeta, latest.ocpTripped ? t("cmd.metaOcp") : t("cmd.metaOtp"));
    } else {
      setText(stateLabel, t("cmd.outputOff"));
      setText(stateMeta, connected ? t("cmd.metaReady") : t("cmd.metaNoLink"));
    }

    // ---- live readout ----
    setText(readMode, t(`mode.${controlModeKey(latest.controlMode, live, latest.fixedDutyActive)}`));

    if (live) {
      setText(
        readTime,
        latest.runSecondsRemaining === RUN_CONTINUOUS
          ? t("cmd.runContinuous")
          : t("cmd.runRemaining", { s: latest.runSecondsRemaining })
      );
      setText(readPower, formatPowerMw(outputPowerMw(latest)));
    } else {
      setText(
        readTime,
        form.continuous ? t("cmd.armedContinuous") : t("cmd.armedSeconds", { s: formatSig(form.runSeconds) })
      );
      setText(readPower, "--");
    }

    // ---- actions ----
    const sweeping = sweep.isActive();
    const targetsDiffer = live && run.targetsDiffer();
    setText(primary, sweeping ? t("cmd.sweepBusy") : live ? t("cmd.update") : t("cmd.start"));
    setClass(primary, "is-armed", targetsDiffer && !sweeping);
    setDisabled(primary, sweeping || (live ? !connected || latest.fixedDutyActive || !targetsDiffer : !connected));
    setDisabled(stop, !connected);
  });
}

exports.mountCommandBar = mountCommandBar;
});
