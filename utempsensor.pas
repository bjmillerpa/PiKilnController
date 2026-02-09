unit uTempSensor;

{$mode objfpc}{$H+}

interface

uses
  Classes, SysUtils, fpgpio, fpspi;

type
  TTempSensorMode = (tsmNormal, tsmSimulation);
  TTempSensorError = (tseOC, tseSCG, tseSCV, tseReserved);
  TTempSensorErrorSet = set of TTempSensorError;
  TTempSensorChangeEvent = procedure (ASender: TObject; aNewTempC: Double) of object;
  TTempSensorErrorEvent = procedure (ASender: TObject; aErrorsSet: TTempSensorErrorSet) of object;

const
  kTempSensorErrorStrings: array[tseOC..tseReserved] of String = ('OC', 'SCG', 'SCV', 'reserved');

type
  TTempSensor = class(TObject)
  private
    class var fGPIO_Clock: TGpioPin;
    class var fGPIO_Data: TGpioPin;
  private
    fMode: TTempSensorMode;
    fSpiDevice: TSPIDevice;
    fGPIO_CS: TGpioPin;
    fTempOffsetC: Double;
    fData: UInt32;
    fTempRawThermocoupleC: Double;
    fTempColdJunctionC: Double;
    fTempCorrectedThermocoupleC: Double;
    fTempSensorErrors: TTempSensorErrorSet;
    fLastTempC: Double;
    fTempChangeEvent: TTempSensorChangeEvent;
    fTempSensorErrorEvent: TTempSensorErrorEvent;
    procedure SetSimulatedTempC(aTempC: Double);
    function ReadSensor: Boolean;
    procedure Correct;
  public
    class constructor Create;
    class destructor Destroy;
    class function ErrorString(aErrors: TTempSensorErrorSet): String;
    class function mV2C(mV: Double): Double;
    constructor Create(aGPIOPinNo: Integer; aTempOffsetC: Double);
    function AsCelcius: Double;
    function AsFarenheit: Double;
    property TempChangeEvent: TTempSensorChangeEvent read fTempChangeEvent write fTempChangeEvent;
    property ErrorEvent: TTempSensorErrorEvent read fTempSensorErrorEvent write fTempSensorErrorEvent;
    property SimulatedTempC: Double write SetSimulatedTempC;
  end;


implementation

uses
  Math,
  uConstants {$IFNDEF LINUX}, uFauxGPioLinux{$ENDIF};

class constructor TTempSensor.Create;
begin
  fGPIO_Clock := TGPioLinuxPin.Create(kGPIO_SPI_Clock);
  fGPIO_Data := TGPioLinuxPin.Create(kGPIO_SPI_Data);

  fGPIO_Clock.Direction := gdOut;
  fGPIO_Clock.Direction := gdIn;
end;

class destructor TTempSensor.Destroy;
begin
  fGPIO_Clock.Free;
  fGPIO_Data.Free;
end;

class function TTempSensor.ErrorString(aErrors: TTempSensorErrorSet): String;
var
  nErrors: Integer;
begin
  nErrors := 0;
  Result := 'E: ';

  if tseOC in aErrors then
  begin
    Result := Result + kTempSensorErrorStrings[tseOC];
    Inc(nErrors);
  end;
  if tseSCG in aErrors then
  begin
    if nErrors > 0 then
      Result := Result + '+';
    Result := Result + kTempSensorErrorStrings[tseSCG];
    Inc(nErrors);
  end;
  if tseSCV in aErrors then
  begin
    if nErrors > 0 then
      Result := Result + '+';
    Result := Result + kTempSensorErrorStrings[tseSCV];
    Inc(nErrors);
  end;
  if tseReserved in aErrors then
  begin
    if nErrors > 0 then
      Result := Result + '+';
    Result := Result + kTempSensorErrorStrings[tseReserved];
    Inc(nErrors);
  end;
end;

class function TTempSensor.mV2C(mV: Double): Double;
var
  b0, b1, b2, b3, b4, b5, b6, b7, b8, b9: Double;
begin
  // calculate corrected temperature reading based on coefficients for 3 different ranges
