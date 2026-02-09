'use strict';

// Timing
const CYCLE_LENGTH_SECONDS = 15.0;
const MIN_FIRE_TIME_SECONDS = 0.5;
const HEARTBEATS_PER_CYCLE = 15;
const HEARTBEAT_RING = { 1: 1, 6: 2, 11: 3 }; // beat mod -> ring number (1-indexed)
const RATE_LOOKBACK_SECONDS = 1800; // 30 minutes

// SPI pins (software bit-bang)
const GPIO_SPI_CLOCK = 22;
const GPIO_SPI_DATA = 17;
const GPIO_SPI_CS = [0, 1, 2]; // CS for rings 1, 2, 3

// Relay GPIO pins
const GPIO_HEAT = [29, 28, 25]; // element relays for rings 1, 2, 3
const GPIO_VENT_FAN = 27;

// Thermocouple calibration offsets (C)
const THERMOCOUPLE_OFFSETS = [0, 0, 0];

// PID defaults
const PID_DEFAULTS = { p: 5, i: 3, d: 3 };

// Element specs
const ELEMENT_WATTS = 240 * 16; // 3840W per element

// Cost
const COST_PER_KWH = 0.12;

// Temperature
const AMBIENT_TEMP_C = 21;
const TEMP_CHANGE_THRESHOLD_C = 0.5; // slightly less than 1F
const ERROR_TEMP_SENSOR = -9999;

// Safety
const MAX_TEMP_C = 1300; // ~2372F absolute ceiling
const ELEMENT_MAX_ON_SECONDS = 20;
const HEARTBEAT_TIMEOUT_MS = 5000;

// Thermal model (brick = fired clay)
const BRICK_HEAT_CAP = 545.0; // J/(kg*K)

// Time formatting
const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

// Temperature conversions
function f2c(f) { return (f - 32) * 5 / 9; }
function c2f(c) { return c * 9 / 5 + 32; }
function fph2cph(fph) { return fph * 5 / 9; }
function cph2fph(cph) { return cph * 9 / 5; }

module.exports = {
  CYCLE_LENGTH_SECONDS,
  MIN_FIRE_TIME_SECONDS,
  HEARTBEATS_PER_CYCLE,
  HEARTBEAT_RING,
  RATE_LOOKBACK_SECONDS,
  GPIO_SPI_CLOCK,
  GPIO_SPI_DATA,
  GPIO_SPI_CS,
  GPIO_HEAT,
  GPIO_VENT_FAN,
  THERMOCOUPLE_OFFSETS,
  PID_DEFAULTS,
  ELEMENT_WATTS,
  COST_PER_KWH,
  AMBIENT_TEMP_C,
  TEMP_CHANGE_THRESHOLD_C,
  ERROR_TEMP_SENSOR,
  MAX_TEMP_C,
  ELEMENT_MAX_ON_SECONDS,
  HEARTBEAT_TIMEOUT_MS,
  BRICK_HEAT_CAP,
  MS_PER_MINUTE,
  MS_PER_HOUR,
  f2c, c2f, fph2cph, cph2fph,
};
