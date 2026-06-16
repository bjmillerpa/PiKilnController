#!/usr/bin/env node
'use strict';

// Offline thermal-loss analyzer. Reads a firing log, extracts the cool-down
// section and any sustained holds, fits a heat-loss-versus-temperature curve
// from each, and compares against the L&L baseline in lib/thermal-model.js.
//
// Three independent signals are extracted from one firing:
//   1. COOL-DOWN: with all elements off, Q_loss(T) = -m·c · dT/dt. Continuous
//      curve over the whole temperature range the kiln traverses.
//   2. HOLDS:    at steady state, Q_loss(T) = avg input power. One anchor per
//      hold segment, at the hold temperature.
//   3. m·c BACK-FIT: divide each hold's direct loss by the cool-down dT/dt at
//      the same temp to recover thermal mass for THIS firing's load.
//
// Usage:  node scripts/analyze-thermal.js <firing-log> [--csv out.csv]

const fs = require('fs');
const path = require('path');
const {
  heatLossW,
  HEAT_CAP_JK,
  AMBIENT_C,
} = require('../lib/thermal-model');
const { ELEMENT_WATTS } = require('../lib/constants');

// ── Parsing ────────────────────────────────────────────────────────────

function f2c(f) { return (f - 32) * 5 / 9; }

function parseTimestamp(s) {
  // 20260607_134226 → Date (treat as UTC; we only care about deltas)
  const y = +s.slice(0, 4), mo = +s.slice(4, 6) - 1, d = +s.slice(6, 8);
  const h = +s.slice(9, 11), mi = +s.slice(11, 13), se = +s.slice(13, 15);
  return Date.UTC(y, mo, d, h, mi, se);
}

function parseLog(text) {
  const events = [];
  const reFire = /^(\d{8}_\d{6}):\s+(\d)\s+Tc:\s+([\d.]+)\s+Tt:\s+([\d.]+)\s+rate:\s+([\d.]+)\s+secs:\s+([\d.]+)/;
  const reCool = /^(\d{8}_\d{6}):\s+(\d)\s+cooling\s+Tc:\s+([\d.]+)/;
  const reHold = /^(\d{8}_\d{6}):\s+starting\s+(\d+)\s+min\s+hold/;
  const reSeg  = /^(\d{8}_\d{6}):\s+starting\s+segment\s+(\d+):\s+(\d+)C\s+@/;
  const reCDStart = /^(\d{8}_\d{6}):\s+Schedule\s+complete/;
  for (const line of text.split('\n')) {
    let m = reFire.exec(line);
    if (m) {
      events.push({
        t: parseTimestamp(m[1]),
        type: 'fire',
        ring: +m[2],
        tempF: +m[3],
        secs: +m[6],
      });
      continue;
    }
    m = reCool.exec(line);
    if (m) {
      events.push({ t: parseTimestamp(m[1]), type: 'cool', ring: +m[2], tempF: +m[3] });
      continue;
    }
    m = reHold.exec(line);
    if (m) { events.push({ t: parseTimestamp(m[1]), type: 'hold-start', minutes: +m[2] }); continue; }
    m = reSeg.exec(line);
    if (m) { events.push({ t: parseTimestamp(m[1]), type: 'segment-start', segment: +m[2], targetC: +m[3] }); continue; }
    m = reCDStart.exec(line);
    if (m) { events.push({ t: parseTimestamp(m[1]), type: 'cooling-start' }); }
  }
  return events;
}

// ── Cool-down loss curve ───────────────────────────────────────────────

function extractCooldown(events) {
  const i = events.findIndex(e => e.type === 'cooling-start');
  if (i < 0) return [];
  return events.slice(i + 1).filter(e => e.type === 'cool');
}

// Per-ring centered-difference dT/dt over a sliding window of `W` samples
// (each side). With one sample per ring every 15 s, W=4 gives a 2-minute
// centered window — wide enough to smooth the 0.5°F sensor quantization but
// narrow enough to capture rate changes during the cool-down's fast first hour.
function computeDTdt(coolSamples, W = 4) {
  const byRing = new Map();
  for (const s of coolSamples) {
    if (!byRing.has(s.ring)) byRing.set(s.ring, []);
    byRing.get(s.ring).push(s);
  }
  const points = [];
  for (const arr of byRing.values()) {
    for (let i = W; i < arr.length - W; i++) {
      const prev = arr[i - W], cur = arr[i], next = arr[i + W];
      const dT_C = f2c(next.tempF) - f2c(prev.tempF);
      const dt_s = (next.t - prev.t) / 1000;
      if (dt_s <= 0) continue;
      const dTdt = dT_C / dt_s;
      if (dTdt >= 0) continue;            // ignore upticks (sensor noise)
      points.push({ tempC: f2c(cur.tempF), dTdt });
    }
  }
  return points;
}

