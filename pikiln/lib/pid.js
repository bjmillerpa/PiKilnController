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

  compute(targetTemp, actualTemp) {
    const now = Date.now();
    const seconds = (now - this.lastTime) / 1000;
    const error = targetTemp - actualTemp;

    this.integralSum += error * seconds;
    const derivative = (error - this.lastError) / seconds;

    const output = (this.kp * error + this.ki * this.integralSum + this.kd * derivative) / 100;
    this.lastOutput = output; // store raw for sister balancing
    this.lastError = error;
    this.lastTime = now;

    // Clamp to [0, 1]
    let clamped = Math.max(0, Math.min(1, output));

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
