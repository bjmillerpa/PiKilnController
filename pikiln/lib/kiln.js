'use strict';

const EventEmitter = require('events');
const {
  CYCLE_LENGTH_SECONDS, HEARTBEATS_PER_CYCLE, HEARTBEAT_RING,
  MIN_FIRE_TIME_SECONDS, ERROR_TEMP_SENSOR, COST_PER_KWH,
  GPIO_HEAT, GPIO_VENT_FAN, GPIO_SPI_CS, THERMOCOUPLE_OFFSETS, AMBIENT_TEMP_C,
  FAN_BALANCE_ON_F, FAN_BALANCE_OFF_F,
  c2f, cph2fph,
} = require('./constants');
const { GpioProvider } = require('./gpio-provider');
const { TempSensor } = require('./temp-sensor');
const { Pid } = require('./pid');
const { Relay, Element } = require('./relay');
const { SafetyMonitor } = require('./safety');
const { updateSimulatedTemps } = require('./simulation');
const { ortonConeFromIndex, arrheniusRate, coneIndexFromH } = require('./orton-cones');
const thermalModel = require('./thermal-model');
const { modelTimeToCoolHrs, modelMaxFireRateCpHr } = thermalModel;
const { COOL_ENOUGH_TEMP_C, MAX_RING_SPREAD_F, RING_END_SPREAD_F, RING_END_WITHIN_F, f2c } = require('./constants');

class Kiln extends EventEmitter {
  constructor(config, logger, perfLog) {
    super();

    // Run lifecycle:
    //   off / idle  → no firing, no heartbeats
    //   running     → executing the schedule, PID active
    //   cooling     → schedule finished but kiln still hot; monitoring temps,
    //                 elements off; transitions to idle when max temp < 120°F
    //   complete    → cooled, perf record sealed, firing-lock released
    // hold/pause are *sub-states* of running (kept in this.holdState).
    this.mode = 'off';
    this.holdState = null;             // null | 'hold' | 'pause'
    this._holdTargetC = null;          // for hold: the temp we lock to
    this._holdStartedAt = 0;           // ms timestamp when entering hold/pause
    this.fanMode = 'off';
    this._heartbeats = 0;
    this._startTime = null;
    this._lastTime = null;
    // Peak temp across the whole run, in C. Updated every heartbeat that has
    // a valid reading; used by getFiringSummary() to record what the kiln
    // actually achieved (schedule.history holds per-ring spot reads, not the
    // max across all sensors, so it's not reliable for the peak figure).
    this._peakTempC = -Infinity;
    // Diagnostic mode — disables every "software fallback" that would mask a
    // thermocouple fault during hardware bring-up (cap/ferrite tuning).
    // When on: sensor fault-debounce drops to 1 sample (every transient
    // surfaces as a fault), _currentTempC stops falling back to sibling
    // rings (a faulted ring's PID gets ERROR_TEMP_SENSOR and that ring
    // simply doesn't fire this beat), and SafetyMonitor's all-failed
    // persistence window collapses to 5 s. Toggled from the Tests tab via
    // the `setDiagnosticMode` WS command. Don't leave it on for normal
    // firings — EMI bursts that would normally be filtered out can
    // emergency-stop the kiln in seconds.
    this._diagnosticMode = false;
    // Fan-balance thresholds. Override from config.fanBalance.{onF,offF} —
    // defaults come from constants and can be tweaked at runtime via the
    // Controls-tab sliders (so the operator can tune empirically during a
    // running firing). Stored as °F to match the UI; converted to °C in
    // _applyBalanceFan.
    this._fanBalance = {
      onF:  config?.fanBalance?.onF  ?? FAN_BALANCE_ON_F,
      offF: config?.fanBalance?.offF ?? FAN_BALANCE_OFF_F,
    };
    // Operator-set kiln load in kg (ware + furniture). Adds to the bare-brick
    // m·c via thermal-model so time-to-cool, max-fire-rate, and the sim's
    // thermal evolution all reflect the actual mass in the chamber. Default
    // 0 (empty) so a fresh install with no setting acts like the bare kiln.
    this._loadKg = Math.max(0, Math.min(100, Number(config?.loadKg) || 0));
    thermalModel.setLoadKg(this._loadKg);
    // Per-ring Arrhenius integral H = ∫ exp(-Ea/RT) dt. Drives the cone-
    // progress reading (schedule.maxConeIndex) via coneIndexFromH(). Reset
    // on each kiln.start() so a fresh firing starts with zero accumulated
    // exposure. Accumulated in _doHeartbeat using each ring's last cached
    // reading, with dt = 1 second (the heartbeat period). One value per
    // ring because each thermocouple measures a different physical position
    // and "max cone reached" is naturally max(per-ring H).
    this._arrheniusH = [0, 0, 0];
    this.schedule = null;
    this._logger = logger;
    this._perf = perfLog || null;
    this._lastFanOn = null;
    this._lastSegment = null;
    this._lastNotifiedThresholdF = 0;  // for 200°F-stepping pushover notifications
    this._coolingStartTime = null;
    this._config = config;

    const gpio = new GpioProvider();
    this.simulation = gpio.simulation;
    this._gpioProvider = gpio;  // exposed for hardware-bring-up debug commands

    // Hardware objects
    this.ventFan = new Relay(GPIO_VENT_FAN, gpio);
    this.elements = GPIO_HEAT.map(pin => new Element(pin, gpio));
    // Per-ring thermocouples. We wire each sensor's edge-triggered fault
    // callbacks back into the logger + perf-log so the firing record
    // captures every individual ring's fault transitions — even when the
    // controller's sibling-ring fallback covers for the fault and keeps
    // firing. Without this, intermittent EMI affecting one ring at a time
    // is silent in the logs (state.sensorFaults shows it live but it's
    // never written to disk), which makes hardware tuning experiments
    // like Bruce's cap/ferrite comparison impossible to analyze after
    // the fact.
    this.tempSensors = GPIO_SPI_CS.map((cs, i) => {
      const s = new TempSensor(cs, THERMOCOUPLE_OFFSETS[i], gpio);
      const ring = i + 1;
      s.onError = (errors) => {
        const codes = Array.from(errors).join('+') || 'fault';
        const lastGood = s._buffer.find(b => !b.isError);
        const tempC = lastGood ? lastGood.tempC : null;
        const tempLabel = (tempC != null)
          ? `last good ${(tempC * 9 / 5 + 32).toFixed(0)}°F`
          : 'no prior reading';
        this._logger.log(`Ring ${ring} sensor faulted: ${codes} (${tempLabel})`);
        if (this._perf) this._perf._write('sensor-fault', {
          r: ring,
          codes,
          tC: tempC != null ? Math.round(tempC * 100) / 100 : null,
        });
      };
      s.onRecover = (durationSec) => {
        this._logger.log(`Ring ${ring} sensor recovered after ${durationSec.toFixed(1)}s`);
        if (this._perf) this._perf._write('sensor-recover', {
          r: ring,
          durSec: Math.round(durationSec * 100) / 100,
        });
      };
      return s;
    });

    // Initialize simulated temps
    if (this.simulation) {
      for (const s of this.tempSensors) s.simulatedTempC = AMBIENT_TEMP_C;
    }

    // PID controllers
    Pid.clearSisters();
    const pid = config.pid || {};
    const rings = pid.rings || [{}, {}, {}];
    this.pids = rings.map(r =>
      new Pid(r.p || 5, r.i || 3, r.d || 3));

    this.safety = new SafetyMonitor(this, logger, config);
    this._heartbeatTimer = null;

    // Ring-balance thresholds. Two regimes: a normal spread (default 15°F)
    // for the bulk of the firing, and a tighter end-approach spread (default
    // 3°F) once the kiln is within END_WITHIN of the schedule's peak target.
    // Each can be overridden via env (PIKILN_MAX_RING_SPREAD_F /
    // PIKILN_END_SPREAD_F / PIKILN_END_WITHIN_F) or config.balance.*.
    const pickF = (envVal, cfgVal, def) => {
      const f = Number(envVal ?? cfgVal ?? def);
      return Number.isFinite(f) && f > 0 ? f : def;
    };
    const normalSpreadF = pickF(
      process.env.PIKILN_MAX_RING_SPREAD_F,
      config?.balance?.maxRingSpreadF,
      MAX_RING_SPREAD_F,
    );
    const endSpreadF = pickF(
      process.env.PIKILN_END_SPREAD_F,
      config?.balance?.endSpreadF,
      RING_END_SPREAD_F,
    );
    const endWithinF = pickF(
      process.env.PIKILN_END_WITHIN_F,
      config?.balance?.endWithinF,
      RING_END_WITHIN_F,
    );
    this._maxRingSpreadC = normalSpreadF * 5 / 9;
    this._endRingSpreadC = endSpreadF    * 5 / 9;
    this._endWithinC     = endWithinF    * 5 / 9;

    // Always-on heartbeat. Runs at 1 Hz from construction onward; reads
    // sensors in idle mode too, so the dashboard shows live temps even when
    // the kiln is off. Only the running/cooling branches drive PID and fire
    // elements — see _doHeartbeat. .unref() lets the process exit cleanly
    // (SIGTERM stops the timer before any of this would matter, but the
    // belt-and-suspenders cost nothing).
    const intervalMs = (CYCLE_LENGTH_SECONDS * 1000) / HEARTBEATS_PER_CYCLE;
    this._heartbeatTimer = setInterval(() => this._doHeartbeat(), intervalMs);
    this._heartbeatTimer.unref?.();
  }

