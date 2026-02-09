unit uSchedule;

{$mode objfpc}{$H+}

interface

uses
  Classes, SysUtils, DateUtils, fgl, fpjson, jsonparser, umonitoredbject;

type
  TDoubleArray = array of Double;
  TBooleanArray = array of Boolean;
  TStringArray = array of String;
  TXYPair = record
    x: Double;
    y: Double;
  end;

  TXYPairArray = array of TXYPair;

  TSchedule = class;
  TScheduleList = class(specialize TFPGMapObject<String, TSchedule>);

  TScheduleStatusChangeEvent = procedure (ASender: TObject; aMsg: String) of object;

  TSchedule = class(TMonitoredObject)
  private
    // stored
    fRates: TDoubleArray;
    fTemps: TDoubleArray;
    fHoldTimes: TDoubleArray;
    fFanOns: TBooleanArray;
    fNotes: TStringArray;
    fMetadata: TStringList;
    fFilename: String;

    fNoSegments: Integer;
    fChanged: Boolean;
    fCurrentSegment: Integer;
    fCurrentSegmentStartTime: TDateTime;
    fTimeLeftHrs: Double;
    fInHold: Boolean;
    fHoldStartTime: TDateTime;
    fStartTempC: Double;
    fStartTime: TDateTime;
    fLastReportedTempC: Double;
    fHistory: TXYPairArray;
    fTargetConeIndex: Double;
    fCurrConeIndex: Double;
    fMaxConeIndex: Double;
    fCurrFiringRateCpHr: Double;
    function GetFanOn: Boolean;
    function GetMetadata(aName: String): String;
    procedure SetMetadata(aName: String; aValue: String);
    procedure SetNoSegments(aValue: Integer);
  private
    fStatusChange: TScheduleStatusChangeEvent;
    class var fScheduleList: TScheduleList;
  public
    constructor Create(aJSON: String);
    destructor Destroy; override;
    function TargetTempC(aReportedTempC: Double): Double;  // need the reported temp to know if it is time to go to hold
    function ActualFiringRateCpHr: Double; // C/hr - used to calculate current cone
    function MeetsCone: Boolean;
    function AsJSON: String;
    function AsXYGraph(asF: Boolean = false): TXYPairArray;
//    function HistoryAsJSON(asF: Boolean = false): String;
    //function TargetFinishTime: TDateTime;
    //function ElapsedTimeHrs: Double;
//    function IsFinished: Boolean;
    procedure Save;
    property CurrentSegment: Integer read fCurrentSegment write fCurrentSegment;
    property FanOn: Boolean read GetFanOn;
    property Changed: Boolean read fChanged write fChanged;
    property Metadata[aName: String]: String read GetMetadata write SetMetadata;
    property MetadataList: TStringList read fMetadata;
    property Filename: String read fFilename write fFilename;
    property Rates: TDoubleArray read fRates;
    property Temps: TDoubleArray read fTemps;
    property HoldTimes: TDoubleArray read fHoldTimes;
    property FanOns: TBooleanArray read fFanOns;
    property Notes: TStringArray read fNotes;
    property NoSegments: Integer read fNoSegments write SetNoSegments;
    property StatusChange: TScheduleStatusChangeEvent read fStatusChange write fStatusChange;
    property TimeLeftHrs: Double read fTimeLeftHrs;
    property LastReportedTempC: Double read fLastReportedTempC;
    property History: TXYPairArray read fHistory;
    property TargetConeIndex: Double read fTargetConeIndex;
    property MaxConeIndex: Double read fMaxConeIndex;
    property CurrConeIndex: Double read fCurrConeIndex;
    class constructor Create2;
    class destructor Destroy2;
    class procedure Clear;
    class procedure LoadAll;
    class procedure SaveAll;
    class property Schedules: TScheduleList read fScheduleList;
  end;


implementation

uses
  FileUtil, Character, Dialogs, Math,
  uConstants, uKiln, uOrtonCones;

class procedure TSchedule.Clear;
begin
  fScheduleList.Clear;
end;

class procedure TSchedule.LoadAll;
var
  jsonFiles: TStringList;
  jsonFile: TStringList;
  schedule: TSchedule;
  iFile: Integer;
  fn: String;