function median(arr) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function binByTemp(points, binSizeC) {
  const bins = new Map();
  for (const p of points) {
    const k = Math.floor(p.tempC / binSizeC) * binSizeC;
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k).push(p.dTdt);
  }
  return [...bins.keys()]
    .sort((a, b) => a - b)
    .map(k => ({
      tempC: k + binSizeC / 2,
      dTdt: median(bins.get(k)),
      n: bins.get(k).length,
    }));
}

// ── Hold anchors (direct loss from input power) ────────────────────────

function extractHolds(events) {
  const holds = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i].type !== 'hold-start') continue;
    const start = events[i];
    // Hold ends at the next segment-start OR the cool-down-start.
    let end = null;
    for (let j = i + 1; j < events.length; j++) {
      if (events[j].type === 'segment-start' || events[j].type === 'cooling-start') {
        end = events[j];
        break;
      }
    }
    if (!end) continue;
    const fires = events.filter(e => e.type === 'fire' && e.t >= start.t && e.t < end.t);
    if (fires.length < 10) continue;
    // Each fire event represents one ring's commanded on-time for the 15 s
    // following that beat. Total energy = Σ secs × ELEMENT_WATTS. Window =
    // wall-time delta. Average power = energy / window.
    const totalEnergyJ = fires.reduce((s, f) => s + f.secs * ELEMENT_WATTS, 0);
    const windowSeconds = (end.t - start.t) / 1000;
    const tempsC = fires.map(f => f2c(f.tempF));
    holds.push({
      tempC: median(tempsC),
      durationS: windowSeconds,
      lossW: totalEnergyJ / windowSeconds,
      nSamples: fires.length,
    });
  }
  return holds;
}

// ── Linear least squares ───────────────────────────────────────────────
//
// Solves min‖Xβ − y‖² for β via Gauss-Jordan elimination on the normal
// equations [XᵀX | Xᵀy]. Partial pivoting for stability. For our 3-parameter
// thermal fit this is fast and accurate enough; numpy would be overkill.
function solveLLS(X, y, weights) {
  const n = X.length, p = X[0].length;
  const w = weights || X.map(() => 1);
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) {
      Xty[a] += w[i] * X[i][a] * y[i];
      for (let b = 0; b < p; b++) {
        XtX[a][b] += w[i] * X[i][a] * X[i][b];
      }
    }
  }
  // Augmented matrix [XtX | Xty]
  const aug = XtX.map((row, i) => [...row, Xty[i]]);
  for (let i = 0; i < p; i++) {
    let maxRow = i;
    for (let k = i + 1; k < p; k++) {
      if (Math.abs(aug[k][i]) > Math.abs(aug[maxRow][i])) maxRow = k;
    }
    [aug[i], aug[maxRow]] = [aug[maxRow], aug[i]];
    const piv = aug[i][i];
    if (Math.abs(piv) < 1e-12) throw new Error('singular normal equations');
    for (let k = 0; k < p; k++) {
      if (k === i) continue;
      const factor = aug[k][i] / piv;
      for (let j = i; j <= p; j++) aug[k][j] -= factor * aug[i][j];
    }
  }
  return aug.map((row, i) => row[p] / row[i]);
}