  start() {
    if (!this.schedule) throw new Error('No schedule loaded');
    if (this.mode === 'running' || this.mode === 'cooling') {
      throw new Error('Already running');
    }

    this.mode = 'running';
    this.holdState = null;
    this._holdTargetC = null;
    this._holdStartedAt = 0;
    this._startTime = Date.now();
    this._lastTime = this._startTime;
    this._heartbeats = 0;
    this._lastNotifiedThresholdF = 0;
    this._coolingStartTime = null;
    this._peakTempC = -Infinity;
    this._arrheniusH = [0, 0, 0];
    // Reset per-element on-time so power/kWh stats reflect THIS firing only.
    // Without this, the firing summary's Energy field shows lifetime watt-
    // hours since the Pi booted — accurate as a meter reading but useless
    // for comparing firings or estimating per-load cost.
    this.elements.forEach(e => e.resetSecondsOn());
    this.ventFan.resetSecondsOn();
    this.pids.forEach(p => p.reset());

    // Reset schedule runtime state, then jump into whichever segment matches
    // the current kiln temperature. For a cold kiln that's segment 0 from the
    // top; for a warm kiln (restart after Stop, or partial cool-down) we skip
    // the lower segments so the schedule resumes from where the kiln actually
    // is rather than wasting cycles re-doing the warm-up.
    this.schedule.currentSegment = 0;
    this.schedule._segmentStartTime = 0;
    this.schedule.history = [[], [], []];
    this.schedule.maxConeIndex = 0;
    this._resumeScheduleAtCurrentTemp();

    this.safety.start();
    // Heartbeat timer is already running from the constructor; we just
    // reset the beat counter so the first ring update after start is ring 1.
    this._heartbeats = 0;

    this._logger.log(`Kiln started${this.simulation ? ' (simulation)' : ''}`);
    this._lastSegment = this.schedule.currentSegment;
    this._lastFanOn = null;
    // Apply fan mode now that we're transitioning into 'running' — picks up
    // auto-mode's per-segment fan setting without waiting for the first
    // heartbeat beat to fire, and lets a pre-set 'on' actually start the
    // fan at the moment of Start rather than 5 s later.
    this._updateFan();
    if (this._perf) this._perf.scheduleStart(this.schedule.metadata.title || '', this.simulation);
    this.emit('started');
    this.emit('firing-state-change', true);
  }

