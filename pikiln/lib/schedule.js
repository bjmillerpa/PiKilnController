'use strict';

const fs = require('fs');
const path = require('path');
const {
  AMBIENT_TEMP_C, CYCLE_LENGTH_SECONDS, RATE_LOOKBACK_SECONDS,
  MS_PER_MINUTE, MS_PER_HOUR,
  f2c, c2f, fph2cph, cph2fph,
} = require('./constants');
const { ortonConeToIndex, ortonConeFromIndex, calcOrtonConeIndex } = require('./orton-cones');
const { modelMaxFireRateCpHr, modelMaxCoolRateCpHr } = require('./thermal-model');

class Schedule {
  constructor(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;

    // Extract metadata (everything that isn't 'segments')
    this.metadata = {};
    for (const key of Object.keys(data)) {
      if (key !== 'segments') {
        this.metadata[key] = data[key];
      }
    }

    // Defaults
    if (!this.metadata.title) this.metadata.title = 'untitled';
    if (!this.metadata['units-temp']) this.metadata['units-temp'] = '°F';
    if (!this.metadata['units-rate']) this.metadata['units-rate'] = '°F/hr';
    if (!this.metadata['units-hold']) this.metadata['units-hold'] = 'min';

    const isStoredInF = (this.metadata['units-temp'] || '').toLowerCase().includes('f');

    // Parse segments, converting to internal Celsius
    const segments = data.segments || [];
    this.noSegments = segments.length;
    this.rates = [];        // C/hr
    this.temps = [];        // C
    this.holdTimes = [];    // minutes (also serves as the cap when holdToCones[i] is set)
    this.holdToCones = [];  // cone string (e.g. "6", "04") or '' for fixed-time holds
    this.fanOns = [];       // boolean
    this.notes = [];        // string

    for (const seg of segments) {
      if (isStoredInF) {
        this.rates.push(fph2cph(seg.rate));
        this.temps.push(f2c(seg.temp));
      } else {
        this.rates.push(seg.rate);
        this.temps.push(seg.temp);
      }
      this.holdTimes.push(seg.hold || 0);
      this.holdToCones.push(typeof seg.holdToCone === 'string' ? seg.holdToCone.trim() : '');
      this.fanOns.push(!!seg.fanon);
      this.notes.push(seg.note || '');
    }

    // Runtime state
    this.currentSegment = 0;
    this._segmentStartTime = 0;
    this.timeLeftHrs = 0;
    this._startTempC = 0;
    this._startTime = 0;
    this.lastReportedTempC = 0;
    this.lastTargetTempC = 0;
    this._inHold = false;
    this._holdStartTime = 0;
    // Per-ring history: this.history[i] is the time-series for ring index i,
    // [{x: hours since start, y: tempC}, ...]. Three arrays so the firing-
    // curve can render each ring as its own line. _actualFiringRateCpHr
    // computes per-ring rates and averages them (was: averaged 3 consecutive
    // mixed points, which only worked because the old single array round-
    // robin'd between rings).
    this.history = [[], [], []];
    this.targetConeIndex = 0;
    this.currConeIndex = 0;
    this.maxConeIndex = 0;
    this._currFiringRateCpHr = 0;

    this.filename = '';
    this.changed = false;
    this._logger = null;
  }

  set logger(l) { this._logger = l; }

  _log(msg) { if (this._logger) this._logger.log(msg); }
  _msg(msg) { if (this._logger) this._logger.message(msg); }

  get fanOn() {
    if (this.currentSegment < this.noSegments) {
      return this.fanOns[this.currentSegment];
    } else if (this.currentSegment > 0) {
      return this.fanOns[this.currentSegment - 1];
    }
    return false;
  }

