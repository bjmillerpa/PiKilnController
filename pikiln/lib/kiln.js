'use strict';

const EventEmitter = require('events');
const {
  CYCLE_LENGTH_SECONDS, HEARTBEATS_PER_CYCLE, HEARTBEAT_RING,
  MIN_FIRE_TIME_SECONDS, ERROR_TEMP_SENSOR, COST_PER_KWH,
  GPIO_HEAT, GPIO_VENT_FAN, GPIO_SPI_CS, THERMOCOUPLE_OFFSETS, AMBIENT_TEMP_C,
  c2f, cph2fph,
} = require('./constants');
const { GpioProvider } = require('./gpio-provider');
const { TempSensor } = require('./temp-sensor');
const { Pid } = require('./pid');
const { Relay, Element } = require('./relay');
const { SafetyMonitor } = require('./safety');
const { updateSimulatedTemps } = require('./simulation');
const { ortonConeFromIndex } = require('./orton-cones');

class Kiln extends EventEmitter {
  constructor(config, logger) {
    super();

    this.mode = 'off'; // off, running, idle, finished
    this.fanMode = 'off'; // off, auto, on
    this._heartbeats = 0;
    this._startTime = null;
    this._lastTime = null;
    this.schedule = null;
    this._logger = logger;
    this._config = config;

    const gpio = new GpioProvider();
    this.simulation = gpio.simulation;

    // Hardware objects
    this.ventFan = new Relay(GPIO_VENT_FAN, gpio);
    this.elements = GPIO_HEAT.map(pin => new Element(pin, gpio));
    this.tempSensors = GPIO_SPI_CS.map((cs, i) =>
      new TempSensor(cs, THERMOCOUPLE_OFFSETS[i], gpio));

    // Initialize simulated temps
    if (this.simulation) {
      for (const s of this.tempSensors) s.simulatedTempC = AMBIENT_TEMP_C;
    }

    // PID controllers
    Pid.clearSisters();
    const pid = config.pid || {};
    const rings = pid.rings || [{}, {}, {}];
    this.pids = rings.map(r =>
      new Pid(r.p || 5, r.i || 3, r.d || 3));

    this.safety = new SafetyMonitor(this, logger);
    this._heartbeatTimer = null;
  }

  start() {
    if (!this.schedule) throw new Error('No schedule loaded');
    if (this.mode === 'running') throw new Error('Already running');

    this.mode = 'running';
    this._startTime = Date.now();
    this._lastTime = this._startTime;
    this._heartbeats = 0;
    this.pids.forEach(p => p.reset());

    // Reset schedule runtime state for a fresh start
    this.schedule.currentSegment = 0;
    this.schedule._segmentStartTime = 0;
    this.schedule.history = [];
    this.schedule.maxConeIndex = 0;

    this.safety.start();

    const intervalMs = (CYCLE_LENGTH_SECONDS * 1000) / HEARTBEATS_PER_CYCLE;
    this._heartbeatTimer = setInterval(() => this._doHeartbeat(), intervalMs);

    this._logger.log(`Kiln started${this.simulation ? ' (simulation)' : ''}`);
    this.emit('started');
  }

  stop() {
    clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;

    this.elements.forEach(e => e.emergencyOff());
    this.ventFan.turnOff();

    // Record stats
    if (this.schedule) {
      this.schedule.metadata['KWHrs per run'] = this.elapsedPowerKWHr.toFixed(1);
      this.schedule.metadata['cost per run'] = (this.elapsedPowerKWHr * COST_PER_KWH).toFixed(2);
      this.schedule.metadata['time per run'] = this._formatElapsed();
      this.schedule.metadata['last start'] = this._formatDateTime(this._startTime);
      this.schedule.metadata['last finish'] = this._formatDateTime(Date.now());
      try { this.schedule.save(); } catch (e) { /* ignore save errors */ }
    }

    this.mode = 'idle';
    this.safety.stop();
    this._logger.log('Kiln stopped');
    this.emit('stopped');
  }

  emergencyStop(reason) {
    clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;

    this.elements.forEach(e => e.emergencyOff());
    this.ventFan.turnOff();

    this.mode = 'off';
    this.safety.stop();
    this.emit('emergency-stop', reason);
  }