  // Fast-forward the loaded schedule so it picks up from wherever the kiln
  // actually is now, rather than re-ramping through segments the kiln has
  // already passed. Called from start() and from saveSchedule when the
  // running schedule is edited mid-firing.
  _resumeScheduleAtCurrentTemp() {
    const currentTempC = this._currentMaxTempC();
    const ambient = this._config?.ambient ?? 21;
    if (!Number.isFinite(currentTempC) || currentTempC < ambient + 5) {
      // Cold kiln (or no sensors yet); start from the top normally.
      return;
    }
    const s = this.schedule;
    const now = Date.now();

    // Skip past every segment the kiln has already heated through. After the
    // loop, `prevTemp` is the start temp of the segment we land in (the end
    // temp of the previous segment, or ambient for segment 0).
    let i = 0, prevTemp = ambient;
    while (i < s.noSegments && s.temps[i] <= currentTempC) {
      prevTemp = s.temps[i];
      i++;
    }

    if (i >= s.noSegments) {
      // Kiln is hotter than the schedule's highest target — nothing left to
      // ramp to. Mark the schedule as past its last segment; the next
      // heartbeat will see targetTempC === -1 and enter cooling mode.
      s.currentSegment = s.noSegments;
      s._segmentStartTime = now;
      s._startTime = now;
      s._startTempC = currentTempC;
      this._logger.log(`Resuming: kiln at ${(currentTempC * 9 / 5 + 32).toFixed(0)}°F is past schedule end — entering cooling`);
      return;
    }

    // Inside segment i. If kiln is between prevTemp and the segment's target,
    // backdate _segmentStartTime so targetTempC produces the matching target
    // right out of the gate (no PID transient as the schedule "catches up").
    // Below prevTemp (e.g. resumed after a cool-down): start the segment now
    // and let the schedule ramp from prevTemp; the PID will fire to catch up.
    const rate = s.rates[i];
    let tIntoSegmentHrs = 0;
    if (rate > 0 && currentTempC > prevTemp) {
      tIntoSegmentHrs = (currentTempC - prevTemp) / rate;
      s._segmentStartTime = now - tIntoSegmentHrs * 3600 * 1000;
    } else {
      s._segmentStartTime = now;
    }
    // _startTime is the schedule's GLOBAL start (= x=0 on the firing curve).
    // We backdate it by the total time the schedule WOULD have spent in
    // all completed segments plus the time-into-this-segment, so history
    // points pushed during this resumed firing land at the same x as the
    // planned curve they belong with. Otherwise actual data appears in
    // the first-segment region of the chart instead of where the schedule
    // really is. Mirrors the per-segment accounting in asXYGraph().
    let elapsedHrs = tIntoSegmentHrs;
    let lastT = ambient;
    for (let k = 0; k < i; k++) {
      const segRate = s.rates[k];
      if (segRate !== 0) {
        elapsedHrs += Math.abs((s.temps[k] - lastT) / segRate);
      }
      elapsedHrs += (s.holdTimes[k] || 0) / 60;
      lastT = s.temps[k];
    }
    s._startTime = now - elapsedHrs * 3600 * 1000;
    s._startTempC = prevTemp;
    s.currentSegment = i;
    s._inHold = false;
    this._logger.log(`Resuming at ${(currentTempC * 9 / 5 + 32).toFixed(0)}°F into segment ${i + 1}/${s.noSegments} (x=${(elapsedHrs * 60).toFixed(0)} min on firing curve)`);
  }

  // Cap on PID duty-cycle output for the current segment, derived from how
  // overpowered the kiln is relative to the schedule's planned rate.
  // Returns 1.0 — i.e. no cap — when:
  //   - hold or pause mode (PID needs full authority to maintain target)
  //   - schedule rate is 0 (means "full speed", user wants ASAP)
  //   - target is descending (different dynamics; elements only fire to
  //     brake the natural cool-down, which is a separate problem)
  // Otherwise:
  //   - 1.5× the steady-state duty needed to track the ramp during catch-up
  //   - 0.5× steady-state in the final 10°F of approach, so the kiln's
  //     thermal momentum carries it to target without overshooting
  // Even with the cap, the PID receives it (see compute(target, actual,
  // maxOutput)) so its anti-windup respects the same ceiling and the
  // integral doesn't quietly wind up while we're externally clamped.
  _segmentDutyCap(currentTempC) {
    if (this.holdState) return 1.0;
    if (!this.schedule || this.schedule.currentSegment >= this.schedule.noSegments) return 1.0;
    const segIdx  = this.schedule.currentSegment;
    const segRate = Math.abs(this.schedule.rates[segIdx] || 0);
    if (segRate === 0) return 1.0;
    const segEnd  = this.schedule.temps[segIdx];
    if (segEnd <= currentTempC) return 1.0;
    const modelMax = modelMaxFireRateCpHr(currentTempC);
    if (modelMax <= 0) return 1.0;
    const steadyDuty = segRate / modelMax;
    // Catch-up cap: 5× steady-state. The cap only meaningfully limits
    // output when the schedule asks for much less than the kiln's max
    // rate — which is only the slow-ramp (candle) case. At typical
    // pottery rates (200–500 °F/hr at peak) steady-state is already
    // 30–60 % of kiln max, so 5× saturates at 1.0 and the PID has full
    // authority. For a 60 °F/hr candle at low temp, steady is ~6 % and
    // the cap caps at 30 % — still enough headroom to track the planned
    // ramp without runaway, while the PID's cap-aware anti-windup
    // handles the soft landing onto target.
    //
    // We DON'T tighten further near the segment-end target. The PID's
    // external-cap-aware anti-windup (PID.compute(target, actual, maxOutput))
    // already handles overshoot — integral freezes at the cap, so when
    // error flips negative the output drops cleanly. A "final approach"
    // tightening, on the other hand, left the kiln stuck at equilibrium
    // just below the segment-end target when the L&L heat-loss model
    // underestimates real heat loss (Bruce's kiln, ~2×). Don't re-add
    // this without per-kiln calibration of heatLossW(T).
    return Math.min(1.0, steadyDuty * 5.0);
  }

  _currentMaxTempC() {
    // Skip faulted sensors — their `lastReadingC` is the last-good value from
    // before the fault, NOT a current reading. Including it would pollute
    // cooling-complete / hold-target / progress-threshold / schedule-resume
    // decisions with a stuck number that drifts further from reality every
    // minute as the kiln moves.
    return this.tempSensors.reduce((max, s) => {
      if (s.hasError) return max;
      const v = s.lastReadingC;
      if (!Number.isFinite(v) || v <= -999) return max;
      return v > max ? v : max;
    }, -Infinity);
  }

