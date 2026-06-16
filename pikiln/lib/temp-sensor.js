'use strict';

const {
  GPIO_SPI_CLOCK, GPIO_SPI_DATA, TEMP_CHANGE_THRESHOLD_C, ERROR_TEMP_SENSOR,
} = require('./constants');

// Rolling buffer of recent SPI reads. Used to debounce intermittent faults
// (transient SCG/SCV from element-switching EMI shouldn't surface as a
// "FAULT: SCV" badge that vanishes 1 s later) and to median-filter the
// temperature signal (rejects single-sample noise spikes without lagging
// real changes — kiln thermal mass is huge, real temps don't move > 1°C/s).
const BUFFER_SIZE = 5;                  // sliding window: 5 samples @ 1 Hz = 5 s
const FAULT_CONFIRM_COUNT = 3;          // need 3-of-last-3 faulted reads to flag
// Convenience: pluck the median of an array of numbers (modifies a copy).
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

class TempSensor {
  constructor(csPin, offsetC, gpioProvider) {
    this._spi = gpioProvider.createSpiReader(GPIO_SPI_CLOCK, GPIO_SPI_DATA, csPin);
    this._simulation = gpioProvider.simulation;
    this._offsetC = offsetC;
    this._simulatedTempC = 21; // ambient
    this._lastTempC = 0;
    // Sample buffer — entries are { tempC, isError, errors, ts } pushed by
    // sample() in arrival order, capped at BUFFER_SIZE. lastReadingC and
    // hasError are derived from this rather than from individual reads.
    this._buffer = [];
    // How many consecutive faulted samples flip hasError to true. Default 3
    // (so a single SPI glitch or EMI transient doesn't surface as a fault);
    // Kiln.setDiagnosticMode(true) drops this to 1 so the operator can see
    // every fault during cap/ferrite tuning. Median temp smoothing is
    // unaffected — only the fault flag.
    this._faultConfirmCount = FAULT_CONFIRM_COUNT;
    this.onTempChange = null;
    this.onError = null;       // fires once when fault confirmed
    this.onRecover = null;     // fires once when sensor returns to healthy
    // Edge-trigger state for onError / onRecover. Must be explicitly false
    // (not undefined) so the very first fault transition fires onError —
    // the previous code relied on falling through to `else if (!hasError)`
    // first, which never happens if a fault is present from the moment the
    // sensor is wired up.
    this._wasError = false;
    this._faultStartedAt = 0;
  }

  setFaultConfirmCount(n) {
    this._faultConfirmCount = Math.max(1, Math.floor(n));
  }

  // Median of recent valid (non-faulted) samples. Falls back to the most
  // recent valid value, then to 0 if the sensor has never produced a good
  // read. Always returns a number — even during a sustained fault, this
  // returns the last-known-good temp (callers should check hasError too).
  get lastReadingC() {
    const valid = this._buffer.filter(s => !s.isError).map(s => s.tempC);
    if (valid.length > 0) return median(valid);
    return this._simulation ? this._simulatedTempC : 0;
  }

  // Debounced fault state. Only true after `_faultConfirmCount` consecutive
  // faulted reads — a single EMI transient or SPI glitch is filtered out.
  // Recovery is symmetric: one successful read flips this back to false.
  get hasError() {
    const n = this._faultConfirmCount;
    if (this._buffer.length < n) return false;
    const recent = this._buffer.slice(-n);
    return recent.every(s => s.isError);
  }

  // Union of error codes seen in the most recent faulted samples. Returns
  // an empty set when not faulted.
  get errors() {
    const out = new Set();
    if (!this.hasError) return out;
    for (const s of this._buffer.slice(-this._faultConfirmCount)) {
      for (const e of s.errors) out.add(e);
    }
    return out;
  }

  get simulatedTempC() { return this._simulatedTempC; }
  set simulatedTempC(v) { this._simulatedTempC = v; }

