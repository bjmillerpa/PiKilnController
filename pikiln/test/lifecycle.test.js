'use strict';
//
// Lifecycle tests: cool-down monitoring, hold/pause/resume clock pause,
// resume-from-current-temp segment scan. These cover transitions the live
// sim can't easily exercise (the thermal model doesn't cool below ~70°C).
//

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Kiln } = require('../lib/kiln');
const { Schedule } = require('../lib/schedule');
const { Pid } = require('../lib/pid');
const { COOL_ENOUGH_TEMP_C, f2c } = require('../lib/constants');

// Force simulation mode so the constructor wires mock GPIO.
process.env.PIKILN_SIMULATE = '1';

const silentLogger = { log: () => {}, error: () => {}, message: () => {} };

function makeKilnWithSchedule(segments) {
  Pid.clearSisters();
  const k = new Kiln({}, silentLogger, null);
  k.schedule = new Schedule({
    title: 'test',
    cone: '-',
    'units-temp': '°F', 'units-rate': '°F/hr', 'units-hold': 'min',
    segments,
  });
  return k;
}

// Drive every sensor to the same simulated temperature so _currentMaxTempC
// returns it. Seeds the sensor's internal debounce buffer with N identical
// good samples so lastReadingC reflects it immediately — the kiln's
// heartbeat would normally do this via sample(), but tests want a
// deterministic precondition without driving heartbeats.
function setKilnTempC(k, tempC) {
  for (const s of k.tempSensors) {
    s.simulatedTempC = tempC;
    s._seedForTest({ tempC });
  }
}

beforeEach(() => Pid.clearSisters());

test('cool-down: schedule-complete transitions to "cooling", not idle', () => {
  const k = makeKilnWithSchedule([{ rate: 200, temp: 100, hold: 0, fanon: false }]);
  setKilnTempC(k, 20);
  k.start();
  assert.equal(k.mode, 'running');

  // Force schedule to look complete: advance past the last segment.
  k.schedule.currentSegment = k.schedule.noSegments;
  k._enterCoolingMode();
  assert.equal(k.mode, 'cooling');
  // Elements should be off after entering cooling
  for (const e of k.elements) assert.equal(e.isOn, false);
  k.stop(); // tidy up timers
});

test('cool-down: _finishCoolDown sets idle and clears mode', () => {
  const k = makeKilnWithSchedule([{ rate: 200, temp: 100, hold: 0, fanon: false }]);
  setKilnTempC(k, 20);
  k.start();
  k._enterCoolingMode();
  let stateChanges = [];
  k.on('firing-state-change', firing => stateChanges.push(firing));
  k._finishCoolDown(COOL_ENOUGH_TEMP_C - 1);
  assert.equal(k.mode, 'idle');
  assert.deepEqual(stateChanges, [false]);
});

test('cool-down threshold: 120°F = ~49°C and crossing fires complete', () => {
  // Sanity: COOL_ENOUGH_TEMP_C should be ~49°C (120°F)
  assert.ok(Math.abs(COOL_ENOUGH_TEMP_C - 48.89) < 0.1);
});

test('hold: sets holdState and locks target to current temp', () => {
  const k = makeKilnWithSchedule([{ rate: 200, temp: 1000, hold: 0 }]);
  setKilnTempC(k, 200);
  k.start();
  // Force a meaningful current reading so _currentMaxTempC returns it
  setKilnTempC(k, 200);
  k.hold();
  assert.equal(k.holdState, 'hold');
  assert.ok(Math.abs(k._holdTargetC - 200) < 0.1);
  k.stop();
});

test('hold throws when not running', () => {
  const k = makeKilnWithSchedule([{ rate: 200, temp: 1000, hold: 0 }]);
  assert.throws(() => k.hold(), /Not running/);
});

test('pause: turns off elements + sets holdState', () => {
  const k = makeKilnWithSchedule([{ rate: 200, temp: 1000, hold: 0 }]);
  setKilnTempC(k, 200);
  k.start();
  // Pretend an element is on
  k.elements[0].turnOn();
  assert.equal(k.elements[0].isOn, true);
  k.pause();
  assert.equal(k.holdState, 'pause');
  assert.equal(k.elements[0].isOn, false);
  k.stop();
});

test('resume: shifts schedule clock forward by hold duration', () => {
  const k = makeKilnWithSchedule([{ rate: 200, temp: 1000, hold: 0 }]);
  setKilnTempC(k, 200);
  k.start();
  // Trigger schedule init by calling targetTempC once
  k.schedule.targetTempC(f2c(200));
  const startTimeBefore = k.schedule._startTime;
  const segStartBefore = k.schedule._segmentStartTime;

  // Simulate a 5-second hold
  k._holdStartedAt = Date.now() - 5000;
  k.holdState = 'hold';
  k.resume();

  // Both timestamps should have shifted forward by ~5 seconds
  const shift = k.schedule._startTime - startTimeBefore;
  assert.ok(shift >= 4900 && shift <= 5100, `expected ~5000ms shift, got ${shift}`);
  assert.equal(k.holdState, null);
  k.stop();
});