  // Core method: returns target temp in Celsius, or -1 when complete.
  // Called by kiln on each ring update with the current reported temp and
  // the ring index (0..2). ringIdx is used to route the history sample to
  // the right per-ring series. Defaults to 0 so older callers/tests that
  // don't pass it keep working — they just see everything on ring 1's line.
  targetTempC(reportedTempC, ringIdx = 0) {
    this.timeLeftHrs = 0;
    this.lastReportedTempC = reportedTempC;

    // Schedule complete?
    if (this.currentSegment >= this.noSegments) return -1;

    let startNewSegment = false;
    let startHold = false;
    const now = Date.now();
    let segmentLengthHrs = 0;
    let timeIntoSegmentHrs = 0;

    // First call initializes
    if (this.currentSegment === 0 && this._segmentStartTime === 0) {
      this._startTime = now;
      this._segmentStartTime = now;
      this._startTempC = reportedTempC;
      this.targetConeIndex = ortonConeToIndex(this.metadata.cone);
      if (this.targetConeIndex > 0) {
        this._log(`target cone: ${this.metadata.cone}`);
        this._msg(`target cone: ${this.metadata.cone}`);
      }
      this._log(`starting segment 0: ${this.rates[0].toFixed(0)}C/hr to ${this.temps[0].toFixed(0)}C ${this.holdTimes[0].toFixed(0)} min hold`);
      this._msg(`${c2f(this.temps[0]).toFixed(0)}F @ ${cph2fph(this.rates[0]).toFixed(0)}F/hr`);
    }

    // Current-cone display: chart interpolation against the present rate.
    // This is the "if I held this rate forever, what cone would the kiln
    // reach at this temperature" reading — useful as a live indicator but
    // not what we record as the firing's max cone.
    //
    // `maxConeIndex` is now driven by the Arrhenius integral in kiln._doHeart-
    // beat — it tracks accumulated time-at-temperature exposure correctly
    // during holds and slow soaks (where the chart's rate-dependent lookup
    // would freeze). We no longer bump it from currConeIndex here.
    this._currFiringRateCpHr = this._actualFiringRateCpHr();
    this.currConeIndex = calcOrtonConeIndex(reportedTempC, this._currFiringRateCpHr);

    // Check for segment transition
    if (this._inHold) {
      // Hold ends when either:
      //   (a) the fixed hold time has elapsed (`holdTimes[i]` minutes), OR
      //   (b) a per-segment cone target has been reached via accumulated heat
      //       work (when holdToCones[i] is set). The fixed-time check is then
      //       the safety cap — the kiln won't soak forever if the cone never
      //       quite tips. Whichever condition fires first wins.
      const holdElapsedMs = now - this._holdStartTime;
      const timeExpired = holdElapsedMs >= this.holdTimes[this.currentSegment] * MS_PER_MINUTE;
      const coneTargetIdx = this._segmentHoldConeIdx(this.currentSegment);
      const coneReached = coneTargetIdx > 0 && this.maxConeIndex >= coneTargetIdx;
      if (timeExpired || coneReached) {
        startNewSegment = true;
        // Tell the operator which condition ended the hold and what cone we
        // landed at — useful to know whether you got there on heat work or
        // had to time out.
        const heldMin = (holdElapsedMs / MS_PER_MINUTE).toFixed(1);
        const coneStr = ortonConeFromIndex(this.maxConeIndex);
        if (coneTargetIdx > 0 && coneReached) {
          this._log(`hold ended: reached cone ${this.holdToCones[this.currentSegment]} after ${heldMin} min`);
        } else if (coneTargetIdx > 0) {
          this._log(`hold ended: max ${this.holdTimes[this.currentSegment]} min reached (target was cone ${this.holdToCones[this.currentSegment]}; current cone ${coneStr})`);
        }
      }
    } else {
      // End temp reached? "Going up" is relative to THIS segment's start temp
      // (the previous segment's end, or the schedule's captured start temp
      // for segment 0) — not the schedule's global start. Using the global
      // start made every segment look up-bound when starting from a cold
      // kiln, so a programmed cool-down (e.g. 2200°F → 1500°F at -100°F/hr)
      // would satisfy `reportedTempC ≥ 1500` on entry and immediately advance
      // out of itself before any controlled descent could happen.
      const segStartTempC = this.currentSegment === 0
        ? this._startTempC
        : this.temps[this.currentSegment - 1];
      const goingUp = this.temps[this.currentSegment] > segStartTempC;
      const tempReached = goingUp
        ? (reportedTempC >= this.temps[this.currentSegment] || this._meetsCone())
        : (reportedTempC <= this.temps[this.currentSegment]);

      if (tempReached) {
        // A segment holds if it has a fixed hold time set OR specifies a
        // cone target (which uses the holdTime as its max-duration cap).
        const coneStr = this.holdToCones[this.currentSegment];
        startHold = this.holdTimes[this.currentSegment] > 0 || !!coneStr;
        startNewSegment = !startHold;
        if (startHold) {
          this._inHold = true;
          this._holdStartTime = now;
          if (coneStr) {
            const cap = this.holdTimes[this.currentSegment];
            this._log(`starting hold to cone ${coneStr} (max ${cap.toFixed(0)} min)`);
            this._msg(`hold to cone ${coneStr} (max ${cap.toFixed(0)} min)`);
          } else {
            this._log(`starting ${this.holdTimes[this.currentSegment].toFixed(0)} min hold`);
            this._msg(`${this.holdTimes[this.currentSegment].toFixed(0)} min hold`);
          }
        }
      }
    }

    // Advance segment
    if (startNewSegment) {
      this.currentSegment++;
      this._inHold = false;
      this._segmentStartTime = now;

      if (this.currentSegment >= this.noSegments) {
        this._log('schedule completed.');
        this._msg('schedule completed.');
        return -1;
      }
      this._log(`starting segment ${this.currentSegment}: ${this.temps[this.currentSegment].toFixed(0)}C @ ${this.rates[this.currentSegment].toFixed(0)}C/hr, ${this.holdTimes[this.currentSegment].toFixed(0)} min hold`);
      this._msg(`${c2f(this.temps[this.currentSegment]).toFixed(0)}F @ ${cph2fph(this.rates[this.currentSegment]).toFixed(0)}F/hr`);
    }

    // Calculate target temp
    let result;
    if (this._inHold) {
      result = this.temps[this.currentSegment];
    } else {
      const segEndTempC = this.temps[this.currentSegment];
      const segRate = this.rates[this.currentSegment];
      timeIntoSegmentHrs = (now - this._segmentStartTime) / MS_PER_HOUR;

      if (segRate === 0) {
        // Full speed
        result = segEndTempC;
      } else {
        const segStartTempC = this.currentSegment === 0
          ? AMBIENT_TEMP_C
          : this.temps[this.currentSegment - 1];

        segmentLengthHrs = Math.abs((segEndTempC - segStartTempC) / segRate);

        if (timeIntoSegmentHrs >= segmentLengthHrs) {
          result = segEndTempC;
        } else {
          result = segStartTempC + (timeIntoSegmentHrs / segmentLengthHrs) * (segEndTempC - segStartTempC);
        }
      }
    }

    this.lastTargetTempC = result;

    // Time remaining — uses a physical model rather than just the planned
    // schedule rate. For the current segment we use the kiln's actual recent
    // achieved rate when it's significantly slower than what the schedule
    // asked for (the "kiln can't keep up" case Bruce reported). For future
    // segments we cap the schedule's planned rate at the kiln's modeled max
    // at that temperature, so a too-aggressive ramp shows up as a more
    // realistic time. Both effects make the displayed Time Left honest about
    // a kiln that's already slipping behind plan.
    this.timeLeftHrs = this._modelTimeLeftHrs(reportedTempC, now);

    // Add to per-ring history
    const ringSlot = (ringIdx >= 0 && ringIdx < 3) ? ringIdx : 0;
    this.history[ringSlot].push({
      x: (now - this._startTime) / MS_PER_HOUR,
      y: reportedTempC,
    });

    return result;
  }

