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

// Numeric index -> cone string
function ortonConeFromIndex(coneIndex) {
  coneIndex = Math.floor(coneIndex * 10) / 10;
  if (coneIndex >= 91) {
    const val = coneIndex - 90;
    return val === Math.floor(val) ? String(val) : val.toFixed(1);
  } else if (coneIndex > 0) {
    const val = 91 - coneIndex;
    const s = val === Math.floor(val) ? String(val) : val.toFixed(1);
    return '0' + s;
  }
  return '-';
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

module.exports = { ortonConeToIndex, ortonConeFromIndex, calcOrtonConeIndex };
