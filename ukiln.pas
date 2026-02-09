unit uKiln;

{$mode objfpc}{$H+}

interface

uses
  Classes, SysUtils, DateUtils, extctrls {TTimer}, fpjson,
  uPid, uRelays, uTempSensor, uSchedule, umonitoredbject;

type
  TFanModes = (fmOff, fmAuto, fmOn);
  TKilnModes = (kmOff, kmTest, kmRunning, kmIdle, kmFinished);

  THeartBeatEvent = procedure (ASender: TObject) of object;
  TMessagePostEvent = procedure (ASender: TObject; aMsg: String) of object;
  TLogPostEvent = procedure (ASender: TObject; aMsg: String) of object;

  TPidArray = array[1..3] of TPid;
  TElementArray = array[1..3] of TElement;
  TTempSensorArray = array[1..3] of TTempSensor;

  TKiln = class(TMonitoredObject)
  private
    fKilnMode: TKilnModes;
    fFanMode: TFanModes;
    fHeartBeats: Int64;
    fFirstNow: TDateTime;
    fLastNow: TDateTime;
    fConfig: TJSONObject;
    fOnHeartBeatEnter: THeartBeatEvent;
    fOnHeartBeatExit: THeartBeatEvent;
    //fOnMessagePost: TMessagePostEvent;
    //fOnLogPost: TLogPostEvent;
    fVentFan: TRelay;
    fElements: TElementArray;
    fPids: TPidArray;
    fTempSensors: TTempSensorArray;
    fSchedule: TSchedule;
    fHeartBeat: TTimer;
    fRunID: String;
    procedure DoHeartBeat(Sender: TObject);
    procedure SetFanMode(aFanMode: TFanModes);
  public
    constructor Create;
    destructor Destroy; override;
    procedure Start;
    procedure Stop;
    function CurrentTempC(aRingNo: Integer): Double;
    function ElapsedTime: TDateTime;
    function ElapsedTimeSeconds: Double;
    function ElapsedPowerKWHr: Double;
    function StatusAsJSON: String;
    property Mode: TKilnModes read fKilnMode;
    property FanMode: TFanModes read fFanMode write SetFanMode;
    property OnHeartBeatEnter: THeartBeatEvent read fOnHeartBeatEnter write fOnHeartBeatEnter;
    property OnHeartBeatExit: THeartBeatEvent read fOnHeartBeatExit write fOnHeartBeatExit;
    //property OnMessagePost: TMessagePostEvent read fOnMessagePost write fOnMessagePost;
    //property OnLogPost: TLogPostEvent read fOnLogPost write fOnLogPost;
    property Schedule: TSchedule read fSchedule write fSchedule;
    property Config: TJSONObject read fConfig;
    property Pids: TPidArray read fPids;
    property Elements: TElementArray read fElements;
    property TempSensors: TTempSensorArray read fTempSensors;
    property VentFan: TRelay read fVentFan;
    // simulation
    class function ModeledKilnHeatLossAtTempC(aTempC: Double): Double;
    class function ModeledVentHeatLossAtTempC(aTempC: Double): Double;
    class function EstimatedMaxFireRate(aTempC: Double): Double;
    class function EstimatedMaxCoolRate(aTempC: Double): Double;
    class function EstimatedKilnHeatCapcity: Double;
  end;

implementation

uses
  uConstants, IniFiles;


constructor TKiln.Create;
var
  i: Integer;
  pidP, pidI, pidD: Double;
  ini: TIniFile;
