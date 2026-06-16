'use strict';
//
// PerfLog — append-only telemetry log for the kiln.
//
// Distinct from the human-readable system log (Logger): this one is structured
// JSONL (one JSON object per line) intended for data mining — keep it forever.
//
// File layout: one file per month, `<dir>/perf-YYYY-MM.jsonl`. New files are
// created lazily on first write of the month. Old files are never rotated or
// deleted by this module.
//
// Internally writes are appended to a queue and flushed on a microtask so a
// burst of events from one heartbeat doesn't fight the event loop. Each line
// is a JSON object with at minimum `ts` (ISO ms) and `event` (string), plus
// event-specific fields.

const fs = require('fs');
const path = require('path');

const FLUSH_INTERVAL_MS = 1000; // also flush on this cadence as a safety net

class PerfLog {
  constructor(dir) {
    this._dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this._queue = [];
    this._writing = false;
    this._timer = setInterval(() => this._flush(), FLUSH_INTERVAL_MS);
    this._timer.unref();
  }

  _filename() {
    const d = new Date();
    const ym = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
    return path.join(this._dir, `perf-${ym}.jsonl`);
  }

  _write(event, fields) {
    const obj = { ts: new Date().toISOString(), event, ...fields };
    this._queue.push(JSON.stringify(obj));
    if (this._queue.length >= 64) this._flush();
  }

  _flush() {
    if (this._writing || this._queue.length === 0) return;
    this._writing = true;
    const batch = this._queue.join('\n') + '\n';
    this._queue = [];
    fs.appendFile(this._filename(), batch, (err) => {
      this._writing = false;
      if (err) {
        // Re-queue and let the timer try again on next tick
        console.error('PerfLog append failed:', err.message);
      }
    });
  }

  // ── Event helpers ────────────────────────────────────────────────────
  // Field names are kept short on purpose — these rows accumulate forever.

  ringUpdate({ ring, tempC, targetC, rate, seconds, mode, segment, elements, fanOn, coneIndex, kwh }) {
    this._write('ring', {
      r: ring,
      tC: round2(tempC),
      gC: round2(targetC),
      du: round3(rate),       // duty (0..1)
      s:  round2(seconds),    // seconds to fire this cycle
      m:  mode,
      seg: segment,
      e:  elements,           // [bool,bool,bool]
      f:  fanOn,
      ci: coneIndex == null ? null : round2(coneIndex),
      kwh: round3(kwh),
    });
  }

  scheduleStart(title, simulation) { this._write('schedule-start', { title, sim: !!simulation }); }
  scheduleComplete(stats)           { this._write('schedule-complete', stats || {}); }
  scheduleStop(reason)              { this._write('schedule-stop', { reason: reason || 'user' }); }
  segmentAdvance(from, to)          { this._write('segment', { from, to }); }
  fanChange(on, mode)               { this._write('fan', { on, mode }); }
  emergencyStop(reason)             { this._write('emergency-stop', { reason }); }
  sensorError(ring, msg)            { this._write('sensor-error', { r: ring, msg }); }

  close(cb) {
    clearInterval(this._timer);
    this._flush();
    // Give the in-flight append a moment to land
    setTimeout(() => cb && cb(), 50);
  }
}

function round2(n) { return n == null || !Number.isFinite(n) ? n : Math.round(n * 100) / 100; }
function round3(n) { return n == null || !Number.isFinite(n) ? n : Math.round(n * 1000) / 1000; }

module.exports = { PerfLog };