// Three-parameter physics-motivated heat-loss model:
//   Q(T) = a·(T - T_amb) + b·(T - T_amb)² + c·((T+273.15)⁴ - (T_amb+273.15)⁴)
//
// The linear term is Newtonian convection/conduction through the walls; the
// quadratic absorbs nonlinearity in convection at higher ΔT; the quartic is
// the Stefan-Boltzmann radiation tail that dominates above ~600°C and that
// the L&L polynomial can't capture.
//
// The basis columns span very different magnitudes (T-T_amb ≈ 10³, T⁴ ≈ 10¹²),
// so we rescale them to ~unit magnitude before solving. The rescaling cancels
// out when we evaluate the model, but it keeps the normal-equation matrix
// well-conditioned.
function fitRadiationModel(dataPoints) {
  const T_AMB = AMBIENT_C;
  const T_AMB_K = T_AMB + 273.15;
  const T_AMB_K4 = Math.pow(T_AMB_K, 4);
  // Build (X, y) — y is W, X columns are [u_lin, u_quad, u_rad]
  const X = [];
  const y = [];
  const w = [];
  for (const p of dataPoints) {
    const dT = p.tempC - T_AMB;
    const TK4 = Math.pow(p.tempC + 273.15, 4);
    X.push([
      dT / 1000,
      Math.pow(dT / 1000, 2),
      (TK4 - T_AMB_K4) / 1e12,
    ]);
    y.push(p.Q);
    w.push(p.weight || 1);
  }
  const beta = solveLLS(X, y, w);
  // Re-derive the physical coefficients from the rescaled fit
  const a = beta[0] / 1000;          // W per K (linear)
  const b = beta[1] / 1e6;           // W per K² (quadratic)
  const c = beta[2] / 1e12;          // W per K⁴ (radiation)
  function predict(tempC) {
    const dT = tempC - T_AMB;
    const TK4 = Math.pow(tempC + 273.15, 4);
    return a * dT + b * dT * dT + c * (TK4 - T_AMB_K4);
  }
  // RMS / max residual
  let sse = 0, maxRes = 0;
  for (let i = 0; i < dataPoints.length; i++) {
    const yhat = predict(dataPoints[i].tempC);
    const r = dataPoints[i].Q - yhat;
    sse += r * r;
    if (Math.abs(r) > maxRes) maxRes = Math.abs(r);
  }
  return { a, b, c, predict, rms: Math.sqrt(sse / dataPoints.length), maxRes };
}

// ── Formatting ─────────────────────────────────────────────────────────

function pad(s, w, align = 'right') {
  s = String(s);
  if (s.length >= w) return s;
  const padding = ' '.repeat(w - s.length);
  return align === 'right' ? padding + s : s + padding;
}

function asciiBar(value, max, width) {
  const n = Math.round((value / max) * width);
  return '█'.repeat(Math.max(0, Math.min(width, n)));
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return `${h}h ${m}m ${ss}s`;
}

