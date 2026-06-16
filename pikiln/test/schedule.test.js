'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Schedule } = require('../lib/schedule');
const { f2c, c2f } = require('../lib/constants');

// Helper: tiny Fahrenheit schedule, 200°F/hr to 1000°F, no hold.
function mkSchedule(extra = {}) {
  return new Schedule({
    title: 'test',
    'units-temp': '°F',
    'units-rate': '°F/hr',
    'units-hold': 'min',
    cone: '6',
    segments: [{ rate: 200, temp: 1000, hold: 0, fanon: false, note: '' }],
    ...extra,
  });
}

test('schedule stores rates and temps internally in Celsius', () => {
  const s = mkSchedule();
  // 1000°F is 537.78°C; 200°F/hr is 111.11°C/hr.
  assert.ok(Math.abs(s.temps[0] - f2c(1000)) < 0.01);
  assert.ok(Math.abs(s.rates[0] - (200 * 5 / 9)) < 0.01);
});

test('targetTempC: first call initializes start state and returns starting temp', () => {
  const s = mkSchedule();
  const target = s.targetTempC(f2c(70));      // start at 70°F
  // Right at start, target equals the start temp (no time has elapsed)
  assert.ok(Math.abs(target - f2c(70)) < 1);
  assert.notEqual(s._startTime, 0);
});

test('targetTempC: target ramps over time at the configured rate', () => {
  const s = mkSchedule();
  s.targetTempC(f2c(70));                     // initialize
  // Pretend 30 minutes has elapsed. 200°F/hr × 0.5h = 100°F rise → target ≈ 170°F.
  s._startTime -= 30 * 60 * 1000;
  s._segmentStartTime = s._startTime;
  const t = s.targetTempC(f2c(70));
  assert.ok(Math.abs(c2f(t) - 170) < 2,
    `expected ~170°F, got ${c2f(t).toFixed(1)}°F`);
});

test('targetTempC: -1 when schedule is complete', () => {
  const s = mkSchedule();
  s.currentSegment = s.noSegments;            // simulate end-of-schedule
  assert.equal(s.targetTempC(f2c(70)), -1);
});

test('multi-segment ramp advances when target temp is reached', () => {
  const s = new Schedule({
    title: 'multi',
    'units-temp': '°F',
    'units-rate': '°F/hr',
    cone: '6',
    segments: [
      { rate: 500, temp: 200, hold: 0 },      // segment 0: → 200°F fast
      { rate: 300, temp: 1000, hold: 0 },     // segment 1: → 1000°F
    ],
  });
  // Initialize at 70°F
  s.targetTempC(f2c(70));
  // Make a lot of time pass and report we've reached 200°F
  s._startTime -= 2 * 3600 * 1000;
  s._segmentStartTime = s._startTime;
  s.targetTempC(f2c(200));                    // should advance segment
  assert.equal(s.currentSegment, 1,
    `expected to advance to segment 1, still on ${s.currentSegment}`);
});

test('cool-down segment: target ramps DOWN from prev temp at the configured rate', () => {
  // Programmed cool-down. Schedule starts cold (ambient ~70°F), heats to
  // 2200°F, then commands a controlled descent to 1500°F at 100°F/hr. The
  // bug we fixed: `goingUp` used the schedule's global start (70°F) for ALL
  // segments, so segment 2's tempReached check went `2200 >= 1500 = true`
  // on the first heartbeat and advanced out of itself before any descent.
  const s = new Schedule({
    title: 'cooldown',
    'units-temp': '°F',
    'units-rate': '°F/hr',
    cone: '-',
    segments: [
      { rate: 500, temp: 2200, hold: 0 },   // ramp up
      { rate: 100, temp: 1500, hold: 0 },   // controlled descent
      { rate: 50,  temp:  500, hold: 0 },   // even slower descent
    ],
  });
  s.targetTempC(f2c(70));                    // init at ambient
  // Simulate hitting 2200°F by backdating segment-start so the ramp completes
  s._startTime -= 5 * 3600 * 1000;
  s._segmentStartTime = s._startTime;
  s.targetTempC(f2c(2200));                  // should advance to segment 1
  assert.equal(s.currentSegment, 1, 'should have advanced to cool-down segment');

  // Right now (t=0 into segment 1), target should be near segment start (2200°F)
  // and NOT immediately jump to segment 2.
  const t0 = s.targetTempC(f2c(2200));
  assert.ok(Math.abs(c2f(t0) - 2200) < 1,
    `t=0 target should be ~2200°F, got ${c2f(t0).toFixed(0)}°F`);
  assert.equal(s.currentSegment, 1, 'cool-down segment should not advance on entry');

  // 30 min into segment 1 at 100°F/hr should put target at ~2150°F
  s._segmentStartTime -= 0.5 * 3600 * 1000;
  const t30 = s.targetTempC(f2c(2195));
  assert.ok(Math.abs(c2f(t30) - 2150) < 2,
    `t=30min target should be ~2150°F (1°F/min descent), got ${c2f(t30).toFixed(0)}°F`);
  assert.equal(s.currentSegment, 1, 'cool-down segment should still be active mid-descent');

  // 7 hours in (past full duration of 7h), should have reached 1500°F and advance
  s._segmentStartTime -= 7 * 3600 * 1000;
  s.targetTempC(f2c(1500));
  assert.equal(s.currentSegment, 2, 'should advance to segment 2 once 1500°F reached');
});