  // Return {spreadC, thresholdC} if this ring's reading exceeds the active
  // spread threshold over the coolest *other* ring's reading; otherwise null.
  // Threshold is normally `_maxRingSpreadC` but tightens to `_endRingSpreadC`
  // once the kiln's hottest reading is within `_endWithinC` of the schedule's
  // peak target — this is where matching final cone matters most.
  _exceedsRingSpread(ringIdx, currentTempC) {
    let minOther = Infinity;
    for (let i = 0; i < this.tempSensors.length; i++) {
      if (i === ringIdx) continue;
      // Skip faulted sensors — their `lastReadingC` is stale and would let a
      // long-disconnected pre-fault number masquerade as a live reading,
      // which either suppresses a balance skip that should happen (stale low
      // value drags minOther down → spread looks small) or triggers a false
      // skip (stale high value → spread looks small the other direction).
      if (this.tempSensors[i].hasError) continue;
      const v = this.tempSensors[i].lastReadingC;
      if (!Number.isFinite(v) || v <= -999) continue;
      if (v < minOther) minOther = v;
    }
    // With only one healthy sensor left, balance is meaningless (nothing to
    // compare against) and we return null so the PID's output passes through
    // untouched. The fault-fallback in _currentTempC keeps firing going by
    // using the lone good sensor as the input for every ring.
    if (minOther === Infinity) return null;
    const spreadC = currentTempC - minOther;
    const thresholdC = this._activeRingSpreadC();
    return spreadC > thresholdC ? { spreadC, thresholdC } : null;
  }

  // Pick the spread threshold for right now: tighter when we're within the
  // end-approach window of the schedule's peak target, otherwise normal.
  _activeRingSpreadC() {
    if (!this.schedule || !this.schedule.temps || this.schedule.temps.length === 0) {
      return this._maxRingSpreadC;
    }
    const peakC = Math.max(...this.schedule.temps);
    const maxC = this._currentMaxTempC();
    if (Number.isFinite(maxC) && maxC >= peakC - this._endWithinC) {
      return this._endRingSpreadC;
    }
    return this._maxRingSpreadC;
  }

  stop() {
    // Heartbeat keeps running — we still want to read sensors in idle.
    this.elements.forEach(e => e.emergencyOff());
    this.ventFan.turnOff();

    // Record stats
    if (this.schedule) {
      this.schedule.metadata['KWHrs per run'] = this.elapsedPowerKWHr.toFixed(1);
      this.schedule.metadata['cost per run'] = (this.elapsedPowerKWHr * COST_PER_KWH).toFixed(2);
      this.schedule.metadata['time per run'] = this._formatElapsed();
      this.schedule.metadata['last start'] = this._formatDateTime(this._startTime);
      this.schedule.metadata['last finish'] = this._formatDateTime(Date.now());
      try { this.schedule.save(); } catch (e) { /* ignore save errors */ }
    }

    this.mode = 'idle';
    this.safety.stop();
    this._logger.log('Kiln stopped');
    if (this._perf) this._perf.scheduleStop('user');
    this.emit('stopped');
    this.emit('firing-state-change', false);
  }

  emergencyStop(reason) {
    // Heartbeat keeps running — we still want to read sensors after e-stop.
    this.elements.forEach(e => e.emergencyOff());
    this.ventFan.turnOff();

    this.mode = 'off';
    this.safety.stop();
    if (this._perf) this._perf.emergencyStop(reason);
    this.emit('emergency-stop', reason);
    this.emit('firing-state-change', false);
  }

  // Toggle diagnostic mode — see the field comment in the constructor for
  // semantics. Applied immediately to all dependents (sensors + safety).
  setDiagnosticMode(enabled) {
    const next = !!enabled;
    if (next === this._diagnosticMode) return;
    this._diagnosticMode = next;
    // Per-sensor: 1 confirms instantly; default 3 keeps the 3-of-3 debounce.
    for (const s of this.tempSensors) s.setFaultConfirmCount(next ? 1 : 3);
    // Safety: collapse persistence window so all-failed triggers e-stop fast,
    // making sustained EMI immediately visible during hardware sanity checks.
    // The SafetyMonitor remembers its configured value internally so we can
    // restore exactly when leaving diagnostic mode.
    this.safety.setDiagnosticMode(next);
    this._logger.log(`Diagnostic mode: ${next ? 'ENABLED — fault filters off' : 'disabled'}`);
  }

