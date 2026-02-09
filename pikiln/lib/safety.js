'use strict';

const {
  ERROR_TEMP_SENSOR, MAX_TEMP_C, ELEMENT_MAX_ON_SECONDS, HEARTBEAT_TIMEOUT_MS,
} = require('./constants');

class SafetyMonitor {
  constructor(kiln, logger) {
    this._kiln = kiln;
    this._logger = logger;
    this._watchdogInterval = null;
    this._lastHeartbeatTime = 0;
    this.maxTempC = MAX_TEMP_C;
    this.maxElementOnSeconds = ELEMENT_MAX_ON_SECONDS;
    this.heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS;
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

    // 4. All sensors failed
    const working = this._kiln.tempSensors.filter(s => !s.hasError);
    if (working.length === 0) {
      this._emergencyStop('All temperature sensors failed');
      return;
    }
  }

  _emergencyStop(reason) {
    this._logger.error(`EMERGENCY STOP: ${reason}`);
    this._kiln.emergencyStop(reason);
  }
}

module.exports = { SafetyMonitor };