  _meetsCone() {
    return this.targetConeIndex > 0 && this.maxConeIndex >= this.targetConeIndex;
  }

  // Per-segment hold-to-cone target as a cone-index, or 0 if the segment is
  // a plain fixed-time hold. Returns 0 for unparseable / blank strings.
  _segmentHoldConeIdx(segIdx) {
    const s = this.holdToCones[segIdx];
    return s ? ortonConeToIndex(s) : 0;
  }

  // Average firing rate over the last RATE_LOOKBACK_SECONDS seconds. With
  // per-ring history each ring updates once every CYCLE_LENGTH_SECONDS (15s),
  // so the lookback window in samples = RATE_LOOKBACK_SECONDS / 15 = 120
  // samples per ring at the default 30 min lookback. We compute each ring's
  // rate independently and average them — that gives the same "all-rings
  // average" the old single-array implementation tried to achieve by
  // averaging three consecutive mixed points, but cleaner.
  _actualFiringRateCpHr() {
    const lookbackSamples = Math.round(RATE_LOOKBACK_SECONDS / CYCLE_LENGTH_SECONDS);
    const minSamples = 40; // ~10 min of per-ring data before we trust the rate
    const rates = [];
    for (let i = 0; i < this.history.length; i++) {
      const h = this.history[i];
      if (h.length < minSamples) continue;
      const endIdx   = h.length - 1;
      const startIdx = Math.max(0, endIdx - lookbackSamples);
      const dT = h[endIdx].y - h[startIdx].y;
      const dt = h[endIdx].x - h[startIdx].x;
      if (dt > 0) rates.push(dT / dt);
    }
    if (rates.length === 0) return 0;
    return rates.reduce((a, b) => a + b, 0) / rates.length;
  }

  // Pick the most credible rate to use for the *current* segment's remaining
  // time. The schedule rate is what was asked for; the model rate is the
  // physical ceiling at this temperature; the actual rate is what's actually
  // happening. The effective rate is min(schedule, model), but we honor the
  // observed slowness when the kiln has been measurably falling behind for
  // long enough that _actualFiringRateCpHr() has data (>10 min of history).
  _effectiveCurrentRateCpHr(reportedTempC) {
    const segRate    = Math.abs(this.rates[this.currentSegment]);
    const segEndC    = this.temps[this.currentSegment];
    const goingUp    = segEndC > reportedTempC;
    const modelMax   = goingUp
      ? modelMaxFireRateCpHr(reportedTempC)
      : modelMaxCoolRateCpHr(reportedTempC);
    if (segRate === 0) return modelMax;                 // "full speed"
    const ceiling = Math.min(segRate, modelMax);
    // If recent actual rate is significantly below the ceiling, the kiln is
    // slipping (cold day, weak element, etc.) — use the slip rather than the
    // optimistic ceiling so Time Left reflects reality. 10% deadband avoids
    // jitter from PID overshoot/undershoot during steady-rate ramps.
    const actual = Math.abs(this._actualFiringRateCpHr());
    if (actual > 0.1 && actual < ceiling * 0.9) return actual;
    return ceiling;
  }