  _doHeartbeat() {
    const tickStart = Date.now();
    // Slow-tick warning: if more than 2 s have elapsed since the last
    // heartbeat, something between then and now blocked the event loop.
    // Log the gap so future stall diagnosis has a starting point — without
    // this, an SD-card I/O stall or a pigpio SPI lockup just shows up as
    // an emergency stop with no context. 2 s threshold leaves the normal
    // 1 s cadence (with small jitter) silent.
    if (this._lastTickAt && tickStart - this._lastTickAt > 2000) {
      this._logger.log(`slow tick: ${tickStart - this._lastTickAt}ms since last heartbeat (event loop blocked)`);
    }
    this._lastTickAt = tickStart;

    this._heartbeats++;
    this.safety.recordHeartbeat();

    // Simulation: update temps based on element firing and thermal model
    if (this.simulation) {
      updateSimulatedTemps(this.elements, this.tempSensors, [0.35, 0.30, 0.35]);
    }

    // Sample all three thermocouples every heartbeat (1 Hz per sensor). This
    // is much faster than the per-ring PID cadence (one ring per 5 s) — the
    // extra reads feed the sample buffer inside TempSensor for fault debounce
    // and median temperature smoothing. Total SPI cost: 3 × ~1 ms = ~3 ms per
    // second, well under any meaningful CPU budget. With the 3-of-last-3
    // confirmation rule, a real fault still surfaces within 3 s while EMI
    // transients (element-switching coupling into thermocouple wires) get
    // filtered out before they ever reach the UI.
    for (const s of this.tempSensors) s.sample();

    // Arrhenius cone-progress integration. Every heartbeat (1 Hz), each
    // ring's cached temperature contributes dH = exp(-Ea/RT) · 1s of work
    // toward bending its cone. We integrate during both 'running' and
    // 'cooling' because the kiln is still hot during cool-down and continues
    // to add real exposure — that's why glaze ware can over-fire on a slow
    // cool. Idle is excluded (no schedule, nothing to track).
    if (this.schedule && (this.mode === 'running' || this.mode === 'cooling')) {
      for (let i = 0; i < this.tempSensors.length; i++) {
        if (this.tempSensors[i].hasError) continue;
        const t = this.tempSensors[i].lastReadingC;
        if (Number.isFinite(t)) this._arrheniusH[i] += arrheniusRate(t);
      }
      // Max cone reached = highest H across all rings, mapped via the
      // precomputed H_CRIT table. maxConeIndex is monotone non-decreasing.
      const maxH = Math.max(...this._arrheniusH);
      const arrConeIdx = coneIndexFromH(maxH);
      if (arrConeIdx > this.schedule.maxConeIndex) {
        this.schedule.maxConeIndex = arrConeIdx;
      }
    }

    // Which ring to update this beat?
    const beatInCycle = this._heartbeats % HEARTBEATS_PER_CYCLE;
    const ring = HEARTBEAT_RING[beatInCycle]; // 1, 2, or 3 (or undefined)

    if (ring && this.schedule && this.mode === 'running') {
      const ringIdx = ring - 1;
      const currentTemp = this._currentTempC(ringIdx);

      if (currentTemp === ERROR_TEMP_SENSOR) {
        this._logger.error(`All sensors failed on ring ${ring} update`);
        if (this._perf) this._perf.sensorError(ring, 'all sensors failed');
      } else {
        if (currentTemp > this._peakTempC) this._peakTempC = currentTemp;
        // Decide target: hold/pause override the schedule's ramp.
        //   hold   → lock to the temperature captured when Hold was clicked
        //   pause  → 0 (PID asks for nothing → no firing → kiln coasts down)
        //   normal → schedule.targetTempC() drives the ramp
        let targetTemp;
        if (this.holdState === 'hold') {
          targetTemp = this._holdTargetC;
        } else if (this.holdState === 'pause') {
          targetTemp = 0;
        } else {
          targetTemp = this.schedule.targetTempC(currentTemp, ringIdx);
        }

        if (targetTemp === -1) {
          this._enterCoolingMode();
        } else {
          // Duty cap for the current segment — caps how hard we fire while
          // tracking a slow ascending ramp. Without this, a 60°F/hr candle
          // segment lets the PID fire at near-full duty whenever it falls
          // behind the trajectory, then overshoots the segment-end target
          // as the kiln coasts on residual heat. We pass the cap INTO the
          // PID so its anti-windup respects it — otherwise the integral
          // keeps growing while we're externally clamped, and the cap
          // becomes a band-aid that delays but doesn't prevent overshoot.
          const dutyCap = this._segmentDutyCap(currentTemp);
          let rate = this.pids[ringIdx].compute(targetTemp, currentTemp, dutyCap);
          if (dutyCap < 1.0 && this.pids[ringIdx].lastOutput > dutyCap + 0.01) {
            this._logger.log(`${ring} duty cap: PID wanted ${(this.pids[ringIdx].lastOutput * 100).toFixed(0)}% → capped at ${(dutyCap * 100).toFixed(0)}% (schedule rate vs kiln max @${c2f(currentTemp).toFixed(0)}°F)`);
          }
          let seconds = rate * CYCLE_LENGTH_SECONDS;

          // Ring-balance: if this ring is too hot relative to the others,
          // skip firing this cycle. The PID still updates (its integral keeps
          // accumulating so it'll fire harder when balance lifts), but the
          // element stays off — including any in-flight firing from a prior
          // start() call. Catches the runaway-when-all-PIDs-saturate case
          // that sister-balancing in pid.js can't. Only checked when this
          // cycle wants to fire OR a prior firing is still running; on
          // cool-down segments with no demand and no in-flight element,
          // the skip would be a no-op and just adds noise to the log.
          if (seconds > MIN_FIRE_TIME_SECONDS || this.elements[ringIdx].isOn) {
            const balanceSkip = this._exceedsRingSpread(ringIdx, currentTemp);
            if (balanceSkip) {
              this.elements[ringIdx].emergencyOff();
              seconds = 0;
              this._logger.log(
                `${ring} balance skip: ${c2f(currentTemp).toFixed(0)}°F is ${(balanceSkip.spreadC * 9 / 5).toFixed(0)}°F above coolest ring (max ${(balanceSkip.thresholdC * 9 / 5).toFixed(0)}°F)`
              );
            }
          }

          if (seconds > MIN_FIRE_TIME_SECONDS) {
            this.elements[ringIdx].start(seconds);
          }

          // Fan control
          this._updateFan();

          this._logger.log(
            `${ring} Tc: ${c2f(currentTemp).toFixed(1)} Tt: ${c2f(targetTemp).toFixed(1)} rate: ${rate.toFixed(2)} secs: ${seconds.toFixed(1)}`
          );

          this._checkProgressThresholds();

          // Telemetry — record one row per ring update; this is the data-mining stream
          if (this._perf) {
            this._perf.ringUpdate({
              ring,
              tempC: currentTemp,
              targetC: targetTemp,
              rate,
              seconds,
              mode: this.holdState || this.mode,
              segment: this.schedule.currentSegment,
              elements: this.elements.map(e => e.isOn),
              fanOn: this.ventFan.isOn,
              coneIndex: this.schedule.maxConeIndex,
              kwh: this.elapsedPowerKWHr,
            });

            // Segment advance — fires once when the schedule rolls forward
            if (this.schedule.currentSegment !== this._lastSegment) {
              this._perf.segmentAdvance(this._lastSegment, this.schedule.currentSegment);
              this._lastSegment = this.schedule.currentSegment;
            }
            // Fan state change — only on transition
            const fanOn = this.ventFan.isOn;
            if (this._lastFanOn !== fanOn) {
              this._perf.fanChange(fanOn, this.fanMode);
              this._lastFanOn = fanOn;
            }
          }
        }
      }
    } else if (ring && this.mode === 'cooling') {
      // Cool-down monitoring: read sensors, record perf data, watch for
      // "cool enough to open" (< 120°F). No PID, no element firing.
      const ringIdx = ring - 1;
      const currentTemp = this._currentTempC(ringIdx);
      if (currentTemp !== ERROR_TEMP_SENSOR) {
        if (currentTemp > this._peakTempC) this._peakTempC = currentTemp;
        // Same per-ring log cadence as running mode — gives the UI's
        // LogViewer a heartbeat-of-life signal during the long cool-down
        // and lets a human see the curve descending.
        this._logger.log(`${ring} cooling Tc: ${c2f(currentTemp).toFixed(1)}°F`);
        // Keep the firing curve growing during cool-down so each ring's
        // line extends past the schedule's planned end. x is in hours since
        // the schedule's start (the UI converts to minutes at the wire
        // boundary). One entry per ring per cooling beat — identical
        // cadence to running mode.
        if (this.schedule && this.schedule._startTime) {
          this.schedule.history[ringIdx].push({
            x: (Date.now() - this.schedule._startTime) / (60 * 60 * 1000),
            y: currentTemp,
          });
        }
        if (this._perf) {
          this._perf.ringUpdate({
            ring,
            tempC: currentTemp,
            targetC: 0,
            rate: 0,
            seconds: 0,
            mode: 'cooling',
            segment: this.schedule?.currentSegment ?? null,
            elements: this.elements.map(e => e.isOn),
            fanOn: this.ventFan.isOn,
            coneIndex: this.schedule?.maxConeIndex ?? null,
            kwh: this.elapsedPowerKWHr,
          });
        }
      }
      // Done cooling? Check the *max* of all working sensors so we don't
      // declare done because one sensor cooled but another is still hot.
      const maxC = this._currentMaxTempC();
      if (Number.isFinite(maxC) && maxC < COOL_ENOUGH_TEMP_C) {
        this._finishCoolDown(maxC);
      }
    }
    // Idle-mode sensor reads happen automatically: the per-sensor sample()
    // calls at the top of this method run every heartbeat regardless of
    // mode, so the dashboard shows live temps when the kiln is off and chip
    // faults surface within the 3-sample debounce window.

    this._lastTime = Date.now();
    this.emit('heartbeat', this.getStatus());
  }