begin
  inherited;

  fKilnMode := kmOff;
  fFanMode := fmOff;
  fOnHeartBeatEnter := nil;
  fOnHeartBeatExit := nil;
  //fOnMessagePost := nil;
  //fOnLogPost := nil;
  fHeartBeats := 0;
  fFirstNow := Now; // just to initialize;
  fLastNow := fFirstNow;
  fSchedule := nil;
  fConfig := TJSONObject.Create;

  fRunID := FormatDateTime(kDateFormat, fFirstNow); // use date in form YYYYMMDD

  // open and read ini file for saved params
  ini := TIniFile.Create(kAppDataFolder + 'config.ini');
  try
    for i:=1 to 3 do
    begin
      pidP := ini.ReadInteger('PID','P' + IntToStr(i) ,kPidP);
      pidI := ini.ReadInteger('PID','I' + IntToStr(i) ,kPidI);
      pidD := ini.ReadInteger('PID','D' + IntToStr(i) ,kPidD);
      fPids[i] := TPid.Create(pidP, pidI, pidD);
    end;
  finally
    ini.Free;
  end;

  fVentFan := TRelay.Create(kGPIO_VentFan);

  fElements[1] := TElement.Create(kGPIO_Heat1);
  fElements[2] := TElement.Create(kGPIO_Heat2);
  fElements[3] := TElement.Create(kGPIO_Heat3);

  fTempSensors[1] := TTempSensor.Create(kGPIO_SPI_CS1, kThermocoupleOffset1);
  fTempSensors[2] := TTempSensor.Create(kGPIO_SPI_CS2, kThermocoupleOffset2);
  fTempSensors[3] := TTempSensor.Create(kGPIO_SPI_CS3, kThermocoupleOffset3);

  // for simulation:
  fTempSensors[1].SimulatedTempC := kAmbientTempC;
  fTempSensors[2].SimulatedTempC := kAmbientTempC;
  fTempSensors[3].SimulatedTempC := kAmbientTempC;

  fHeartBeat := TTimer.Create(nil);
  fHeartBeat.Interval := Round(kCycleLengthSeconds*1000/kHeartBeatsPerCycle);
  fHeartBeat.OnTimer := @DoHeartBeat;
  fHeartBeat.Enabled := false;
end;

destructor TKiln.Destroy;
begin
  fHeartBeat.Enabled := false;

  fHeartBeat.Free;

  fTempSensors[3].Free;
  fTempSensors[2].Free;
  fTempSensors[1].Free;

  fElements[3].Free;
  fElements[2].Free;
  fElements[1].Free;

  fConfig.Free;
end;

function TKiln.CurrentTempC(aRingNo: Integer): Double;
begin
  result := errorTempSensor;
  // check first in the chosen ring, on error use one of the others
  case aRingNo of
    1: begin
         result := fTempSensors[1].AsCelcius;
         if result = errorTempSensor then
           result := fTempSensors[2].AsCelcius;
         if result = errorTempSensor then
           result := fTempSensors[3].AsCelcius;
      end;
    2: begin
         result := fTempSensors[2].AsCelcius;
         if result = errorTempSensor then
           result := fTempSensors[1].AsCelcius;
         if result = errorTempSensor then
           result := fTempSensors[3].AsCelcius;
      end;
    3: begin
         result := fTempSensors[3].AsCelcius;
         if result = errorTempSensor then
           result := fTempSensors[2].AsCelcius;
         if result = errorTempSensor then
           result := fTempSensors[1].AsCelcius;
      end;
  end;
end;

function TKiln.ElapsedTime: TDateTime;
begin
  result := fLastNow - fFirstNow;
end;

function TKiln.ElapsedTimeSeconds: Double;
begin
  result := MillisecondsBetween(fFirstNow,fLastNow)/1000;
end;

function TKiln.ElapsedPowerKWHr: Double;
begin
  result := (fElements[1].Watts * fElements[1].SecondsOn
          + fElements[2].Watts * fElements[2].SecondsOn
          + fElements[3].Watts * fElements[3].SecondsOn)/(1000*60*60);
end;

procedure TKiln.DoHeartBeat(Sender: TObject);
var
  tTargetTemp: Double;
  tCurrentTemp: Double;
  tSeconds: Double;
  tRate: Double;
  tMod: Integer;
  iRing: Integer;
  ws1,ws2,ws3: Double;
  dt1,dt2,dt3: Double;