// ── Main ───────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const logPath = args.find(a => !a.startsWith('--'));
  const csvIdx = args.indexOf('--csv');
  const csvPath = csvIdx >= 0 ? args[csvIdx + 1] : null;
  if (!logPath) {
    console.error('Usage: analyze-thermal.js <firing-log> [--csv out.csv]');
    process.exit(1);
  }

  const text = fs.readFileSync(logPath, 'utf8');
  const events = parseLog(text);
  const coolSamples = extractCooldown(events);
  const holds = extractHolds(events);
  const points = computeDTdt(coolSamples);
  const binned = binByTemp(points, 25);   // 25°C bins → 30-ish bins across firing range

  const fileLabel = path.basename(logPath);
  console.log(`=== Thermal-loss analysis: ${fileLabel} ===\n`);

  if (coolSamples.length > 0) {
    const cdStart = coolSamples[0].t, cdEnd = coolSamples[coolSamples.length - 1].t;
    console.log(`Cool-down: ${coolSamples.length} samples over ${fmtDuration(cdEnd - cdStart)}`);
    console.log(`  Temperature range: ${f2c(coolSamples[coolSamples.length - 1].tempF).toFixed(0)}°C → ${f2c(coolSamples[0].tempF).toFixed(0)}°C`);
  }
  console.log(`Holds: ${holds.length}`);
  console.log(`Assumed m·c (L&L baseline): ${HEAT_CAP_JK.toFixed(0)} J/K   (ELEMENT_W: ${ELEMENT_WATTS} × 3 rings)\n`);

  // ── Loss curve from cool-down ──
  console.log('LOSS CURVE FROM COOL-DOWN  (Q_loss = m·c · |dT/dt|, assumes L&L m·c):');
  console.log('  ' + pad('°C', 5) + ' | ' + pad('°C/min', 8) + ' | '
    + pad('Q learn W', 10) + ' | ' + pad('Q L&L W', 9) + ' | '
    + pad('ratio', 6) + ' | ' + pad('n', 5) + ' | bar');
  const maxLearnedW = Math.max(...binned.map(b => Math.abs(b.dTdt) * HEAT_CAP_JK), 1);
  for (const b of binned) {
    const learnedW = Math.abs(b.dTdt) * HEAT_CAP_JK;
    const llW = heatLossW(b.tempC);
    const ratio = llW > 0 ? (learnedW / llW).toFixed(2) : '   - ';
    console.log('  '
      + pad(b.tempC.toFixed(0), 5) + ' | '
      + pad((b.dTdt * 60).toFixed(2), 8) + ' | '
      + pad(learnedW.toFixed(0), 10) + ' | '
      + pad(llW.toFixed(0), 9) + ' | '
      + pad(ratio, 6) + ' | '
      + pad(b.n, 5) + ' | '
      + asciiBar(learnedW, maxLearnedW, 30));
  }

  // ── Hold anchors ──
  console.log('\nHOLD ANCHORS  (direct: Q_loss = avg input power):');
  console.log('  ' + pad('°C', 5) + ' | ' + pad('duration', 9) + ' | '
    + pad('Q hold W', 9) + ' | ' + pad('Q L&L W', 9) + ' | '
    + pad('ratio', 6) + ' | implied m·c (J/K)');
  for (const h of holds) {
    const llW = heatLossW(h.tempC);
    const ratio = llW > 0 ? (h.lossW / llW).toFixed(2) : '   - ';
    const cb = binned.find(b => Math.abs(b.tempC - h.tempC) < 25);
    const impliedMC = cb && Math.abs(cb.dTdt) > 0
      ? (h.lossW / Math.abs(cb.dTdt)).toFixed(0)
      : '     -';
    console.log('  '
      + pad(h.tempC.toFixed(0), 5) + ' | '
      + pad((h.durationS / 60).toFixed(0) + ' min', 9) + ' | '
      + pad(h.lossW.toFixed(0), 9) + ' | '
      + pad(llW.toFixed(0), 9) + ' | '
      + pad(ratio, 6) + ' | '
      + impliedMC);
  }

  // ── m·c back-fit ──
  const mcEstimates = [];
  for (const h of holds) {
    const cb = binned.find(b => Math.abs(b.tempC - h.tempC) < 25);
    if (cb && Math.abs(cb.dTdt) > 0) mcEstimates.push(h.lossW / Math.abs(cb.dTdt));
  }
  if (mcEstimates.length > 0) {
    const med = median(mcEstimates);
    console.log(`\nm·c BACK-FIT:`);
    console.log(`  Median across ${mcEstimates.length} holds: ${med.toFixed(0)} J/K  (L&L baseline ${HEAT_CAP_JK}; ratio ${(med / HEAT_CAP_JK).toFixed(2)})`);
    // Re-scale the cool-down curve using the back-fit m·c and report ratios
    // at the hold temps — sanity check that the joint fit hangs together.
    console.log(`  After re-scaling cool-down curve with that m·c:`);
    console.log('  ' + pad('°C', 5) + ' | '
      + pad('Q cool W', 9) + ' | '
      + pad('Q hold W', 9) + ' | '
      + pad('ratio', 6));
    for (const h of holds) {
      const cb = binned.find(b => Math.abs(b.tempC - h.tempC) < 25);
      if (!cb) continue;
      const coolW = Math.abs(cb.dTdt) * med;
      const ratio = h.lossW > 0 ? (coolW / h.lossW).toFixed(2) : '   - ';
      console.log('  '
        + pad(h.tempC.toFixed(0), 5) + ' | '
        + pad(coolW.toFixed(0), 9) + ' | '
        + pad(h.lossW.toFixed(0), 9) + ' | '
        + pad(ratio, 6));
    }

    // ── Radiation-aware fit ──
    //
    // Pool cool-down bins (Q derived using the back-fit m·c) and hold anchors
    // (direct measurements, no m·c assumption) into a single dataset and fit
    // Q(T) = a·(T-T_amb) + b·(T-T_amb)² + c·((T_K)⁴ - (T_amb_K)⁴). Weight by
    // number of underlying samples so hold anchors don't get drowned out by
    // the many low-temp cool-down bins, but cool-down bins still anchor the
    // slope. Holds get a floor weight equivalent to ~100 cool-down samples,
    // reflecting that they're direct measurements with no m·c uncertainty.
    const fitPoints = [];
    for (const b of binned) {
      // Below ~100°C the cool-down dT/dt is dominated by sensor quantization
      // and ambient air convection; the kiln-loss signal is too weak to
      // recover. Skip those bins from the fit (they're still shown in the
      // table above for reference).
      if (b.tempC < 100) continue;
      fitPoints.push({
        tempC: b.tempC,
        Q: Math.abs(b.dTdt) * med,    // re-scaled with back-fit m·c
        weight: b.n,
        kind: 'cool',
      });
    }
    for (const h of holds) {
      fitPoints.push({
        tempC: h.tempC,
        Q: h.lossW,
        weight: Math.max(100, h.nSamples),
        kind: 'hold',
      });
    }
    const fit = fitRadiationModel(fitPoints);
    console.log(`\nRADIATION-AWARE FIT  Q(T) = a·ΔT + b·ΔT² + c·(T_K⁴ - T_amb_K⁴),  ΔT = T - ${AMBIENT_C}°C`);
    console.log(`  a (linear)     = ${fit.a.toExponential(3)} W/K`);
    console.log(`  b (quadratic)  = ${fit.b.toExponential(3)} W/K²`);
    console.log(`  c (radiation)  = ${fit.c.toExponential(3)} W/K⁴`);
    console.log(`  RMS residual:  ${fit.rms.toFixed(0)} W`);
    console.log(`  Max residual:  ${fit.maxRes.toFixed(0)} W`);

    // Compare measured vs fit vs L&L at each anchor
    console.log(`\nCOMPARISON AT ANCHOR POINTS:`);
    console.log('  ' + pad('°C', 5) + ' | ' + pad('source', 7) + ' | '
      + pad('Q meas W', 9) + ' | ' + pad('Q fit W', 9) + ' | '
      + pad('Q L&L W', 9) + ' | ' + pad('fit err', 8));
    const orderedAnchors = [...fitPoints].sort((a, b) => a.tempC - b.tempC);
    for (const p of orderedAnchors) {
      const qFit = fit.predict(p.tempC);
      const qLL  = heatLossW(p.tempC);
      const err  = qFit - p.Q;
      console.log('  '
        + pad(p.tempC.toFixed(0), 5) + ' | '
        + pad(p.kind, 7) + ' | '
        + pad(p.Q.toFixed(0), 9) + ' | '
        + pad(qFit.toFixed(0), 9) + ' | '
        + pad(qLL.toFixed(0), 9) + ' | '
        + pad((err >= 0 ? '+' : '') + err.toFixed(0), 8));
    }

    // Extrapolate up to typical cone-6 / cone-10 peaks. With only one hold
    // anchor above ~600°C, the radiation coefficient is poorly constrained —
    // call that out so the predicted curve isn't read as ground truth at high
    // temp. Once a few cone-6 firings give us uncontrolled-cool-down data up
    // to ~1100°C, the fit will tighten.
    const tMaxHold = Math.max(...holds.map(h => h.tempC));
    const totalElementW = 3 * ELEMENT_WATTS;
    console.log(`\nEXTRAPOLATION  (fit anchored on data 100-${tMaxHold.toFixed(0)}°C; radiation term`);
    console.log(`  uses one hold above 600°C — slope above ${tMaxHold.toFixed(0)}°C is poorly constrained):`);
    console.log('  ' + pad('°C', 5) + ' | ' + pad('°F', 5) + ' | '
      + pad('Q fit W', 9) + ' | ' + pad('Q L&L W', 9) + ' | '
      + pad('fit / L&L', 9) + ' | note');
    for (const T of [400, 600, 800, 1000, 1100, 1200, 1300]) {
      const qFit = fit.predict(T);
      const qLL  = heatLossW(T);
      const ratio = qLL > 0 ? (qFit / qLL).toFixed(2) : '    -';
      const notes = [];
      if (T > tMaxHold) notes.push('extrapolated');
      if (qFit > totalElementW) notes.push(`> max element power (${totalElementW}W)`);
      console.log('  '
        + pad(T, 5) + ' | '
        + pad((T * 9 / 5 + 32).toFixed(0), 5) + ' | '
        + pad(qFit.toFixed(0), 9) + ' | '
        + pad(qLL.toFixed(0), 9) + ' | '
        + pad(ratio, 9) + ' | ' + notes.join(', '));
    }
  }

  // ── CSV output ──
  if (csvPath) {
    const lines = ['source,tempC,dTdt_C_per_min,Q_W,n,duration_s'];
    for (const b of binned) {
      lines.push(`cooldown,${b.tempC.toFixed(1)},${(b.dTdt * 60).toFixed(3)},${(Math.abs(b.dTdt) * HEAT_CAP_JK).toFixed(0)},${b.n},`);
    }
    for (const h of holds) {
      lines.push(`hold,${h.tempC.toFixed(1)},,${h.lossW.toFixed(0)},${h.nSamples},${h.durationS.toFixed(0)}`);
    }
    fs.writeFileSync(csvPath, lines.join('\n') + '\n');
    console.log(`\nCSV written: ${csvPath}`);
  }
}

main();
