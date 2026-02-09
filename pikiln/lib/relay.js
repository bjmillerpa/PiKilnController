'use strict';

const { CYCLE_LENGTH_SECONDS } = require('./constants');

class Relay {
  constructor(pin, gpioProvider) {
    this._gpio = gpioProvider.createOutput(pin);
    this._gpio.write(0);
    this.isOn = false;
    this.secondsOn = 0;
    this._lastAccumulationTime = 0;
    this._secondsOnLastChecked = 0;
    this._continuousOnStart = 0;
    this.onToggle = null; // callback(isOn)
  }

  turnOn() {
    this._gpio.write(1);
    if (!this.isOn) {
      this.isOn = true;
      this._lastAccumulationTime = Date.now();
      this._continuousOnStart = this._lastAccumulationTime;
      if (this.onToggle) this.onToggle(true);
    }
  }

  turnOff() {
    this._gpio.write(0);
    if (this.isOn) {
      this._accumulateSecondsOn();
      this.isOn = false;
      this._continuousOnStart = 0;
      if (this.onToggle) this.onToggle(false);
    }
  }

  get continuousOnSeconds() {
    if (!this.isOn || !this._continuousOnStart) return 0;
    return (Date.now() - this._continuousOnStart) / 1000;
  }

  get secondsOnSinceLastChecked() {
    this._accumulateSecondsOn();
    const delta = this.secondsOn - this._secondsOnLastChecked;
    this._secondsOnLastChecked = this.secondsOn;
    return delta;
  }

  _accumulateSecondsOn() {
    if (this.isOn && this._lastAccumulationTime > 0) {
      const now = Date.now();
      this.secondsOn += (now - this._lastAccumulationTime) / 1000;
      this._lastAccumulationTime = now;
    }
  }
}

class Element extends Relay {
  constructor(pin, gpioProvider, watts = 240 * 16) {
    super(pin, gpioProvider);
    this.watts = watts;
    this._offTimer = null;
  }

  start(durationSeconds) {
    clearTimeout(this._offTimer);
    this._offTimer = null;

    if (durationSeconds <= 0) {
      this.turnOff();
      return;
    }

    // If at or above cycle length, overlap slightly so relay stays on
    if (durationSeconds >= CYCLE_LENGTH_SECONDS) {
      durationSeconds = CYCLE_LENGTH_SECONDS * 1.2;
    }

    this.turnOn();
    this._offTimer = setTimeout(() => {
      this._offTimer = null;
      this.turnOff();
    }, durationSeconds * 1000);
  }

  emergencyOff() {
    clearTimeout(this._offTimer);
    this._offTimer = null;
    this.turnOff();
  }
}

module.exports = { Relay, Element };