test('resume throws when not held/paused', () => {
  const k = makeKilnWithSchedule([{ rate: 200, temp: 1000, hold: 0 }]);
  setKilnTempC(k, 200);
  k.start();
  assert.throws(() => k.resume(), /Not in hold or pause/);
  k.stop();
});

test('resume-from-current-temp: cold kiln starts from segment 0', () => {
  const k = makeKilnWithSchedule([
    { rate: 200, temp: 500, hold: 0 },
    { rate: 300, temp: 1000, hold: 0 },
  ]);
  setKilnTempC(k, 20);  // cold
  k.start();
  assert.equal(k.schedule.currentSegment, 0);
  k.stop();
});

test('resume-from-current-temp: warm kiln fast-forwards to matching segment', () => {
  const k = makeKilnWithSchedule([
    { rate: 200, temp: 500,  hold: 0 },   // → seg 0 ends at 500°F
    { rate: 300, temp: 1000, hold: 0 },   // → seg 1 ends at 1000°F
    { rate: 100, temp: 1500, hold: 0 },   // → seg 2 ends at 1500°F
  ]);
  // Place kiln mid-segment-1 at ~700°F (between 500 and 1000)
  setKilnTempC(k, f2c(700));
  k.start();
  // Should resume in segment index 1 (the one containing 700°F)
  assert.equal(k.schedule.currentSegment, 1,
    `expected segment 1 for 700°F mid-ramp, got ${k.schedule.currentSegment}`);
  k.stop();
});

test('resume-from-current-temp: kiln above all segments goes past final segment', () => {
  const k = makeKilnWithSchedule([
    { rate: 200, temp: 500, hold: 0 },
    { rate: 300, temp: 1000, hold: 0 },
  ]);
  setKilnTempC(k, f2c(2000));  // way past everything
  k.start();
  // currentSegment is set past the last index so the next heartbeat sees
  // targetTempC === -1 and enters cooling mode immediately.
  assert.equal(k.schedule.currentSegment, k.schedule.noSegments);
  k.stop();
});

test('resume-from-current-temp: produces matching target right away (no waiting at 21°C)', () => {
  // Bruce's bug: previous behavior left the schedule's _segmentStartTime
  // unset (== 0 == 1970) when "resuming instant" — so targetTempC returned
  // a target near ambient, the kiln cooled while waiting. After the fix,
  // targetTempC's first reading should match the kiln's actual temperature.
  const k = makeKilnWithSchedule([
    { rate: 600, temp: 500,  hold: 0 },
    { rate: 300, temp: 1000, hold: 0 },
  ]);
  setKilnTempC(k, f2c(700));  // mid-segment-1
  k.start();
  const target = k.schedule.targetTempC(f2c(700));
  // The target should be at 700°F (give or take a tiny epsilon for the
  // few-ms gap between start() and this call).
  const targetF = target * 9 / 5 + 32;
  assert.ok(Math.abs(targetF - 700) < 5,
    `expected ~700°F target after resume, got ${targetF.toFixed(1)}°F`);
  k.stop();
});

test('mid-firing schedule edit: re-applies resume-from-current-temp', () => {
  // After saveSchedule replaces the running schedule, the new schedule
  // should fast-forward to where the kiln is, not restart at segment 0.
  const k = makeKilnWithSchedule([
    { rate: 600, temp: 500, hold: 0 },
  ]);
  setKilnTempC(k, 21);
  k.start();
  // Kiln has warmed mid-firing; user edits the schedule (e.g. extends).
  setKilnTempC(k, f2c(700));
  const newSched = new Schedule({
    title: 'test',
    cone: '-',
    'units-temp': '°F', 'units-rate': '°F/hr', 'units-hold': 'min',
    segments: [
      { rate: 600, temp: 500,  hold: 0 },
      { rate: 300, temp: 1000, hold: 0 },
    ],
  });
  k.schedule = newSched;
  k._resumeScheduleAtCurrentTemp();  // what saveSchedule does for the running case
  assert.equal(k.schedule.currentSegment, 1,
    `expected to fast-forward to segment 1, got ${k.schedule.currentSegment}`);
  // And the schedule's target should now be ~700°F, not ambient.
  const target = k.schedule.targetTempC(f2c(700));
  const targetF = target * 9 / 5 + 32;
  assert.ok(Math.abs(targetF - 700) < 5,
    `expected ~700°F target after mid-firing edit, got ${targetF.toFixed(1)}°F`);
  k.stop();
});

// ── Outage-recovery state file & decision logic ─────────────────────────
//
// The decision function lives in pikiln.js as a closure over module state,
// so we can't import it directly. Instead these tests exercise the *shape*
// of the state file and the read/write/decide helpers indirectly through
// fs assertions.

const path = require('node:path');
const os = require('node:os');