test('cool-down segment: tempReached fires on descent THROUGH target, not above it', () => {
  // Direct test of the goingUp logic for a mid-schedule cool-down. With the
  // bug, this would advance immediately on entry to seg 1.
  const s = new Schedule({
    title: 'descent-only',
    'units-temp': '°F',
    'units-rate': '°F/hr',
    cone: '-',
    segments: [
      { rate: 500, temp: 2000, hold: 0 },
      { rate: 100, temp: 1500, hold: 0 },   // cool-down
    ],
  });
  s.targetTempC(f2c(70));
  s._startTime -= 5 * 3600 * 1000;
  s._segmentStartTime = s._startTime;
  s.targetTempC(f2c(2000));                  // advance to seg 1
  assert.equal(s.currentSegment, 1);

  // Kiln at 1800°F mid-descent — above 1500°F target. Should NOT advance.
  s.targetTempC(f2c(1800));
  assert.equal(s.currentSegment, 1, 'mid-descent above target should not advance');

  // Kiln at 1500°F — reached. Should advance.
  s._segmentStartTime -= 5 * 3600 * 1000;
  s.targetTempC(f2c(1500));
  assert.ok(s.currentSegment >= 2, 'descent reached should advance');
});

test('time-left: reasonable estimate for a fresh firing on a feasible schedule', () => {
  // 300 °F/hr to 2200 °F is well under the kiln's modeled ~500 °F/hr at peak,
  // so the time-left at the start should be close to the schedule's planned
  // ((2200-70)/300 = 7.1 h). Allow a 30% margin — the model caps at peak temp
  // and slightly pads the slowest segments.
  const s = new Schedule({
    title: 'feasible', cone: '-',
    'units-temp': '°F', 'units-rate': '°F/hr', 'units-hold': 'min',
    segments: [{ rate: 300, temp: 2200, hold: 0 }],
  });
  s.targetTempC(f2c(70));
  // Planned time: (2200-70)/300 = 7.1 h
  assert.ok(s.timeLeftHrs > 5 && s.timeLeftHrs < 10,
    `feasible firing should report ~7 h, got ${s.timeLeftHrs.toFixed(1)} h`);
});

test('time-left: too-aggressive ramp is capped at the kiln model maximum', () => {
  // 2000 °F/hr is well above the kiln's modeled ~270 °C/hr (~500 °F/hr) at
  // peak, so the time-left should be HIGHER than the planned (2200-70)/2000 =
  // 1.07 h — capping the rate to the model means more time.
  const s = new Schedule({
    title: 'aggressive', cone: '-',
    'units-temp': '°F', 'units-rate': '°F/hr', 'units-hold': 'min',
    segments: [{ rate: 2000, temp: 2200, hold: 0 }],
  });
  s.targetTempC(f2c(70));
  const planned = (2200 - 70) / 2000;        // ~1.07 h
  assert.ok(s.timeLeftHrs > planned * 2,
    `aggressive schedule should be capped much higher than planned (${planned.toFixed(2)} h), got ${s.timeLeftHrs.toFixed(2)} h`);
});