//  if(thermocouple_mVolts < 0) then
  if(mV < 0) then
  begin
     b0 := 0.0000000E+00;
     b1 := 2.5173462E+01;
     b2 := -1.1662878E+00;
     b3 := -1.0833638E+00;
     b4 := -8.9773540E-01;
     b5 := -3.7342377E-01;
     b6 := -8.6632643E-02;
     b7 := -1.0450598E-02;
     b8 := -5.1920577E-04;
     b9 := 0.0000000E+00;
  end
//  else if(thermocouple_mVolts < 20.644) then
  else if(mV < 20.644) then
  begin
     b0 := 0.000000E+00;
     b1 := 2.508355E+01;
     b2 := 7.860106E-02;
     b3 := -2.503131E-01;
     b4 := 8.315270E-02;
     b5 := -1.228034E-02;
     b6 := 9.804036E-04;
     b7 := -4.413030E-05;
     b8 := 1.057734E-06;
     b9 := -1.052755E-08;
  end
//  else if(thermocouple_mVolts < 54.886) then
  else if(mV < 54.886) then
  begin
     b0 := -1.318058E+02;
     b1 := 4.830222E+01;
     b2 := -1.646031E+00;
     b3 := 5.464731E-02;
     b4 := -9.650715E-04;
     b5 := 8.802193E-06;
     b6 := -3.110810E-08;
     b7 := 0.000000E+00;
     b8 := 0.000000E+00;
     b9 := 0.000000E+00;
  end
  else
     // TODO: handle error - out of range
     exit;

  //fTempCorrectedThermocoupleC :=  b0 +
  //   b1 * sum_mVolts +
  //   b2 * Power(sum_mVolts, 2.0) +
  //   b3 * Power(sum_mVolts, 3.0) +
  //   b4 * Power(sum_mVolts, 4.0) +
  //   b5 * Power(sum_mVolts, 5.0) +
  //   b6 * Power(sum_mVolts, 6.0) +
  //   b7 * Power(sum_mVolts, 7.0) +
  //   b8 * Power(sum_mVolts, 8.0) +
  //   b9 * Power(sum_mVolts, 9.0);

  result :=  b0 +
     b1 * mV +
     b2 * Power(mV, 2.0) +
     b3 * Power(mV, 3.0) +
     b4 * Power(mV, 4.0) +
     b5 * Power(mV, 5.0) +
     b6 * Power(mV, 6.0) +
     b7 * Power(mV, 7.0) +
     b8 * Power(mV, 8.0) +
     b9 * Power(mV, 9.0);

end;

constructor TTempSensor.Create(aGPIOPinNo: Integer; aTempOffsetC: Double);
begin
  inherited Create;

  fGPIO_CS := TGPioLinuxPin.Create(aGPIOPinNo);
  fGPIO_CS.Direction := TGpioDirection.gdOut;

  fSpiDevice := TSPILinuxDevice.Create(0,aGPIOPinNo);

  {$IFDEF LINUX}
  fMode := tsmNormal;
  {$ELSE}
  fMode := tsmSimulation;
  {$ENDIF}

  fTempOffsetC := aTempOffsetC;

  // turn sensor OFF!
  fGPIO_CS.Value := true;  // pin high is OFF

  fTempCorrectedThermocoupleC := 0;
  fData := 0;
  fTempSensorErrors := [];
  fLastTempC := 0;
  fTempChangeEvent := nil;
  fTempSensorErrorEvent := nil;
end;

procedure TTempSensor.SetSimulatedTempC(aTempC: Double);
begin
  fTempCorrectedThermocoupleC := aTempC;
end;

function TTempSensor.AsCelcius: Double;
begin
  if fMode = tsmNormal then
  begin
    ReadSensor;
    if fTempSensorErrors <> [] then Exit(errorTempSensor);
    Correct;
  end;
  result := fTempCorrectedThermocoupleC;
  // only trigger on significant change
  if Abs(result - fLastTempC) >= kTempChangeEventThresholdC then
  begin
    fLastTempC := result;
    if Assigned(fTempChangeEvent) then
      fTempChangeEvent(self, fLastTempC);
  end;
end;

function TTempSensor.AsFarenheit: Double;
begin
  result := AsCelcius*9/5 + 32;
end;

function TTempSensor.ReadSensor: Boolean;
var
  tData: UInt32;
  tTemp: Int32;