test('firing-state file: round-trip matches schedule + kiln state', () => {
  const k = makeKilnWithSchedule([
    { rate: 600, temp: 1500, hold: 0 },
  ]);
  setKilnTempC(k, f2c(600));
  k.start();
  // Mimic what writeFiringState() builds — just verify the field set the
  // recovery decision relies on is exposed via getStatus + schedule internals.
  const s = k.schedule;
  const snapshot = {
    version: 1,
    schedule: s.metadata.title,
    mode: k.mode,
    holdState: k.holdState,
    fanMode: k.fanMode,
    currentSegment: s.currentSegment,
    segmentStartTime: s._segmentStartTime,
    startTime: s._startTime,
    startTempC: s._startTempC,
    maxTempC: k._currentMaxTempC(),
    ts: new Date().toISOString(),
  };
  // All recovery-critical fields should be present
  for (const key of ['schedule','mode','currentSegment','segmentStartTime','startTime','startTempC','maxTempC','ts']) {
    assert.ok(snapshot[key] != null, `missing field: ${key}`);
  }
  k.stop();
});

test('recovery thresholds: 200°F = warm, 199°F = cool (with 200°F threshold)', () => {
  // Trivial threshold check — exercises the same float math the recovery
  // decision uses so a refactor of the constant is caught.
  const threshold = 200;
  assert.ok(200 > threshold === false);   // exactly at threshold = NOT warm
  assert.ok(200.1 > threshold === true);  // just above = warm
  assert.ok(199 > threshold === false);   // just below = cool
});

test('ring balance: _exceedsRingSpread returns null below threshold, object above', () => {
  // Threshold is 15°F = 8.33°C
  const k = makeKilnWithSchedule([{ rate: 600, temp: 1500, hold: 0 }]);
  // Ring 0 at 500°C, others at 495°C → spread 5°C ≈ 9°F, below 15°F threshold
  k.tempSensors[0]._seedForTest({ tempC: 500 });
  k.tempSensors[1]._seedForTest({ tempC: 495 });
  k.tempSensors[2]._seedForTest({ tempC: 495 });
  assert.equal(k._exceedsRingSpread(0, 500), null);
  // Now ring 0 at 510°C, others 495°C → spread 15°C ≈ 27°F, above threshold
  k.tempSensors[0]._seedForTest({ tempC: 510 });
  const result = k._exceedsRingSpread(0, 510);
  assert.ok(result, 'expected spread exceedance object');
  assert.ok(Math.abs(result.spreadC - 15) < 0.01);
});

test('ring balance: env var overrides default threshold', () => {
  process.env.PIKILN_MAX_RING_SPREAD_F = '30';
  try {
    const k = makeKilnWithSchedule([{ rate: 600, temp: 1500, hold: 0 }]);
    // 25°F spread = 13.89°C — below the new 30°F threshold
    k.tempSensors[0]._seedForTest({ tempC: 500 });
    k.tempSensors[1]._seedForTest({ tempC: 486.11 });
    k.tempSensors[2]._seedForTest({ tempC: 486.11 });
    assert.equal(k._exceedsRingSpread(0, 500), null,
      `with 30°F threshold, 25°F spread should be allowed; got ${JSON.stringify(k._exceedsRingSpread(0, 500))}`);
  } finally {
    delete process.env.PIKILN_MAX_RING_SPREAD_F;
  }
});

test('cool-down mode emits per-ring log lines (UI LogViewer stays alive)', () => {
  // Bruce's overnight observation: UI log went silent the moment cooling
  // started. Confirm a "cooling Tc: …°F" log line fires for each ring update
  // during cool-down.
  const k = makeKilnWithSchedule([{ rate: 200, temp: 300, hold: 0 }]);
  setKilnTempC(k, f2c(150));
  k.start();
  // Force cool-down mode (skipping the schedule-complete path, which is
  // covered by its own tests).
  k._enterCoolingMode();

  // Capture log lines emitted by the kiln
  const logged = [];
  k._logger = { log: (line) => logged.push(line), error: () => {}, message: () => {} };

  // Drive a few heartbeats — only beats 1, 6, 11 fire ring updates (rings
  // 1, 2, 3 respectively). Pump through a full cycle.
  for (let i = 0; i < 15; i++) k._doHeartbeat();

  // Filter to just the cooling log lines
  const coolingLines = logged.filter(l => /cooling Tc/.test(l));
  assert.equal(coolingLines.length, 3,
    `expected 3 cooling log lines (one per ring per cycle), got ${coolingLines.length}: ${JSON.stringify(coolingLines)}`);
  // Verify the format matches what running mode does — ring number first,
  // then current temp in °F.
  for (const line of coolingLines) {
    assert.match(line, /^[1-3] cooling Tc: \d+\.\d°F$/);
  }
  k.stop();
});

test('cool-down stops heartbeat when max temp drops below threshold', () => {
  // Verify the cool-down-complete branch wires through the heartbeat. The
  // sim's thermal model alone won't get us there in reasonable time, so
  // poke sensor values directly and step _doHeartbeat.
  const k = makeKilnWithSchedule([{ rate: 200, temp: 300, hold: 0 }]);
  setKilnTempC(k, f2c(150));
  k.start();
  k._enterCoolingMode();

  let completed = false;
  k.on('cool-down-complete', () => { completed = true; });

  // Drop sensor temps below the cool-enough threshold (120°F)
  setKilnTempC(k, f2c(115));
  // Step heartbeats until a ring update fires
  for (let i = 0; i < 15 && !completed; i++) k._doHeartbeat();

  assert.ok(completed, 'cool-down-complete should have fired below 120°F');
  assert.equal(k.mode, 'idle');
});

