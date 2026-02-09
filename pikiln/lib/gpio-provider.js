'use strict';

class MockGpioPin {
  constructor(pin) {
    this.pin = pin;
    this._value = false;
    this._direction = 'out';
  }
  write(v) { this._value = !!v; }
  read() { return this._value ? 1 : 0; }
}

class MockSpiReader {
  constructor(clockPin, dataPin, csPin) {
    this.clockPin = clockPin;
    this.dataPin = dataPin;
    this.csPin = csPin;
  }
  read32() { return 0; }
  close() {}
}

class RealGpioPin {
  constructor(pin, Gpio) {
    this._gpio = new Gpio(pin, { mode: Gpio.OUTPUT });
  }
  write(v) { this._gpio.digitalWrite(v ? 1 : 0); }
  read() { return this._gpio.digitalRead(); }
}

class RealSpiReader {
  constructor(clockPin, dataPin, csPin, pigpio) {
    this._pigpio = pigpio;
    this._csPin = csPin;
    // Open bit-banged SPI: CS, MISO, MOSI (-1 = unused), SCLK, baud, flags
    // MOSI is not used for MAX31855 (read-only device)
    this._handle = pigpio.bbSPIOpen(csPin, dataPin, -1, clockPin, 1000000, 0);
  }
  read32() {
    const txBuf = Buffer.alloc(4);
    const rxBuf = Buffer.alloc(4);
    this._pigpio.bbSPIXfer(this._csPin, txBuf, rxBuf);
    return rxBuf.readUInt32BE(0);
  }
  close() {
    this._pigpio.bbSPIClose(this._csPin);
  }
}

class GpioProvider {
  constructor() {
    this.simulation = false;
    this._pigpio = null;
    this._Gpio = null;

    if (process.env.PIKILN_SIMULATE === '1') {
      this.simulation = true;
      return;
    }

    try {
      this._pigpio = require('pigpio');
      this._Gpio = this._pigpio.Gpio;
    } catch {
      this.simulation = true;
    }
  }

  createOutput(pin) {
    if (this.simulation) return new MockGpioPin(pin);
    return new RealGpioPin(pin, this._Gpio);
  }

  createSpiReader(clockPin, dataPin, csPin) {
    if (this.simulation) return new MockSpiReader(clockPin, dataPin, csPin);
    return new RealSpiReader(clockPin, dataPin, csPin, this._pigpio);
  }
}

module.exports = { GpioProvider, MockGpioPin, MockSpiReader };
