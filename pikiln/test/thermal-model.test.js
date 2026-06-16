'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  heatLossW, modelMaxFireRateCpHr, modelMaxCoolRateCpHr, modelTimeToCoolHrs,
  AMBIENT_C, SAFE_OPEN_C, HEAT_CAP_JK,
  setLoadKg, getLoadKg, getHeatCapJK, CERAMIC_LOAD_HEAT_CAP_JKG_K,
} = require('../lib/thermal-model');

test('heatLossW is non-negative and monotone non-decreasing above ambient', () => {
  let prev = 0;
  for (let T = AMBIENT_C; T <= 1400; T += 50) {
    const loss = heatLossW(T);
    assert.ok(loss >= 0, `loss negative at ${T}°C: ${loss}`);
    assert.ok(loss >= prev, `loss decreased at ${T}°C (was ${prev}, now ${loss})`);
    prev = loss;
  }
});

test('heatLossW returns 0 at and below ambient (no extrapolation artifacts)', () => {
  assert.equal(heatLossW(AMBIENT_C), 0);
  assert.equal(heatLossW(0), 0);
  assert.equal(heatLossW(-50), 0);
  assert.equal(heatLossW(NaN), 0);
});

test('heatLossW matches the empty-kiln calibration anchors (2026-06-12)', () => {
  // Direct hold-loss measurements from the empty-kiln calibration firing.
  // Fit residuals at these three anchors must stay under ~5% so future
  // tweaks to the polynomial don't silently drift away from measured data.
  const anchors = [
    { T: 301, measured: 1956 },
    { T: 500, measured: 3544 },
    { T: 700, measured: 5106 },
  ];
  for (const { T, measured } of anchors) {
    const predicted = heatLossW(T);
    const err = Math.abs(predicted - measured) / measured;
    assert.ok(err < 0.05,
      `heatLossW(${T}) = ${predicted.toFixed(0)} vs measured ${measured} (${(err * 100).toFixed(1)}% off)`);
  }
});

test('heatLossW stays under element power across the firing range (cone 10 feasible)', () => {
  const elementPowerW = 3 * 240 * 16;  // 11,520 W
  // Net heating power must remain positive at cone-10 peak temps. Loss at
  // 1300°C should leave a headroom of at least ~500 W net for thermal mass.
  const loss1300 = heatLossW(1300);
  assert.ok(loss1300 < elementPowerW - 500,
    `loss at 1300°C (${loss1300.toFixed(0)} W) leaves <500 W net heating headroom`);
});

test('modelMaxFireRateCpHr is positive throughout the firing range and decreases with temp', () => {
  // At ambient, ~all 11.5 kW goes to heating → ~540°C/hr.
  // At cone 10 (~1300°C), heat loss eats ~half the power → ~270°C/hr.
  const rates = [21, 200, 500, 800, 1000, 1200, 1300].map(modelMaxFireRateCpHr);
  for (const r of rates) assert.ok(r > 0, `rate non-positive: ${r}`);
  for (let i = 1; i < rates.length; i++) {
    assert.ok(rates[i] < rates[i - 1],
      `rate did not decrease: ${rates[i - 1]} → ${rates[i]} (idx ${i})`);
  }
  // Sanity: at ambient, the full 11520 W goes to heating; 11520 × 3600 / 76300 ≈ 543 °C/hr.
  assert.ok(Math.abs(rates[0] - 543) < 3,
    `ambient max-rate should be ≈543 °C/hr (got ${rates[0].toFixed(0)})`);
});

test('modelMaxCoolRateCpHr is 0 at ambient and rises with temp', () => {
  assert.equal(modelMaxCoolRateCpHr(AMBIENT_C), 0);
  assert.equal(modelMaxCoolRateCpHr(0), 0);
  const rates = [50, 100, 200, 500, 1000, 1200].map(modelMaxCoolRateCpHr);
  for (let i = 1; i < rates.length; i++) {
    assert.ok(rates[i] > rates[i - 1],
      `cool rate did not increase: ${rates[i - 1]} → ${rates[i]} (idx ${i})`);
  }
});