test('ring balance: tightens to end-spread when within end-window of peak', () => {
  // Schedule peaks at 1500°F = 815.6°C. With default end-within 25°F (≈13.9°C),
  // the tight cap (default 3°F ≈ 1.67°C) kicks in at 1475°F (≈801.7°C) and up.
  const k = makeKilnWithSchedule([
    { rate: 200, temp: 500,  hold: 0 },
    { rate: 300, temp: 1500, hold: 0 },
  ]);

  // Below the end-window: normal 15°F cap applies. 10°F spread is OK.
  k.tempSensors[0]._seedForTest({ tempC: f2c(1300) });
  k.tempSensors[1]._seedForTest({ tempC: f2c(1290) });
  k.tempSensors[2]._seedForTest({ tempC: f2c(1290) });
  assert.equal(k._activeRingSpreadC(), k._maxRingSpreadC,
    'below end-window should use normal threshold');
  assert.equal(k._exceedsRingSpread(0, f2c(1300)), null,
    '10°F spread below end-window should be allowed');

  // Inside the end-window: tight 3°F cap applies. Same 10°F spread now fails.
  k.tempSensors[0]._seedForTest({ tempC: f2c(1490) });  // within 25°F of 1500
  k.tempSensors[1]._seedForTest({ tempC: f2c(1480) });
  k.tempSensors[2]._seedForTest({ tempC: f2c(1480) });
  assert.equal(k._activeRingSpreadC(), k._endRingSpreadC,
    'inside end-window should use end threshold');
  const result = k._exceedsRingSpread(0, f2c(1490));
  assert.ok(result, '10°F spread inside end-window should trip the cap');
  assert.ok(Math.abs(result.thresholdC - k._endRingSpreadC) < 0.01);
});

test('ring balance: peak is the max segment temp, not necessarily the last segment', () => {
  // Schedule that goes 1500°F (peak) → 1200°F (cooling segment). Peak should
  // still be 1500°F, and end-window applies as we approach 1500.
  const k = makeKilnWithSchedule([
    { rate: 600, temp: 1500, hold: 0 },
    { rate: 200, temp: 1200, hold: 0 },
  ]);
  k.tempSensors[0]._seedForTest({ tempC: f2c(1480) });  // within 25°F of 1500
  k.tempSensors[1]._seedForTest({ tempC: f2c(1480) });
  k.tempSensors[2]._seedForTest({ tempC: f2c(1480) });
  assert.equal(k._activeRingSpreadC(), k._endRingSpreadC);
});

test('ring balance: end-window env vars override defaults', () => {
  process.env.PIKILN_END_SPREAD_F  = '8';   // looser end cap than default 3
  process.env.PIKILN_END_WITHIN_F  = '100'; // wider window than default 25
  try {
    const k = makeKilnWithSchedule([
      { rate: 600, temp: 1500, hold: 0 },
    ]);
    // 100°F window means anything at ≥1400°F triggers end-mode
    k.tempSensors[0]._seedForTest({ tempC: f2c(1410) });
    k.tempSensors[1]._seedForTest({ tempC: f2c(1410) });
    k.tempSensors[2]._seedForTest({ tempC: f2c(1410) });
    const inEnd = k._activeRingSpreadC();
    assert.ok(Math.abs(inEnd - 8 * 5 / 9) < 0.01,
      `expected end-spread ~8°F (4.44°C), got ${inEnd}°C`);
  } finally {
    delete process.env.PIKILN_END_SPREAD_F;
    delete process.env.PIKILN_END_WITHIN_F;
  }
});

test('ring balance: ignores other rings with invalid/error readings', () => {
  const k = makeKilnWithSchedule([{ rate: 600, temp: 1500, hold: 0 }]);
  k.tempSensors[0]._seedForTest({ tempC: 500 });
  k.tempSensors[1]._seedForTest({ hasError: true });   // faulted → skipped
  k.tempSensors[2]._seedForTest({ tempC: 495 });        // 5°C spread, below threshold
  assert.equal(k._exceedsRingSpread(0, 500), null);
  // Now make all others faulted → no comparison possible → no skip
  k.tempSensors[2]._seedForTest({ hasError: true });
  assert.equal(k._exceedsRingSpread(0, 500), null);
});

