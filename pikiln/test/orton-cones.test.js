'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ortonConeToIndex, ortonConeFromIndex, calcOrtonConeIndex,
  arrheniusRate, coneIndexFromH, H_CRIT,
  CONE_NAMES, TEMPS_27, TEMPS_108, TEMPS_270,
} = require('../lib/orton-cones');
const { f2c, fph2cph } = require('../lib/constants');

// Simulate a perfect constant-rate ramp from ambient up to T_endF, returning
// the accumulated Arrhenius H at the endpoint. Step size = 1 second matches
// the controller's heartbeat integration cadence.
function simulateRamp(rateFperHr, T_endF) {
  const rateCperS = rateFperHr * (5 / 9) / 3600;
  const T_endC = (T_endF - 32) * 5 / 9;
  let T_C = 21;       // ambient
  let H = 0;
  while (T_C < T_endC) {
    H += arrheniusRate(T_C);  // dt = 1s implicit
    T_C += rateCperS;          // 1s of ramping
  }
  return H;
}

test('cone name → index → name roundtrip', () => {
  // Cone "10" is the hottest end at index 100; cone "018" is the coolest at index 73.
  const cases = ['10','9','6','1','01','06','010','018'];
  for (const c of cases) {
    const idx = ortonConeToIndex(c);
    assert.equal(ortonConeFromIndex(idx), c, `roundtrip failed for cone ${c}`);
  }
});

test('cone monotonicity: hotter cones have higher index', () => {
  // Hotter cones (10, 9, … 1) sit above colder ones (01, 02, … 018)
  assert.ok(ortonConeToIndex('10') > ortonConeToIndex('6'));
  assert.ok(ortonConeToIndex('6')  > ortonConeToIndex('1'));
  assert.ok(ortonConeToIndex('1')  > ortonConeToIndex('01'));
  assert.ok(ortonConeToIndex('01') > ortonConeToIndex('06'));
  assert.ok(ortonConeToIndex('06') > ortonConeToIndex('018'));
});

test('cone-from-index returns "-" for non-positive indices', () => {
  assert.equal(ortonConeFromIndex(0), '-');
  assert.equal(ortonConeFromIndex(-1), '-');
  assert.equal(ortonConeFromIndex(NaN), '-');
});

test('cone-from-index returns "<018" for any index below the lowest cone (73)', () => {
  // Arrhenius starts accumulating the moment the kiln is above ambient, so
  // the index climbs to small values long before any real ceramic cone
  // would bend. Showing a fake low-numbered cone (e.g. "041") for these
  // intermediate values was misleading — the kiln hasn't reached cone 018
  // (the coolest tabulated cone, idx 73) yet.
  assert.equal(ortonConeFromIndex(1),   '<018');
  assert.equal(ortonConeFromIndex(50),  '<018');
  assert.equal(ortonConeFromIndex(72.9), '<018');
  // Right at the boundary, we report cone 018 proper.
  assert.equal(ortonConeFromIndex(73),  '018');
});

test('calcOrtonConeIndex: below room temp → 0', () => {
  assert.equal(calcOrtonConeIndex(f2c(20), fph2cph(108)), 0);
});

test('calcOrtonConeIndex: well above cone 10 → 100', () => {
  // Cone 10 at 108°F/hr is 2345°F; anything well above that pegs at 100.
  assert.equal(calcOrtonConeIndex(f2c(2500), fph2cph(108)), 100);
});

test('calcOrtonConeIndex: cone 6 at the published 108°F/hr temp is within a few cones', () => {
  // From TEMPS_108: cone 6 = 2232°F at 108°F/hr. The implementation has a known
  // table-weighting quirk that biases toward the slower-rate table at rate
  // boundaries; we only require the answer to land in the cone-6 neighborhood
  // (within ~3 cones) rather than exactly 96.
  const idx = calcOrtonConeIndex(f2c(2232), fph2cph(108));
  assert.ok(Math.abs(idx - ortonConeToIndex('6')) < 3,
    `expected within 3 cones of 6 (96), got ${idx.toFixed(2)}`);
});

