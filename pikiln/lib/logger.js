'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

// Threshold for considering disk-write trouble persistent. After this many
// consecutive failed appends, file logging is disabled until restart and a
// `writes-disabled` event fires — at which point pikiln.js sends an alert
// and the kiln keeps running on the assumption that data loss beats firing-
// load loss. See class docstring below.
const WRITE_FAILURE_THRESHOLD = 10;

// Logger writes to disk asynchronously (fs.appendFile, not appendFileSync)
// so a failing or stalled SD card doesn't block the kiln's 1 Hz heartbeat —
// the event loop stays free and the control loop keeps running even if
// every log write is taking seconds to fail. Errors are counted; on
// repeated failure, file logging is disabled entirely and a "writes-
// disabled" event lets pikiln.js send a Pushover alert. Once disabled,
// stays disabled until restart — there's no automatic retry (an SD card
// that started failing usually keeps failing).
class Logger extends EventEmitter {
  constructor(logDir, firingsDir) {
    super();
    this._logDir = logDir;
    // Per-firing logs live in their own directory so the daily-rotated
    // system log doesn't intermingle with them. Defaults to a sibling of
    // logDir if not specified, which is what pikiln.js uses in practice.
    this._firingsDir = firingsDir || path.join(path.dirname(logDir), 'firings');
    this._currentFile = null;
    this._currentDate = null;
    // Per-firing state. Null when no firing is active.
    this._firingFile = null;     // absolute path to active firing log
    this._firingMeta = null;     // { title, startedAt, notes, mode }
    this._firingId = null;       // basename without .log — used in events
    // SD-failure tracking. _writesDisabled flips true after the threshold
    // of consecutive failures; subsequent log() calls become memory-only
    // (still emit('log') so WS clients see them, just no disk writes).
    this._writeFailures = 0;
    this._writesDisabled = false;
    // In-memory mirror of event lines written during the active firing.
    // endFiring uses this to rewrite the firing log with the SUMMARY block
    // prepended, rather than reading the on-disk file back — which would
    // race with the async _appendToFile writes and miss any that hadn't
    // flushed yet. Empty unless a firing is active.
    this._firingEventLines = [];
    this._ensureDirs();
  }

