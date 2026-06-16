'use strict';

class Pid {
  static sisters = [];

  constructor(kp, ki, kd) {
    this.kp = kp;
    this.ki = ki;
    this.kd = kd;
    this.integralSum = 0;
    this.lastError = 0;
    this.lastOutput = 0; // pre-clamped, used for sister balancing
    this.lastTime = Date.now();
    Pid.sisters.push(this);
  }

  compute(targetTemp, actualTemp, maxOutput = 1.0) {
    const now = Date.now();
    const seconds = (now - this.lastTime) / 1000;
    const error = targetTemp - actualTemp;

    // Anti-windup via conditional integration. Without this, during a long
    // saturated ramp the integral accumulates without bound (output clamps to
    // 1 but the maths keeps adding `error * dt` to the sum). When the kiln
    // finally reaches target and error flips negative, the integral term
    // still dominates and keeps the element firing for minutes — a 10°F+
    // overshoot in sim, and during a programmed cool-down that wind-up can
    // be larger than the entire planned descent. Standard fix: tentatively
    // compute the new integral and output; only commit the integral update
    // if doing so wouldn't drive output further into an existing saturation.
    //
    // `maxOutput` lets the caller (Kiln._doHeartbeat) impose an EXTERNAL
    // cap on this firing (e.g. the schedule's duty cap for low-temp ramps).
    // Anti-windup must respect that external cap too — otherwise the PID's
    // integral keeps growing while we're externally clamped, and when the
    // cap relaxes the output spikes and the kiln overshoots. By treating
    // maxOutput as the effective upper saturation limit, integral freezes
    // the moment we're at the cap, regardless of where uncapped output
    // would have landed.
    const newIntegral = this.integralSum + error * seconds;
    // Guard against dt=0 (same-ms calls would make derivative Infinity, and
    // kd=0 then yields NaN). Treat zero elapsed time as zero rate-of-change.
    const derivative = seconds > 0 ? (error - this.lastError) / seconds : 0;

    const output = (this.kp * error + this.ki * newIntegral + this.kd * derivative) / 100;

    if (output > maxOutput && error > 0) {
      // Saturated at upper bound (natural 1.0 or external cap) and error
      // would push integral higher — freeze it.
    } else if (output < 0 && error < 0) {
      // Saturated low and error would push integral lower — freeze it.
    } else {
      // Either not saturated, or saturated in the direction error helps
      // recover from. Commit the update.
      this.integralSum = newIntegral;
    }
    this.lastOutput = output; // store raw for sister balancing
    this.lastError = error;
    this.lastTime = now;

    // Clamp to [0, maxOutput]
    let clamped = Math.max(0, Math.min(maxOutput, output));

    // Sister balancing: if a sister has higher demand (>1), scale back
    // proportionally to prevent one zone from hogging
    let ratio = 1;
    for (const sister of Pid.sisters) {
      if (sister !== this) {
        const sisterOut = sister.lastOutput;
        if (sisterOut > 1 && sisterOut > this.lastOutput && this.lastOutput > 0) {
          const r = this.lastOutput / sisterOut;
          if (r < ratio) ratio = r;
        }
      }
    }

    return clamped * ratio;
  }

  reset() {
    this.integralSum = 0;
    this.lastError = 0;
    this.lastOutput = 0;
    this.lastTime = Date.now();
  }

  static clearSisters() {
    Pid.sisters.length = 0;
  }
}

module.exports = { Pid };
