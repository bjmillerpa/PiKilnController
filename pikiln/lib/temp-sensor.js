'use strict';

const {
  GPIO_SPI_CLOCK, GPIO_SPI_DATA, TEMP_CHANGE_THRESHOLD_C, ERROR_TEMP_SENSOR,
} = require('./constants');

class TempSensor {
  constructor(csPin, offsetC, gpioProvider) {
    this._spi = gpioProvider.createSpiReader(GPIO_SPI_CLOCK, GPIO_SPI_DATA, csPin);
    this._simulation = gpioProvider.simulation;
    this._offsetC = offsetC;
    this._simulatedTempC = 21; // ambient
    this._lastTempC = 0;
    this._lastReadingC = gpioProvider.simulation ? 21 : 0;
    this._hasError = false;
    this._errors = new Set();
    this.onTempChange = null;
    this.onError = null;
  }

  get lastReadingC() { return this._lastReadingC; }
  get hasError() { return this._hasError; }
  get simulatedTempC() { return this._simulatedTempC; }
  set simulatedTempC(v) { this._simulatedTempC = v; }

  readCelsius() {
    if (this._simulation) {
      const temp = this._simulatedTempC;
      this._lastReadingC = temp;
      this._hasError = false;
      this._checkChangeEvent(temp);
      return temp;
    }

    const raw = this._readRaw();
    if (raw.errors.size > 0) {
      this._hasError = true;
      this._errors = raw.errors;
      if (this.onError) this.onError(raw.errors);
      return ERROR_TEMP_SENSOR;
    }

    this._hasError = false;
    const corrected = this._correct(raw.thermocoupleC, raw.coldJunctionC) + this._offsetC;
    this._lastReadingC = corrected;
    this._checkChangeEvent(corrected);
    return corrected;
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

    // Bit 16: fault flag
    if (data & (1 << 16)) {
      if (data & (1 << 0)) errors.add('OC');   // open circuit
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