  // Try preferred ring's sensor, fall back to others on error
  // Return this ring's debounced temperature, with fallback to a healthy
  // sister ring if this one is faulted. Reads from the per-sensor buffer
  // (no fresh SPI call) — the heartbeat already populated it at the top
  // of _doHeartbeat. This is what makes one-thermocouple-only operation
  // work: a faulted ring's PID gets driven from a working ring's reading,
  // and the median filter has already smoothed out single-sample spikes.
  //
  // In diagnostic mode the sibling fallback is disabled — a faulted ring
  // gets ERROR_TEMP_SENSOR and stops firing, so the operator can see in
  // the log exactly which ring is misbehaving during cap/ferrite tuning.
  _currentTempC(ringIdx) {
    if (this._diagnosticMode) {
      const s = this.tempSensors[ringIdx];
      return s.hasError ? ERROR_TEMP_SENSOR : s.lastReadingC;
    }
    const order = [ringIdx, (ringIdx + 1) % 3, (ringIdx + 2) % 3];
    for (const i of order) {
      const s = this.tempSensors[i];
      if (!s.hasError) return s.lastReadingC;
    }
    return ERROR_TEMP_SENSOR;
  }

  // Public setter: change fan mode AND apply it to the relay immediately.
  // The previous "just mutate kiln.fanMode" approach left the physical fan
  // out of sync until the next ring-update beat applied it via _updateFan
  // — which never fires when the kiln is idle or cooling, so the run-tab
  // off/on/auto buttons appeared dead.
  setFanMode(mode) {
    if (!['off', 'auto', 'on', 'balance'].includes(mode)) {
      throw new Error(`Invalid fan mode: ${mode}`);
    }
    this.fanMode = mode;
    this._updateFan();
  }

  _updateFan() {
    switch (this.fanMode) {
      case 'off': this.ventFan.turnOff(); break;
      case 'on':  this.ventFan.turnOn(); break;
      case 'auto':
        // Auto follows the schedule's per-segment fan flag — only meaningful
        // while a firing is actually in progress. When idle, "auto" is a
        // future preference: the relay stays off so a stale schedule whose
        // segment-0 specified fan=on doesn't run the fan now. The mode itself
        // is preserved; it takes effect again at next kiln.start().
        if (this.schedule && (this.mode === 'running' || this.mode === 'cooling')) {
          if (this.schedule.fanOn) this.ventFan.turnOn();
          else this.ventFan.turnOff();
        } else {
          this.ventFan.turnOff();
        }
        break;
      case 'balance':
        this._applyBalanceFan();
        break;
    }
  }

  // Active ring-balance fan control. Runs the downdraft vent whenever the
  // TOP ring is more than FAN_BALANCE_ON_F hotter than the coolest other
  // ring; releases when the gap drops below FAN_BALANCE_OFF_F. The
  // hysteresis (ventFan.isOn determines the active threshold) prevents
  // relay chatter as the spread oscillates. Faulted sensors are skipped —
  // if the top sensor is faulted we can't make a balance decision, so we
  // err toward off. _updateFan is called every ring-update beat (~5 s
  // cadence), which is plenty for fan-cycling decisions.
  _applyBalanceFan() {
    const topIdx = this.tempSensors.length - 1;     // ring 3 (index 2)
    const topSensor = this.tempSensors[topIdx];
    if (topSensor.hasError) { this.ventFan.turnOff(); return; }
    const topTempC = topSensor.lastReadingC;
    let coolestOtherC = Infinity;
    for (let i = 0; i < topIdx; i++) {
      const s = this.tempSensors[i];
      if (s.hasError) continue;
      const t = s.lastReadingC;
      if (Number.isFinite(t) && t < coolestOtherC) coolestOtherC = t;
    }
    if (!Number.isFinite(coolestOtherC) || !Number.isFinite(topTempC)) {
      this.ventFan.turnOff();
      return;
    }
    const spreadF = (topTempC - coolestOtherC) * 9 / 5;
    if (this.ventFan.isOn) {
      if (spreadF < this._fanBalance.offF) this.ventFan.turnOff();
    } else {
      if (spreadF > this._fanBalance.onF) this.ventFan.turnOn();
    }
  }

  // Update the fan-balance ON/OFF spread thresholds (in °F). Called from
  // the Controls-tab sliders so the operator can tweak responsiveness mid-
  // firing. Constraints: ON must be > OFF (otherwise the hysteresis flips
  // and the relay chatters); OFF must be non-negative. Re-runs _updateFan
  // immediately if balance mode is currently active so the new thresholds
  // take effect on this beat.
  setFanBalanceThresholds({ onF, offF }) {
    const newOn  = Number.isFinite(onF)  ? Math.max(1, Math.min(60, onF))  : this._fanBalance.onF;
    let   newOff = Number.isFinite(offF) ? Math.max(0, Math.min(60, offF)) : this._fanBalance.offF;
    // Cross-field invariant: OFF must always be strictly below ON,
    // independent of which field was just updated. Otherwise the hysteresis
    // collapses and the relay would chatter at the boundary.
    if (newOff >= newOn) newOff = Math.max(0, newOn - 1);
    this._fanBalance = { onF: newOn, offF: newOff };
    if (this.fanMode === 'balance') this._updateFan();
  }