begin
  fScheduleList.Clear;
  fn := ExpandFileName(kAppScheduleFolder);
  jsonFiles := FindAllFiles(ExpandFileName(kAppScheduleFolder),'*.json');
  jsonFile := TStringList.Create;
  try
    for iFile := 0 to jsonFiles.Count-1 do
    begin
      fn := jsonFiles[iFile];
      jsonFile.LoadFromFile(fn);
      try
        schedule := TSchedule.Create(jsonFile.Text);
        schedule.Filename:= fn;
        fScheduleList.Add(schedule.Metadata['title'], schedule);
      except
        ShowMessage('Error reading JSON in: ' + fn);
      end;
    end;
  finally
    jsonFiles.Free;
    jsonFile.Free;
  end;
end;

class procedure TSchedule.SaveAll;
begin
  if ForceDirectories(ExpandFileName(kAppScheduleFolder)) then
  begin

  end;
end;

class constructor TSchedule.Create2;
begin
  fScheduleList := TScheduleList.Create(true);
  LoadAll;
end;

class destructor TSchedule.Destroy2;
begin
  SaveAll;
  fScheduleList.Free;
end;

constructor TSchedule.Create(aJSON: String);
var
  jData: TJSONData;
  jMain: TJSONObject;
  jSegment: TJSONObject;
  jSegments: TJSONArray;
  iSegment: Integer;
  iMain: Integer;
  isStoredInF: Boolean;
begin
  inherited Create;

  fCurrentSegment := 0;
  fCurrentSegmentStartTime := 0;
  fTimeLeftHrs := 0;
  fStartTempC := 0;
  fLastReportedTempC := 0;
  fInHold := false;
  fChanged := false;
  fFilename := '';
  SetLength(fHistory,0);
  fCurrConeIndex := 0;
  fMaxConeIndex := 0;
  fTargetConeIndex := 0;
  fCurrFiringRateCpHr := 0;

  fMetadata := TStringList.Create;
  // pre-populate some metadata
  fMetadata.Values['title'] := 'untitled';
  fMetadata.Values['created'] := DateToStr(Now);
  fMetadata.Values['modified'] := fMetadata.Values['created'];
  fMetadata.Values['cone'] := '';
  fMetadata.Values['type'] := '';
  fMetadata.Values['units-rate'] := '°F/hr';
  fMetadata.Values['units-temp'] := '°F';
  fMetadata.Values['units-hold'] := 'min';
  fMetadata.Values['units-fanon'] := 'true/false';

  jData := GetJSON(aJSON);
  try
    jMain := TJSONObject(jData);
    // anything not segments is metadata
    for iMain:=0 to jMain.Count-1 do
    begin
      if jMain.Items[iMain].JSONType = jtString then
        fMetaData.Values[jMain.Names[iMain]] := jMain.Strings[jMain.Names[iMain]];
    end;

    isStoredInF := fMetadata.Values['units-temp'].ToLower.Contains('f');

    jSegments := TJSONArray(jMain['segments']);
    NoSegments := jSegments.Count;

    for iSegment := 0 to fNoSegments-1 do
    begin
      jSegment := TJSONObject(jSegments[iSegment]);
      if isStoredInF then
      begin
        fRates[iSegment] := FpH2CpH(jSegment['rate'].AsFloat);
        fTemps[iSegment] := F2C(jSegment['temp'].AsFloat);
      end
      else
      begin
        fRates[iSegment] := jSegment['rate'].AsFloat;
        fTemps[iSegment] := jSegment['temp'].AsFloat;
      end;
      fHoldTimes[iSegment] := jSegment['hold'].AsFloat;
      fFanOns[iSegment] := jSegment['fanon'].AsBoolean;
      fNotes[iSegment] := jSegment['note'].AsString;
    end;

    fChanged := false;
  finally
    jData.Free;
  end;
end;

destructor TSchedule.Destroy;
begin
  fMetadata.Free;

  inherited;
end;

procedure TSchedule.Save;
var
  sl: TStringList;
  tieBreaker: Integer;
  iChar: Integer;