  _ensureDirs() {
    for (const d of [this._logDir, this._firingsDir]) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }
  }

  _dateStr() {
    const d = new Date();
    return d.getFullYear().toString() +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0');
  }

  _timestamp() {
    const d = new Date();
    return this._dateStr() + '_' +
      String(d.getHours()).padStart(2, '0') +
      String(d.getMinutes()).padStart(2, '0') +
      String(d.getSeconds()).padStart(2, '0');
  }

  _openLog() {
    const dateStr = this._dateStr();
    if (dateStr !== this._currentDate) {
      this._currentDate = dateStr;
      this._currentFile = path.join(this._logDir, dateStr + '.log');
    }
  }

  _appendToFile(line) {
    if (this._writesDisabled) {
      // Still emit the WS event so the firing log mirror keeps a record on
      // the relay even if local disk is dead. The relay maintains its own
      // copy in /srv/firings/ — invaluable when the SD card itself is the
      // problem.
      if (this._firingFile) this.emit('firing-log-append', { firingId: this._firingId, line });
      return;
    }
    this._openLog();
    const data = line + '\n';
    fs.appendFile(this._currentFile, data, (err) => {
      if (err) this._onWriteError('system-log', err);
      else this._onWriteSuccess();
    });
    if (this._firingFile) {
      // Track in memory so endFiring can rewrite the file with the SUMMARY
      // block prepended without having to read back the on-disk content
      // (which may be missing writes that haven't flushed yet).
      this._firingEventLines.push(line);
      fs.appendFile(this._firingFile, data, (err) => {
        if (err) this._onWriteError('firing-log', err);
      });
      this.emit('firing-log-append', { firingId: this._firingId, line });
    }
  }

  _onWriteError(which, err) {
    this._writeFailures += 1;
    if (this._writeFailures === 1) {
      console.error(`[logger] write failed (${which}): ${err.message}`);
      this.emit('write-error', { which, message: err.message });
    }
    if (this._writeFailures >= WRITE_FAILURE_THRESHOLD && !this._writesDisabled) {
      this._writesDisabled = true;
      console.error(`[logger] ${this._writeFailures} consecutive write failures — disabling file logging until restart. Kiln control continues; check the SD card.`);
      this.emit('writes-disabled', { failures: this._writeFailures, lastError: err.message });
    }
  }

  _onWriteSuccess() {
    if (this._writeFailures > 0) {
      const recovered = this._writeFailures;
      this._writeFailures = 0;
      // Only announce a recovery if we'd had multiple failures — a single
      // transient blip isn't worth a Pushover.
      if (recovered >= 3) {
        this.emit('writes-recovered', { afterFailures: recovered });
      }
    }
  }

  log(msg) {
    const line = `${this._timestamp()}: ${msg}`;
    this._appendToFile(line);
    this.emit('log', line);
    console.log(line);
  }

  message(msg) {
    this.emit('message', msg);
  }

  error(msg) {
    const line = `${this._timestamp()}: ERROR: ${msg}`;
    this._appendToFile(line);
    this.emit('log', line);
    this.emit('message', `ERROR: ${msg}`);
    console.error(line);
  }

  // ── Per-firing log ──────────────────────────────────────────────────────
  //
  // A firing log captures everything between Kiln start and cool-down complete
  // for one firing run. Structure on disk while a firing is active:
  //
  //   === FIRING IN PROGRESS ===
  //   Schedule: <title>
  //   Started:  <ISO datetime>
  //   Mode:     real|simulation
  //
  //   === NOTES ===
  //   <user-entered notes, possibly multi-line, may be empty>
  //
  //   === EVENT LOG ===
  //   <timestamped event lines, appended as they happen>
  //
  // On endFiring(), the header block is replaced with a SUMMARY containing
  // total runtime, cool-down time, max temp, max cone, energy, etc. The
  // notes and event-log sections stay as-is. This is what the operator
  // (and any later thermal-model fitting) reads months later.

  startFiring(meta) {
    const startedAt = meta.startedAt || new Date();
    const id = `${this._fileSlug(startedAt)}_${this._titleSlug(meta.title)}`;
    this._firingId = id;
    this._firingMeta = { ...meta, startedAt };
    this._firingFile = path.join(this._firingsDir, id + '.log');
    this._firingEventLines = [];

    const header = this._renderHeader('FIRING IN PROGRESS', {
      Schedule: meta.title || '(untitled)',
      Started:  this._fmtDateTime(startedAt),
      Mode:     meta.mode === 'simulation' ? 'simulation' : 'real',
    });
    const notesSection = `=== NOTES ===\n${(meta.notes || '').trim()}\n\n`;
    const eventsHeader = '=== EVENT LOG ===\n';

    // startFiring is a one-shot, not in the heartbeat hot path — sync write
    // is fine. The relay-side mirror is independent and the operator's not
    // mid-firing yet, so a brief block here doesn't risk an e-stop. Emit
    // the WS event regardless of local disk success so the relay's mirror
    // at /srv/firings/ has a record even when the SD card doesn't.
    const headerText = header + notesSection + eventsHeader;
    this.emit('firing-log-start', {
      firingId: id,
      path: this._firingFile,
      meta: this._firingMeta,
      header: headerText,
    });
    if (!this._writesDisabled) {
      try {
        fs.writeFileSync(this._firingFile, headerText);
      } catch (err) {
        this._onWriteError('firing-log-start', err);
      }
    }
  }

  endFiring(summary) {
    if (!this._firingFile) return;
    const file = this._firingFile;
    const id = this._firingId;
    // Build the final content from in-memory state — header reconstructed
    // from metadata + summary, notes from this._firingMeta.notes, event
    // lines from this._firingEventLines. Independent of the on-disk file,
    // which may be missing some of the most recent async appends, and
    // works even when writes have been disabled by SD failure (the WS
    // event below still carries the full content to the relay mirror).
    const summaryFields = this._renderSummaryFields(this._firingMeta, summary);
    const newHeader = this._renderHeader('FIRING SUMMARY', summaryFields);
    const notesSection = `=== NOTES ===\n${(this._firingMeta?.notes || '').trim()}\n\n`;
    const eventsHeader = '=== EVENT LOG ===\n';
    const eventBody = this._firingEventLines.length
      ? this._firingEventLines.join('\n') + '\n'
      : '';
    const final = newHeader + notesSection + eventsHeader + eventBody;

    // Emit unconditionally so the relay can mirror the full final content
    // even if the local SD is dead. Local write is best-effort async.
    this.emit('firing-log-complete', {
      firingId: id,
      path: file,
      content: final,
    });
    // endFiring is one-shot at cool-down-complete / stop / e-stop — sync
    // write is fine and keeps the firing-log file consistent for the test
    // suite and any post-firing tooling that reads it immediately. SD
    // failure here just gets reported via _onWriteError; the relay
    // received the full content via the WS event above and has a clean
    // copy.
    if (!this._writesDisabled) {
      try {
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, final);
        fs.renameSync(tmp, file);
      } catch (err) {
        this._onWriteError('firing-log-finalize', err);
      }
    }
    this._firingFile = null;
    this._firingMeta = null;
    this._firingId = null;
    this._firingEventLines = [];
  }

  // Append a note that the operator added mid-firing. Logged as a normal
  // event line so it appears inline in the event log, plus emitted as a
  // distinct event the relay can use to refresh the mirrored notes section.
  addNote(text) {
    if (!this._firingFile) {
      this.log(`note (no active firing): ${text}`);
      return;
    }
    this.log(`note: ${text}`);
  }

  // For tests + WS introspection.
  get activeFiring() {
    return this._firingFile ? {
      firingId: this._firingId,
      path: this._firingFile,
      meta: this._firingMeta,
    } : null;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  _fileSlug(d) {
    // YYYY-MM-DD_HHMMSS — lexically sortable, no spaces.
    const date = (d instanceof Date) ? d : new Date(d);
    return date.getFullYear() + '-' +
      String(date.getMonth() + 1).padStart(2, '0') + '-' +
      String(date.getDate()).padStart(2, '0') + '_' +
      String(date.getHours()).padStart(2, '0') +
      String(date.getMinutes()).padStart(2, '0') +
      String(date.getSeconds()).padStart(2, '0');
  }

  _titleSlug(title) {
    return (title || 'untitled').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'untitled';
  }

  _fmtDateTime(d) {
    const date = (d instanceof Date) ? d : new Date(d);
    return date.getFullYear() + '-' +
      String(date.getMonth() + 1).padStart(2, '0') + '-' +
      String(date.getDate()).padStart(2, '0') + ' ' +
      String(date.getHours()).padStart(2, '0') + ':' +
      String(date.getMinutes()).padStart(2, '0') + ':' +
      String(date.getSeconds()).padStart(2, '0');
  }

  _fmtDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '–';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h}h ${m}m ${s}s`;
  }

  _renderHeader(title, fields) {
    let out = `=== ${title} ===\n`;
    const labels = Object.keys(fields);
    const w = Math.max(...labels.map(l => l.length));
    for (const label of labels) {
      out += label.padEnd(w + 2) + fields[label] + '\n';
    }
    out += '\n';
    return out;
  }

  _renderSummaryFields(meta, summary) {
    const s = summary || {};
    const fields = {
      Schedule: meta?.title || '(untitled)',
      Started:  this._fmtDateTime(meta?.startedAt || s.startedAt || new Date()),
      Completed: this._fmtDateTime(s.completedAt || new Date()),
    };
    if (s.runtimeSeconds != null)   fields['Total runtime']   = this._fmtDuration(s.runtimeSeconds);
    if (s.firingSeconds != null)    fields['Firing time']     = this._fmtDuration(s.firingSeconds);
    if (s.cooldownSeconds != null)  fields['Cool-down time']  = this._fmtDuration(s.cooldownSeconds);
    if (s.maxTempF != null)         fields['Max temperature'] = `${s.maxTempF.toFixed(0)}°F (${((s.maxTempF - 32) * 5/9).toFixed(0)}°C)`;
    if (s.maxCone)                  fields['Max cone']        = s.maxCone;
    if (s.coneIndex != null)        fields['Cone index']      = s.coneIndex.toFixed(2);
    if (s.kwh != null)              fields['Energy']          = `${s.kwh.toFixed(2)} kWh${s.costUSD != null ? ` ($${s.costUSD.toFixed(2)})` : ''}`;
    if (s.loadKg != null)           fields['Load']            = `${s.loadKg} kg (m·c ${s.heatCapJK?.toLocaleString() || '?'} J/K)`;
    if (s.endReason)                fields['End reason']      = s.endReason;
    fields['Mode'] = meta?.mode === 'simulation' ? 'simulation' : 'real';
    return fields;
  }
}

module.exports = { Logger };