  // Update the assumed kiln load (kg of ware + furniture). Clamps to
  // [0, 100] kg — beyond that is outside realistic ranges for this kiln.
  // Pushes through to thermal-model so the next time-left/cool-time
  // calculation and the next sim heartbeat both use the new heat capacity.
  setLoadKg(kg) {
    const v = Math.max(0, Math.min(100, Number(kg) || 0));
    this._loadKg = v;
    thermalModel.setLoadKg(v);
  }

  get elapsedTimeSeconds() {
    if (!this._startTime) return 0;
    return ((this._lastTime || Date.now()) - this._startTime) / 1000;
  }

  get elapsedPowerKWHr() {
    return this.elements.reduce((sum, e) => sum + e.watts * e.secondsOn, 0) / (1000 * 3600);
  }

  getStatus() {
    return {
      mode: this.mode,
      holdState: this.holdState,
      holdTargetC: this._holdTargetC,
      coolingStartedAt: this._coolingStartTime,
      fanMode: this.fanMode,
      fan: { isOn: this.ventFan.isOn },
      fanBalance: { ...this._fanBalance },
      // Operator-set kiln load in kg + the derived total heat capacity.
      // Exposed so the Settings tab can show the current setting and the
      // resulting m·c (for operator intuition about how much the load matters).
      loadKg: this._loadKg,
      heatCapJK: thermalModel.getHeatCapJK(),
      elapsedSeconds: this.elapsedTimeSeconds,
      temps: this.tempSensors.map(s => s.lastReadingC),
      // Per-ring sensor fault state. `null` means healthy; a string code
      // names the fault (NO_CHIP / OC / SCG / SCV). Multiple codes get
      // joined ("OC+SCG" — rare).
      sensorFaults: this.tempSensors.map(s => {
        if (!s.hasError) return null;
        const errs = Array.from(s.errors);
        return errs.length ? errs.join('+') : 'fault';
      }),
      elements: this.elements.map(e => ({
        isOn: e.isOn,
        secondsOn: e.secondsOn,
      })),
      schedule: this.schedule ? {
        title: this.schedule.metadata.title || '',
        currentSegment: this.schedule.currentSegment,
        totalSegments: this.schedule.noSegments,
        // Schedule-driven hold flag: true while we're in the per-segment
        // hold period defined by the schedule's `hold:` field (distinct
        // from the operator-initiated kiln.holdState, which is in
        // state.holdState). The dashboard segment tile shows " hold"
        // when this is true so the operator can tell whether the kiln
        // is still ramping or sitting at the segment-end target.
        inHold: !!this.schedule._inHold,
        targetTempC: this.schedule.lastTargetTempC,
        timeLeftHrs: this.schedule.timeLeftHrs,
        cone: ortonConeFromIndex(this.schedule.maxConeIndex),
        maxConeIndex: this.schedule.maxConeIndex,
        // Per-ring histories, x in minutes (matches asXYGraph()). Each
        // entry is the time-series for one ring — the UI renders each as
        // its own colored line so the operator can see ring-to-ring spread
        // directly. Internal x is hours (the rate calc needs that); we
        // convert at the wire boundary.
        histories: this.schedule.history.map(arr =>
          arr.map(p => ({ x: p.x * 60, y: p.y }))),
        planned: this.schedule.asXYGraph(),
      } : null,
      powerKWHr: this.elapsedPowerKWHr,
      costPerKWH: COST_PER_KWH,
      // Modeled hours from current peak temp down to the 120°F safe-open
      // threshold using only natural heat loss (elements off, no fan). Null
      // when the kiln is already cool. The UI shows this during cooling
      // mode and any time the kiln is still warm. This is the L&L HVAC-data
      // model — when we have enough perf-log data we can replace it with a
      // per-kiln regression fit, and this field stays the same.
      timeToCoolHrs: (() => {
        const peakC = this._currentMaxTempC();
        if (!Number.isFinite(peakC)) return null;
        const hrs = modelTimeToCoolHrs(peakC);
        return hrs > 0 ? hrs : null;
      })(),
      simulation: this.simulation,
      diagnosticMode: this._diagnosticMode,
      timestamp: new Date().toISOString(),
    };
  }

  // Build a snapshot of run-summary data for the firing-log header. Called
  // by pikiln.js on cool-down-complete / stopped / emergency-stop to compose
  // the SUMMARY block at the top of the firing log. `endReason` is the event
  // name that triggered finalization (used to distinguish a normal completion
  // from a user abort or a SIGTERM-interrupted run).
  getFiringSummary(endReason) {
    const now = Date.now();
    const startedAt = this._startTime || now;
    const cooled = this._coolingStartTime || now;
    const peakC = Number.isFinite(this._peakTempC) ? this._peakTempC : this._currentMaxTempC();
    const coneIndex = this.schedule?.maxConeIndex || 0;
    return {
      startedAt: new Date(startedAt),
      completedAt: new Date(now),
      runtimeSeconds:  Math.max(0, (now - startedAt) / 1000),
      firingSeconds:   this._coolingStartTime
        ? Math.max(0, (cooled - startedAt) / 1000)
        : Math.max(0, (now - startedAt) / 1000),  // no cool-down recorded
      cooldownSeconds: this._coolingStartTime
        ? Math.max(0, (now - cooled) / 1000)
        : 0,
      maxTempF: Number.isFinite(peakC) ? (peakC * 9 / 5 + 32) : null,
      maxCone:  coneIndex > 0 ? ortonConeFromIndex(coneIndex) : null,
      coneIndex,
      kwh:     this.elapsedPowerKWHr,
      costUSD: this.elapsedPowerKWHr * COST_PER_KWH,
      // Stamp the assumed load + derived m·c into the firing record so the
      // offline analyzer can use the right thermal mass when back-fitting
      // the loss curve. Without this the analyzer would guess.
      loadKg:    this._loadKg,
      heatCapJK: thermalModel.getHeatCapJK(),
      endReason: endReason || 'completed',
    };
  }

