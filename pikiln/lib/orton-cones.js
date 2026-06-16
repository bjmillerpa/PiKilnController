'use strict';

const { c2f, cph2fph } = require('./constants');

// Orton cone data: final temperatures in Fahrenheit at three ramp rates
const CONE_NAMES = [
  '10','9','8','7','6','5','4','3','2','1',
  '01','02','03','04','05','06','07','08','09','010',
  '011','012','013','014','015','016','017','018',
];

const TEMPS_27 = [
  2284,2235,2212,2194,2165,2118,2086,2039,2034,2028,
  1999,1972,1960,1915,1870,1798,1764,1692,1665,1636,
  1575,1549,1485,1395,1382,1368,1301,1267,
];

const TEMPS_108 = [
  2345,2300,2273,2262,2232,2167,2142,2106,2088,2079,
  2046,2016,1987,1945,1888,1828,1789,1728,1688,1657,
  1607,1582,1539,1485,1456,1422,1360,1252,
];

const TEMPS_270 = [
  2381,2336,2320,2295,2269,2205,2161,2138,2127,2109,
  2080,2052,2019,1971,1911,1855,1809,1753,1706,1679,
  1641,1620,1582,1540,1504,1465,1405,1283,
];

// Cone string -> numeric index (73-100 scale)
// Cone 10 = 100, Cone 1 = 91, Cone 01 = 90, Cone 018 = 73
function ortonConeToIndex(coneStr) {
  if (!coneStr) return 0;
  const x = parseFloat(coneStr);
  if (isNaN(x)) return 0;
  if (coneStr.startsWith('0')) return 91 - x;
  return x + 90;
}

// Numeric index -> cone string. Returns:
//   '-'    no measurable heat work accumulated yet (coneIndex == 0)
//   '<018' some accumulated H but below the coolest tabulated cone (018 = idx 73)
//   '<NNN' string for valid cone (e.g. '018', '06', '6', '10', '6.5')
//
// The '<018' band is meaningful — Arrhenius integration starts the moment the
// kiln is above ambient, so the index begins climbing before any real ceramic
// transformation has happened. Showing fake low-cone strings (e.g. '041',
// which isn't a real cone) for those intermediate values was misleading.
function ortonConeFromIndex(coneIndex) {
  if (!Number.isFinite(coneIndex) || coneIndex <= 0) return '-';
  coneIndex = Math.floor(coneIndex * 10) / 10;
  // Below cone 018 (idx 73): some heat-work done but not enough to bend
  // even the lowest-temp cone in Orton's table.
  if (coneIndex < 73) return '<018';
  if (coneIndex >= 91) {
    const val = coneIndex - 90;
    return val === Math.floor(val) ? String(val) : val.toFixed(1);
  }
  // 73 <= coneIndex < 91 → cones 018 .. 01 (cool-end of the table)
  const val = 91 - coneIndex;
  const s = val === Math.floor(val) ? String(val) : val.toFixed(1);
  return '0' + s;
}

// ── Arrhenius cone model ────────────────────────────────────────────────
//
// Orton's chart approach (calcOrtonConeIndex below) reads end-point temp
// from a 3-rate lookup table and interpolates. That's right for steady
// ramps in the 27..270 °F/hr range — Orton calibrated the tables by
// integrating the same Arrhenius rate law we use here at those reference
// rates — but it can't represent time-at-temperature exposure during a
// hold. A 30-min peak hold accumulates real Arrhenius work the chart
// doesn't see (chart says "you're at this rate, you need this temp";
// during a hold rate→0, the chart's lookup column gets pinned to the
// slowest tabulated rate and the cone-progress reading freezes).
//
// The integral H = ∫₀ᵗ exp(-Ea/RT(τ)) dτ is rate-independent: any path
// through (T,t) that reaches the same H bends the same cone. H_CRIT[i] is
// the accumulated H at the moment cone CONE_NAMES[i] is "done", calibrated
// against the published TEMPS_108 endpoint table at 108 °F/hr.
//
// Ea = 170 kcal/mol. The literature value (Hesselberth) of ~91 kcal/mol
// characterizes the bend-visualization step, but fitting *Orton's published
// tables* directly across the 27 / 108 / 270 °F/hr columns wants a much
// higher effective Ea — see the calibration sweep in orton-cones.test.js.
// At 170 we get ~0.5 cones RMS error across the off-reference rate columns,
// worst-case ~1.9 cones at the 27 °F/hr edge for a few mid-table cones
// (the tables themselves have visible irregularities — cones 1 and 7 in
// particular). For typical firings in the 100..250 °F/hr range, error vs
// the chart is well under 0.5 cones — much smaller than the thermocouple
// + cold-junction uncertainty in the kiln.
//
// The big win this approach gives is hold/soak accumulation: during a hold
// the chart approach freezes (rate→0 collapses to the slowest tabulated
// column), but Arrhenius keeps integrating as it should.

const EA_KCAL_PER_MOL = 170;
const R_GAS_KCAL = 1.987e-3;        // kcal/(mol·K)
const EA_OVER_R   = EA_KCAL_PER_MOL / R_GAS_KCAL;  // K (≈45797)

// Per-second contribution to the Arrhenius integral at the given temperature.
// Multiply by dt (in seconds) to get dH for that time slice.
function arrheniusRate(tempC) {
  if (!Number.isFinite(tempC) || tempC < 0) return 0;
  return Math.exp(-EA_OVER_R / (tempC + 273.15));
}