begin
  if Assigned (fOnHeartBeatEnter) then
     fOnHeartBeatEnter(self);

  // record energy used since last heartbeat
  //    sum for elements: (240V * 16amps * length of heartbeat * runtime)

  // wattSeconds = inputs - losses
  ws1 := fElements[1].SecondsOnSinceLastChecked * fElements[1].Watts - ModeledKilnHeatLossAtTempC(fTempSensors[1].AsCelcius)*0.35; // (650 + 130) sq in / 2210 sq in
  ws2 := fElements[2].SecondsOnSinceLastChecked * fElements[2].Watts - ModeledKilnHeatLossAtTempC(fTempSensors[2].AsCelcius)*0.30; // 650 sq in / 2210 sq in
  ws3 := fElements[3].SecondsOnSinceLastChecked * fElements[3].Watts - ModeledKilnHeatLossAtTempC(fTempSensors[3].AsCelcius)*0.35; // (650 + 130) sq in / 2210 sq in

    // deltaTemp
    dt1 := ws1/(EstimatedKilnHeatCapcity*0.35);  // (kiln heat cap)*(proportion of total kiln mass)
    dt2 := ws2/(EstimatedKilnHeatCapcity*0.30);
    dt3 := ws3/(EstimatedKilnHeatCapcity*0.35);

    fTempSensors[1].SimulatedTempC := fTempSensors[1].AsCelcius + dt1;
    fTempSensors[2].SimulatedTempC := fTempSensors[2].AsCelcius + dt2;
    fTempSensors[3].SimulatedTempC := fTempSensors[3].AsCelcius + dt3;


  Inc(fHeartBeats);

  // maybe choose a ring to update
  iRing := 0;
  tMod := fHeartBeats mod kHeartBeatsPerCycle;
  case tMod of
    kHeartBeatRing1: iRing := 1;
    kHeartBeatRing2: iRing := 2;
    kHeartBeatRing3: iRing := 3;
  end;

  if (iRing <> 0) and (fSchedule <> nil) then
  begin          // CurrentTempC will attempt to find a working temp sensor if there is a failure!
    tCurrentTemp := CurrentTempC(iRing);
    tTargetTemp := fSchedule.TargetTempC(tCurrentTemp);
    if tTargetTemp = -1 then
      Stop
    else
    begin
      tRate := fPids[iRing].Compute(tTargetTemp, tCurrentTemp); // returns fraction of time element should be on
      tSeconds := tRate*kCycleLengthSeconds;
      // only fire if non-trivial amount of time
      if tSeconds > kMinFireTimeSeconds then
        fElements[iRing].Start(tSeconds);

      // maybe control the fan
      case fFanMode of
        fmOff: fVentFan.IsOn := false;
        //fmOver500F:  fVentFan.IsOn := tCurrentTemp > 260;
        //fmOver1000F: fVentFan.IsOn := tCurrentTemp > 538;
        //fmScheduled: fVentFan.IsOn := fSchedule.FanOn;
        fmOn: fVentFan.IsOn := true;
      end;
      LogThis(Format('%d Tc: %0.1f Tt: %0.1f rate: %0.2f secs: %0.1f',[iRing,C2F(tCurrentTemp),C2F(tTargetTemp),tRate,tSeconds]));
    end;
  end;

  fLastNow := Now;
  if Assigned (fOnHeartBeatExit) then
     fOnHeartBeatExit(self);
end;

procedure TKiln.Start;
begin
  // check to see if schedule is set

  // check to see if thermocouples are operational
  fKilnMode := kmRunning;
  fFirstNow := Now;
  fHeartBeat.Enabled := true; // make sure heartbeat is active
end;

procedure TKiln.Stop;
begin
  fLastNow := Now;

  fElements[1].TurnOff;
  fElements[2].TurnOff;
  fElements[3].TurnOff;

  fVentFan.TurnOff;

  fKilnMode := kmIdle;

  // record stats
  if fSchedule <> nil then
  begin
    fSchedule.Metadata['KWHrs per run'] := Format('%.1f',[ElapsedPowerKWHr]);
    fSchedule.Metadata['cost per run'] := Format('%.2f',[ElapsedPowerKWHr*kCostPerKW]);;
    fSchedule.Metadata['time per run'] := FormatDateTime(kElapsedTimeFormat, ElapsedTime);
    fSchedule.Metadata['last start'] := FormatDateTime(kDateTimeFormat, fFirstNow);
    fSchedule.Metadata['last finish'] := FormatDateTime(kDateTimeFormat, fLastNow);
    fSchedule.Save;
  end;