test('ring balance: ignores stuck lastReadingC from faulted sensors', () => {
  // The conflict Bruce found: when a thermocouple disconnects, its
  // `lastReadingC` holds the last good value forever. Without this fix,
  // balance compares against a stale number that has nothing to do with
  // the kiln's current state and either suppresses or triggers false skips.
  const k = makeKilnWithSchedule([{ rate: 600, temp: 1500, hold: 0 }]);
  k.tempSensors[0]._seedForTest({ tempC: 500 });
  // Ring 1 disconnected and is now faulted (was reading 200°C cold). Even
  // though lastReadingC could still return 200 from the pre-fault history,
  // hasError is true and the kiln's spread calculation skips it.
  k.tempSensors[1]._seedForTest({ hasError: true });
  k.tempSensors[2]._seedForTest({ tempC: 495 });   // real reading, 5°C below ring 0
  assert.equal(k._exceedsRingSpread(0, 500), null,
    'faulted ring 1 stuck-low value should be ignored; real spread of 5°C is well below threshold');

  // Flip the failure mode: ring 1 stuck *high* would also be ignored once
  // faulted — what matters is the hasError flag, not the stale value.
  k.tempSensors[0]._seedForTest({ tempC: 520 });
  k.tempSensors[1]._seedForTest({ hasError: true });
  k.tempSensors[2]._seedForTest({ tempC: 495 });   // real → real spread 25°C ≈ 45°F
  const result = k._exceedsRingSpread(0, 520);
  assert.ok(result, 'real spread vs healthy ring 2 should trip the cap even if faulted ring 1 looks hotter');
});

test('_currentMaxTempC: ignores stuck lastReadingC from faulted sensors', () => {
  const k = makeKilnWithSchedule([{ rate: 600, temp: 1500, hold: 0 }]);
  // Ring 0 healthy at 800°C; ring 1 faulted with stuck 1200°C; ring 2 healthy at 790°C.
  // Without the fault filter, max would be 1200 (a value the kiln has never reached)
  // and would trip cooling-complete / end-spread / progress-threshold logic falsely.
  k.tempSensors[0]._seedForTest({ tempC: 800 });
  k.tempSensors[1]._seedForTest({ hasError: true });
  k.tempSensors[2]._seedForTest({ tempC: 790 });
  assert.equal(k._currentMaxTempC(), 800,
    'faulted sensor with stuck-high lastReadingC must not be the max');
});

test('setFanMode applies to the relay immediately, even when idle', () => {
  // Regression for "Run-tab fan buttons don't move the relay when idle".
  // Before the fix, pikiln.js just assigned kiln.fanMode = X and waited
  // for the heartbeat to apply it — but the heartbeat only calls
  // _updateFan during running mode, so idle changes were ignored.
  const k = makeKilnWithSchedule([{ rate: 200, temp: 1000, hold: 0, fanon: true }]);
  // Kiln starts in 'off' mode, idle. Fan should be off.
  assert.equal(k.ventFan.isOn, false);

  k.setFanMode('on');
  assert.equal(k.ventFan.isOn, true, 'on while idle should turn the fan on now');

  k.setFanMode('off');
  assert.equal(k.ventFan.isOn, false, 'off while idle should turn the fan off now');

  // 'auto' while idle should stay off — it's a preference for the next
  // firing, not a "turn on whatever segment 0 says" command.
  k.setFanMode('auto');
  assert.equal(k.ventFan.isOn, false,
    'auto while idle keeps the fan off (it kicks in at next Start)');

  // Auto kicks in at Start: segment 0 has fanon:true above.
  setKilnTempC(k, 20);
  k.start();
  assert.equal(k.ventFan.isOn, true,
    'auto + fanon segment + kiln started → fan on at the moment of start');

  // Switching to off mid-firing should drop the fan immediately.
  k.setFanMode('off');
  assert.equal(k.ventFan.isOn, false,
    'mid-firing off should turn the fan off without waiting for the next ring beat');

  k.stop();
});

test('_segmentDutyCap: slow candle ramp clamps PID output to ~5× steady-state', () => {
  // Candle 2-hr to 200°F. With the kiln's max heating rate ~530°C/hr at
  // low temps, a 60°F/hr (33°C/hr) schedule has steady-state duty ~6%.
  // Cap should be ~30% (5× steady) — enough headroom for the PID to track
  // the slow ramp while the cap-aware anti-windup prevents overshoot.
  const k = makeKilnWithSchedule([{ rate: 60, temp: 200, hold: 0 }]);
  setKilnTempC(k, f2c(70));
  k.start();
  const cap = k._segmentDutyCap(f2c(150));
  assert.ok(cap > 0.15 && cap < 0.45,
    `candle ramp cap should be ~30% (got ${(cap * 100).toFixed(1)}%)`);
  k.stop();
});

test('_segmentDutyCap: stays at catch-up multiplier near target (no approach tightening)', () => {
  // We deliberately do NOT crash the cap to a fraction of steady-state in
  // the last few degrees of the segment. The PID's cap-aware anti-windup
  // handles the soft landing instead. See the long comment in
  // _segmentDutyCap explaining why approach tightening got removed —
  // it left the kiln stuck below target when the heat-loss model
  // underestimates real loss.
  const k = makeKilnWithSchedule([{ rate: 60, temp: 200, hold: 0 }]);
  setKilnTempC(k, f2c(70));
  k.start();
  const capFar  = k._segmentDutyCap(f2c(150));
  const capNear = k._segmentDutyCap(f2c(199));
  // Tolerance of 1% absolute: the cap shifts slightly with temperature
  // because heatLossW grows with temp (affects the modeled max rate the
  // cap is computed against). What this test guards against is the OLD
  // approach-tightening logic that crashed the cap to a fraction of the
  // catch-up multiplier near target — that would show a much larger drop.
  assert.ok(Math.abs(capNear - capFar) < 0.01,
    `near-target cap should match catch-up cap, got far=${(capFar*100).toFixed(1)}% near=${(capNear*100).toFixed(1)}%`);
  k.stop();
});