test('modelTimeToCoolHrs: already cool → 0', () => {
  assert.equal(modelTimeToCoolHrs(SAFE_OPEN_C), 0);
  assert.equal(modelTimeToCoolHrs(SAFE_OPEN_C - 5), 0);
  assert.equal(modelTimeToCoolHrs(21), 0);
});

test('modelTimeToCoolHrs: from cone 6 peak is a sane upper bound', () => {
  // Cone 6 ≈ 1222°C peak. The model represents natural cool-down with no fan
  // and a closed lid — a worst case. The L&L heat-loss polynomial fits the
  // firing range well but underestimates cooling near ambient (it relies on
  // a K=2 W/K linear floor below ~150°C). Real cool-down with the vent fan
  // running or the lid cracked is much faster — usually 6–14 hours from
  // cone 6 — but the operator still gets a conservative ceiling estimate
  // until we replace this with a per-kiln fit from perf-log data.
  const hrs = modelTimeToCoolHrs(1222);
  assert.ok(hrs > 6 && hrs < 48,
    `cone-6 natural cool-down should be 6–48 h (got ${hrs.toFixed(1)} h)`);
});

test('modelTimeToCoolHrs is monotone in starting temperature', () => {
  let prev = 0;
  for (const T of [100, 200, 500, 800, 1000, 1200]) {
    const h = modelTimeToCoolHrs(T);
    assert.ok(h >= prev, `time-to-cool regressed: T=${T}, prev=${prev}, h=${h}`);
    prev = h;
  }
});

test('modelTimeToCoolHrs slows dramatically near ambient (the tail is most of the time)', () => {
  // Cooling from 1000°C: most of the heat-loss budget is near peak, but the
  // last 100°C above ambient takes a disproportionate share of the time
  // because the heat-loss rate has fallen off. Verify that the "second
  // half" (500°C → 49°C) takes more time than the "first half" (1000°C →
  // 500°C). This is the property that makes "time to cool" interesting —
  // it's not linear, and the operator's intuition about it is often wrong.
  const upper = modelTimeToCoolHrs(1000) - modelTimeToCoolHrs(500);
  const lower = modelTimeToCoolHrs(500);
  assert.ok(lower > upper,
    `lower half should take longer than upper (upper=${upper.toFixed(1)}h, lower=${lower.toFixed(1)}h)`);
});

test('setLoadKg: bumps effective heat capacity by load × ceramic specific heat', () => {
  setLoadKg(0);
  assert.equal(getHeatCapJK(), HEAT_CAP_JK);     // empty: bare-brick baseline
  setLoadKg(20);
  assert.equal(getLoadKg(), 20);
  assert.equal(getHeatCapJK(), HEAT_CAP_JK + 20 * CERAMIC_LOAD_HEAT_CAP_JKG_K);
  // Clamp at upper bound (100 kg)
  setLoadKg(200);
  assert.equal(getLoadKg(), 100);
  // Clamp at lower bound (0)
  setLoadKg(-5);
  assert.equal(getLoadKg(), 0);
  // Reset for other tests
  setLoadKg(0);
});

test('load increase slows the modeled cool rate', () => {
  setLoadKg(0);
  const emptyRate  = modelMaxCoolRateCpHr(500);
  setLoadKg(40);
  const loadedRate = modelMaxCoolRateCpHr(500);
  assert.ok(loadedRate < emptyRate,
    `loaded kiln should cool slower (empty=${emptyRate.toFixed(0)} C/hr, loaded=${loadedRate.toFixed(0)})`);
  // Ratio should match the heat-cap ratio
  const expected = emptyRate * HEAT_CAP_JK / getHeatCapJK();
  assert.ok(Math.abs(loadedRate - expected) < 0.01);
  setLoadKg(0);
});
