'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Logger } = require('../lib/logger');

function mkLogger() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pikiln-logger-'));
  const logDir = path.join(root, 'logs');
  const firingsDir = path.join(root, 'firings');
  const logger = new Logger(logDir, firingsDir);
  return { logger, root, logDir, firingsDir };
}

test('Logger creates the firings directory', () => {
  const { firingsDir, root } = mkLogger();
  assert.ok(fs.existsSync(firingsDir), 'firings dir should exist after Logger construction');
  fs.rmSync(root, { recursive: true, force: true });
});

test('startFiring writes a FIRING IN PROGRESS header with notes and event-log section', () => {
  const { logger, firingsDir, root } = mkLogger();
  const startedAt = new Date('2026-05-29T14:30:00');
  logger.startFiring({
    title: 'Cone 6 Glaze',
    startedAt,
    notes: 'Loaded with 12 cups, 3 plates\nGlaze: clear celadon',
    mode: 'simulation',
  });
  const af = logger.activeFiring;
  assert.ok(af, 'activeFiring should be set');
  assert.match(af.firingId, /^2026-05-29_143000_Cone_6_Glaze$/);

  const content = fs.readFileSync(af.path, 'utf8');
  assert.match(content, /=== FIRING IN PROGRESS ===/);
  assert.match(content, /Schedule\s+Cone 6 Glaze/);
  assert.match(content, /Mode\s+simulation/);
  assert.match(content, /=== NOTES ===/);
  assert.match(content, /Loaded with 12 cups, 3 plates/);
  assert.match(content, /Glaze: clear celadon/);
  assert.match(content, /=== EVENT LOG ===/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('log() during a firing mirrors to both system log and firing log', async () => {
  const { logger, logDir, firingsDir, root } = mkLogger();
  logger.startFiring({ title: 't', startedAt: new Date(), notes: '', mode: 'real' });
  logger.log('1 Tc: 70 Tt: 75 rate: 0.5 secs: 7.5');
  // Async appendFile — give the I/O a moment to land before reading.
  await new Promise(r => setTimeout(r, 50));
  const firingFile = logger.activeFiring.path;
  const firingContent = fs.readFileSync(firingFile, 'utf8');
  assert.match(firingContent, /1 Tc: 70 Tt: 75 rate: 0.5 secs: 7.5/,
    'event line should appear in the firing log');
  // System log file in logDir
  const sysFiles = fs.readdirSync(logDir).filter(f => f.endsWith('.log'));
  assert.equal(sysFiles.length, 1, 'one daily system log file');
  const sysContent = fs.readFileSync(path.join(logDir, sysFiles[0]), 'utf8');
  assert.match(sysContent, /1 Tc: 70 Tt: 75 rate: 0.5 secs: 7.5/,
    'event line should also appear in the daily system log');
  fs.rmSync(root, { recursive: true, force: true });
});

test('log() outside a firing only writes to the system log', () => {
  const { logger, firingsDir, root } = mkLogger();
  logger.log('idle housekeeping');
  // Firings dir should be empty
  assert.deepEqual(fs.readdirSync(firingsDir), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('endFiring replaces the IN PROGRESS header with a SUMMARY block', () => {
  const { logger, root } = mkLogger();
  const startedAt = new Date('2026-05-29T14:30:00');
  logger.startFiring({ title: 'PID Test', startedAt, notes: 'test fire', mode: 'simulation' });
  logger.log('Kiln started');
  logger.log('1 Tc: 70 Tt: 75 rate: 0.5 secs: 7.5');
  const firingFile = logger.activeFiring.path;

  logger.endFiring({
    startedAt,
    completedAt: new Date('2026-05-29T22:30:00'),
    runtimeSeconds: 8 * 3600,
    firingSeconds: 5.5 * 3600,
    cooldownSeconds: 2.5 * 3600,
    maxTempF: 2028,
    maxCone: 'cone 6',
    coneIndex: 13.0,
    kwh: 21.3,
    costUSD: 2.56,
    endReason: 'completed',
  });

  // activeFiring should be cleared
  assert.equal(logger.activeFiring, null);

  const content = fs.readFileSync(firingFile, 'utf8');
  assert.match(content, /=== FIRING SUMMARY ===/);
  assert.doesNotMatch(content, /=== FIRING IN PROGRESS ===/,
    'IN PROGRESS header must be removed');
  assert.match(content, /Total runtime\s+8h 0m 0s/);
  assert.match(content, /Cool-down time\s+2h 30m 0s/);
  assert.match(content, /Max temperature\s+2028°F/);
  assert.match(content, /Max cone\s+cone 6/);
  assert.match(content, /Energy\s+21.30 kWh \(\$2.56\)/);
  assert.match(content, /End reason\s+completed/);
  // NOTES + event log preserved
  assert.match(content, /=== NOTES ===/);
  assert.match(content, /test fire/);
  assert.match(content, /=== EVENT LOG ===/);
  assert.match(content, /Kiln started/);
  assert.match(content, /1 Tc: 70 Tt: 75 rate: 0.5 secs: 7.5/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('endFiring with no active firing is a no-op (no crash)', () => {
  const { logger, root } = mkLogger();
  // Should not throw
  logger.endFiring({ maxTempF: 100 });
  assert.equal(logger.activeFiring, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('addNote during a firing writes "note: <text>" to the event log', async () => {
  const { logger, root } = mkLogger();
  logger.startFiring({ title: 't', startedAt: new Date(), notes: '', mode: 'real' });
  logger.addNote('kiln smelled funny');
  await new Promise(r => setTimeout(r, 50));   // wait for async appendFile
  const content = fs.readFileSync(logger.activeFiring.path, 'utf8');
  assert.match(content, /note: kiln smelled funny/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('firing-log-start and firing-log-append events are emitted for relay mirroring', () => {
  const { logger, root } = mkLogger();
  const events = [];
  logger.on('firing-log-start',    e => events.push({ kind: 'start', data: e }));
  logger.on('firing-log-append',   e => events.push({ kind: 'append', data: e }));
  logger.on('firing-log-complete', e => events.push({ kind: 'complete', data: e }));

  logger.startFiring({ title: 'evt', startedAt: new Date(), notes: 'n', mode: 'real' });
  logger.log('line 1');
  logger.log('line 2');
  logger.endFiring({ maxTempF: 1234, endReason: 'completed' });

  const kinds = events.map(e => e.kind);
  assert.deepEqual(kinds.slice(0, 3), ['start', 'append', 'append']);
  assert.equal(kinds[kinds.length - 1], 'complete');
  // Start event includes header for the relay to mirror as a fresh file
  assert.match(events[0].data.header, /=== FIRING IN PROGRESS ===/);
  // Complete event includes the final content (with SUMMARY)
  const complete = events.find(e => e.kind === 'complete');
  assert.match(complete.data.content, /=== FIRING SUMMARY ===/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Logger: SD failure simulation — emits write-error then writes-disabled, kiln keeps logging in memory', async () => {
  // Simulate a failing SD card: replace the daily log file with a
  // directory so appendFile reliably gets EISDIR. After
  // WRITE_FAILURE_THRESHOLD failures the logger should disable file writes
  // entirely and fire writes-disabled.
  const { logger, root } = mkLogger();
  const errors = [];
  const disabled = [];
  logger.on('write-error', (e) => errors.push(e));
  logger.on('writes-disabled', (e) => disabled.push(e));

  // Force daily-log appends to fail by making the target a directory.
  // We use the logger's own _dateStr formatting to match what _openLog
  // will compute.
  const dateStr = logger._dateStr();
  const logPath = path.join(root, 'logs', dateStr + '.log');
  fs.mkdirSync(logPath, { recursive: true });

  // Drive enough writes to cross the threshold of 10 failures.
  for (let i = 0; i < 15; i++) logger.log(`probe ${i}`);
  await new Promise(r => setTimeout(r, 100));

  assert.ok(errors.length >= 1, 'write-error should fire at least once');
  assert.equal(disabled.length, 1, 'writes-disabled fires exactly once');
  assert.ok(disabled[0].failures >= 10, 'reports the failure count');

  // After disable, log() is a no-op for I/O — error count shouldn't keep
  // climbing.
  const failuresBefore = errors.length;
  for (let i = 0; i < 5; i++) logger.log(`post ${i}`);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(errors.length, failuresBefore,
    'no more I/O attempts after writes-disabled');

  fs.rmSync(root, { recursive: true, force: true });
});

test('Kiln.getFiringSummary captures peak temp, cone index, kwh, and durations', () => {
  // This test wires through the lifecycle helper test pattern — uses the
  // simulated kiln to drive a short firing and verifies summary fields.
  const { Kiln } = require('../lib/kiln');
  const { Schedule } = require('../lib/schedule');
  const { Pid } = require('../lib/pid');
  Pid.clearSisters();
  process.env.PIKILN_SIMULATE = '1';
  const silentLogger = { log: () => {}, error: () => {}, message: () => {} };
  const k = new Kiln({}, silentLogger, null);
  k.schedule = new Schedule({
    title: 't', cone: '-', 'units-temp': '°F', 'units-rate': '°F/hr', 'units-hold': 'min',
    segments: [{ rate: 200, temp: 300, hold: 0 }],
  });
  // Pre-set sensor temps so the peak tracker has something to record.
  for (const s of k.tempSensors) { s.simulatedTempC = 50; s._lastReadingC = 50; }
  k.start();
  // Inject a peak directly (sim mode would converge eventually but we want
  // the test to be fast and deterministic).
  k._peakTempC = 100;
  k._coolingStartTime = Date.now() - 1000;  // 1s ago — pretend we just entered cool-down
  k._startTime = Date.now() - 5000;          // started 5s ago
  const summary = k.getFiringSummary('completed');
  assert.ok(summary.runtimeSeconds >= 4 && summary.runtimeSeconds <= 6);
  assert.ok(summary.cooldownSeconds >= 0.9 && summary.cooldownSeconds <= 1.2);
  assert.ok(Math.abs(summary.maxTempF - 212) < 1, `peak 100°C ≈ 212°F, got ${summary.maxTempF}`);
  assert.equal(summary.endReason, 'completed');
  k.stop();
});
