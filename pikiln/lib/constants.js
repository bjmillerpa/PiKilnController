'use strict';

// Timing
const CYCLE_LENGTH_SECONDS = 15.0;
const MIN_FIRE_TIME_SECONDS = 0.5;
const HEARTBEATS_PER_CYCLE = 15;
const HEARTBEAT_RING = { 1: 1, 6: 2, 11: 3 }; // beat mod -> ring number (1-indexed)
const RATE_LOOKBACK_SECONDS = 1800; // 30 minutes

// SPI pins (software bit-bang against three Adafruit MAX31855 breakouts).
// BCM numbers; physical pins on Bruce's 40-pin ribbon are 23/21/11/12/13.
// MOSI isn't used — the MAX31855 is read-only. The kernel SPI driver must
// be disabled (raspi-config → Interface Options → SPI → Disable) because
// BCM 9/10/11 are the hardware SPI0 pins and the kernel would otherwise
// claim them.
const GPIO_SPI_CLOCK = 11;             // physical pin 23
const GPIO_SPI_DATA  = 9;              // physical pin 21 (MISO)
const GPIO_SPI_CS    = [17, 18, 27];   // physical pins 11/12/13 — CS for rings 1, 2, 3

// Relay GPIO pins. BCM numbers verified by the hardware-bring-up sweep on
// 2026-05-27 — earlier values were wiringPi numbering carried over from
// the Pascal port.
const GPIO_HEAT     = [21, 20, 26];    // physical pins 40/38/37 — H1, H2, H3
const GPIO_VENT_FAN = 16;              // physical pin 36

// Thermocouple calibration offsets (C)
const THERMOCOUPLE_OFFSETS = [0, 0, 0];

// Physical position of each ring in the kiln, indexed by ring (0..2). On
// Bruce's L&L the wiring ended up with ring 1 (BCM 21 heat, BCM 17 CS) at
// the BOTTOM of the stack and ring 3 (BCM 26 / 27) at the TOP. Controller
// logic doesn't care which is which — each ring has its own sensor, element,
// and PID — but the UI uses these labels so the operator can map a temp
// reading to a physical position at a glance. Flip these if the kiln is
// ever re-wired without rebuilding the firmware.
const RING_POSITION_LABELS = ['Bottom', 'Mid', 'Top'];

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
// Threshold below which we declare the kiln "cool enough to open" and end
// the run. Below 120°F (~49°C) the elements have been off for a while and
// thermal stress on the load is past.
const COOL_ENOUGH_TEMP_C = (120 - 32) * 5 / 9;

// Safety
const MAX_TEMP_C = 1300; // ~2372F absolute ceiling
// Element-on watchdog: with `_continuousOnStart` reset on every start() call,
// normal max time between control-loop interventions for one element is 15 s
// (one full heartbeat cycle). 30 s = 2× that — comfortably anomalous if hit.
const ELEMENT_MAX_ON_SECONDS = 30;
// Heartbeat watchdog — declare a stall and e-stop if _doHeartbeat hasn't run
// for this long. 15 s is loose enough to ride out SD-card write stalls
// (wear-leveling rebalance, dirty-page flush, log rotation), tight enough
// that a genuine event-loop hang (pigpio SPI lockup, runaway promise) still
// trips within reasonable time. Bruce hit false-positive e-stops at 5 s
// during quiet cool-down monitoring — pure I/O, no element firing.
// Override via config.safety.heartbeatTimeoutMs.
const HEARTBEAT_TIMEOUT_MS = 15000;
// Ring-balance: if the ring being updated is more than this much hotter than
// the coolest other ring, we force-skip its firing for this cycle (and turn
// the element off if it was still on from a previous start). The existing
// PID sister-balance only helps when one ring is saturated and others aren't;
// when *all* three saturate (climb rate the kiln can't sustain), uneven
// thermal mass otherwise lets one ring run away. 15°F default — override
// via PIKILN_MAX_RING_SPREAD_F.
const MAX_RING_SPREAD_F = 15;
// Tighter spread when the kiln is approaching its peak temperature. What
// matters most for the load is that all three rings reach the same final
// cone at the same time — so as we close in on the schedule's highest target,
// we clamp the spread harder. Defaults: 3°F spread allowed when within 25°F
// of peak. Overrides: PIKILN_END_SPREAD_F and PIKILN_END_WITHIN_F.
const RING_END_SPREAD_F  = 3;
const RING_END_WITHIN_F  = 25;

// Fan-balance mode thresholds. The "balance" fanMode actively cycles the
// vent fan to pull hot air down from the top ring (downdraft) whenever the
// top is significantly hotter than the coolest other ring. Fan turns ON
// when the gap exceeds FAN_BALANCE_ON_F; it stays on until the gap drops
// below FAN_BALANCE_OFF_F. The hysteresis prevents the relay from
// chattering as the spread oscillates near a single threshold.
//
// Bruce's empirical observation (2026-06-04): the L&L's downdraft vent
// significantly mixes the air column — during heat, top→bottom transfer
// closes the spread; during cool, top cools faster (which we want during
// post-firing but not during active balance).
const FAN_BALANCE_ON_F  = 8;
const FAN_BALANCE_OFF_F = 3;

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
  RING_POSITION_LABELS,
  PID_DEFAULTS,
  ELEMENT_WATTS,
  COST_PER_KWH,
  AMBIENT_TEMP_C,
  TEMP_CHANGE_THRESHOLD_C,
  ERROR_TEMP_SENSOR,
  COOL_ENOUGH_TEMP_C,
  MAX_TEMP_C,
  ELEMENT_MAX_ON_SECONDS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_RING_SPREAD_F,
  RING_END_SPREAD_F,
  RING_END_WITHIN_F,
  BRICK_HEAT_CAP,
  FAN_BALANCE_ON_F,
  FAN_BALANCE_OFF_F,
  MS_PER_MINUTE,
  MS_PER_HOUR,
  f2c, c2f, fph2cph, cph2fph,
};