begin
  sl := TStringList.Create;
  try
    sl.Text := AsJSON;
    if fFilename = '' then  // has never been saved to file
    begin
      fFilename := Metadata['title'];
      // remove all non letters or numbers
      for iChar := length(fFilename)-1 downto 0 do
        if not IsLetterOrDigit(fFilename[iChar]) then
          Delete(fFilename,iChar,1);
      // expand
      fFilename := ExpandFileName(kAppScheduleFolder + fFilename + '.json');
      // test for existence
      if FileExists(fFilename) then
      begin
        // find unique name
        tieBreaker := 1;
        while FileExists(fFilename + IntToStr(tieBreaker)) do
          Inc(tieBreaker);
        fFilename := fFilename + IntToStr(tieBreaker);
      end;
    end;
    sl.SaveToFile(fFilename);

  finally
    sl.Free;
  end;
end;

procedure TSchedule.SetNoSegments(aValue: Integer);
begin
  fNoSegments := aValue;

  // resize all arrays
  SetLength(fRates,fNoSegments);
  SetLength(fTemps,fNoSegments);
  SetLength(fHoldTimes,fNoSegments);
  SetLength(fFanOns,fNoSegments);
  SetLength(fNotes,fNoSegments);
end;

function TSchedule.AsXYGraph(asF: Boolean = false): TXYPairArray;
var
  sumX: Double;  // hours!
  iSegment: Integer;
  iPoints: Integer;
  nPoints: Integer;
  cTemp: Double;
  lastTemp: Double;
begin
  sumX := 0;
  nPoints := 1 + 2 * fNoSegments;
  iPoints := 0;
  SetLength(result,nPoints);
  // first point is room temp
  result[iPoints].x := 0;
  if asF then
    lastTemp := C2F(kAmbientTempC)
  else
    lastTemp := kAmbientTempC;
  result[iPoints].y := lastTemp;

  for iSegment := 0 to fNoSegments-1 do
  begin
    Inc(iPoints);
    if asF then
    begin
      cTemp := C2F(fTemps[iSegment]);
      sumX := sumX + Abs(((cTemp-lastTemp)/CpH2FpH(fRates[iSegment])) * 60);  // reporting minutes, rate is in F/hr
    end
    else
    begin
      cTemp := fTemps[iSegment];
      sumX := sumX + Abs(((cTemp-lastTemp)/fRates[iSegment]) * 60);  // reporting minutes, rate is in C/hr
    end;
    result[iPoints].x := sumX;
    result[iPoints].y := cTemp;
    Inc(iPoints);
    sumX := sumX + fHoldTimes[iSegment];  // holds are in minutes
    result[iPoints].x := sumX;
    result[iPoints].y := cTemp;
    lastTemp := cTemp;
  end;
end;

function TSchedule.AsJSON: String;
var
  jMain: TJSONObject;
  jSegment: TJSONObject;
  jSegments: TJSONArray;
  iSegment: Integer;
  iMeta: Integer;
  isStoredInF: Boolean;
begin
  isStoredInF := fMetadata.Values['units-temp'].ToLower.Contains('f');

  jMain := TJSONObject.Create;
  for iMeta:=0 to fMetadata.Count -1 do
    jMain.Add(fMetadata.Names[iMeta],fMetaData.Values[fMetadata.Names[iMeta]]);
  jSegments := TJSONArray.Create;
  for iSegment:= 0 to fNoSegments-1 do
  begin
    jSegment := TJSONObject.Create;
    if isStoredInF then
    begin
      jSegment.Add('rate',CpH2FpH(fRates[iSegment]));
      jSegment.Add('temp',C2F(fTemps[iSegment]));
    end
    else
    begin
      jSegment.Add('rate',fRates[iSegment]);
      jSegment.Add('temp',fTemps[iSegment]);
    end;
    jSegment.Add('hold',fHoldTimes[iSegment]);
    jSegment.Add('fanon',fFanOns[iSegment]);
    jSegment.Add('note',fNotes[iSegment]);
  end;

  jMain.Add('segments', jSegments);
  result := jMain.FormatJSON;
  jMain.Free;
end;

function TSchedule.GetMetadata(aName: String): String;
begin
  result := fMetadata.Values[aName];
end;

procedure TSchedule.SetMetadata(aName: String; aValue: String);
begin
  if fMetadata.Values[aName] <> aValue then
  begin
    fMetadata.Values[aName] := aValue;
    fChanged := true;
  end;