  // Take one fresh SPI reading (or simulated sample) and append to the
  // ring buffer. The control loop calls this every heartbeat (1 Hz) on
  // every sensor, regardless of which ring is on this beat's PID update —
  // that way fault debounce and temperature smoothing have enough data to
  // work with, without paying per-ring 1 ms SPI cost only once per 15 s.
  sample() {
    let entry;
    if (this._simulation) {
      entry = { tempC: this._simulatedTempC, isError: false, errors: new Set(), ts: Date.now() };
    } else {
      const raw = this._readRaw();
      if (raw.errors.size > 0) {
        entry = { tempC: null, isError: true, errors: raw.errors, ts: Date.now() };
      } else {
        const corrected = this._correct(raw.thermocoupleC, raw.coldJunctionC) + this._offsetC;
        entry = { tempC: corrected, isError: false, errors: new Set(), ts: Date.now() };
      }
    }
    this._buffer.push(entry);
    if (this._buffer.length > BUFFER_SIZE) this._buffer.shift();

    // Edge-triggered callbacks. Fire onError when transitioning into a
    // confirmed fault (so callers don't get spammed every sample),
    // onRecover when the same ring's debounced state clears. Both feed
    // the per-ring fault log so Bruce can post-process which rings
    // faulted, when, and for how long — independent of whether the kiln
    // continued firing via sibling-ring fallback.
    if (entry.isError && this.hasError && this._wasError === false) {
      this._wasError = true;
      this._faultStartedAt = Date.now();
      if (this.onError) this.onError(this.errors);
    } else if (!this.hasError && this._wasError === true) {
      this._wasError = false;
      const durationSec = this._faultStartedAt
        ? (Date.now() - this._faultStartedAt) / 1000
        : 0;
      this._faultStartedAt = 0;
      if (this.onRecover) this.onRecover(durationSec);
    }
    if (!this.hasError) this._checkChangeEvent(this.lastReadingC);
  }

  // Backward-compat wrapper. Equivalent to `sample(); return lastReadingC ||
  // ERROR_TEMP_SENSOR`. New code should call sample() once per heartbeat
  // and read lastReadingC / hasError directly.
  readCelsius() {
    this.sample();
    return this.hasError ? ERROR_TEMP_SENSOR : this.lastReadingC;
  }

  // Test helper. Fills the buffer with N identical samples so the debounced
  // state matches the caller's intent immediately, bypassing the 3-of-last-3
  // confirmation window. Used by lifecycle/kiln tests to set up "this ring
  // is at 500°C" or "this ring is faulted" preconditions without juggling
  // SPI mocks. Not for production code.
  _seedForTest({ tempC = 0, hasError = false, errorCodes = ['SCV'] } = {}) {
    this._buffer = [];
    for (let i = 0; i < this._faultConfirmCount; i++) {
      this._buffer.push({
        tempC: hasError ? null : tempC,
        isError: hasError,
        errors: new Set(hasError ? errorCodes : []),
        ts: Date.now(),
      });
    }
    this._wasError = hasError;
  }

  readFahrenheit() {
    const c = this.readCelsius();
    if (c === ERROR_TEMP_SENSOR) return ERROR_TEMP_SENSOR;
    return c * 9 / 5 + 32;
  }

  _checkChangeEvent(tempC) {
    if (Math.abs(tempC - this._lastTempC) >= TEMP_CHANGE_THRESHOLD_C) {
      this._lastTempC = tempC;
      if (this.onTempChange) this.onTempChange(tempC);
    }
  }

