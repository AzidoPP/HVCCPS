// Application entry point.
//
// Boot order matters:
//   1. resolve the language and translate the static markup   -- before paint
//   2. build the device stack (transport -> frames -> services)
//   3. load plugins (they may register tools before the UI mounts)
//   4. mount the UI and reveal the shell
//
// Nothing above this file knows about anything below it: main.js is the only
// place where the transport, the services, the plugins and the views meet.

HV.define("main", function (require, exports) {
"use strict";

const { bus, EVENTS } = require("core/bus");
const { logger } = require("core/logger");
const { renderNow } = require("core/scheduler");
const { apply: applyI18n, getLanguage, initLanguage, onLanguageChange, setLanguage } = require("i18n/index");
const { createDeviceService } = require("device/device-service");
const { createCalibrationService } = require("device/calibration-service");
const { createCalibrationSweepService } = require("device/calibration-sweep");
const { createConfigService } = require("device/config-service");
const { createPresetsService } = require("device/presets-service");
const { createRunService } = require("device/run-service");
const { TELEMETRY_METRICS } = require("device/metrics");
const { createPluginHost } = require("plugins/api");
const { BUILT_IN_PLUGINS } = require("plugins/index");
const { mountApp } = require("ui/app");

function reveal() {
  document.documentElement.classList.add("is-ready");
}

function boot() {
  window.addEventListener("error", (event) => logger.error(event.message || "unhandled error", event.error || null));
  window.addEventListener("unhandledrejection", (event) => logger.error("unhandled rejection", event.reason || null));

  initLanguage();
  applyI18n(document);
  onLanguageChange((language) => {
    applyI18n(document);
    bus.emit(EVENTS.LANGUAGE_CHANGE, language);
  });

  const device = createDeviceService();
  const config = createConfigService(device);
  const run = createRunService(device);
  const presets = createPresetsService(device, config);
  const calibration = createCalibrationService(device, config);
  const calibrationSweep = createCalibrationSweepService(device, calibration);
  const services = { config, run, presets, calibration, calibrationSweep };

  const plugins = createPluginHost({ device, services, metrics: TELEMETRY_METRICS });
  plugins.registerAll(BUILT_IN_PLUGINS);

  const app = mountApp({ device, services, plugins });

  // Documented automation / debugging handle. Everything the console does is
  // reachable from here, so a browser console, an end-to-end test or an
  // out-of-tree plugin can drive the app without patching it:
  //   HVCCPS.device.telemetry.latest        live decoded telemetry
  //   HVCCPS.services.run.start()           same call the command bar makes
  //   HVCCPS.bus.on(HVCCPS.EVENTS.HEARTBEAT, fn)
  //   HVCCPS.plugins.register(myPlugin)     load a plugin at runtime
  //   HVCCPS.render()                       force a synchronous UI pass
  window.HVCCPS = Object.freeze({
    version: "2.1",
    bus,
    EVENTS,
    device,
    services,
    plugins,
    i18n: { setLanguage, getLanguage },
    ui: app,
    render: renderNow
  });

  logger.info("console ready");
}

try {
  boot();
} catch (error) {
  logger.error("boot failed", error);
} finally {
  reveal();
}

});