end;

function TSchedule.GetFanOn: Boolean;
begin
  if fCurrentSegment < fNoSegments then
    result := fFanOns[fCurrentSegment]
  else if fCurrentSegment > 0 then
    result := fFanOns[fCurrentSegment-1]   // continue with last segment
  else
    result := false;
end;

function TSchedule.MeetsCone: Boolean;
begin
  result := (fTargetConeIndex > 0) and (fMaxConeIndex >= fTargetConeIndex);
end;

function TSchedule.ActualFiringRateCpHr: Double; // C/hr - used to calculate current cone
var
  i,n: Integer;
  dTime,dTemp: Double;
begin
  n := Length(fHistory);

  // need a reasonable history
  // 3 history entries per kCycleLengthSeconds
  if n < (kCycleLengthSeconds/3)*12*10 then  // ~10 minutes
    exit(0);

  i := Max(3,n-Round(kRateLookBackSeconds/(kCycleLengthSeconds/3)));    // look ~30 minutes back, if available

  // use 3 history points at each end so that all 3 temp sensors are involved
  dTemp := ((fHistory[n-1].Y + fHistory[n-2].Y + fHistory[n-3].Y)-(fHistory[i-1].Y + fHistory[i-2].X + fHistory[i-3].Y))/3; // delta temp °C
  dTime := ((fHistory[n-1].X + fHistory[n-2].X + fHistory[n-3].X)-(fHistory[i-1].X + fHistory[i-2].X + fHistory[i-3].X))/3; // delta hours

  result := dTemp/dTime; // delta C per Hr
end;

function TSchedule.TargetTempC(aReportedTempC: Double): Double;
var
  segmentStartTempC: Double;
  segmentEndTempC: Double;
  segmentLengthHrs: Double;
  timeIntoSegmentHrs: Double;
  segmentRate: Double;
  tNow: TDateTime;
  startNewSegment: Boolean;
  startHold: Boolean;
  iSegment: Integer;
  n: Integer;
begin
  fTimeLeftHrs := 0;
  fLastReportedTempC := aReportedTempC;

  // is schedule complete?
  if fCurrentSegment >= fNoSegments then
    exit(-1);

  startNewSegment := false;
  startHold := false;
  tNow := Now;
  segmentLengthHrs := 0;

  // first time into schedule?
  if (fCurrentSegment = 0) and (fCurrentSegmentStartTime = 0) then
  begin
    fStartTime := tNow;
    fCurrentSegmentStartTime := tNow;
    fStartTempC := aReportedTempC;
    fTargetConeIndex := OrtonConeToIndex(fMetadata.Values['cone']);
    if fTargetConeIndex > 0 then
    begin
      LogThis(Format('target cone: %s', [fMetadata.Values['cone']]));
      MsgThis(Format('target cone: %s', [fMetadata.Values['cone']]));
    end;
    LogThis(Format('starting segment %d: %.0f°C/hr to %.0f°C %.0f min hold', [fCurrentSegment,fRates[fCurrentSegment],fTemps[fCurrentSegment],fHoldTimes[fCurrentSegment]]));