// Precomputed H threshold per cone. Calibrated against TEMPS_108 (108 °F/hr
// reference). Same indexing as CONE_NAMES — H_CRIT[0] is cone 10 (hottest,
// largest H), H_CRIT[27] is cone 018 (coolest, smallest H).
const H_CRIT = (() => {
  const refRateFperHr  = 108;
  const refRateCperSec = refRateFperHr * (5 / 9) / 3600;
  const dT       = 0.5;             // °C step for numerical integration
  const maxC     = 1400;            // beyond hottest cone
  const dtPerStep = dT / refRateCperSec;
  // cumulative[k] = ∫₀^(k·dT °C) arrheniusRate(T(t)) dt for a perfect 108°F/hr ramp
  // starting at 0°C. Then look up H at any cone's end-temp by interpolation.
  const cumulative = new Array(Math.ceil(maxC / dT) + 1);
  let H = 0;
  for (let k = 0; k < cumulative.length; k++) {
    cumulative[k] = H;
    H += arrheniusRate(k * dT) * dtPerStep;
  }
  function HatTempC(T_C) {
    if (T_C <= 0) return 0;
    const idxF = T_C / dT;
    const idx  = Math.floor(idxF);
    if (idx >= cumulative.length - 1) return cumulative[cumulative.length - 1];
    const frac = idxF - idx;
    return cumulative[idx] * (1 - frac) + cumulative[idx + 1] * frac;
  }
  return CONE_NAMES.map((_, coneIdx) => {
    const T_C = (TEMPS_108[coneIdx] - 32) * 5 / 9;
    return HatTempC(T_C);
  });
})();

// Convert an accumulated H value to a cone index (the same 73..100 scale
// used elsewhere). Interpolates between adjacent cones using log H, which
// matches the exponential spacing of H_CRIT values.
//
// Below cone 018 (H < H_CRIT[27]): we only return a non-zero index when
// the kiln has accumulated >=10% of cone 018's H — at that point the UI
// shows "<018" (approaching but not bent). Anything less reads as 0 (UI
// shows "-"). Previously a buggy log-ratio gave index 73 for ANY tiny
// positive H, so the cone display jumped from "-" to "018" the moment
// the Arrhenius integrator picked up any heat — even at room temp.
function coneIndexFromH(H) {
  if (!Number.isFinite(H) || H <= 0) return 0;
  // Beyond cone 10? Clamp at the top.
  if (H >= H_CRIT[0]) return ortonConeToIndex(CONE_NAMES[0]);
  const h27 = H_CRIT[H_CRIT.length - 1];
  if (H < h27) {
    // Approaching cone 018 (within an order of magnitude): interpolate
    // 0 → 72.9 in log H. Lower than that → 0.
    const floorH = h27 * 0.1;
    if (H <= floorH) return 0;
    const f = (Math.log(H) - Math.log(floorH)) /
              (Math.log(h27)  - Math.log(floorH));
    return Math.min(72.9, Math.max(0, f * 72.9));
  }
  // H >= h27 — bracket within the cone table and interpolate in log H.
  for (let i = 0; i < H_CRIT.length - 1; i++) {
    if (H_CRIT[i] >= H && H >= H_CRIT[i + 1]) {
      const hotIdx  = ortonConeToIndex(CONE_NAMES[i]);
      const coolIdx = ortonConeToIndex(CONE_NAMES[i + 1]);
      const f = (Math.log(H) - Math.log(H_CRIT[i + 1])) /
                (Math.log(H_CRIT[i]) - Math.log(H_CRIT[i + 1]));
      return coolIdx + f * (hotIdx - coolIdx);
    }
  }
  return 0;
}

// Calculate cone index from temperature (C) and firing rate (C/hr)
// Interpolates between two bracketing rate tables
function calcOrtonConeIndex(tempC, rateCpH) {
  const tempF = c2f(tempC);
  const rateF = cph2fph(rateCpH);

  let fractionArray0, t0Array, t1Array;
  if (rateF <= 27) {
    fractionArray0 = 0;
    t0Array = TEMPS_27;
    t1Array = TEMPS_27;
  } else if (rateF <= 108) {
    fractionArray0 = (rateF - 27) / (108 - 27);
    t0Array = TEMPS_27;
    t1Array = TEMPS_108;
  } else if (rateF <= 270) {
    fractionArray0 = (rateF - 108) / (270 - 108);
    t0Array = TEMPS_108;
    t1Array = TEMPS_270;
  } else {
    fractionArray0 = 0;
    t0Array = TEMPS_270;
    t1Array = TEMPS_270;
  }

  // Check bounds
  if (t0Array[27] > tempF) return 0;
  if (t1Array[0] < tempF) return 100;

  // Find where tempF falls in each array (descending order)
  let iCone0 = 0;
  while (t0Array[iCone0] > tempF && iCone0 < 26) iCone0++;
  let iCone1 = 0;
  while (t1Array[iCone1] > tempF && iCone1 < 26) iCone1++;

  let t0 = t0Array[iCone0 - 1];
  let t1 = t0Array[iCone0];
  const cone0 = iCone0 - 1 + (t0 - tempF) / (t0 - t1);

  t0 = t1Array[iCone1 - 1];
  t1 = t1Array[iCone1];
  const cone1 = iCone1 - 1 + (t0 - tempF) / (t0 - t1);

  // Apportion between two arrays based on rate
  return 100 - (cone0 * fractionArray0 + cone1 * (1 - fractionArray0));
}

module.exports = {
  ortonConeToIndex, ortonConeFromIndex, calcOrtonConeIndex,
  arrheniusRate, coneIndexFromH,
  // Exported for tests + cross-validation against the chart approach.
  H_CRIT, CONE_NAMES, TEMPS_27, TEMPS_108, TEMPS_270,
  EA_KCAL_PER_MOL,
};