test('time-left: includes hold time in current segment', () => {
  // 200 °F/hr to 1000 °F + 30 min hold. Total: ~4.65 h ramp + 0.5 h hold.
  const s = new Schedule({
    title: 'with-hold', cone: '-',
    'units-temp': '°F', 'units-rate': '°F/hr', 'units-hold': 'min',
    segments: [{ rate: 200, temp: 1000, hold: 30 }],
  });
  s.targetTempC(f2c(70));
  // Should be at least the hold time plus some ramp
  assert.ok(s.timeLeftHrs > 0.5,
    `should include the 30 min hold, got ${s.timeLeftHrs.toFixed(2)} h`);
});

test('time-left: drops as kiln progresses through the segment', () => {
  const s = new Schedule({
    title: 'progress', cone: '-',
    'units-temp': '°F', 'units-rate': '°F/hr', 'units-hold': 'min',
    segments: [{ rate: 300, temp: 2000, hold: 0 }],
  });
  s.targetTempC(f2c(70));
  const atStart = s.timeLeftHrs;
  // Pretend we're halfway through
  s.targetTempC(f2c(1035));
  const atMid = s.timeLeftHrs;
  s.targetTempC(f2c(1800));
  const nearEnd = s.timeLeftHrs;
  assert.ok(atMid < atStart, `time-left should drop at mid (${atMid.toFixed(2)} < ${atStart.toFixed(2)})`);
  assert.ok(nearEnd < atMid, `time-left should drop near end (${nearEnd.toFixed(2)} < ${atMid.toFixed(2)})`);
});

test('time-left: in-hold reflects time remaining in the hold', () => {
  const s = new Schedule({
    title: 'inhold', cone: '-',
    'units-temp': '°F', 'units-rate': '°F/hr', 'units-hold': 'min',
    segments: [
      { rate: 500, temp: 500, hold: 0 },
      { rate: 200, temp: 1000, hold: 30 },
    ],
  });
  // Drive to segment 1
  s.targetTempC(f2c(70));
  s._startTime -= 3 * 3600 * 1000;
  s._segmentStartTime = s._startTime;
  s.targetTempC(f2c(500));   // advance to segment 1
  // Drive into hold
  s._segmentStartTime -= 2.6 * 3600 * 1000;
  s.targetTempC(f2c(1000));   // should enter hold
  // 5 minutes into hold, ~25 minutes left = 0.42 h
  s._holdStartTime = Date.now() - 5 * 60 * 1000;
  s.targetTempC(f2c(1000));
  assert.ok(s.timeLeftHrs > 0.3 && s.timeLeftHrs < 0.5,
    `in-hold time-left should reflect remaining hold, got ${s.timeLeftHrs.toFixed(2)} h`);
});

test('save/load roundtrip preserves segments', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
  try {
    const s = mkSchedule({ title: 'roundtrip' });
    const fp = path.join(dir, 'roundtrip.json');
    s.save(fp);
    const loaded = Schedule.loadFromFile(fp);
    assert.equal(loaded.metadata.title, 'roundtrip');
    assert.equal(loaded.noSegments, 1);
    // Both stored in F; internal C representation should match
    assert.ok(Math.abs(loaded.temps[0] - s.temps[0]) < 0.01);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadAll picks up production schedules in canonical dir', () => {
  // Sanity: the real production schedules load without throwing.
  const dir = path.join(__dirname, '..', 'data', 'schedules');
  if (!fs.existsSync(dir)) return;            // skip if not deployed
  const m = Schedule.loadAll(dir);
  assert.ok(m.size >= 1, `expected ≥1 schedule, got ${m.size}`);
  // Every loaded schedule should have a title
  for (const [title, s] of m) {
    assert.ok(title.length > 0, `schedule with empty title`);
    assert.ok(Array.isArray(s.temps));
  }
});

test('holdToCone: parsed from segment JSON and exposed on schedule', () => {
  const s = new Schedule({
    title: 't', 'units-temp': '°F', 'units-rate': '°F/hr', cone: '6',
    segments: [
      { rate: 200, temp: 1000, hold: 0 },
      { rate: 100, temp: 2200, hold: 30, holdToCone: '6' },
    ],
  });
  assert.equal(s.holdToCones[0], '');
  assert.equal(s.holdToCones[1], '6');
});

