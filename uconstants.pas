unit uConstants;

{$mode objfpc}{$H+}

interface

const
  kCycleLengthSeconds = 15.0; // seconds
  kMinFireTimeSeconds = 0.5; // seconds
  kHeartBeatsPerCycle = 15;
  kHeartBeatRing1 = 1;
  kHeartBeatRing2 = 6;
  kHeartBeatRing3 = 11;
  kRateLookBackSeconds = 1800; // 30 minutes

  // need to get from pi itself
  //SPI0: MOSI (GPIO10); MISO (GPIO9); SCLK (GPIO11); CE0 (GPIO8), CE1 (GPIO7)
  //SPI1: MOSI (GPIO20); MISO (GPIO19); SCLK (GPIO21); CE0 (GPIO18); CE1 (GPIO17); CE2 (GPIO16)

  kGPIO_SPI_Clock = 22;
  kGPIO_SPI_Data = 17;

  kGPIO_SPI_CS1 = 0;
  kGPIO_SPI_CS2 = 1;
  kGPIO_SPI_CS3 = 2;

  kNTempSensorHits = 5;

  kGPIO_Heat1 = 29;
  kGPIO_Heat2 = 28;
  kGPIO_Heat3 = 25;

  kThermocoupleOffset1 = 0; // if tcouple reads 4C at 0C set to -4 to compensate
  kThermocoupleOffset2 = 0;
  kThermocoupleOffset3 = 0;

  kPidP = 5;
  kPidI = 3;
  kPidD = 3;

  kGPIO_VentFan = 27;

  kTempChangeEventThresholdC = 0.5; // slightly less than 1°F

  kCostPerKW = 0.12; // $/KW
  kMillisecondsPerMinute: Double = 60*1000;
  kMillisecondsPerHour: Double = 60*60*1000;
  kMillisecondsPerDay: Double = 24*60*60*1000;

  kBrickHeatCap = 545.0; // J/(kg*K)

//  kAmbientTempC = 21; // °C
  kAmbientTempC = 500; // °C
  kDateFormat = 'yyyymmdd';
  kDateTimeFormat = 'yyyymmdd_hhnnss';
  kClockTimeFormat = 'hh:nn';
  kElapsedTimeFormat = 'hh:nn:ss';
  {$IFNDEF WINDOWS}
  kAppDataFolder = '~/Documents/PiKilnController/';
  {$ELSE}
  kAppDataFolder = '//Mac/Home/Documents/PiKilnController/';
  {$ENDIF}
  kAppLogFolder = kAppDataFolder + 'logs/';
  kAppScheduleFolder = kAppDataFolder + 'schedules/';
  kAppConfigFilename = kAppDataFolder + 'config.json';

  errorTempSensor = -9999;

  // constants for correcting thermocouple temps
  //Coef_cjetv_pos: array[0..9] of Double = (-0.176004136860E-01,  0.389212049750E-01,  0.185587700320E-04, -0.994575928740E-07,  0.318409457190E-09, -0.560728448890E-12,  0.560750590590E-15, -0.320207200030E-18,  0.971511471520E-22, -0.121047212750E-25);
  //Coef_cjetv_neg: array[0..10] of Double = (0.000000000000E+00,  0.394501280250E-01,  0.236223735980E-04, -0.328589067840E-06, -0.499048287770E-08, -0.675090591730E-10, -0.574103274280E-12, -0.310888728940E-14, -0.104516093650E-16, -0.198892668780E-19, -0.163226974860E-22);
  //Coef_v2t_neg: array[0..9] of Double = (0.0000000E+00, 2.5173462E+01, -1.1662878E+00, -1.0833638E+00, -8.9773540E-01, -3.7342377E-01, -8.6632643E-02, -1.0450598E-02, -5.1920577E-04, 0.0000000E+00);
  //Coef_v2t_lt20_644: array[0..9] of Double = (0.000000E+00, 2.508355E+01, 7.860106E-02, -2.503131E-01, 8.315270E-02, -1.228034E-02, 9.804036E-04, -4.413030E-05, 1.057734E-06, -1.052755E-08);
  //Coef_v2t_lt54_886: array[0..9] of Double = (-1.318058E+02, 4.830222E+01, -1.646031E+00, 5.464731E-02, -9.650715E-04, 8.802193E-06, -3.110810E-08, 0.000000E+00, 0.000000E+00, 0.000000E+00);

  // Exponential coefficients. Only used for positive temperatures
  //Coef_cjetva_pos: array[0..2] of double =  (0.118597600000E+00, -0.118343200000E-03, 0.126968600000E+03);

  function F2C(aF: Double): Double;
  function C2F(aC: Double): Double;

  function FpH2CpH(aFpH: Double): Double;
  function CpH2FpH(aCpH: Double): Double;

implementation

function F2C(aF: Double): Double;
begin
  result := (aF - 32)* 5/9;
end;

function C2F(aC: Double): Double;
begin
  result := aC * 9/5 +32;
end;

function FpH2CpH(aFpH: Double): Double;
begin
  result := aFpH* 5/9;
end;

function CpH2FpH(aCpH: Double): Double;
begin
  result := aCpH * 9/5;
end;

end.