//    MsgThis(Format('%.0f°C @ %.0f°C/hr', [fTemps[fCurrentSegment],fRates[fCurrentSegment]]));
    MsgThis(Format('%.0f°F @ %.0f°F/hr', [C2F(fTemps[fCurrentSegment]),CpH2FpH(fRates[fCurrentSegment])]));
  end;

  // Update cone progress
  fCurrFiringRateCpHr := ActualFiringRateCpHr;
  fCurrConeIndex := CalcOrtonConeIndex(aReportedTempC,fCurrFiringRateCpHr);
  if fCurrConeIndex > fMaxConeIndex then
    fMaxConeIndex := fCurrConeIndex;

  // check to see if we qualify for next segment
  // if hold has expired then start new segment
  if fInHold then
    startNewSegment := MillisecondsBetween(tNow,fHoldStartTime) >= fHoldTimes[fCurrentSegment] * kMillisecondsPerMinute
  else
  begin
    // if end temp met then maybe start hold, otherwise start next segment
    if (fTemps[fCurrentSegment] > fStartTempC) and ((aReportedTempC >= fTemps[fCurrentSegment]) or MeetsCone())
      or ((not (fTemps[fCurrentSegment] > fStartTempC)) and (aReportedTempC <= fTemps[fCurrentSegment])) then
    begin
      startHold := fHoldTimes[fCurrentSegment] > 0;
      startNewSegment := not startHold;
      if startHold then
      begin
        fInHold := true;
        fHoldStartTime := tNow;
        LogThis(Format('starting %.0f min hold', [fHoldTimes[fCurrentSegment]]));
        MsgThis(Format('%.0f min hold', [fHoldTimes[fCurrentSegment]]));
      end;
    end;
  end;

  // if start new segment
  if startNewSegment then
  begin
    Inc(fCurrentSegment);
    fInHold := false;
    fCurrentSegmentStartTime := tNow;
    // check if we are done with schedule
    if fCurrentSegment >= fNoSegments then
    begin
      LogThis('schedule completed.');
      MsgThis('schedule completed.');
      exit(-1);
    end
    else
    begin
       LogThis(Format('starting segment %d: %.0f°C @ %.0f°C/hr, %.0f min hold', [fCurrentSegment,fTemps[fCurrentSegment],fRates[fCurrentSegment],fHoldTimes[fCurrentSegment]]));
//      MsgThis(Format('%.0f°C @ %.0f°C/hr', [fTemps[fCurrentSegment],fRates[fCurrentSegment]]));
      MsgThis(Format('%.0f°F @ %.0f°F/hr', [C2F(fTemps[fCurrentSegment]),Cph2FpH(fRates[fCurrentSegment])]));
    end;
  end;

  // get target temp
  if fInHold then
    result := fTemps[fCurrentSegment]
  else
  begin
    segmentEndTempC := fTemps[fCurrentSegment];
    segmentRate := fRates[fCurrentSegment];

    // how many hours into this segment are we?
    timeIntoSegmentHrs := MillisecondsBetween(tNow,fCurrentSegmentStartTime) / kMillisecondsPerHour;

    // check for special cases first
    if segmentRate = 0 then // special case: full tilt boogie
      result := segmentEndTempC
    else
    begin
      // segment start temp
      if fCurrentSegment = 0 then
        segmentStartTempC := kAmbientTempC // assume start of first segment is room temp
      else
        segmentStartTempC := fTemps[fCurrentSegment-1];

      segmentLengthHrs := Abs((segmentEndTempC-segmentStartTempC)/segmentRate);

      // if past scheduled end time use end temp
      if timeIntoSegmentHrs >= segmentLengthHrs then
        result := segmentEndTempC
      else
      begin
        // interpolate the segment
        result := segmentStartTempC + (timeIntoSegmentHrs/segmentLengthHrs)*(segmentEndTempC-segmentStartTempC);
      end;
    end;
  end;

  // calc time left

  // this segment
  if fInHold then
    fTimeLeftHrs := (tNow - fHoldStartTime)*24
  else
    fTimeLeftHrs := segmentLengthHrs - timeIntoSegmentHrs + fHoldTimes[fCurrentSegment]/60; // holds are in minutes

  // balance of schedule
  for iSegment := fCurrentSegment+1 to fNoSegments-1 do
  begin
    if fRates[iSegment] = 0 then
      fTimeLeftHrs := fTimeLeftHrs + Abs((fTemps[iSegment]-fTemps[iSegment-1])/TKiln.EstimatedMaxFireRate((fTemps[iSegment]-fTemps[iSegment-1])/2))
    else
      fTimeLeftHrs := fTimeLeftHrs + Abs((fTemps[iSegment]-fTemps[iSegment-1])/fRates[iSegment]);

    fTimeLeftHrs := fTimeLeftHrs + fHoldTimes[iSegment]/60;  // holds are in minutes
  end;

  // add to history
  n := Length(History);
  SetLength(fHistory,n+1);
  fHistory[n].x := MillisecondsBetween(tNow,fStartTime)/kMillisecondsPerHour; // hours
  fHistory[n].y := aReportedTempC; // °C

  // log stuff
  //   LogThis(Format('',[iRing,C2F(tCurrentTemp),C2F(tTargetTemp),tRate,tSeconds]));

end;

end.