begin
  result := false; // true on success
  fTempRawThermocoupleC := 0;
  fTempColdJunctionC := 0;
  fData := 0;

  // toggle on CS pin
  try
    fGPIO_CS.Value := false;  // pin low is ON
    // do spi call on thermocouple
    fSpiDevice.Read(fData, 32);

    // errors by bit
    // 0 - OC fault (open circuit)
    // 1 - SCG fault (short circuit to ground)
    // 2 - SCV fault (short circuit to V+)
    // 3 - reserved, always 0
    // 16 - 0: no fault, 1: any fault above
    // 17 - reserved, always 0

    fTempSensorErrors := [];
    if (fData and (1 shl 16)) <> 0 then   // any error
    begin
      if (fData and (1 shl 0)) <> 0 then fTempSensorErrors := fTempSensorErrors + [tseOC];
      if (fData and (1 shl 1)) <> 0 then fTempSensorErrors := fTempSensorErrors + [tseSCG];
      if (fData and (1 shl 2)) <> 0 then fTempSensorErrors := fTempSensorErrors + [tseSCV];
      if (fData and (1 shl 3)) <> 0 then fTempSensorErrors := fTempSensorErrors + [tseReserved];
      if Assigned(fTempSensorErrorEvent) then
        fTempSensorErrorEvent(self, fTempSensorErrors);
    end
    else  // on device error disregard rest of data
    begin
      // cold junction temp is 12 bits - 15:4
      tData := (fData shl 4) and $7FF;
      // check for negative, but it shouldn't happen
      if (tData and $800) <> 0 then
        // Convert to negative value by extending sign and casting to signed type
        tTemp := $F800 or (tData and $7FF)
      else
        tTemp := tData;
      // adjust for resolution
      fTempColdJunctionC := tTemp * 0.0625;  // LSB = 0.0625°C

      // thermocouple temp is 14 bits - 31:18
      tData := fData shl 18;
      // check for negative, but it shouldn't happen
      if (tData and $00003FFF) <> 0 then
        // Convert to negative value by extending sign and casting to signed type
        tTemp := $FFFFC000 or (tData and $00003FFF)
      else
        tTemp := tData;
      // adjust for resolution
      fTempRawThermocoupleC := tTemp * 0.25; // LSB = 0.25°C

      result := true;
    end;
  finally
    // toggle CS pin high to take offline
    fGPIO_CS.Value := true;
  end;
end;

procedure TTempSensor.Correct;
var
  thermocouple_mVolts: Double;
  coldJuncion_mVolts: Double;
  sum_mVolts: Double;
begin
  thermocouple_mVolts := 0;
  coldJuncion_mVolts := 0;
  sum_mVolts := 0;
  fTempCorrectedThermocoupleC := 0;

  // Subtract cold junction temperature from the raw thermocouple temperature and convert to volts
  thermocouple_mVolts := (fTempRawThermocoupleC - fTempColdJunctionC)*0.041276;  // C * mv/C = mV

  // Calculate the cold junction equivalent thermocouple voltage
  coldJuncion_mVolts := -0.176004136860E-01 +
     0.389212049750E-01  * fTempColdJunctionC +
     0.185587700320E-04  * Power(fTempColdJunctionC, 2.0) +
     -0.994575928740E-07 * Power(fTempColdJunctionC, 3.0) +
     0.318409457190E-09  * Power(fTempColdJunctionC, 4.0) +
     -0.560728448890E-12 * Power(fTempColdJunctionC, 5.0) +
     0.560750590590E-15  * Power(fTempColdJunctionC, 6.0) +
     -0.320207200030E-18 * Power(fTempColdJunctionC, 7.0) +
     0.971511471520E-22  * Power(fTempColdJunctionC, 8.0) +
     -0.121047212750E-25 * Power(fTempColdJunctionC, 9.0) +
     0.118597600000E+00  * exp(-0.118343200000E-03 * Power((fTempColdJunctionC-0.126968600000E+03), 2.0));

  // cold junction voltage + thermocouple voltage
  sum_mVolts := thermocouple_mVolts + coldJuncion_mVolts;

  fTempCorrectedThermocoupleC := mV2C(sum_mVolts);

end;


end.