  // Total remaining time across the rest of the schedule. Current segment
  // uses the effective rate above; future segments use the schedule rate
  // capped by the kiln's modeled max at each segment's mid-temperature.
  // Holds add their fixed duration. This is what `timeLeftHrs` exposes to
  // the UI and to the firing summary.
  _modelTimeLeftHrs(reportedTempC, now = Date.now()) {
    let total = 0;
    if (this._inHold) {
      total = ((this._holdStartTime + this.holdTimes[this.currentSegment] * MS_PER_MINUTE) - now) / MS_PER_HOUR;
    } else {
      const segEndC = this.temps[this.currentSegment];
      const tempRemainingC = Math.abs(segEndC - reportedTempC);
      if (tempRemainingC > 0.5) {
        const rate = this._effectiveCurrentRateCpHr(reportedTempC);
        if (rate > 0.1) total = tempRemainingC / rate;
      }
      total += this.holdTimes[this.currentSegment] / 60;
    }
    for (let i = this.currentSegment + 1; i < this.noSegments; i++) {
      const segStartC = this.temps[i - 1];
      const segEndC   = this.temps[i];
      const goingUp   = segEndC > segStartC;
      const tempDelta = Math.abs(segEndC - segStartC);
      const midC      = (segStartC + segEndC) / 2;
      const segRate   = Math.abs(this.rates[i]);
      const modelMax  = goingUp ? modelMaxFireRateCpHr(midC) : modelMaxCoolRateCpHr(midC);
      const effective = segRate === 0 ? modelMax : Math.min(segRate, modelMax);
      if (effective > 0.1) total += tempDelta / effective;
      total += this.holdTimes[i] / 60;
    }
    return Math.max(0, total);
  }

  // Generate XY pairs for schedule preview graph
  asXYGraph(asF = false) {
    const points = [];
    let sumMinutes = 0;
    let lastTemp = asF ? c2f(AMBIENT_TEMP_C) : AMBIENT_TEMP_C;
    points.push({ x: 0, y: lastTemp });

    for (let i = 0; i < this.noSegments; i++) {
      let temp, rate;
      if (asF) {
        temp = c2f(this.temps[i]);
        rate = cph2fph(this.rates[i]);
      } else {
        temp = this.temps[i];
        rate = this.rates[i];
      }

      // Ramp time
      if (rate !== 0) {
        sumMinutes += Math.abs(((temp - lastTemp) / rate) * 60);
      }
      points.push({ x: sumMinutes, y: temp });

      // Hold time
      sumMinutes += this.holdTimes[i];
      points.push({ x: sumMinutes, y: temp });

      lastTemp = temp;
    }
    return points;
  }

  asJSON() {
    const isStoredInF = (this.metadata['units-temp'] || '').toLowerCase().includes('f');
    const obj = { ...this.metadata };
    obj.segments = [];

    for (let i = 0; i < this.noSegments; i++) {
      const seg = {
        rate: isStoredInF ? cph2fph(this.rates[i]) : this.rates[i],
        temp: isStoredInF ? c2f(this.temps[i]) : this.temps[i],
        hold: this.holdTimes[i],
        fanon: this.fanOns[i],
        note: this.notes[i],
      };
      // Only emit holdToCone when set, so plain segments round-trip clean.
      if (this.holdToCones[i]) seg.holdToCone = this.holdToCones[i];
      obj.segments.push(seg);
    }
    return JSON.stringify(obj, null, 2);
  }

  save(filepath) {
    const fp = filepath || this.filename;
    if (!fp) return;
    fs.writeFileSync(fp, this.asJSON(), 'utf8');
    this.filename = fp;
    this.changed = false;
  }

  static loadFromFile(filepath) {
    const json = fs.readFileSync(filepath, 'utf8');
    const schedule = new Schedule(json);
    schedule.filename = filepath;
    return schedule;
  }

  static loadAll(schedulesDir) {
    const schedules = new Map();
    if (!fs.existsSync(schedulesDir)) return schedules;

    const files = fs.readdirSync(schedulesDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const schedule = Schedule.loadFromFile(path.join(schedulesDir, file));
        schedules.set(schedule.metadata.title, schedule);
      } catch (err) {
        console.error(`Error loading schedule ${file}: ${err.message}`);
      }
    }
    return schedules;
  }
}

module.exports = { Schedule };