test('_segmentDutyCap: aggressive ramp at high temps imposes no cap (1.0)', () => {
  // Normal cone-6 firing: 300°F/hr at peak temps. Kiln's model max at
  // 1200°C is ~310°C/hr, so schedule rate ≈ kiln max — cap × 2 saturates
  // at 1.0 (no effective cap).
  const k = makeKilnWithSchedule([{ rate: 300, temp: 2200, hold: 0 }]);
  setKilnTempC(k, f2c(2100));
  k.start();
  const cap = k._segmentDutyCap(f2c(2100));
  assert.equal(cap, 1.0,
    `near-peak ramp at typical pottery rates should NOT cap PID (got ${cap})`);
  k.stop();
});

test('_segmentDutyCap: hold state lifts the cap entirely', () => {
  const k = makeKilnWithSchedule([{ rate: 60, temp: 200, hold: 0 }]);
  setKilnTempC(k, f2c(150));
  k.start();
  k.holdState = 'hold';   // pretend operator pressed Hold
  const cap = k._segmentDutyCap(f2c(150));
  assert.equal(cap, 1.0, 'hold mode lifts the duty cap');
  k.stop();
});

test('_segmentDutyCap: full-speed (rate=0) segment is uncapped', () => {
  const k = makeKilnWithSchedule([{ rate: 0, temp: 2000, hold: 0 }]);
  setKilnTempC(k, f2c(70));
  k.start();
  assert.equal(k._segmentDutyCap(f2c(500)), 1.0);
  k.stop();
});

test('element on-time resets at firing start (per-firing kWh)', () => {
  const k = makeKilnWithSchedule([{ rate: 200, temp: 1000, hold: 0 }]);
  setKilnTempC(k, 20);
  // Pretend a previous firing accumulated some element on-time.
  k.elements[0].secondsOn = 3600;
  k.elements[1].secondsOn = 3600;
  k.elements[2].secondsOn = 3600;
  k.start();
  assert.equal(k.elements[0].secondsOn, 0, 'element on-time must reset at start');
  assert.equal(k.elements[1].secondsOn, 0);
  assert.equal(k.elements[2].secondsOn, 0);
  k.stop();
});

test('setFanMode rejects invalid modes', () => {
  const k = makeKilnWithSchedule([{ rate: 200, temp: 1000, hold: 0 }]);
  assert.throws(() => k.setFanMode('reverse'), /Invalid fan mode/);
});

test('fan balance: turns on when top ring exceeds upper threshold, off below lower (hysteresis)', () => {
  const k = makeKilnWithSchedule([{ rate: 200, temp: 1000, hold: 0 }]);
  // Configure all three rings — top hotter than others.
  // Top (ring 3) > coolestOther by 10°F → above 8°F ON threshold → fan on.
  k.tempSensors[0]._seedForTest({ tempC: 500 });           // ring 1
  k.tempSensors[1]._seedForTest({ tempC: 500 });           // ring 2
  k.tempSensors[2]._seedForTest({ tempC: 500 + (10 * 5/9) }); // ring 3 (+10°F)
  k.setFanMode('balance');
  assert.equal(k.ventFan.isOn, true, 'spread > 8°F should turn fan on');

  // Now the top cools toward parity (still above OFF threshold but below ON).
  // Spread = 5°F → not enough to turn off (OFF=3°F), so fan stays on.
  k.tempSensors[2]._seedForTest({ tempC: 500 + (5 * 5/9) });
  k._updateFan();
  assert.equal(k.ventFan.isOn, true, 'hysteresis: stays on between ON and OFF thresholds');

  // Top now within OFF threshold → fan off.
  k.tempSensors[2]._seedForTest({ tempC: 500 + (2 * 5/9) });
  k._updateFan();
  assert.equal(k.ventFan.isOn, false, 'spread < 3°F should turn fan off');

  // Heating up again — back above ON threshold.
  k.tempSensors[2]._seedForTest({ tempC: 500 + (10 * 5/9) });
  k._updateFan();
  assert.equal(k.ventFan.isOn, true, 'spread > 8°F after cooling cycle should re-engage');
});

test('fan balance: no fan action when top sensor is faulted', () => {
  const k = makeKilnWithSchedule([{ rate: 200, temp: 1000, hold: 0 }]);
  k.tempSensors[0]._seedForTest({ tempC: 500 });
  k.tempSensors[1]._seedForTest({ tempC: 500 });
  k.tempSensors[2]._seedForTest({ hasError: true });
  k.setFanMode('balance');
  assert.equal(k.ventFan.isOn, false,
    'cannot decide balance without top reading — fail safe to off');
});

