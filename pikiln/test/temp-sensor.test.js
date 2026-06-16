'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TempSensor } = require('../lib/temp-sensor');
const { ERROR_TEMP_SENSOR } = require('../lib/constants');

// Mock SPI reader. The test pushes a queue of 32-bit words; each read32()
// pops one. Format mirrors what _readRaw() expects (thermocouple bits 31:18,
// fault flag bit 16, fault types in bits 0..2, cold-junction bits 15:4).
function makeMockProvider() {
  const queue = [];
  return {
    simulation: false,
    queue,
    createSpiReader: () => ({
      read32: () => (queue.length ? queue.shift() : 0),
      close: () => {},
    }),
  };
}

// Encode a 32-bit MAX31855 word: a normal reading at the given thermocouple-C
// and cold-junction-C values. Uses signed 14-bit for TC (0.25°C resolution)
// and signed 12-bit for CJ (0.0625°C resolution). Bit 16 (fault) is 0.
function encodeGood(tcC, cjC) {
  const tcRaw = Math.round(tcC / 0.25) & 0x3FFF;
  const cjRaw = Math.round(cjC / 0.0625) & 0xFFF;
  return ((tcRaw << 18) >>> 0) | ((cjRaw & 0xFFF) << 4);
}

// Encode a word with the SCV (bit 2) fault flag set.
function encodeFaultSCV() { return (1 << 16) | (1 << 2); }
function encodeFaultSCG() { return (1 << 16) | (1 << 1); }

test('TempSensor: single faulted sample does not flip hasError', () => {
  const mock = makeMockProvider();
  const s = new TempSensor(0, 0, mock);
  // Two clean reads, then one fault, then a clean one.
  mock.queue.push(encodeGood(100, 25), encodeGood(101, 25),
                  encodeFaultSCV(),
                  encodeGood(102, 25));
  for (let i = 0; i < 4; i++) s.sample();
  assert.equal(s.hasError, false,
    'single transient fault should not flip the debounced flag');
});

test('TempSensor: 3 consecutive faulted samples DO flip hasError', () => {
  const mock = makeMockProvider();
  const s = new TempSensor(0, 0, mock);
  // Two good reads first so the buffer has a baseline.
  mock.queue.push(encodeGood(100, 25), encodeGood(101, 25));
  s.sample(); s.sample();
  assert.equal(s.hasError, false);

  // Three faults in a row → confirmed.
  mock.queue.push(encodeFaultSCV(), encodeFaultSCV(), encodeFaultSCV());
  s.sample();
  assert.equal(s.hasError, false, '2 faults in last-3 is not enough (1 good still in window)');
  s.sample();
  assert.equal(s.hasError, false, 'still one good in the last-3 window');
  s.sample();
  assert.equal(s.hasError, true, '3-of-last-3 confirmed → fault flag set');
  assert.ok(s.errors.has('SCV'));
});

test('TempSensor: one good sample clears the fault flag (symmetric recovery)', () => {
  const mock = makeMockProvider();
  const s = new TempSensor(0, 0, mock);
  // Drive into confirmed fault.
  for (let i = 0; i < 3; i++) {
    mock.queue.push(encodeFaultSCV());
    s.sample();
  }
  assert.equal(s.hasError, true);
  // One good read → the trailing 3-window no longer all-faulted.
  mock.queue.push(encodeGood(800, 25));
  s.sample();
  assert.equal(s.hasError, false, 'one good sample should clear the debounced fault');
});

test('TempSensor: lastReadingC returns the median of valid samples (rejects spike)', () => {
  const mock = makeMockProvider();
  const s = new TempSensor(0, 0, mock);
  // Five samples — four at 1000°C and one wild spike. Median ignores the
  // spike. (Real EMI tends to push raw ADC counts to extreme values that
  // would still parse as valid temps before they trip the fault detector.)
  mock.queue.push(
    encodeGood(1000, 25),
    encodeGood(1001, 25),
    encodeGood(1300, 25),    // spike
    encodeGood(1002, 25),
    encodeGood(999,  25),
  );
  for (let i = 0; i < 5; i++) s.sample();
  // Median of [999, 1000, 1001, 1002, 1300] = 1001 — the corrected value
  // will be close to 1001°C (NIST polynomial is ~unity-gain in this range).
  const reading = s.lastReadingC;
  assert.ok(reading > 990 && reading < 1015,
    `median should reject the 1300°C spike, got ${reading.toFixed(1)}°C`);
});

