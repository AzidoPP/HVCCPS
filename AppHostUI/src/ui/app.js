// Composition root for the UI layer.
//
// Creates the drawer host, mounts every view, and owns the few genuinely global
// behaviours (navigation routing, keyboard shortcuts, the undo stack). Views
// never reach for each other; anything shared arrives as an argument.

HV.define("ui/app", function (require, exports) {
"use strict";

const { hydrateIcons } = require("core/dom");
const { HistoryStack, deepClone } = require("core/history");
const { onLanguageChange } = require("i18n/index");
const { registerView, renderNow, requestRender } = require("core/scheduler");
const { CHART_SAMPLE_MS } = require("device/telemetry");
const { createChartSelection } = require("ui/chart-selection");
const { createDrawerHost } = require("ui/components/drawer-host");
const { installNumberGuards } = require("ui/components/number-guard");
const { mountToasts } = require("ui/components/toast");
const { mountCommandBar } = require("ui/views/command-bar");
const { mountCycleOverlay } = require("ui/views/cycle-overlay");
const { mountStatusPanel } = require("ui/views/status-panel");
const { mountTelemetryPanel } = require("ui/views/telemetry-panel");
const { mountTopbar } = require("ui/views/topbar");
const { mountCalibrationDrawer } = require("ui/views/drawers/calibration");
const { mountConfigureDrawer } = require("ui/views/drawers/configure");
const { mountConnectDrawer } = require("ui/views/drawers/connect");
const { mountPresetsDrawer } = require("ui/views/drawers/presets");
const { mountRunDrawer } = require("ui/views/drawers/run");
const { mountToolsDrawer } = require("ui/views/drawers/tools");

function mountApp({ device, services }) {
  hydrateIcons(document);
  installNumberGuards();
  mountToasts(document.getElementById("toastStack"));

  const selection = createChartSelection();
  const drawers = createDrawerHost(document.getElementById("drawerBackdrop"));

  // The undo stack is created after the views so their inputs already exist;
  // views ask for it lazily through this holder.
  let history = null;
  const historyRef = { get: () => history };

  const cycle = mountCycleOverlay({
    root: document.getElementById("cycleOverlay"),
    device
  });

  mountTopbar({ root: document.getElementById("topbar"), device, history: historyRef, drawers });
  mountCommandBar({
    root: document.getElementById("commandBar"),
    device,
    run: services.run,
    history: historyRef,
    sweep: services.calibrationSweep
  });
  mountTelemetryPanel({ root: document.getElementById("plotPanel"), device, selection });
  mountStatusPanel({ root: document.getElementById("statusPanel"), device, config: services.config });

  // ---- drawers -----------------------------------------------------------
  const connectRoot = document.getElementById("connectDrawer");
  const runRoot = document.getElementById("runDrawer");
  const configureRoot = document.getElementById("configureDrawer");
  const presetsRoot = document.getElementById("presetsDrawer");
  const calibrationRoot = document.getElementById("calibrationDrawer");
  const toolsRoot = document.getElementById("toolsDrawer");

  mountConnectDrawer({
    root: connectRoot,
    device,
    onConnected: async () => {
      await services.config.syncSnapshot({ announce: true });
      await services.calibration.refreshInfo();
    }
  });
  mountRunDrawer({ root: runRoot, device, run: services.run, history: historyRef });
  mountConfigureDrawer({
    root: configureRoot,
    device,
    config: services.config,
    run: services.run,
    history: historyRef
  });
  mountPresetsDrawer({ root: presetsRoot, device, presets: services.presets, run: services.run });
  mountCalibrationDrawer({
    root: calibrationRoot,
    device,
    cal: services.calibration,
    run: services.run,
    sweep: services.calibrationSweep
  });
  mountToolsDrawer({ root: toolsRoot, drawers });

  drawers.register("connect", connectRoot);
  drawers.register("run", runRoot);
  drawers.register("configure", configureRoot);
  drawers.register("presets", presetsRoot);
  drawers.register("calibration", calibrationRoot, {
    onOpen: () => {
      if (device.isConnected()) void services.calibration.refreshInfo();
    },
    // Closing the drawer (or Escape) has to drop the output: the wizard drives
    // the bench, and its points are already in the table.
    onClose: () => services.calibrationSweep.stop()
  });
  drawers.register("tools", toolsRoot);

  // ---- navigation routing -------------------------------------------------
  document.addEventListener("click", (event) => {
    const opener = event.target.closest("[data-open]");
    if (opener) {
      if (opener.dataset.open === "cycle") cycle.toggle();
      else drawers.open(opener.dataset.open);
      return;
    }
    if (event.target.closest("[data-drawer-close]")) drawers.close();
  });

  // ---- keyboard ------------------------------------------------------------
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        if (cycle.isOpen()) {
          cycle.close();
          return;
        }
        drawers.close();
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || !history) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        history.undo();
      } else if (key === "y" || (key === "z" && event.shiftKey)) {
        event.preventDefault();
        history.redo();
      }
    },
    true
  );

  // ---- undo / redo ---------------------------------------------------------
  history = new HistoryStack({
    snapshot: () => ({
      run: services.run.getForm(),
      config: deepClone(services.config.getForm()),
      chart: selection.get()
    }),
    apply: (snap) => {
      services.run.replaceForm(snap.run);
      services.config.replaceForm(snap.config);
      selection.set(snap.chart);
    },
    onChange: requestRender
  });

  // ---- heartbeat-independent chart sampling -------------------------------
  window.setInterval(() => {
    device.telemetry.sample(performance.now());
  }, CHART_SAMPLE_MS);

  // A language switch is ONE apply() pass plus ONE render pass -- no per-node
  // rewriting, so nothing flickers and no box changes size.
  onLanguageChange(() => {
    if (cycle.isOpen()) cycle.render();
    renderNow();
  });

  registerView("app-shell", () => {
    document.body.classList.toggle("is-output-live", device.isOutputLive());
  });

  renderNow();
  return { drawers, cycle, history };
}

exports.mountApp = mountApp;
});
