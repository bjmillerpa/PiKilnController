'use strict';

// Thermal simulation model. SIM-ONLY — none of this runs on real hardware,
// where actual thermocouples replace the simulated temps.
//
// Design goals: the sim should feel like a real kiln, not a perfect math
// machine. Real kilns have asymmetric ring temps, run harder than a clean
// polynomial fit predicts, and let the top ring drift hot enough to trip
// fan-balance. The defaults here are tuned against the Glass-Slumping
// firing analyzed by scripts/analyze-thermal.js — see help doc
// "thermal-analysis" for the methodology.

// Single thermal-model handle for both loss and heat-capacity delegation.
// After the 2026-06-12 empty-kiln calibration, sim and live share the same
// measured-kiln loss curve and the same load-adjusted m·c — the sim no
// longer needs its own scaled L&L polynomial.
const thermalModel = require('./thermal-model');

// Baseline heat loss in watts at temp °C.
function heatLossAtTempC(tempC) {
  return thermalModel.heatLossW(tempC);
}

// Vent fan heat loss in watts at given temperature.
function ventHeatLossAtTempC(tempC) {
  const intakeAirTempC = 50;
  const ventFlowCFM = 25;
  const cfm2cmm = 0.028;       // cfm to m^3/min
  const heatCapAir = 1.005;    // kJ/kg*K
  const densityAir = 1.2754;   // kg/m^3

  const kgPerSec = (ventFlowCFM * cfm2cmm) * densityAir / 60;
  return (tempC - intakeAirTempC) * kgPerSec * (heatCapAir / 1000);
}

// Estimated kiln heat capacity in J/K. Bare brick = 76,300 J/K; each kg of
// operator-specified ceramic load adds ~900 J/K on top (calibrated against
// the 2026-06-13 loaded firing: 67 kg load → 930 J/(kg·K), rounded to 900).
// With Settings-tab loadKg = 0 the sim runs empty-kiln fast; bump it to
// 20–40 kg to make the sim feel like a typical glaze firing.
function estimatedKilnHeatCapacity() {
  return thermalModel.getHeatCapJK();
}

// Estimated max firing rate in C/hr at given temp.
function estimatedMaxFireRate(tempC) {
  return ((48000 * 240) - heatLossAtTempC(tempC)) / estimatedKilnHeatCapacity();
}

// Estimated max cooling rate in C/hr at given temp.
function estimatedMaxCoolRate(tempC) {
  return (heatLossAtTempC(tempC) / estimatedKilnHeatCapacity()) * 3600;
}

// Per-ring heat-loss multiplier [bottom, mid, top]. Hot air rises and
// pools at the top, so the top ring loses less to the surroundings than
// the bottom (which sinks heat through the floor / stand). This is the
// asymmetry that makes real kilns naturally run hot at the top — and the
// reason fan-balance exists in the first place. Without it, all three
// rings track within ~1°F and balance never engages.
const RING_LOSS_MULTIPLIER = [1.35, 1.00, 0.60];

// Inter-ring conduction in W/K. Heat flows between adjacent rings
// proportional to their temp difference. Without coupling, the
// asymmetric loss multipliers would let the rings drift to unphysical
// extremes during fast ramps. 25 W/K means a 50°C gradient drives
// ~1250 W of inter-ring flow — significant but well below a single
// element's 3840 W peak, so the rings can still diverge meaningfully
// when the PID is saturated on one ring.
const RING_COUPLING_W_PER_K = 25;

// Update simulated temps based on element firing, heat loss, asymmetric
// per-ring losses, and inter-ring conduction. Called each heartbeat
// (~1 Hz) when in simulation mode.
function updateSimulatedTemps(elements, tempSensors, proportions) {
  const heatCap = estimatedKilnHeatCapacity();
  // Snapshot temps before any update so coupling sees a consistent state
  // across all three rings (otherwise ring 1's new temp would already be
  // baked into ring 2's coupling term).
  const T = tempSensors.map(s => s.simulatedTempC);

  for (let i = 0; i < 3; i++) {
    const secondsOn = elements[i].secondsOnSinceLastChecked;
    const watts = elements[i].watts;
    const tempC = T[i];
    const prop  = proportions[i];
    const lossMult = RING_LOSS_MULTIPLIER[i];

    // Heat flow from adjacent rings — positive into this ring when a
    // neighbor is hotter, negative when this ring is hotter. Each
    // heartbeat is implicitly 1 second so watts ≡ joules-per-tick.
    let couplingJ = 0;
    if (i > 0) couplingJ += (T[i - 1] - tempC) * RING_COUPLING_W_PER_K;
    if (i < 2) couplingJ += (T[i + 1] - tempC) * RING_COUPLING_W_PER_K;

    // Energy balance (J over the implicit 1-second heartbeat):
    //   element on-time × watts  +  coupling  -  heat-loss × prop × lossMult
    const ws = secondsOn * watts + couplingJ - heatLossAtTempC(tempC) * prop * lossMult;
    const dt = ws / (heatCap * prop);
    tempSensors[i].simulatedTempC = tempC + dt;
  }
}

module.exports = {
  heatLossAtTempC,
  ventHeatLossAtTempC,
  estimatedKilnHeatCapacity,
  estimatedMaxFireRate,
  estimatedMaxCoolRate,
  updateSimulatedTemps,
  RING_LOSS_MULTIPLIER,
  RING_COUPLING_W_PER_K,
};
