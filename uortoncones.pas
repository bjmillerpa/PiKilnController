unit uOrtonCones;

{$mode objfpc}{$H+}

interface

uses
  Classes, SysUtils;

function OrtonConeToIndex(aCone: String): Double;
function CalcOrtonConeIndex(aTempC: Double; aRateCpH: Double): Double;
function OrtonConeFromIndex(aConeIndex: Double): String;


implementation

uses
  Math, uConstants;

const
  kConeNames: array[0..27] of String = ('10','9','8','7','6','5','4','3','2','1','01','02','03','04','05','06','07','08','09','010','011','012','013','014','015','016','017','018');
  kConeTemps27:  array[0..27] of Double = (2284,2235,2212,2194,2165,2118,2086,2039,2034,2028,1999,1972,1960,1915,1870,1798,1764,1692,1665,1636,1575,1549,1485,1395,1382,1368,1301,1267);
  kConeTemps108: array[0..27] of Double = (2345,2300,2273,2262,2232,2167,2142,2106,2088,2079,2046,2016,1987,1945,1888,1828,1789,1728,1688,1657,1607,1582,1539,1485,1456,1422,1360,1252);
  kConeTemps270: array[0..27] of Double = (2381,2336,2320,2295,2269,2205,2161,2138,2127,2109,2080,2052,2019,1971,1911,1855,1809,1753,1706,1679,1641,1620,1582,1540,1504,1465,1405,1283);

  // 100 = cone 10
  //  96 = cone 6
  //  91 = cone 1
  //  90 = cone 01
  //  80 = cone 011
  //  73 = cone 018


function OrtonConeToIndex(aCone: String): Double;
var
  x: Double;
begin
  if TryStrToFloat(aCone,x) then
  begin
    if aCone.StartsWith('0') then
      result := 91 - x
    else
      result := x + 90;
  end
  else
    result := 0;
end;

// 0 = too low
// 100 = cone 10 or higher
// 27 = cone 018
// decimal is fraction towards next cone

function OrtonConeFromIndex(aConeIndex: Double): String;
begin
  // round down to nearest .1 cone first
  aConeIndex := Floor(aConeIndex*10)/10;

  if aConeIndex >= 91 then
    result := FormatFloat('.#', aConeIndex - 90)
  else if aConeIndex > 0 then
    result := '0' + FormatFloat('.#', 91 - aConeIndex)
  else
    result := '-';
end;

function CalcOrtonConeIndex(aTempC: Double; aRateCpH: Double): Double;
var
  t0Array: array[0..27] of Double;
  t1Array: array[0..27] of Double;
  rateF, fractionArray0: Double;
  t0,t1,tempF: Double;
  cone0, cone1, coneF: Double;
  iCone0, iCone1: Integer;
begin
  // arrays are in F
  tempF := C2F(aTempC);
  rateF := CpH2FpH(aRateCpH);

  // select which arrays to use
  //   and by what ratio
  if rateF <= 27 then
  begin
    fractionArray0 := 0;
    t0Array := kConeTemps27;
    t1Array := kConeTemps27;
  end
  else if rateF <= 108 then
  begin
    fractionArray0 := (rateF - 27)/(108-27);
    t0Array := kConeTemps27;
    t1Array := kConeTemps108;
  end
  else if rateF <= 270 then
  begin
    fractionArray0 := (rateF - 108)/(270-108);
    t0Array := kConeTemps108;
    t1Array := kConeTemps270;
  end
  else {if rateF > 270 then }
  begin
    fractionArray0 := 0;
    t0Array := kConeTemps270;
    t1Array := kConeTemps270;
  end;

  // test low bounds
  if (t0Array[27] > tempF) then
    exit(0);
  // test high bounds
  if (t1Array[0] < tempF) then
    exit(100); // cone 10 is higher than kiln can go

  // find where aTemp falls in each array
  // this will fall between t0 and t1 = i-1 and i
  iCone0 := 0;
  while (t0Array[iCone0] > tempF) and (iCone0 < 26) do
    Inc(iCone0);
  iCone1 := 0;
  while (t1Array[iCone1] > tempF) and (iCone1 < 26) do
    Inc(iCone1);

  t0 := t0Array[iCone0-1];
  t1 := t0Array[iCone0];
  // how far into array
  cone0 := iCone0-1 + (t0-tempF)/(t0-t1);

  t0 := t1Array[iCone0-1];
  t1 := t1Array[iCone0];
  // how far into array
  cone1 := iCone1-1 + (t0-tempF)/(t0-t1);

  // apportion between two based on rate
  // and convert 0 index to 100 (cone 10)
  result := 100 - (cone0 * fractionArray0 + cone1 *(1-fractionArray0));  // fractionArray0 + (1-fractionArray0) = 1, so this is an apportionment
end;


end.

//Orton Cone number
//Final temp in degrees F at ramp rate of 27 degrees F/hr
//Final temp in degrees F at ramp rate of 108 degrees F/hr
//Final temp in degrees F at ramp rate of 270 degrees F/hr
//
//10 	2284 	2345 	2381
//9 	2235 	2300 	2336
//8 	2212 	2273 	2320
//7 	2194 	2262 	2295
//6 	2165 	2232 	2269
//5 	2118 	2167 	2205
//4 	2086 	2142 	2161
//3 	2039 	2106 	2138
//2 	2034 	2088 	2127
//1 	2028 	2079 	2109
//01 	1999 	2046 	2080
//02 	1972 	2016 	2052
//03 	1960 	1987 	2019
//04 	1915 	1945 	1971
//05 	1870 	1888 	1911
//06 	1798 	1828 	1855
//07 	1764 	1789 	1809
//08 	1692 	1728 	1753
//09 	1665 	1688 	1706
//010 	1636 	1657 	1679
//011 	1575 	1607 	1641
//012 	1549 	1582 	1620
//013 	1485 	1539 	1582
//014 	1395 	1485 	1540
//015 	1382 	1456 	1504
//016 	1368 	1422 	1465
//017 	1301 	1360 	1405
//018 	1267 	1252 	1283
//019 	1213 	1252 	1283
//020 		1159 	1180
//021 		1112 	1143
//022 		1087 	1094

