'use strict';

// Thermal simulation model ported from ukiln.pas
// Models heat loss using polynomial regression from L&L Kilns HVAC data

// Heat loss in watts at given temperature
function heatLossAtTempC(tempC) {
  if (tempC <= 38) return 0;
  return 0.001741 * tempC * tempC + 2.184254 * tempC - 157.973796;
}

// Vent fan heat loss in watts at given temperature
function ventHeatLossAtTempC(tempC) {
  const intakeAirTempC = 50;
  const ventFlowCFM = 25;
  const cfm2cmm = 0.028;       // cfm to m^3/min
  const heatCapAir = 1.005;    // kJ/kg*K
  const densityAir = 1.2754;   // kg/m^3

  const kgPerSec = (ventFlowCFM * cfm2cmm) * densityAir / 60;
  return (tempC - intakeAirTempC) * kgPerSec * (heatCapAir / 1000);
}

// Estimated kiln heat capacity in J/K
function estimatedKilnHeatCapacity() {
  // kiln mass ~360 lbs (use half), load ~70 lbs = ~140kg
  // brick (fired clay) heat cap: 545 J/(kg*K)
  return 140 * 545;
}

// Estimated max firing rate in C/hr at given temp
function estimatedMaxFireRate(tempC) {
  return ((48000 * 240) - heatLossAtTempC(tempC)) / estimatedKilnHeatCapacity();
}

// Estimated max cooling rate in C/hr at given temp
function estimatedMaxCoolRate(tempC) {
  return (heatLossAtTempC(tempC) / estimatedKilnHeatCapacity()) * 3600;
}

// Update simulated temps based on element firing and heat loss
// Called each heartbeat when in simulation mode
// proportions: fraction of kiln mass per ring [0.35, 0.30, 0.35]
function updateSimulatedTemps(elements, tempSensors, proportions) {
  const heatCap = estimatedKilnHeatCapacity();

  for (let i = 0; i < 3; i++) {
    const secondsOn = elements[i].secondsOnSinceLastChecked;
    const watts = elements[i].watts;
    const tempC = tempSensors[i].lastReadingC || tempSensors[i].simulatedTempC;
    const prop = proportions[i];

    // wattSeconds = heat input - heat loss
    const ws = secondsOn * watts - heatLossAtTempC(tempC) * prop;

    // deltaTemp = wattSeconds / (heat capacity * proportion of mass)
    const dt = ws / (heatCap * prop);

    tempSensors[i].simulatedTempC = tempSensors[i].simulatedTempC + dt;
  }
}

module.exports = {
  heatLossAtTempC,
  ventHeatLossAtTempC,
  estimatedKilnHeatCapacity,
  estimatedMaxFireRate,
  estimatedMaxCoolRate,
  updateSimulatedTemps,
};