  _doHeartbeat() {
    this._heartbeats++;
    this.safety.recordHeartbeat();

    // Simulation: update temps based on element firing and thermal model
    if (this.simulation) {
      updateSimulatedTemps(this.elements, this.tempSensors, [0.35, 0.30, 0.35]);
    }

    // Which ring to update this beat?
    const beatInCycle = this._heartbeats % HEARTBEATS_PER_CYCLE;
    const ring = HEARTBEAT_RING[beatInCycle]; // 1, 2, or 3 (or undefined)

    if (ring && this.schedule && this.mode === 'running') {
      const ringIdx = ring - 1;
      const currentTemp = this._currentTempC(ringIdx);

      if (currentTemp === ERROR_TEMP_SENSOR) {
        this._logger.error(`All sensors failed on ring ${ring} update`);
      } else {
        const targetTemp = this.schedule.targetTempC(currentTemp);

        if (targetTemp === -1) {
          this.stop();
          this.mode = 'finished';
          this._logger.log('Schedule complete — kiln finished');
          this.emit('schedule-complete');
        } else {
          const rate = this.pids[ringIdx].compute(targetTemp, currentTemp);
          const seconds = rate * CYCLE_LENGTH_SECONDS;

          if (seconds > MIN_FIRE_TIME_SECONDS) {
            this.elements[ringIdx].start(seconds);
          }

          // Fan control
          this._updateFan();

          this._logger.log(
            `${ring} Tc: ${c2f(currentTemp).toFixed(1)} Tt: ${c2f(targetTemp).toFixed(1)} rate: ${rate.toFixed(2)} secs: ${seconds.toFixed(1)}`
          );
        }
      }
    }

    this._lastTime = Date.now();
    this.emit('heartbeat', this.getStatus());
  }

  // Try preferred ring's sensor, fall back to others on error
  _currentTempC(ringIdx) {
    const order = [ringIdx, (ringIdx + 1) % 3, (ringIdx + 2) % 3];
    for (const i of order) {
      const temp = this.tempSensors[i].readCelsius();
      if (temp !== ERROR_TEMP_SENSOR) return temp;
    }
    return ERROR_TEMP_SENSOR;
  }

  _updateFan() {
    switch (this.fanMode) {
      case 'off': this.ventFan.turnOff(); break;
      case 'on':  this.ventFan.turnOn(); break;
      case 'auto':
        if (this.schedule) {
          if (this.schedule.fanOn) this.ventFan.turnOn();
          else this.ventFan.turnOff();
        }
        break;
    }
  }

  get elapsedTimeSeconds() {
    if (!this._startTime) return 0;
    return ((this._lastTime || Date.now()) - this._startTime) / 1000;
  }

  get elapsedPowerKWHr() {
    return this.elements.reduce((sum, e) => sum + e.watts * e.secondsOn, 0) / (1000 * 3600);
  }

  getStatus() {
    return {
      mode: this.mode,
      fanMode: this.fanMode,
      fan: { isOn: this.ventFan.isOn },
      elapsedSeconds: this.elapsedTimeSeconds,
      temps: this.tempSensors.map(s => s.lastReadingC),
      elements: this.elements.map(e => ({
        isOn: e.isOn,
        secondsOn: e.secondsOn,
      })),
      schedule: this.schedule ? {
        title: this.schedule.metadata.title || '',
        currentSegment: this.schedule.currentSegment,
        totalSegments: this.schedule.noSegments,
        targetTempC: this.schedule.lastTargetTempC,
        timeLeftHrs: this.schedule.timeLeftHrs,
        cone: ortonConeFromIndex(this.schedule.maxConeIndex),
        maxConeIndex: this.schedule.maxConeIndex,
        history: this.schedule.history,
        planned: this.schedule.asXYGraph(),
      } : null,
      powerKWHr: this.elapsedPowerKWHr,
      costPerKWH: COST_PER_KWH,
      simulation: this.simulation,
      timestamp: new Date().toISOString(),
    };
  }

  _formatElapsed() {
    const s = this.elapsedTimeSeconds;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  _formatDateTime(ms) {
    const d = new Date(ms);
    return d.getFullYear().toString() +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0') + '_' +
      String(d.getHours()).padStart(2, '0') +
      String(d.getMinutes()).padStart(2, '0') +
      String(d.getSeconds()).padStart(2, '0');
  }
}

module.exports = { Kiln };
