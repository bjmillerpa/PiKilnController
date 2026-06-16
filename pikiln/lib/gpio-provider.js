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

// Software (bit-bang) SPI for the MAX31855 thermocouples.
//
// We can't use pigpio's bbSPI* C helpers because the fivdi/pigpio npm
// package doesn't expose them — only the Gpio class and a few utilities.
// The MAX31855 is a read-only Mode-0 SPI device (CPOL=0, CPHA=0, MSB first),
// so this loop is enough: assert CS low, clock out 32 bits sampling MISO on
// each rising edge, deassert CS. The chip puts each next bit on MISO on the
// falling edge of SCK, which makes "sample on rising / advance on falling"
// the natural sequence.
//
// Performance: each read32() takes ~roughly 100–300 µs of JS overhead, fine
// at the controller's 1 Hz heartbeat (each sensor is read about once per
// 5 s).
class RealSpiReader {
  constructor(clockPin, dataPin, csPin, Gpio) {
    this._cs   = new Gpio(csPin,   { mode: Gpio.OUTPUT });
    this._miso = new Gpio(dataPin, { mode: Gpio.INPUT });
    this._clk  = new Gpio(clockPin, { mode: Gpio.OUTPUT });
    this._cs.digitalWrite(1);   // CS idle high (active-low)
    this._clk.digitalWrite(0);  // SCK idle low (CPOL=0)
  }

  read32() {
    this._cs.digitalWrite(0);   // assert CS — chip places D31 on MISO
    let val = 0;
    for (let i = 0; i < 32; i++) {
      this._clk.digitalWrite(1);                          // rising edge: sample
      val = (val << 1) | this._miso.digitalRead();
      this._clk.digitalWrite(0);                          // falling edge: chip shifts next bit
    }
    this._cs.digitalWrite(1);   // deassert CS
    return val >>> 0;            // force unsigned 32-bit
  }

  close() {
    this._cs.digitalWrite(1);
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
      // The pigpio npm package is a thin wrapper over a native .node addon,
      // which itself dynamically links libpigpio.so. If the system library is
      // missing the .node fails to self-register; require() still succeeds
      // (the JS shell loads fine), but Gpio.OUTPUT (sourced from the native
      // binding) ends up undefined and any later `new Gpio(...)` blows up
      // with "pigpio.gpioInitialise is not a function".
      //
      // Detect that case here and fall back to simulation instead of
      // letting the service crash-loop. The operator will see the warning
      // in journalctl and know to run `apt install pigpio`.
      if (!this._Gpio || typeof this._Gpio.OUTPUT !== 'number') {
        throw new Error('pigpio native binding did not register — is the pigpio C library installed? (sudo apt install pigpio)');
      }
    } catch (e) {
      console.error('[gpio-provider] pigpio unavailable, using simulation:', e.message);
      this._pigpio = null;
      this._Gpio = null;
      this.simulation = true;
    }
  }

  createOutput(pin) {
    if (this.simulation) return new MockGpioPin(pin);
    return new RealGpioPin(pin, this._Gpio);
  }

  createSpiReader(clockPin, dataPin, csPin) {
    if (this.simulation) return new MockSpiReader(clockPin, dataPin, csPin);
    return new RealSpiReader(clockPin, dataPin, csPin, this._Gpio);
  }

  // ── Hardware-bring-up debug helpers ──────────────────────────────────
  // These instantiate Gpio handles ad-hoc and tear them down (well, leave
  // them for the GC — pigpio doesn't really care). Refuse to do anything
  // dangerous: the call sites in pikiln.js still gate on kiln.mode.

  // Force a pin to a level. Pin numbers are BCM (pigpio's only mode).
  debugWrite(pin, level) {
    if (this.simulation) return { ok: true, sim: true, pin, level: level ? 1 : 0 };
    const Gpio = this._Gpio;
    const p = new Gpio(pin, { mode: Gpio.OUTPUT });
    p.digitalWrite(level ? 1 : 0);
    return { ok: true, pin, level: level ? 1 : 0 };
  }

  // Drive HIGH for durationMs, then return to LOW. Returns when done.
  async debugPulse(pin, durationMs = 500) {
    if (this.simulation) {
      await new Promise(r => setTimeout(r, durationMs));
      return { ok: true, sim: true, pin };
    }
    const Gpio = this._Gpio;
    const p = new Gpio(pin, { mode: Gpio.OUTPUT });
    p.digitalWrite(1);
    await new Promise(r => setTimeout(r, durationMs));
    p.digitalWrite(0);
    return { ok: true, pin };
  }

  // Pulse each BCM pin from `startPin` to `endPin` in turn — useful for
  // figuring out which BCM number corresponds to a given physical relay on
  // the board. The caller hears the relays clicking in sequence.
  async debugSweep(startPin, endPin, durationMs = 400, gapMs = 200) {
    const pinsPulsed = [];
    if (this.simulation) {
      for (let pin = startPin; pin <= endPin; pin++) {
        pinsPulsed.push(pin);
        await new Promise(r => setTimeout(r, durationMs + gapMs));
      }
      return { ok: true, sim: true, pinsPulsed };
    }
    const Gpio = this._Gpio;
    for (let pin = startPin; pin <= endPin; pin++) {
      try {
        const p = new Gpio(pin, { mode: Gpio.OUTPUT });
        p.digitalWrite(1);
        pinsPulsed.push(pin);
        await new Promise(r => setTimeout(r, durationMs));
        p.digitalWrite(0);
        await new Promise(r => setTimeout(r, gapMs));
      } catch (e) {
        // Some pin numbers (28+, 32+) may not be on the header — skip and continue
      }
    }
    return { ok: true, pinsPulsed };
  }

  // One-shot raw 32-bit read from a bit-bang SPI device on the given pins.
  // Returns the integer the wire produced. For a MAX31855 with a working
  // thermocouple, the top 14 bits decode to the thermocouple temp (°C×0.25);
  // 0 means "no chip responding" or "wrong pins" or "tc open".
  async debugSpiRead(clockPin, dataPin, csPin) {
    if (this.simulation) return { ok: true, sim: true, raw: 0, hex: '00000000' };
    const Gpio = this._Gpio;
    const cs   = new Gpio(csPin,    { mode: Gpio.OUTPUT });
    const miso = new Gpio(dataPin,  { mode: Gpio.INPUT  });
    const clk  = new Gpio(clockPin, { mode: Gpio.OUTPUT });
    cs.digitalWrite(1);
    clk.digitalWrite(0);
    await new Promise(r => setTimeout(r, 10));  // settle
    cs.digitalWrite(0);
    let val = 0;
    for (let i = 0; i < 32; i++) {
      clk.digitalWrite(1);
      val = (val << 1) | miso.digitalRead();
      clk.digitalWrite(0);
    }
    cs.digitalWrite(1);
    val >>>= 0;
    return { ok: true, raw: val, hex: val.toString(16).padStart(8, '0') };
  }
}

module.exports = { GpioProvider, MockGpioPin, MockSpiReader };