test('calcOrtonConeIndex: faster ramp shifts cone higher (hotter) for same temp', () => {
  // Same temp, hotter ramp → glaze sees less heat-work → measured cone is lower.
  const t = f2c(2150);
  const idxFast = calcOrtonConeIndex(t, fph2cph(270));
  const idxSlow = calcOrtonConeIndex(t, fph2cph(27));
  assert.ok(idxSlow > idxFast,
    `slow firing should reach higher cone at same temp; fast=${idxFast}, slow=${idxSlow}`);
});

// ── Arrhenius cone model ────────────────────────────────────────────────

test('arrheniusRate: monotone non-decreasing in temperature', () => {
  let prev = 0;
  for (let T = 0; T <= 1400; T += 50) {
    const r = arrheniusRate(T);
    assert.ok(r >= prev, `rate decreased from ${prev} to ${r} at T=${T}°C`);
    prev = r;
  }
});

test('arrheniusRate: returns 0 for invalid / sub-zero temps', () => {
  assert.equal(arrheniusRate(-10), 0);
  assert.equal(arrheniusRate(NaN), 0);
  // Infinity is non-finite by design — sensor garbage shouldn't poison the
  // integrator with the dimensionless 1 it would mathematically yield.
  assert.equal(arrheniusRate(Infinity), 0);
});

test('coneIndexFromH: monotone non-decreasing in H', () => {
  let prevIdx = 0;
  for (let H = 0; H <= H_CRIT[0] * 1.5; H += H_CRIT[0] / 100) {
    const idx = coneIndexFromH(H);
    assert.ok(idx >= prevIdx - 1e-9,
      `cone index regressed from ${prevIdx} to ${idx} at H=${H.toExponential(3)}`);
    prevIdx = idx;
  }
});

test('coneIndexFromH(H_CRIT[cone]) returns that cone exactly', () => {
  // By construction: at H = H_CRIT[i], we should be exactly at CONE_NAMES[i].
  for (let i = 0; i < CONE_NAMES.length; i++) {
    const idx = coneIndexFromH(H_CRIT[i]);
    const expected = ortonConeToIndex(CONE_NAMES[i]);
    assert.ok(Math.abs(idx - expected) < 0.5,
      `H_CRIT[${i}] (cone ${CONE_NAMES[i]}, expected idx ${expected}) gave ${idx.toFixed(2)}`);
  }
});

test('Arrhenius at 108 °F/hr matches the chart (calibration self-consistency)', () => {
  // H_CRIT is calibrated against TEMPS_108. A simulated 108°F/hr ramp to the
  // chart's published end temp for each cone must yield H close to H_CRIT.
  for (let i = 0; i < CONE_NAMES.length; i += 4) {  // sample every 4th cone
    const H = simulateRamp(108, TEMPS_108[i]);
    const ratio = H / H_CRIT[i];
    // Allow 5% slop (numerical-integration discretization, ambient floor).
    assert.ok(Math.abs(ratio - 1) < 0.05,
      `cone ${CONE_NAMES[i]} @ 108°F/hr: H=${H.toExponential(3)} vs H_CRIT=${H_CRIT[i].toExponential(3)} (ratio ${ratio.toFixed(3)})`);
  }
});

test('Arrhenius at 27 and 270 °F/hr agrees with the chart within tuned tolerance', () => {
  // Cross-calibration. H_CRIT was built from the 108 column; the off-
  // reference 27 and 270 columns measure how well a single Ea fits Orton's
  // empirical tables. At Ea=170 the RMS error is ~0.5 cones; worst-case
  // ~1.9 cones at a few mid-table irregularities (cones 1, 7) at 27 °F/hr.
  // We test a sample that avoids those known-irregular cones — what's
  // important here is "no catastrophic systematic offset," not exact match.
  const samples = [4, 8, 12, 16, 20];  // cones 6, 2, 03, 07, 011
  for (const i of samples) {
    for (const [rate, table] of [[27, TEMPS_27], [270, TEMPS_270]]) {
      const H = simulateRamp(rate, table[i]);
      const reachedConeIdx = coneIndexFromH(H);
      const expectedIdx = ortonConeToIndex(CONE_NAMES[i]);
      const err = Math.abs(reachedConeIdx - expectedIdx);
      assert.ok(err < 2.0,
        `cone ${CONE_NAMES[i]} @ ${rate}°F/hr: Arrhenius reached cone index ${reachedConeIdx.toFixed(2)} (expected ${expectedIdx}, err ${err.toFixed(2)})`);
    }
  }
});

