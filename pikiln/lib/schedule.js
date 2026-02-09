'use strict';

const fs = require('fs');
const path = require('path');
const {
  AMBIENT_TEMP_C, CYCLE_LENGTH_SECONDS, RATE_LOOKBACK_SECONDS,
  MS_PER_MINUTE, MS_PER_HOUR,
  f2c, c2f, fph2cph, cph2fph,
} = require('./constants');
const { ortonConeToIndex, ortonConeFromIndex, calcOrtonConeIndex } = require('./orton-cones');

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
    this.rates = [];     // C/hr
    this.temps = [];     // C
    this.holdTimes = []; // minutes
    this.fanOns = [];    // boolean
    this.notes = [];     // string

    for (const seg of segments) {
      if (isStoredInF) {
        this.rates.push(fph2cph(seg.rate));
        this.temps.push(f2c(seg.temp));
      } else {
        this.rates.push(seg.rate);
        this.temps.push(seg.temp);
      }
      this.holdTimes.push(seg.hold || 0);
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
    this.history = []; // [{x: hours, y: tempC}, ...]
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

  // Core method: returns target temp in Celsius, or -1 when complete
  // Called by kiln on each ring update with the current reported temp
  targetTempC(reportedTempC) {
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

    // Update cone progress
    this._currFiringRateCpHr = this._actualFiringRateCpHr();
    this.currConeIndex = calcOrtonConeIndex(reportedTempC, this._currFiringRateCpHr);
    if (this.currConeIndex > this.maxConeIndex) {
      this.maxConeIndex = this.currConeIndex;
    }

    // Check for segment transition
    if (this._inHold) {
      // Hold expired?
      startNewSegment = (now - this._holdStartTime) >= this.holdTimes[this.currentSegment] * MS_PER_MINUTE;
    } else {
      // End temp reached?
      const goingUp = this.temps[this.currentSegment] > this._startTempC;
      const tempReached = goingUp
        ? (reportedTempC >= this.temps[this.currentSegment] || this._meetsCone())
        : (reportedTempC <= this.temps[this.currentSegment]);

      if (tempReached) {
        startHold = this.holdTimes[this.currentSegment] > 0;
        startNewSegment = !startHold;
        if (startHold) {
          this._inHold = true;
          this._holdStartTime = now;
          this._log(`starting ${this.holdTimes[this.currentSegment].toFixed(0)} min hold`);
          this._msg(`${this.holdTimes[this.currentSegment].toFixed(0)} min hold`);
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

    // Calculate time remaining
    if (this._inHold) {
      this.timeLeftHrs = ((this._holdStartTime + this.holdTimes[this.currentSegment] * MS_PER_MINUTE) - now) / MS_PER_HOUR;
    } else {
      this.timeLeftHrs = (segmentLengthHrs - timeIntoSegmentHrs) + this.holdTimes[this.currentSegment] / 60;
    }

    // Remaining segments
    for (let i = this.currentSegment + 1; i < this.noSegments; i++) {
      if (this.rates[i] === 0) {
        // Estimate time at max fire rate
        const midTemp = (this.temps[i] + this.temps[i - 1]) / 2;
        const maxRate = this._estimatedMaxFireRate(midTemp);
        if (maxRate > 0) {
          this.timeLeftHrs += Math.abs((this.temps[i] - this.temps[i - 1]) / maxRate);
        }
      } else {
        this.timeLeftHrs += Math.abs((this.temps[i] - this.temps[i - 1]) / this.rates[i]);
      }
      this.timeLeftHrs += this.holdTimes[i] / 60;
    }

    // Add to history
    this.history.push({
      x: (now - this._startTime) / MS_PER_HOUR,
      y: reportedTempC,
    });

    return result;
  }

  _meetsCone() {
    return this.targetConeIndex > 0 && this.maxConeIndex >= this.targetConeIndex;
  }

  _actualFiringRateCpHr() {
    const n = this.history.length;
    // Need ~10 minutes of history
    const minEntries = Math.round((CYCLE_LENGTH_SECONDS / 3) * 12 * 10);
    if (n < minEntries) return 0;

    const lookback = Math.max(3, n - Math.round(RATE_LOOKBACK_SECONDS / (CYCLE_LENGTH_SECONDS / 3)));

    // Average 3 points at each end so all 3 sensors are involved
    const endY = (this.history[n - 1].y + this.history[n - 2].y + this.history[n - 3].y) / 3;
    const endX = (this.history[n - 1].x + this.history[n - 2].x + this.history[n - 3].x) / 3;
    const startY = (this.history[lookback - 1].y + this.history[lookback - 2].y + this.history[lookback - 3].y) / 3;
    const startX = (this.history[lookback - 1].x + this.history[lookback - 2].x + this.history[lookback - 3].x) / 3;

    const dTemp = endY - startY;
    const dTime = endX - startX;
    if (dTime === 0) return 0;

    return dTemp / dTime; // C/hr
  }

  // Rough estimate for time-remaining calculation
  _estimatedMaxFireRate(tempC) {
    const heatLoss = 0.001741 * tempC * tempC + 2.184254 * tempC - 157.973796;
    const heatCap = 140 * 545;
    return ((48000 * 240) - Math.max(0, heatLoss)) / heatCap;
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