  _readRaw() {
    const data = this._spi.read32();
    const errors = new Set();

    // An all-zero word means MISO is stuck low — the chip isn't responding.
    // Could be a broken CS wire, an unpowered or fried breakout, or a kernel
    // SPI driver claiming the pins. A working MAX31855 always has non-zero
    // cold-junction bits (it senses its own die temp continuously), so the
    // all-zero pattern reliably indicates "no chip" rather than a real 0°C
    // reading. Without this guard the UI shows 32°F and looks normal.
    if (data === 0) {
      errors.add('NO_CHIP');
      return { thermocoupleC: 0, coldJunctionC: 0, errors };
    }

    // Bit 16: fault flag — bits 0..2 tell us which kind.
    if (data & (1 << 16)) {
      if (data & (1 << 0)) errors.add('OC');   // open circuit (no thermocouple, or wire broken)
      if (data & (1 << 1)) errors.add('SCG');  // short to ground
      if (data & (1 << 2)) errors.add('SCV');  // short to VCC
      return { thermocoupleC: 0, coldJunctionC: 0, errors };
    }

    // Cold junction: bits 15:4, 12-bit signed, LSB = 0.0625C
    let cjRaw = (data >> 4) & 0xFFF;
    if (cjRaw & 0x800) cjRaw = cjRaw - 0x1000;
    const coldJunctionC = cjRaw * 0.0625;

    // Thermocouple: bits 31:18, 14-bit signed, LSB = 0.25C
    let tcRaw = (data >> 18) & 0x3FFF;
    if (tcRaw & 0x2000) tcRaw = tcRaw - 0x4000;
    const thermocoupleC = tcRaw * 0.25;

    return { thermocoupleC, coldJunctionC, errors };
  }

  // NIST cold-junction compensation for K-type thermocouple
  // Ported from utempsensor.pas Correct() and mV2C()
  _correct(rawThermocoupleC, coldJunctionC) {
    // Thermocouple voltage in mV
    const tcmV = (rawThermocoupleC - coldJunctionC) * 0.041276;

    // Cold junction equivalent thermocouple voltage (NIST polynomial)
    const cj = coldJunctionC;
    const cjmV =
      -0.176004136860e-01 +
       0.389212049750e-01  * cj +
       0.185587700320e-04  * Math.pow(cj, 2) +
      -0.994575928740e-07  * Math.pow(cj, 3) +
       0.318409457190e-09  * Math.pow(cj, 4) +
      -0.560728448890e-12  * Math.pow(cj, 5) +
       0.560750590590e-15  * Math.pow(cj, 6) +
      -0.320207200030e-18  * Math.pow(cj, 7) +
       0.971511471520e-22  * Math.pow(cj, 8) +
      -0.121047212750e-25  * Math.pow(cj, 9) +
       0.118597600000e+00  * Math.exp(
        -0.118343200000e-03 * Math.pow(cj - 0.126968600000e+03, 2)
       );

    return TempSensor.mv2c(tcmV + cjmV);
  }

  // NIST voltage-to-temperature conversion for K-type thermocouple
  // Three coefficient sets for three voltage ranges
  static mv2c(mV) {
    let b;
    if (mV < 0) {
      b = [0.0000000e+00, 2.5173462e+01, -1.1662878e+00, -1.0833638e+00,
           -8.9773540e-01, -3.7342377e-01, -8.6632643e-02, -1.0450598e-02,
           -5.1920577e-04, 0.0000000e+00];
    } else if (mV < 20.644) {
      b = [0.000000e+00, 2.508355e+01, 7.860106e-02, -2.503131e-01,
           8.315270e-02, -1.228034e-02, 9.804036e-04, -4.413030e-05,
           1.057734e-06, -1.052755e-08];
    } else if (mV < 54.886) {
      b = [-1.318058e+02, 4.830222e+01, -1.646031e+00, 5.464731e-02,
           -9.650715e-04, 8.802193e-06, -3.110810e-08, 0.000000e+00,
            0.000000e+00, 0.000000e+00];
    } else {
      return ERROR_TEMP_SENSOR; // out of range
    }

    let result = 0;
    for (let i = 0; i < b.length; i++) {
      result += b[i] * Math.pow(mV, i);
    }
    return result;
  }

  close() {
    this._spi.close();
  }
}

module.exports = { TempSensor };