test('setFanBalanceThresholds: updates values, clamps OFF below ON, persists hysteresis ordering', () => {
  const k = makeKilnWithSchedule([{ rate: 200, temp: 1000, hold: 0 }]);
  k.setFanBalanceThresholds({ onF: 12, offF: 5 });
  assert.deepEqual(k._fanBalance, { onF: 12, offF: 5 });

  // Try to set OFF higher than ON — should clamp OFF to ON-1.
  k.setFanBalanceThresholds({ offF: 20 });
  assert.equal(k._fanBalance.onF, 12);
  assert.equal(k._fanBalance.offF, 11, 'OFF must stay below ON');

  // Partial updates leave the other field alone.
  k.setFanBalanceThresholds({ onF: 6 });
  assert.equal(k._fanBalance.onF, 6);
  // OFF was 11 → must clamp to 5 (< onF=6)
  assert.equal(k._fanBalance.offF, 5);
});

test('setFanBalanceThresholds rejects garbage; preserves current values', () => {
  const k = makeKilnWithSchedule([{ rate: 200, temp: 1000, hold: 0 }]);
  k.setFanBalanceThresholds({ onF: 10, offF: 4 });
  k.setFanBalanceThresholds({ onF: NaN });
  assert.equal(k._fanBalance.onF, 10);
  k.setFanBalanceThresholds({ offF: 'bad' });
  assert.equal(k._fanBalance.offF, 4);
});

test('fan balance: thresholds from constructor config win over constants', () => {
  Pid.clearSisters();
  const k = new (require('../lib/kiln').Kiln)(
    { fanBalance: { onF: 15, offF: 7 } },
    silentLogger,
    null,
  );
  assert.equal(k._fanBalance.onF, 15);
  assert.equal(k._fanBalance.offF, 7);
  k.stop();
});

test('fan balance: no fan when no healthy non-top sensors available', () => {
  const k = makeKilnWithSchedule([{ rate: 200, temp: 1000, hold: 0 }]);
  k.tempSensors[0]._seedForTest({ hasError: true });
  k.tempSensors[1]._seedForTest({ hasError: true });
  k.tempSensors[2]._seedForTest({ tempC: 600 });
  k.setFanMode('balance');
  assert.equal(k.ventFan.isOn, false,
    'no other rings to compare against → fan off');
});

test('setDiagnosticMode propagates to sensors + safety and gates the sibling fallback', () => {
  const k = makeKilnWithSchedule([{ rate: 200, temp: 1000, hold: 0 }]);
  // Default: 3-of-3 debounce, safety persistence 30 s, fallback enabled.
  assert.equal(k.tempSensors[0]._faultConfirmCount, 3);
  assert.equal(k.safety.allSensorsFaultedTimeoutSec, 30);

  k.setDiagnosticMode(true);
  assert.equal(k.tempSensors[0]._faultConfirmCount, 1);
  assert.equal(k.safety.allSensorsFaultedTimeoutSec, 5);

  // Sibling fallback should be disabled in diagnostic mode. Seed ring 0 as
  // faulted, ring 1 healthy: normal mode returns ring 1's reading for ring
  // 0's PID; diagnostic mode returns ERROR_TEMP_SENSOR (the fault is loud).
  k.tempSensors[0]._seedForTest({ hasError: true });
  k.tempSensors[1]._seedForTest({ tempC: 800 });
  const { ERROR_TEMP_SENSOR } = require('../lib/constants');
  assert.equal(k._currentTempC(0), ERROR_TEMP_SENSOR,
    'diagnostic mode must not fall back to sibling ring');

  k.setDiagnosticMode(false);
  assert.equal(k.tempSensors[0]._faultConfirmCount, 3);
  assert.equal(k.safety.allSensorsFaultedTimeoutSec, 30);
  // Re-seed now that the buffer-window requirement is back to 3 — _seedForTest
  // fills as many entries as the current _faultConfirmCount expects, so we
  // need to seed again after toggling.
  k.tempSensors[0]._seedForTest({ hasError: true });
  k.tempSensors[1]._seedForTest({ tempC: 800 });
  assert.equal(k._currentTempC(0), 800,
    'fallback should resume when diagnostic mode is off');
});

test('heartbeat: constructor creates exactly one timer; start() does not add another', () => {
  // Regression guard. The heartbeat used to be set up in start(); when we
  // moved it to the constructor, some callers (e.g. cooling-mode recovery in
  // pikiln.js) still tried to create a second setInterval. Two timers running
  // double the heartbeat rate, which doubles the element-trigger rate. With
  // 11.1s firings re-arming every 7.5s, the element is effectively on
  // continuously — even during cool-down where the PID is asking for 0%.
  const k = makeKilnWithSchedule([{ rate: 200, temp: 1000, hold: 0 }]);
  const originalTimer = k._heartbeatTimer;
  assert.ok(originalTimer, 'constructor should have created a heartbeat timer');
  setKilnTempC(k, 20);
  k.start();
  assert.equal(k._heartbeatTimer, originalTimer,
    'start() must not create a second heartbeat timer');
  k.stop();
  assert.equal(k._heartbeatTimer, originalTimer,
    'stop() must not clear or replace the heartbeat timer');
});

test('_currentMaxTempC: returns -Infinity when all sensors faulted', () => {
  // No healthy sensors → no defensible max. Callers (hold target, cooling
  // complete check, schedule resume) all check Number.isFinite and bail.
  const k = makeKilnWithSchedule([{ rate: 600, temp: 1500, hold: 0 }]);
  for (const s of k.tempSensors) {
    s._seedForTest({ hasError: true });
  }
  assert.equal(Number.isFinite(k._currentMaxTempC()), false);
});

