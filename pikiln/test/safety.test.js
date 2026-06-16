'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { SafetyMonitor } = require('../lib/safety');
const { ERROR_TEMP_SENSOR } = require('../lib/constants');

// Build a minimal fake kiln that satisfies what SafetyMonitor inspects.
function makeKiln(overrides = {}) {
  const kiln = {
    mode: 'running',
    tempSensors: [
      { lastReadingC: 100, hasError: false },
      { lastReadingC: 100, hasError: false },
      { lastReadingC: 100, hasError: false },
    ],
    elements: [
      { isOn: false, continuousOnSeconds: 0 },
      { isOn: false, continuousOnSeconds: 0 },
      { isOn: false, continuousOnSeconds: 0 },
    ],
    _stopped: null,
    emergencyStop(reason) { this._stopped = reason; },
    ...overrides,
  };
  return kiln;
}

const silentLogger = { log: () => {}, error: () => {}, message: () => {} };

let safety;
beforeEach(() => {
  // No setInterval — we drive _check() ourselves so the test stays deterministic.
});

test('over-temp triggers emergency stop', () => {
  const k = makeKiln();
  k.tempSensors[1].lastReadingC = 1500;     // > MAX_TEMP_C (1300)
  safety = new SafetyMonitor(k, silentLogger);
  safety._lastHeartbeatTime = Date.now();   // skip heartbeat watchdog
  safety._check();
  assert.match(k._stopped || '', /Over-temp.*sensor 2/);
});

test('element on too long triggers emergency stop', () => {
  const k = makeKiln();
  k.elements[2].isOn = true;
  k.elements[2].continuousOnSeconds = 999;  // > ELEMENT_MAX_ON_SECONDS (20)
  safety = new SafetyMonitor(k, silentLogger);
  safety._lastHeartbeatTime = Date.now();
  safety._check();
  assert.match(k._stopped || '', /Element 3 on too long/);
});

test('all sensors failed triggers emergency stop after persistence window', () => {
  const k = makeKiln();
  for (const s of k.tempSensors) s.hasError = true;
  // Test-only: short persistence so the test is fast. Real default is 30 s.
  safety = new SafetyMonitor(k, silentLogger, {
    safety: { allSensorsFaultedTimeoutSec: 1 },
  });
  safety._lastHeartbeatTime = Date.now();

  // First check: condition observed, timer starts. NO e-stop yet.
  safety._check();
  assert.equal(k._stopped, null,
    'first observation should arm the timer, not stop');

  // Backdate the timer so the second check sees the persistence threshold met.
  safety._allFailedSince = Date.now() - 1500;
  safety._check();
  assert.match(k._stopped || '', /All temperature sensors failed for/);
});

test('all sensors failed: brief EMI burst that recovers does NOT trigger e-stop', () => {
  const k = makeKiln();
  for (const s of k.tempSensors) s.hasError = true;
  safety = new SafetyMonitor(k, silentLogger, {
    safety: { allSensorsFaultedTimeoutSec: 30 },
  });
  safety._lastHeartbeatTime = Date.now();

  // EMI hits: all faulted, timer arms.
  safety._check();
  assert.equal(k._stopped, null);
  assert.notEqual(safety._allFailedSince, 0, 'timer should arm');

  // 5 s later (within the 30 s window), at least one sensor recovers.
  // The timer resets and we never e-stop.
  k.tempSensors[0].hasError = false;
  safety._check();
  assert.equal(safety._allFailedSince, 0, 'recovery must reset the timer');
  assert.equal(k._stopped, null, 'recovery within window must not e-stop');
});

test('all sensors failed: long sustained failure DOES trigger e-stop', () => {
  const k = makeKiln();
  for (const s of k.tempSensors) s.hasError = true;
  safety = new SafetyMonitor(k, silentLogger, {
    safety: { allSensorsFaultedTimeoutSec: 30 },
  });
  safety._lastHeartbeatTime = Date.now();

  safety._check();                                  // arm timer
  safety._allFailedSince = Date.now() - 31_000;     // pretend 31 s elapsed
  safety._check();
  assert.match(k._stopped || '', /failed for 31s/);
});

test('setDiagnosticMode shortens the all-failed window to 5s and restores on toggle off', () => {
  const k = makeKiln();
  safety = new SafetyMonitor(k, silentLogger, {
    safety: { allSensorsFaultedTimeoutSec: 45 },  // operator-configured value
  });
  assert.equal(safety.allSensorsFaultedTimeoutSec, 45);

  safety.setDiagnosticMode(true);
  assert.equal(safety.allSensorsFaultedTimeoutSec, 5,
    'diagnostic mode should collapse the window to 5s for fast fault visibility');

  safety.setDiagnosticMode(false);
  assert.equal(safety.allSensorsFaultedTimeoutSec, 45,
    'leaving diagnostic mode must restore the operator-configured value, not the constants default');
});

test('heartbeat watchdog fires when heartbeats stop', () => {
  const k = makeKiln();
  safety = new SafetyMonitor(k, silentLogger);
  // Pretend the last heartbeat happened way in the past
  safety._lastHeartbeatTime = Date.now() - 60_000;
  safety._check();
  assert.match(k._stopped || '', /Heartbeat timeout/);
});

test('safety only checks when kiln is running (except watchdog)', () => {
  const k = makeKiln({ mode: 'idle' });
  k.tempSensors[0].lastReadingC = 1500;     // would normally trigger
  safety = new SafetyMonitor(k, silentLogger);
  safety._lastHeartbeatTime = Date.now();
  safety._check();
  assert.equal(k._stopped, null,
    'over-temp check should be skipped when kiln is not running');
});

test('config.safety overrides constants', () => {
  const k = makeKiln();
  k.tempSensors[0].lastReadingC = 500;      // above our custom threshold
  safety = new SafetyMonitor(k, silentLogger, {
    safety: { maxTempC: 400, maxElementOnSeconds: 5, heartbeatTimeoutMs: 1000 },
  });
  assert.equal(safety.maxTempC, 400);
  assert.equal(safety.maxElementOnSeconds, 5);
  assert.equal(safety.heartbeatTimeoutMs, 1000);
  safety._lastHeartbeatTime = Date.now();
  safety._check();
  assert.match(k._stopped || '', /Over-temp/);
});

test('healthy kiln does not trigger any stop', () => {
  const k = makeKiln();
  safety = new SafetyMonitor(k, silentLogger);
  safety._lastHeartbeatTime = Date.now();
  safety._check();
  assert.equal(k._stopped, null);
});

test('valid temp but ERROR_TEMP_SENSOR reading is skipped (not treated as over-temp)', () => {
  const k = makeKiln();
  k.tempSensors[0].lastReadingC = ERROR_TEMP_SENSOR;
  k.tempSensors[0].hasError = true;
  // The other two still working, so all-sensors-failed shouldn't fire either.
  safety = new SafetyMonitor(k, silentLogger);
  safety._lastHeartbeatTime = Date.now();
  safety._check();
  assert.equal(k._stopped, null);
});