// corrected temperature reading for a K-type thermocouple
// allowing accurate readings over an extended range
// http://forums.adafruit.com/viewtopic.php?f=19&t=32086&p=372992#p372992
// assuming global: Adafruit_MAX31855 thermocouple(CLK, CS, DO);
float correctedCelsius(){

   // MAX31855 thermocouple voltage reading in mV
   float thermocoupleVoltage = (thermocouple.readCelsius() - thermocouple.readInternal()) * 0.041276;

   // MAX31855 cold junction voltage reading in mV
   float coldJunctionTemperature = thermocouple.readInternal();
   float coldJunctionVoltage = -0.176004136860E-01 +
      0.389212049750E-01  * coldJunctionTemperature +
      0.185587700320E-04  * pow(coldJunctionTemperature, 2.0) +
      -0.994575928740E-07 * pow(coldJunctionTemperature, 3.0) +
      0.318409457190E-09  * pow(coldJunctionTemperature, 4.0) +
      -0.560728448890E-12 * pow(coldJunctionTemperature, 5.0) +
      0.560750590590E-15  * pow(coldJunctionTemperature, 6.0) +
      -0.320207200030E-18 * pow(coldJunctionTemperature, 7.0) +
      0.971511471520E-22  * pow(coldJunctionTemperature, 8.0) +
      -0.121047212750E-25 * pow(coldJunctionTemperature, 9.0) +
      0.118597600000E+00  * exp(-0.118343200000E-03 *
                           pow((coldJunctionTemperature-0.126968600000E+03), 2.0)
                        );


   // cold junction voltage + thermocouple voltage
   float voltageSum = thermocoupleVoltage + coldJunctionVoltage;

   // calculate corrected temperature reading based on coefficients for 3 different ranges
   float b0, b1, b2, b3, b4, b5, b6, b7, b8, b9, b10;
   if(thermocoupleVoltage < 0){
      b0 = 0.0000000E+00;
      b1 = 2.5173462E+01;
      b2 = -1.1662878E+00;
      b3 = -1.0833638E+00;
      b4 = -8.9773540E-01;
      b5 = -3.7342377E-01;
      b6 = -8.6632643E-02;
      b7 = -1.0450598E-02;
      b8 = -5.1920577E-04;
      b9 = 0.0000000E+00;
   }

   else if(thermocoupleVoltage < 20.644){
      b0 = 0.000000E+00;
      b1 = 2.508355E+01;
      b2 = 7.860106E-02;
      b3 = -2.503131E-01;
      b4 = 8.315270E-02;
      b5 = -1.228034E-02;
      b6 = 9.804036E-04;
      b7 = -4.413030E-05;
      b8 = 1.057734E-06;
      b9 = -1.052755E-08;
   }

   else if(thermocoupleVoltage < 54.886){
      b0 = -1.318058E+02;
      b1 = 4.830222E+01;
      b2 = -1.646031E+00;
      b3 = 5.464731E-02;
      b4 = -9.650715E-04;
      b5 = 8.802193E-06;
      b6 = -3.110810E-08;
      b7 = 0.000000E+00;
      b8 = 0.000000E+00;
      b9 = 0.000000E+00;
   }

   else {
      // TODO: handle error - out of range
      return 0;
   }

   return b0 +
      b1 * voltageSum +
      b2 * pow(voltageSum, 2.0) +
      b3 * pow(voltageSum, 3.0) +
      b4 * pow(voltageSum, 4.0) +
      b5 * pow(voltageSum, 5.0) +
      b6 * pow(voltageSum, 6.0) +
      b7 * pow(voltageSum, 7.0) +
      b8 * pow(voltageSum, 8.0) +
      b9 * pow(voltageSum, 9.0);
}





          // Step 3. Calculate the cold junction equivalent thermocouple voltage.

          if (internalTemp >= 0) { // For positive temperatures use appropriate NIST coefficients
             // Coefficients and equations available from http://srdata.nist.gov/its90/download/type_k.tab

             double c[] = {-0.176004136860E-01,  0.389212049750E-01,  0.185587700320E-04, -0.994575928740E-07,  0.318409457190E-09, -0.560728448890E-12,  0.560750590590E-15, -0.320207200030E-18,  0.971511471520E-22, -0.121047212750E-25};

             // Count the the number of coefficients. There are 10 coefficients for positive temperatures (plus three exponential coefficients),
             // but there are 11 coefficients for negative temperatures.
             int cLength = sizeof(c) / sizeof(c[0]);

             // Exponential coefficients. Only used for positive temperatures.
             double a0 =  0.118597600000E+00;
             double a1 = -0.118343200000E-03;
             double a2 =  0.126968600000E+03;


             // From NIST: E = sum(i=0 to n) c_i t^i + a0 exp(a1 (t - a2)^2), where E is the thermocouple voltage in mV and t is the temperature in degrees C.
             // In this case, E is the cold junction equivalent thermocouple voltage.
             // Alternative form: C0 + C1*internalTemp + C2*internalTemp^2 + C3*internalTemp^3 + ... + C10*internaltemp^10 + A0*e^(A1*(internalTemp - A2)^2)
             // This loop sums up the c_i t^i components.
             for (i = 0; i < cLength; i++) {
                internalVoltage += c[i] * pow(internalTemp, i);
             }
                // This section adds the a0 exp(a1 (t - a2)^2) components.
                internalVoltage += a0 * exp(a1 * pow((internalTemp - a2), 2));
          }
          else if (internalTemp < 0) { // for negative temperatures
             double c[] = {0.000000000000E+00,  0.394501280250E-01,  0.236223735980E-04, -0.328589067840E-06, -0.499048287770E-08, -0.675090591730E-10, -0.574103274280E-12, -0.310888728940E-14, -0.104516093650E-16, -0.198892668780E-19, -0.163226974860E-22};
             // Count the number of coefficients.
             int cLength = sizeof(c) / sizeof(c[0]);

             // Below 0 degrees Celsius, the NIST formula is simpler and has no exponential components: E = sum(i=0 to n) c_i t^i
             for (i = 0; i < cLength; i++) {
                internalVoltage += c[i] * pow(internalTemp, i) ;
             }
          }

          // Step 4. Add the cold junction equivalent thermocouple voltage calculated in step 3 to the thermocouple voltage calculated in step 2.
          double totalVoltage = thermocoupleVoltage + internalVoltage;

          // Step 5. Use the result of step 4 and the NIST voltage-to-temperature (inverse) coefficients to calculate the cold junction compensated, linearized temperature value.
          // The equation is in the form correctedTemp = d_0 + d_1*E + d_2*E^2 + ... + d_n*E^n, where E is the totalVoltage in mV and correctedTemp is in degrees C.
          // NIST uses different coefficients for different temperature subranges: (-200 to 0C), (0 to 500C) and (500 to 1372C).
          if (totalVoltage < 0) { // Temperature is between -200 and 0C.
             double d[] = {0.0000000E+00, 2.5173462E+01, -1.1662878E+00, -1.0833638E+00, -8.9773540E-01, -3.7342377E-01, -8.6632643E-02, -1.0450598E-02, -5.1920577E-04, 0.0000000E+00};

             int dLength = sizeof(d) / sizeof(d[0]);
             for (i = 0; i < dLength; i++) {
                correctedTemp += d[i] * pow(totalVoltage, i);
             }
          }
          else if (totalVoltage < 20.644) { // Temperature is between 0C and 500C.
             double d[] = {0.000000E+00, 2.508355E+01, 7.860106E-02, -2.503131E-01, 8.315270E-02, -1.228034E-02, 9.804036E-04, -4.413030E-05, 1.057734E-06, -1.052755E-08};
             int dLength = sizeof(d) / sizeof(d[0]);
             for (i = 0; i < dLength; i++) {
                correctedTemp += d[i] * pow(totalVoltage, i);
             }
          }
          else if (totalVoltage < 54.886 ) { // Temperature is between 500C and 1372C.
             double d[] = {-1.318058E+02, 4.830222E+01, -1.646031E+00, 5.464731E-02, -9.650715E-04, 8.802193E-06, -3.110810E-08, 0.000000E+00, 0.000000E+00, 0.000000E+00};
             int dLength = sizeof(d) / sizeof(d[0]);
             for (i = 0; i < dLength; i++) {
                correctedTemp += d[i] * pow(totalVoltage, i);
             }
          } else { // NIST only has data for K-type thermocouples from -200C to +1372C. If the temperature is not in that range, set temp to impossible value.
             // Error handling should be improved.
             Serial.print("Temperature is out of range. This should never happen.");
             correctedTemp = NAN;
          }