test('holdToCone: ends hold early when cone target is reached via heat work', () => {
  // Two-segment schedule: ramp to peak, then hold-to-cone-6 with a 60-min cap.
  // We don't run real time — we drive the schedule by manipulating its clocks
  // and setting maxConeIndex directly (production code computes it via
  // Arrhenius integration in kiln._doHeartbeat; here we simulate that).
  const s = new Schedule({
    title: 't', 'units-temp': '°F', 'units-rate': '°F/hr', cone: '6',
    segments: [
      { rate: 1000, temp: 2200, hold: 60, holdToCone: '6' },
    ],
  });
  s.targetTempC(f2c(2200));                  // initialize, kiln already at peak
  // Backdate so the segment-start logic sees us as "at target" and enters hold.
  s._segmentStartTime -= 60 * 60 * 1000;
  s.targetTempC(f2c(2200));                  // should enter hold
  assert.equal(s._inHold, true);
  // 5 minutes into the hold, cone target not yet met — keep holding.
  s._holdStartTime -= 5 * 60 * 1000;
  s.maxConeIndex = 95;                       // just below cone 6 (idx 96)
  s.targetTempC(f2c(2200));
  assert.equal(s._inHold, true);
  // 10 minutes in, cone 6 reached — should exit hold and complete the schedule.
  s._holdStartTime -= 5 * 60 * 1000;
  s.maxConeIndex = 96;
  const t = s.targetTempC(f2c(2200));
  assert.equal(t, -1, 'schedule should be complete after hold ends');
});

test('holdToCone: caps at max hold time when cone is never reached', () => {
  const s = new Schedule({
    title: 't', 'units-temp': '°F', 'units-rate': '°F/hr', cone: '6',
    segments: [{ rate: 1000, temp: 2200, hold: 30, holdToCone: '6' }],
  });
  s.targetTempC(f2c(2200));
  s._segmentStartTime -= 60 * 60 * 1000;
  s.targetTempC(f2c(2200));                  // enter hold
  assert.equal(s._inHold, true);
  // 31 minutes in — past the cap, cone never reached. Hold should expire.
  s._holdStartTime -= 31 * 60 * 1000;
  s.maxConeIndex = 50;                       // well below cone 6
  const t = s.targetTempC(f2c(2200));
  assert.equal(t, -1, 'schedule should advance even though cone never met');
});

test('holdToCone: plain time-only holds are unchanged when holdToCone is blank', () => {
  const s = new Schedule({
    title: 't', 'units-temp': '°F', 'units-rate': '°F/hr', cone: '6',
    segments: [{ rate: 1000, temp: 2200, hold: 15 }],
  });
  s.targetTempC(f2c(2200));
  s._segmentStartTime -= 60 * 60 * 1000;
  s.targetTempC(f2c(2200));                  // enter hold
  assert.equal(s._inHold, true);
  // Cone "reached" should NOT exit a plain time-only hold.
  s._holdStartTime -= 5 * 60 * 1000;
  s.maxConeIndex = 100;
  s.targetTempC(f2c(2200));
  assert.equal(s._inHold, true, 'plain hold ignores maxConeIndex');
  // Only the time cap ends it.
  s._holdStartTime -= 11 * 60 * 1000;
  const t = s.targetTempC(f2c(2200));
  assert.equal(t, -1);
});

test('holdToCone: round-trips through asJSON', () => {
  const s = new Schedule({
    title: 't', 'units-temp': '°F', 'units-rate': '°F/hr', cone: '6',
    segments: [
      { rate: 200, temp: 1000, hold: 0 },                   // plain
      { rate: 100, temp: 2200, hold: 30, holdToCone: '6' }, // cone-target
    ],
  });
  const json = JSON.parse(s.asJSON());
  assert.equal(json.segments[0].holdToCone, undefined,
    'plain segment should not emit holdToCone');
  assert.equal(json.segments[1].holdToCone, '6');
  assert.equal(json.segments[1].hold, 30);
});

test('°F units variant with degree symbol parses', () => {
  // Production schedules use "°F" (with the degree symbol) and the loader must
  // treat both as Fahrenheit storage.
  const s = new Schedule({
    title: 't', 'units-temp': '°F', 'units-rate': '°F/hr', cone: '6',
    segments: [{ rate: 200, temp: 1000, hold: 0 }],
  });
  assert.ok(Math.abs(s.temps[0] - f2c(1000)) < 0.01);
});
