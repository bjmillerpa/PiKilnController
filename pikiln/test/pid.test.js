'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Pid } = require('../lib/pid');

beforeEach(() => Pid.clearSisters());

// Helper: nudge the PID's internal clock back so the next compute() sees a
// non-zero dt. Without this, ctor and compute() may land in the same ms and
// the derivative term goes to Infinity, producing NaN when kd=0.
function withDt(p, seconds) { p.lastTime = Date.now() - seconds * 1000; return p; }

test('Pid clamps output to [0, 1]', () => {
  // Huge positive error with strong P should saturate at 1
  const p = withDt(new Pid(100, 0, 0), 1);
  const out = p.compute(1000, 0);
  assert.ok(out >= 0 && out <= 1, `expected 0..1, got ${out}`);
  assert.equal(out, 1);
});

test('Pid output is 0 when actual is well above target', () => {
  const p = withDt(new Pid(5, 3, 3), 1);
  const out = p.compute(100, 200);  // we are 100° too hot
  assert.equal(out, 0);
});

test('Pid integral accumulates while error persists', () => {
  const p = new Pid(0, 10, 0);          // pure I
  // Drive at small constant error over a long time; integral should grow.
  p.lastTime = Date.now() - 10_000;     // pretend 10s elapsed
  const out1 = p.compute(50, 49);       // error = 1
  p.lastTime = Date.now() - 10_000;
  const out2 = p.compute(50, 49);
  assert.ok(out2 >= out1, `integral should accumulate (out1=${out1}, out2=${out2})`);
});

test('anti-windup: integral does not accumulate while output saturates high', () => {
  // Reproduces the cool-down overshoot bug. Drive a PID into saturation with
  // a sustained positive error (simulating climb to target). Without anti-
  // windup, the integral grows unbounded. With it, the integral is capped to
  // whatever value makes the un-clamped output ≈ 1; further saturated time
  // does not add to it.
  const p = new Pid(5, 3, 3);
  // Saturate hard for 60 simulated seconds (12 calls @ 5s each, like the
  // controller's per-ring update cadence)
  for (let i = 0; i < 12; i++) {
    p.lastTime = Date.now() - 5_000;
    p.compute(2000, 1500);   // 500° below target → saturate at 1
  }
  const integralAfterSaturation = p.integralSum;
  // Drive more saturated time and confirm integral does NOT keep growing
  for (let i = 0; i < 12; i++) {
    p.lastTime = Date.now() - 5_000;
    p.compute(2000, 1500);
  }
  assert.equal(p.integralSum, integralAfterSaturation,
    `integral must stop accumulating once saturated (was ${integralAfterSaturation}, now ${p.integralSum})`);
});

test('anti-windup: integral DOES unwind when error flips negative after saturation', () => {
  // Critical for cool-down. After a long saturated climb, the kiln reaches
  // target and error flips negative. The integral must unwind so output
  // returns to 0 within a reasonable time, not minutes later.
  const p = new Pid(5, 3, 3);
  for (let i = 0; i < 12; i++) {
    p.lastTime = Date.now() - 5_000;
    p.compute(2000, 1500);   // saturate climbing
  }
  // Now flip: kiln above target (the overshoot scenario)
  p.lastTime = Date.now() - 5_000;
  const out1 = p.compute(2000, 2010);
  // One per-ring update later
  p.lastTime = Date.now() - 5_000;
  const out2 = p.compute(2000, 2010);
  // Output should be heading toward 0 quickly. After 2 updates with -10°
  // error at this gain set, output should be at or near 0.
  assert.ok(out2 <= out1, `output should decrease after error flip (out1=${out1}, out2=${out2})`);
  assert.ok(out2 < 0.5, `output should drop fast after sustained negative error (got ${out2})`);
});

test('compute(target, actual, maxOutput): external cap clamps output AND freezes integral', () => {
  // Regression for: an external duty cap that doesn't propagate into the
  // PID lets the integral wind up unbounded while the controller's actual
  // output is held at the cap. When the cap relaxes, the integral pops the
  // output past saturation and the kiln overshoots.
  const p = new Pid(5, 3, 3);
  const cap = 0.10;  // 10% — typical candle-segment cap
  // Drive a sustained large positive error for 60 simulated seconds with
  // the cap in effect.
  for (let i = 0; i < 12; i++) {
    p.lastTime = Date.now() - 5_000;
    const out = p.compute(500, 100, cap);
    assert.ok(out <= cap + 1e-9, `external cap should clamp output: got ${out}`);
  }
  const integralAfterCap = p.integralSum;
  // Continue for another 60 s — integral must NOT grow further (it's
  // saturated at the external cap, same as if it were saturated at 1.0).
  for (let i = 0; i < 12; i++) {
    p.lastTime = Date.now() - 5_000;
    p.compute(500, 100, cap);
  }
  assert.equal(p.integralSum, integralAfterCap,
    'integral must not wind up while output is held at the external cap');
});

test('compute(target, actual, maxOutput=1.0) is backward-compatible', () => {
  // Without the cap argument, behavior matches the un-capped path: max
  // output is 1.0, and anti-windup triggers at the natural saturation
  // limit.
  const p = new Pid(5, 3, 3);
  // Force a long saturated run; integral should freeze at 1.0 saturation.
  for (let i = 0; i < 12; i++) {
    p.lastTime = Date.now() - 5_000;
    const out = p.compute(2000, 100);
    assert.ok(out <= 1.0);
  }
  const saturated = p.integralSum;
  for (let i = 0; i < 12; i++) {
    p.lastTime = Date.now() - 5_000;
    p.compute(2000, 100);
  }
  assert.equal(p.integralSum, saturated);
});

test('reset() clears integral and error history', () => {
  const p = new Pid(0, 5, 0);
  p.lastTime = Date.now() - 5_000;
  p.compute(100, 90);                   // builds integral
  p.reset();
  assert.equal(p.integralSum, 0);
  assert.equal(p.lastError, 0);
  assert.equal(p.lastOutput, 0);
});

test('sister balancing scales back when another zone is over-driven', () => {
  // Two PIDs: A has small demand, B is saturated (lastOutput > 1).
  const a = withDt(new Pid(5, 0, 0), 1);
  const b = withDt(new Pid(5, 0, 0), 1);

  // Drive B hard so its lastOutput exceeds 1
  b.compute(1000, 0);
  assert.ok(b.lastOutput > 1, `precondition: B should be over-driven (lastOutput=${b.lastOutput})`);

  // A has small but positive demand
  const aOut = a.compute(20, 0);  // small error → lastOutput in (0, 1)
  // Sister balancing kicks in if A.lastOutput > 0 AND B.lastOutput > A.lastOutput.
  // The ratio is A.lastOutput / B.lastOutput which should be < 1, so A is scaled down.
  assert.ok(aOut < 1, `sister-balanced output should be < 1, got ${aOut}`);
});

test('clearSisters() removes all registered PIDs', () => {
  new Pid(1,1,1); new Pid(1,1,1); new Pid(1,1,1);
  assert.equal(Pid.sisters.length, 3);
  Pid.clearSisters();
  assert.equal(Pid.sisters.length, 0);
});
