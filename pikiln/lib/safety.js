'use strict';

const {
  ERROR_TEMP_SENSOR, MAX_TEMP_C, ELEMENT_MAX_ON_SECONDS, HEARTBEAT_TIMEOUT_MS,
} = require('./constants');

class SafetyMonitor {
  constructor(kiln, logger, config) {
    this._kiln = kiln;
    this._logger = logger;
    this._watchdogInterval = null;
    this._lastHeartbeatTime = 0;
    // Tracks how long the kiln has been in "all sensors faulted" state. Reset
    // on any recovery (even momentary), so brief EMI bursts that correlate
    // with element switching don't trigger e-stop — only sustained failure
    // (a real wiring problem) does.
    this._allFailedSince = 0;
    this._allFailedWarnedAt = 0;
    // Pull from config.safety with the constants as fallbacks. Keeps existing
    // call sites that didn't pass config (e.g. tests) working unchanged.
    const s = (config && config.safety) || {};
    this.maxTempC = s.maxTempC ?? MAX_TEMP_C;
    this.maxElementOnSeconds = s.maxElementOnSeconds ?? ELEMENT_MAX_ON_SECONDS;
    this.heartbeatTimeoutMs = s.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    // Persistence window for "all sensors faulted" before e-stopping. Default
    // 30 s — long enough to ride out element-switching EMI bursts (typically
    // seconds, sometimes 10–15 s during peak-duty firing) while still
    // catching genuine simultaneous failure within half a minute. Override
    // via config.safety.allSensorsFaultedTimeoutSec.
    //
    // `_configuredTimeoutSec` remembers the operator's configured value so
    // setDiagnosticMode() can restore it exactly when diagnostic mode is
    // turned back off (rather than reverting to the constants default).
    this.allSensorsFaultedTimeoutSec = s.allSensorsFaultedTimeoutSec ?? 30;
    this._configuredTimeoutSec = this.allSensorsFaultedTimeoutSec;
  }

  // Apply or unapply the diagnostic-mode window. While diagnostic mode is on
  // we want sustained simultaneous fault to e-stop within ~5 s so the
  // operator can see the EMI severity clearly. Restoring the configured
  // value on the way back keeps `config.safety.allSensorsFaultedTimeoutSec`
  // overrides honored.
  setDiagnosticMode(enabled) {
    this.allSensorsFaultedTimeoutSec = enabled ? 5 : this._configuredTimeoutSec;
  }

  start() {
    this._lastHeartbeatTime = Date.now();
    this._watchdogInterval = setInterval(() => this._check(), 1000);
  }

  stop() {
    if (this._watchdogInterval) {
      clearInterval(this._watchdogInterval);
      this._watchdogInterval = null;
    }
  }

  recordHeartbeat() {
    this._lastHeartbeatTime = Date.now();
  }

  _check() {
    const now = Date.now();

    // 1. Heartbeat watchdog: control loop stalled?
    if (this._lastHeartbeatTime > 0 &&
        (now - this._lastHeartbeatTime) > this.heartbeatTimeoutMs) {
      this._emergencyStop('Heartbeat timeout — control loop stalled');
      return;
    }

    // Only check the rest if kiln is running
    if (this._kiln.mode !== 'running') return;

    // 2. Over-temperature protection
    for (let i = 0; i < this._kiln.tempSensors.length; i++) {
      const temp = this._kiln.tempSensors[i].lastReadingC;
      if (temp !== ERROR_TEMP_SENSOR && temp > this.maxTempC) {
        this._emergencyStop(`Over-temp: ${temp.toFixed(1)}C on sensor ${i + 1} (max ${this.maxTempC}C)`);
        return;
      }
    }

    // 3. Element on too long without PID re-check
    for (let i = 0; i < this._kiln.elements.length; i++) {
      if (this._kiln.elements[i].isOn &&
          this._kiln.elements[i].continuousOnSeconds > this.maxElementOnSeconds) {
        this._emergencyStop(`Element ${i + 1} on too long: ${this._kiln.elements[i].continuousOnSeconds.toFixed(1)}s`);
        return;
      }
    }

    // 4. All sensors failed — only e-stop when this persists.
    //
    // EMI from element switching at peak duty can fault all three thermo-
    // couples simultaneously for several seconds — the kiln didn't actually
    // lose all its sensors, the wiring is just noisy. We start a timer the
    // first tick the all-failed condition is observed and reset it the
    // moment any sensor recovers. Only sustained simultaneous failure (real
    // wiring problem) trips the e-stop. During the persistence window the
    // PID's per-ring fault-fallback can't find a working sensor either, so
    // no new firing commands go out — the elements coast to their auto-off
    // timers and the kiln drifts down a few degrees while we wait.
    const working = this._kiln.tempSensors.filter(s => !s.hasError);
    if (working.length === 0) {
      if (this._allFailedSince === 0) {
        this._allFailedSince = now;
        this._allFailedWarnedAt = 0;
      }
      const elapsedSec = (now - this._allFailedSince) / 1000;
      if (elapsedSec >= this.allSensorsFaultedTimeoutSec) {
        this._emergencyStop(`All temperature sensors failed for ${elapsedSec.toFixed(0)}s`);
        return;
      }
      // Periodic warning so the operator can see the kiln is riding through
      // bad EMI rather than silently. Log every 5 s.
      if (now - this._allFailedWarnedAt >= 5000) {
        this._logger.log(`Safety: all sensors faulted (${elapsedSec.toFixed(0)}s / ${this.allSensorsFaultedTimeoutSec}s before e-stop) — likely element-switching EMI`);
        this._allFailedWarnedAt = now;
      }
    } else if (this._allFailedSince !== 0) {
      const elapsedSec = (now - this._allFailedSince) / 1000;
      this._logger.log(`Safety: sensors recovered after ${elapsedSec.toFixed(0)}s of all-faulted`);
      this._allFailedSince = 0;
      this._allFailedWarnedAt = 0;
    }
  }

  _emergencyStop(reason) {
    this._logger.error(`EMERGENCY STOP: ${reason}`);
    this._kiln.emergencyStop(reason);
  }
}

module.exports = { SafetyMonitor };