test('TempSensor: mixed fault + good samples — lastReadingC ignores faulted reads', () => {
  const mock = makeMockProvider();
  const s = new TempSensor(0, 0, mock);
  mock.queue.push(
    encodeGood(800, 25),
    encodeFaultSCG(),
    encodeGood(802, 25),
    encodeFaultSCG(),
    encodeGood(801, 25),
  );
  for (let i = 0; i < 5; i++) s.sample();
  // hasError stays false (no 3-in-a-row fault) and the reading reflects the
  // 3 good samples.
  assert.equal(s.hasError, false);
  const reading = s.lastReadingC;
  assert.ok(reading > 790 && reading < 815,
    `mixed-noise reading should ride the median, got ${reading.toFixed(1)}°C`);
});

test('TempSensor: NO_CHIP (all-zero word) participates in the same debounce', () => {
  // The all-zero pattern means MISO is stuck low (wiring fault). It should
  // debounce identically to OC/SCG/SCV — one transient zero read isn't a
  // confirmed fault.
  const mock = makeMockProvider();
  const s = new TempSensor(0, 0, mock);
  mock.queue.push(encodeGood(500, 25), 0, encodeGood(501, 25));
  s.sample(); s.sample(); s.sample();
  assert.equal(s.hasError, false, 'single NO_CHIP read between good samples must not flip');
});

test('TempSensor: readCelsius (compat wrapper) returns ERROR_TEMP_SENSOR only on confirmed fault', () => {
  const mock = makeMockProvider();
  const s = new TempSensor(0, 0, mock);
  // First call: pushes one good sample, returns the median.
  mock.queue.push(encodeGood(600, 25));
  let r = s.readCelsius();
  assert.ok(r > 590 && r < 615, `first read should be ~600°C, got ${r}`);
  // Two more good samples to fill the buffer, then a single fault — the
  // wrapper should still return a real temp because the debounce isn't met.
  mock.queue.push(encodeGood(601, 25), encodeGood(602, 25), encodeFaultSCV());
  s.readCelsius(); s.readCelsius();
  r = s.readCelsius();
  assert.notEqual(r, ERROR_TEMP_SENSOR,
    'single fault among 4 good samples should not produce ERROR_TEMP_SENSOR');
});

test('TempSensor: onError fires once on confirmed fault, onRecover fires once on clear with duration', () => {
  const mock = makeMockProvider();
  const s = new TempSensor(0, 0, mock);
  const errorEvents = [];
  const recoverEvents = [];
  s.onError = (errs) => errorEvents.push(Array.from(errs).sort().join('+'));
  s.onRecover = (dur) => recoverEvents.push(dur);

  // Seed with 3 faulted reads → confirmed fault → onError fires once.
  for (let i = 0; i < 3; i++) {
    mock.queue.push(encodeFaultSCV());
    s.sample();
  }
  assert.deepEqual(errorEvents, ['SCV'], 'onError should fire exactly once on transition');
  assert.equal(recoverEvents.length, 0);

  // Another faulted sample — still in fault state, no duplicate event.
  mock.queue.push(encodeFaultSCV());
  s.sample();
  assert.equal(errorEvents.length, 1, 'onError must not re-fire while still faulted');

  // One good sample → debounce clears → onRecover fires with duration.
  mock.queue.push(encodeGood(500, 25));
  s.sample();
  assert.equal(recoverEvents.length, 1, 'onRecover should fire exactly once on transition');
  assert.ok(recoverEvents[0] >= 0, 'recovery duration should be non-negative');
});

test('TempSensor: simulation mode samples cleanly with no SPI traffic', () => {
  const mock = { simulation: true, createSpiReader: () => ({ read32: () => { throw new Error('should not read in sim'); }, close: () => {} }) };
  const s = new TempSensor(0, 0, mock);
  s.simulatedTempC = 1234;
  for (let i = 0; i < 3; i++) s.sample();
  assert.equal(s.lastReadingC, 1234);
  assert.equal(s.hasError, false);
});