  _formatElapsed() {
    const s = this.elapsedTimeSeconds;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  _formatDateTime(ms) {
    const d = new Date(ms);
    return d.getFullYear().toString() +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0') + '_' +
      String(d.getHours()).padStart(2, '0') +
      String(d.getMinutes()).padStart(2, '0') +
      String(d.getSeconds()).padStart(2, '0');
  }
}

function round2(n) { return n == null || !Number.isFinite(n) ? n : Math.round(n * 100) / 100; }
function round3(n) { return n == null || !Number.isFinite(n) ? n : Math.round(n * 1000) / 1000; }

// ── Cool-down + Hold/Pause + progress threshold helpers ────────────────
// Attached as instance methods so they share `this` with the rest of Kiln.

Kiln.prototype._enterCoolingMode = function () {
  if (this.mode === 'cooling') return;
  this._logger.log('Schedule complete — entering cool-down monitoring');
  this.mode = 'cooling';
  this.holdState = null;
  this._coolingStartTime = Date.now();
  // Elements off; fan stays under user control (Bruce may want it on to
  // speed cool-down, or off to slow it for fragile loads).
  this.elements.forEach(e => e.emergencyOff());
  if (this._perf) this._perf.scheduleComplete({
    kwh: round3(this.elapsedPowerKWHr),
    seconds: Math.round(this.elapsedTimeSeconds),
    coneIndex: this.schedule ? round2(this.schedule.maxConeIndex) : null,
  });
  this.emit('schedule-complete');
  // Note: we do NOT emit firing-state-change(false) here — cool-down is
  // still part of the run, so the firing-lock stays held and updates remain
  // refused until the kiln is actually cool.
};

Kiln.prototype._finishCoolDown = function (atMaxTempC) {
  // Heartbeat keeps running — we still want sensor readings post-firing.
  this.elements.forEach(e => e.emergencyOff());
  this.ventFan.turnOff();
  // Record final run stats on the schedule (same fields as stop()).
  if (this.schedule) {
    this.schedule.metadata['KWHrs per run'] = this.elapsedPowerKWHr.toFixed(1);
    this.schedule.metadata['cost per run'] = (this.elapsedPowerKWHr * 0.12).toFixed(2);
    this.schedule.metadata['time per run'] = this._formatElapsed();
    this.schedule.metadata['last start'] = this._formatDateTime(this._startTime);
    this.schedule.metadata['last finish'] = this._formatDateTime(Date.now());
    try { this.schedule.save(); } catch { /* ignore */ }
  }
  this.mode = 'idle';
  this.safety.stop();
  if (this._perf) this._perf._write?.('cool-down-complete', {
    atTempC: round2(atMaxTempC),
    coolingMinutes: round2((Date.now() - this._coolingStartTime) / 60000),
  });
  this._logger.log(`Cool-down complete (max sensor ${(atMaxTempC * 9 / 5 + 32).toFixed(0)}°F) — run finished`);
  this.emit('cool-down-complete', { atTempC: atMaxTempC });
  this.emit('firing-state-change', false);
};

// User pressed Hold. Lock target to current kiln temp; PID will maintain.
// Pauses the schedule clock so the firing resumes from this point on Resume.
Kiln.prototype.hold = function () {
  if (this.mode !== 'running') throw new Error('Not running');
  if (this.holdState) throw new Error(`Already in ${this.holdState}`);
  const t = this._currentMaxTempC();
  if (!Number.isFinite(t)) throw new Error('No valid sensor reading');
  this.holdState = 'hold';
  this._holdTargetC = t;
  this._holdStartedAt = Date.now();
  this._logger.log(`Holding at ${(t * 9 / 5 + 32).toFixed(0)}°F`);
  if (this._perf) this._perf._write?.('hold-start', { atTempC: round2(t) });
  this.emit('hold-state-change', this.holdState);
};

// User pressed Pause. Elements off, kiln coasts down. Schedule clock paused.
Kiln.prototype.pause = function () {
  if (this.mode !== 'running') throw new Error('Not running');
  if (this.holdState) throw new Error(`Already in ${this.holdState}`);
  this.holdState = 'pause';
  this._holdTargetC = null;
  this._holdStartedAt = Date.now();
  this.elements.forEach(e => e.emergencyOff());
  this._logger.log('Paused — elements off');
  if (this._perf) this._perf._write?.('pause-start', {});
  this.emit('hold-state-change', this.holdState);
};

Kiln.prototype.resume = function () {
  if (!this.holdState) throw new Error('Not in hold or pause');
  const heldFor = Date.now() - this._holdStartedAt;
  // Shift the schedule's clock forward so the ramp picks up where it left
  // off rather than jumping ahead by the hold duration.
  if (this.schedule) {
    this.schedule._startTime += heldFor;
    this.schedule._segmentStartTime += heldFor;
    if (this.schedule._holdStartTime) this.schedule._holdStartTime += heldFor;
  }
  const prev = this.holdState;
  this._logger.log(`Resumed after ${(heldFor / 60000).toFixed(1)} min ${prev}`);
  if (this._perf) this._perf._write?.('resume', { from: prev, durationMs: heldFor });
  this.holdState = null;
  this._holdTargetC = null;
  this._holdStartedAt = 0;
  this.emit('hold-state-change', null);
};

// Send a Pushover-style milestone notification when the kiln crosses each
// 200°F threshold during heat-up. Skipped during hold/pause and during
// cooling. Only ascending — descending thresholds aren't useful as separate
// notifications since cool-down complete is its own event.
Kiln.prototype._checkProgressThresholds = function () {
  if (this.holdState || this.mode !== 'running') return;
  const maxC = this._currentMaxTempC();
  if (!Number.isFinite(maxC)) return;
  const maxF = maxC * 9 / 5 + 32;
  // Don't fire below ~ambient
  if (maxF < 100) return;
  const nextThreshold = Math.floor(maxF / 200) * 200;
  if (nextThreshold > this._lastNotifiedThresholdF) {
    this._lastNotifiedThresholdF = nextThreshold;
    this.emit('progress-threshold', { tempF: nextThreshold });
  }
};

module.exports = { Kiln };