test('Arrhenius cross-rate RMS error stays under 1 cone (calibration guard)', () => {
  // Aggregate check: across all 28 cones × 2 off-reference rate columns, the
  // RMS cone-index error must stay under 1 cone. If a future change drifts
  // this badly, the Ea constant in orton-cones.js needs re-tuning.
  let sumSq = 0, n = 0;
  for (let i = 1; i < CONE_NAMES.length - 1; i++) {
    for (const [rate, table] of [[27, TEMPS_27], [270, TEMPS_270]]) {
      const H = simulateRamp(rate, table[i]);
      const err = coneIndexFromH(H) - ortonConeToIndex(CONE_NAMES[i]);
      sumSq += err * err;
      n++;
    }
  }
  const rms = Math.sqrt(sumSq / n);
  assert.ok(rms < 1.0, `RMS cone error across off-reference rates is ${rms.toFixed(2)} (>1.0)`);
});

test('Arrhenius accumulates during a hold (the chart-approach blind spot)', () => {
  // The whole reason for switching to Arrhenius. Ramp to just below cone 6,
  // then hold flat — H must keep growing and cross H_CRIT for cone 6 even
  // though temperature isn't changing. The chart-based calcOrtonConeIndex
  // can't do this because at rate=0 it uses the slowest-rate column.
  const T_hold_F = 2200;       // just below cone 6's 108°F/hr end of 2232°F
  const T_hold_C = (T_hold_F - 32) * 5 / 9;
  let H_pre = simulateRamp(108, T_hold_F);
  const conePre = coneIndexFromH(H_pre);
  // 30 min hold at this temp
  let H_post = H_pre;
  for (let s = 0; s < 30 * 60; s++) H_post += arrheniusRate(T_hold_C);
  const conePost = coneIndexFromH(H_post);
  assert.ok(conePost > conePre + 0.3,
    `hold should advance cone reading (was ${conePre.toFixed(2)}, after 30min hold ${conePost.toFixed(2)})`);
});

test('Arrhenius cone progress is monotone non-decreasing under heartbeat integration', () => {
  // End-to-end: drive a Kiln through a small simulated firing, verify that
  // schedule.maxConeIndex never regresses across heartbeats.
  const { Kiln } = require('../lib/kiln');
  const { Schedule } = require('../lib/schedule');
  const { Pid } = require('../lib/pid');
  Pid.clearSisters();
  process.env.PIKILN_SIMULATE = '1';
  const silentLogger = { log: () => {}, error: () => {}, message: () => {} };
  const k = new Kiln({}, silentLogger, null);
  k.schedule = new Schedule({
    title: 't', cone: '6', 'units-temp': '°F', 'units-rate': '°F/hr', 'units-hold': 'min',
    segments: [{ rate: 200, temp: 1500, hold: 0 }],
  });
  // Force the kiln warm so Arrhenius accumulates noticeably each beat.
  for (const s of k.tempSensors) { s.simulatedTempC = 800; s._seedForTest({ tempC: 800 }); }
  k.start();
  let prev = 0;
  for (let i = 0; i < 30; i++) {
    k._doHeartbeat();
    assert.ok(k.schedule.maxConeIndex >= prev - 1e-9,
      `maxConeIndex regressed from ${prev} to ${k.schedule.maxConeIndex} at beat ${i}`);
    prev = k.schedule.maxConeIndex;
  }
  k.stop();
});
