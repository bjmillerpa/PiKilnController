'use strict';

// Lumped-parameter thermal model for the kiln. Used to estimate:
//   - max sustainable heating rate at a given temperature (for time-left
//     calculations when the schedule asks for more than the kiln can deliver)
//   - max sustainable cooling rate at a given temperature
//   - time required to cool from peak to the safe-open threshold
//
// Coefficients come from L&L Kilns' published HVAC data fit to a polynomial
// regression (heat loss as a function of internal temperature). Element power
// is 3 × 3840 W = 11520 W total; kiln + load mass is ~140 kg of brick at
// 545 J/(kg·K).
//
// This is an approximation. The polynomial fit covers the normal firing range
// (~150–1300 °C); below that we floor on a Newton's-law linear term so cool-
// down doesn't predict zero rate near ambient. Real kiln behavior depends on
// load mass, vent state, ambient temp, and element age — once we have enough
// perf-log data we can replace this module's coefficients with a per-kiln
// regression and the rest of the controller won't change.

const TOTAL_ELEMENT_W = 3 * 3840;        // three 240V·16A elements
const KILN_MASS_KG    = 140;             // bare brick, no load
const BRICK_HEAT_CAP_JKG_K = 545;
const HEAT_CAP_JK     = KILN_MASS_KG * BRICK_HEAT_CAP_JKG_K;  // 76,300 J/K — bare-brick baseline
// Specific heat of fired ceramic (ware + cordierite/mullite kiln furniture).
// 900 J/(kg·K) is the mid-range of porcelain (~800), stoneware (~850), and
// kiln-shelf refractories (~1000). One number for the lot is good enough
// at our level of precision.
const CERAMIC_LOAD_HEAT_CAP_JKG_K = 900;
const AMBIENT_C       = 21;
const SAFE_OPEN_C     = (120 - 32) * 5 / 9;  // 120°F → 48.9°C

// Operator-set kiln load in kg (ware + furniture). 0 = empty. The current
// effective m·c is the bare-brick baseline plus the load times its specific
// heat. setLoadKg() updates a module-level value used by the model functions
// below — it's mutable singleton state, which is fine since the whole
// controller is one kiln. Persistence lives upstream in userConfig.loadKg.
let _loadKg = 0;
function setLoadKg(kg) {
  const v = Number(kg);
  _loadKg = Number.isFinite(v) && v > 0 ? Math.min(v, 100) : 0;
}
function getLoadKg() { return _loadKg; }
function getHeatCapJK() {
  return HEAT_CAP_JK + _loadKg * CERAMIC_LOAD_HEAT_CAP_JKG_K;
}

// Heat loss at internal temperature, in watts.
//
// Calibrated against the 2026-06-12 empty-kiln calibration firing (3 holds
// at 301/500/700°C giving direct steady-state loss anchors). Least-squares
// fit to those three points: Q(T) = a·ΔT + b·ΔT²  where ΔT = T - T_amb.
// Residuals < 1.5% at all three anchors. The earlier L&L-polynomial baseline
// under-predicted loss by 2.3-3.0× — see scripts/analyze-thermal.js and the
// firing log 2026-06-12_131253_Thermal_Calibration.log for the derivation.
//
// Extrapolates to ~9.5 kW at cone 6 (1200°C) and ~10.5 kW at cone 10 (1300°C)
// — both under the 11.5 kW element ceiling, matching Bruce's observed cone-6
// capability. No explicit radiation term: with only three anchors topping
// out at 700°C the quartic is poorly constrained, and the quadratic captures
// enough curvature for our temperature range. Future high-temp calibrations
// can add c·(T_K⁴ - T_amb_K⁴) if needed.
function heatLossW(tempC) {
  if (!Number.isFinite(tempC) || tempC <= AMBIENT_C) return 0;
  const dT = tempC - AMBIENT_C;
  return 6.76 * dT + 1.11e-3 * dT * dT;
}

// Max sustainable heating rate at the given temperature, in C/hr.
// Net power = element power − heat loss; rate = net / heat capacity.
// (Old code had a unit-confused formula that returned ~constant 151 C/hr
// regardless of temperature; this is the corrected version.)
function modelMaxFireRateCpHr(tempC) {
  if (!Number.isFinite(tempC)) return 0;
  const netW = TOTAL_ELEMENT_W - heatLossW(tempC);
  if (netW <= 0) return 0;
  return netW * 3600 / getHeatCapJK();
}

// Max sustainable cooling rate at the given temperature, in C/hr (positive
// value meaning "temperature dropping at this rate"). Equal to heat-loss
// power divided by heat capacity — elements off, no fan.
function modelMaxCoolRateCpHr(tempC) {
  if (!Number.isFinite(tempC) || tempC <= AMBIENT_C) return 0;
  return heatLossW(tempC) * 3600 / getHeatCapJK();
}

// Estimated hours to cool from `fromTempC` down to the safe-open threshold
// (120 °F / ~49 °C by default). Numerical integration in 5°C steps using the
// max cooling rate at each step. Returns 0 if already cool. This is an
// upper-bound natural cool-down; opening the lid or running the vent fan
// will be faster.
function modelTimeToCoolHrs(fromTempC, toTempC = SAFE_OPEN_C) {
  if (!Number.isFinite(fromTempC) || fromTempC <= toTempC) return 0;
  let hrs = 0;
  let T = fromTempC;
  const stepC = 5;
  while (T > toTempC) {
    const rate = modelMaxCoolRateCpHr(T);
    if (rate <= 0) break;                  // ambient — would take forever
    const dT = Math.min(stepC, T - toTempC);
    hrs += dT / rate;
    T -= dT;
  }
  return hrs;
}

module.exports = {
  TOTAL_ELEMENT_W,
  HEAT_CAP_JK,                       // bare-brick baseline (analyzer reference)
  CERAMIC_LOAD_HEAT_CAP_JKG_K,
  AMBIENT_C,
  SAFE_OPEN_C,
  heatLossW,
  modelMaxFireRateCpHr,
  modelMaxCoolRateCpHr,
  modelTimeToCoolHrs,
  setLoadKg,
  getLoadKg,
  getHeatCapJK,
};