end;

procedure TKiln.SetFanMode(aFanMode: TFanModes);
begin
  fFanMode := aFanMode;
  // if kiln is on then turn on/off etc fan else let happen at start
end;

// watts
class function TKiln.ModeledKilnHeatLossAtTempC(aTempC: Double): Double;
begin
  // under min temp calc
  if aTempC <= 38 then
    exit(0);

  // polynomial regression from L&L Kilns HVAC data
  result := 0.001741*aTempC*aTempC + 2.184254*aTempC - 157.973796;
end;

// watts
class function TKiln.ModeledVentHeatLossAtTempC(aTempC: Double): Double;
const
  // assume 50°C intake air & 25 cfm
  kIntakeAirTempC: Double = 50;
  kVentFlowCFM: Double = 25;

  kCFM3CMM: Double = 0.028; // cfm to m^3/min
  kHeatCapAir: Double = 1.005;  // kJ/kg⋅K
  kDensityAir: Double = 1.2754; // kg/m^3
var
  kgPerSec: Double;
begin
  kgPerSec := (kVentFlowCFM * kCFM3CMM)   // flow rate in m^3/min
            * (kDensityAir)               // density in kg/m^3
            / 60;                         // sec per min
                                          // = kg per sec

  // deltaT * mass * heat cap
  result :=   (aTempC - kIntakeAirTempC)  // delta Temp K
             * kgPerSec
             * (kHeatCapAir/1000);        // J/kg⋅K = watt⋅sec/kg⋅K

end;

// °K/hr
class function TKiln.EstimatedMaxFireRate(aTempC: Double): Double;
begin
             // max input (W) - calced loss at tempC (W)
  result := ((48000*240) - ModeledKilnHeatLossAtTempC(aTempC))/EstimatedKilnHeatCapcity;
end;

// °K/hr
class function TKiln.EstimatedMaxCoolRate(aTempC: Double): Double;
begin
             // ((max input (W) - calced loss at tempC (W))/heat capacity) * secsInHour
  result := (ModeledKilnHeatLossAtTempC(aTempC)/EstimatedKilnHeatCapcity) * 60*60;
end;

// J/°K  = (W*sec)/°K
class function TKiln.EstimatedKilnHeatCapcity: Double;
begin
  //      kiln mass: 360# (use half), load: 40# - 100# (using 70#) = ~140kg
  //      brick (aka fired clay) heat cap: 545 J/(kg*K)
  //      J = W*sec
  result := 140 * 545;  // kg * W*sec/(kg*K) = W*sec/K = J/K
end;

function TKiln.StatusAsJSON: String;
begin
  //fTempSensors[1].AsCelcius
  //fTempSensors[2].AsCelcius
  //fTempSensors[3].AsCelcius
  //if schedule <> nil then
  //begin
  //  kWatts := fKiln.ElapsedPowerKWHr;
  //  schedule.Metadata[]; // title, target cone, etc
  //  lblTargetTemp.Caption := TempCToDisplayStr(schedule.TargetTempC(fKiln.TempSensors[2].AsCelcius));
  //  lblCone.Caption := OrtonConeFromIndex(fKiln.Schedule.MaxConeIndex);
  //  lblCost.Caption := Format('%.1f kWh $%0.2f',[kWatts, kWatts * kCostPerKW]);
  //  lblElapsedTime.Caption := FormatDateTime(kElapsedTimeFormat, fKiln.ElapsedTime);
  //  lblTimeFinished.Caption := FormatDateTime(kClockTimeFormat, Time + fKiln.Schedule.TimeLeftHrs/24);
  //
end;

end.