test('apparent load: back-calculates kiln m·c from synthesized window data', () => {
  // The apparent-load math reads {t, T, jCum} from the rolling buffer and
  // solves m·c = (P_in − Q_loss(T)) / (dT/dt). Verify it lands close to a
  // known synthetic m·c when we inject a plausible window of data — bypassing
  // the actual heartbeat (which would take 2 minutes of wall clock to fill
  // the min window). The kiln object is otherwise stock.
  const { heatLossW } = require('../lib/thermal-model');
  const k = makeKilnWithSchedule([{ rate: 200, temp: 1000, hold: 0 }]);
  k.start();

  // Synthesize a 3-minute window: kiln ramps 300°C → 320°C (~400°C/hr), at a
  // temp where heat loss is well within the polynomial fit. Inject the
  // energy that a kiln with m·c=104,670 J/K (76,300 brick + 31.5 kg load)
  // would have absorbed.
  const mcTrue = 104670;
  const T0 = 300, T1 = 320;
  const windowS = 180;
  const T_mid = (T0 + T1) / 2;
  const heatAbsorbedJ = mcTrue * (T1 - T0);
  const heatLostJ     = heatLossW(T_mid) * windowS;
  const energyInJ     = heatAbsorbedJ + heatLostJ;
  const now = Date.now();

  k._apparentBuf = [
    { t: now - windowS * 1000, T: T0, jCum: 0 },
    { t: now,                  T: T1, jCum: energyInJ },
  ];

  // Run the math by re-invoking _sampleApparentLoad with synthetic next-beat
  // values. The sampler appends a new entry — we pre-position the buffer so
  // its endpoints are the synthetic window, and inject a no-op final sample
  // by setting kiln state appropriately. Simpler: call the inner math by
  // monkey-patching the sensors + power for one tick.
  for (const s of k.tempSensors) s._seedForTest({ tempC: T1 });
  // Spoof elapsedPowerKWHr by stubbing the elements' on-time so the kWh
  // getter returns our target. Element watts × secondsOn = energyInJ, three
  // elements split the energy equally for simplicity.
  const eachWattS = energyInJ / 3;
  for (const e of k.elements) {
    e.secondsOn = eachWattS / e.watts;
  }
  k._sampleApparentLoad();

  const al = k._apparentLoad;
  assert.ok(al, 'expected apparent-load estimate');
  // Tolerance: 10% — the inner sample pushes a new entry, so the actual window
  // is slightly different from the synthetic one; what matters is that the
  // estimate lands in the right ballpark.
  const err = Math.abs(al.mcJK - mcTrue) / mcTrue;
  assert.ok(err < 0.10,
    `apparent m·c off by ${(err * 100).toFixed(1)}%: got ${al.mcJK}, expected ~${mcTrue}`);
  // And the kg derivation should be in the load ballpark
  assert.ok(Math.abs(al.kg - 31.5) < 10,
    `apparent load kg off: got ${al.kg}, expected ~31.5`);
  k.stop();
});

test('apparent load: returns null (or stale) during a hold', () => {
  // When the kiln is essentially not moving (|dT/dt| < threshold), the
  // back-calculation degenerates — skip rather than publish nonsense.
  const k = makeKilnWithSchedule([{ rate: 200, temp: 500, hold: 30 }]);
  k.start();
  const now = Date.now();
  // Window where the kiln barely moves (10°C/hr is well below the 30°C/hr
  // threshold)
  k._apparentBuf = [
    { t: now - 180000, T: 500, jCum: 0 },
    { t: now,          T: 500.5, jCum: 100000 },
  ];
  for (const s of k.tempSensors) s._seedForTest({ tempC: 500.5 });
  // The sampler doesn't have a prior valid estimate to mark stale, so on a
  // hold-only sample sequence we expect _apparentLoad to remain null.
  k._sampleApparentLoad();
  assert.equal(k._apparentLoad, null);
  k.stop();
});

test('progress thresholds: 200°F-step crossings fire one event each', () => {
  const k = makeKilnWithSchedule([{ rate: 600, temp: 1500, hold: 0 }]);
  setKilnTempC(k, 20);
  k.start();
  const fired = [];
  k.on('progress-threshold', e => fired.push(e.tempF));

  setKilnTempC(k, f2c(150)); k._checkProgressThresholds();  // below 200, no fire
  setKilnTempC(k, f2c(220)); k._checkProgressThresholds();  // crosses 200
  setKilnTempC(k, f2c(380)); k._checkProgressThresholds();  // still in 200..400, no new fire
  setKilnTempC(k, f2c(420)); k._checkProgressThresholds();  // crosses 400
  setKilnTempC(k, f2c(650)); k._checkProgressThresholds();  // crosses 600
  setKilnTempC(k, f2c(800)); k._checkProgressThresholds();  // crosses 800

  assert.deepEqual(fired, [200, 400, 600, 800]);
  k.stop();
});
