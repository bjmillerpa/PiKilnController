unit uMain;

{$mode objfpc}{$H+}

interface

uses
  Classes, SysUtils, Forms, Controls, Graphics, Dialogs, ExtCtrls, ComCtrls,
  ValEdit, StdCtrls, Grids, Buttons, ActnList, TAGraph,
  TASeries, uSchedule, uKiln, uTempSensor, TADrawUtils, TACustomSeries,
  fpjson, Types;

type

  { TfrmMain }

  TTempScale = (tsFahrenheit, tsCelcius);

  TfrmMain = class(TForm)
    alMain: TActionList;
    btnFanTest: TButton;
    btnHeat1Test: TButton;
    btnHeat2Test: TButton;
    btnHeat3Test: TButton;
    btnScheduleAdd: TSpeedButton;
    btnScheduleAdd1: TSpeedButton;
    btnScheduleAdd2: TSpeedButton;
    btnScheduleAdd3: TSpeedButton;
    btnScheduleEdit: TSpeedButton;
    btnTarget1: TSpeedButton;
    btnTestConeCalcs: TSpeedButton;
    cbSchedules: TComboBox;
    chartSchedule: TChart;
    ControlBar1: TControlBar;
    editorSettings: TValueListEditor;
    gbMessages: TGroupBox;
    gbSchedule: TGroupBox;
    gbStats: TGroupBox;
    gbTrain: TGroupBox;
    GroupBox3: TGroupBox;
    GroupBox4: TGroupBox;
    ilStats: TImageList;
    ilFans: TImageList;
    ilStarts: TImageList;
    lblElapsedTime: TLabel;
    lblTargetTemp: TLabel;
    lblCost: TLabel;
    lblCone: TLabel;
    lblTimeFinished: TLabel;
    Panel16: TPanel;
    btnTestFormulae: TSpeedButton;
    tabLog: TTabSheet;
    memoLog: TMemo;
    memoMessages: TMemo;
    pcMain: TPageControl;
    pcSchedule: TPageControl;
    Panel1: TPanel;
    Panel10: TPanel;
    Panel11: TPanel;
    Panel12: TPanel;
    Panel13: TPanel;
    Panel14: TPanel;
    Panel15: TPanel;
    Panel3: TPanel;
    Panel4: TPanel;
    pnlTemp3: TPanel;
    pnlTemp1: TPanel;
    pnlTemp2: TPanel;
    Panel8: TPanel;
    Panel9: TPanel;
    seriesActual: TLineSeries;
    seriesPlanned: TLineSeries;
    sgFiringCurve: TStringGrid;
    btnTarget: TSpeedButton;
    SpeedButton2: TSpeedButton;
    btnVentFan: TSpeedButton;
    SpeedButton4: TSpeedButton;
    SpeedButton5: TSpeedButton;
    btnKilnPower: TSpeedButton;
    tabSchedule: TTabSheet;
    tabMonitor: TTabSheet;
    tabKiln: TTabSheet;
    tabFiringCurve: TTabSheet;
    tabMetadata: TTabSheet;
    tabTests: TTabSheet;
    vleScheduleMetadata: TValueListEditor;
    procedure btnFanTestMouseDown(Sender: TObject; Button: TMouseButton;
      Shift: TShiftState; X, Y: Integer);
    procedure btnFanTestMouseUp(Sender: TObject; Button: TMouseButton;
      Shift: TShiftState; X, Y: Integer);
    procedure btnHeat1TestMouseDown(Sender: TObject; Button: TMouseButton;
      Shift: TShiftState; X, Y: Integer);
    procedure btnHeat1TestMouseUp(Sender: TObject; Button: TMouseButton;
      Shift: TShiftState; X, Y: Integer);
    procedure btnHeat2TestMouseDown(Sender: TObject; Button: TMouseButton;
      Shift: TShiftState; X, Y: Integer);
    procedure btnHeat2TestMouseUp(Sender: TObject; Button: TMouseButton;
      Shift: TShiftState; X, Y: Integer);
    procedure btnHeat3TestMouseDown(Sender: TObject; Button: TMouseButton;
      Shift: TShiftState; X, Y: Integer);
    procedure btnHeat3TestMouseUp(Sender: TObject; Button: TMouseButton;
      Shift: TShiftState; X, Y: Integer);
    procedure btnTestConeCalcsClick(Sender: TObject);
    procedure btnTestFormulaeClick(Sender: TObject);
    procedure btnVentFanClick(Sender: TObject);
    procedure cbSchedulesChange(Sender: TObject);
    procedure FormClose(Sender: TObject; var CloseAction: TCloseAction);
    procedure FormCloseQuery(Sender: TObject; var CanClose: boolean);
    procedure FormCreate(Sender: TObject);
    procedure FormDestroy(Sender: TObject);
    procedure lblTargetTempClick(Sender: TObject);
    procedure rgFanModeClick(Sender: TObject);
    procedure sgFiringCurveColRowInserted(Sender: TObject; IsColumn: Boolean;
      sIndex, tIndex: Integer);
    procedure btnKilnPowerClick(Sender: TObject);
    procedure sgFiringCurveGetEditMask(Sender: TObject; ACol, ARow: Integer;
      var Value: string);
    procedure tabTestsContextPopup(Sender: TObject; MousePos: TPoint;
      var Handled: Boolean);
  private
    fnLog: String;
    fKiln: TKiln;
    fConfig: TJSONObject;
    fRecents: TJSONObject;
    fDisplayTempScale: TTempScale;
    procedure HeartBeatEnter(Sender: TObject);
    procedure HeartBeatExit(Sender: TObject);
    procedure PostMessage(Sender: TObject; aMsg: String);
    procedure PostLog(Sender: TObject; aMsg: String);
    procedure TempSensorChange1(Sender: TObject; aNewTempC: Double);
    procedure TempSensorChange2(Sender: TObject; aNewTempC: Double);
    procedure TempSensorChange3(Sender: TObject; aNewTempC: Double);
    procedure TempSensorError1(Sender: TObject; aErrors: TTempSensorErrorSet);
    procedure TempSensorError2(Sender: TObject; aErrors: TTempSensorErrorSet);
    procedure TempSensorError3(Sender: TObject; aErrors: TTempSensorErrorSet);
    procedure VentFanToggle(Sender: TObject; aIsOn: Boolean);
    procedure ElementToggle1(Sender: TObject; aIsOn: Boolean);
    procedure ElementToggle2(Sender: TObject; aIsOn: Boolean);
    procedure ElementToggle3(Sender: TObject; aIsOn: Boolean);
    procedure NewLog;
    procedure LogThis(aMsg: String);
    procedure LoadScheduleList;
    procedure LoadSchedule(aSchedule: TSchedule);
    procedure SaveSchedule(aSchedule: TSchedule);
    procedure UpdateButtons;
    procedure UpdateMonitor;
    procedure UpdateScheduleGraph(aTempC: Double; aTimeSecs: Double);
    procedure ToggleDisplayTempScale;
    function  TempCToDisplayStr(aTempC: Double): String;
  public

  end;

var
  frmMain: TfrmMain;

implementation

uses
  Math, uConstants, uOrtonCones, uTests, umonitoredbject;

{$R *.lfm}

{ TfrmMain }

const
  iRateCol = 0;
  iTempCol = 1;
  iHoldCol = 2;
  iFanCol = 3;
  iNoteCol = 4;
  clRelayOn = clRed;
  clRelayOff = clMedGray;
  clSensorError = clRed;
  clStatusNeutral = clBlack;
  clStatusGood = clLime;
  clStatusCautionary = clYellow;
  clStatsBad = clRed;


function CtoFAsString(aTempC: Double): String;
begin
  result := IntToStr(Round(aTempC*9/5 + 32)) + '°F';
end;

procedure TfrmMain.btnFanTestMouseDown(Sender: TObject; Button: TMouseButton;
  Shift: TShiftState; X, Y: Integer);
begin
  // turn on
  LogThis('fan on');
  fKiln.VentFan.TurnOn;
end;

procedure TfrmMain.btnFanTestMouseUp(Sender: TObject; Button: TMouseButton;
  Shift: TShiftState; X, Y: Integer);
begin
  // turn off
  LogThis('fan off');
  fKiln.VentFan.TurnOff;
end;

procedure TfrmMain.btnHeat1TestMouseDown(Sender: TObject; Button: TMouseButton;
  Shift: TShiftState; X, Y: Integer);
begin
  fKiln.Elements[1].TurnOn;
end;

procedure TfrmMain.btnHeat1TestMouseUp(Sender: TObject; Button: TMouseButton;
  Shift: TShiftState; X, Y: Integer);
begin
  fKiln.Elements[1].TurnOff;
end;

procedure TfrmMain.btnHeat2TestMouseDown(Sender: TObject; Button: TMouseButton;
  Shift: TShiftState; X, Y: Integer);
begin
  fKiln.Elements[2].TurnOn;
end;

procedure TfrmMain.btnHeat2TestMouseUp(Sender: TObject; Button: TMouseButton;
  Shift: TShiftState; X, Y: Integer);
begin
  fKiln.Elements[2].TurnOff;
end;

procedure TfrmMain.btnHeat3TestMouseDown(Sender: TObject; Button: TMouseButton;
  Shift: TShiftState; X, Y: Integer);
begin
   fKiln.Elements[3].TurnOn;
end;

procedure TfrmMain.btnHeat3TestMouseUp(Sender: TObject; Button: TMouseButton;
  Shift: TShiftState; X, Y: Integer);
begin
   fKiln.Elements[3].TurnOff;
end;

procedure TfrmMain.btnTestConeCalcsClick(Sender: TObject);
var
  rate, temp, i,j : Integer;
  io: Double;
begin
  for i := 0 to 5 do
  begin
    for j := 0 to 60 do
    begin
      rate := 25 + i*50;
      temp := 1200 + j*20;
      io := CalcOrtonConeIndex(F2C(temp), FpH2CpH(rate));
      LogThis(IntToStr(temp) + '°F @ ' + IntToStr(rate) + '°F/hr = ' + FloatToStr(io) + ': ' + OrtonConeFromIndex(io) + '  ' + FloatToStr(OrtonConeToIndex(OrtonConeFromIndex(io))));
    end;
  end;
end;

procedure TfrmMain.btnTestFormulaeClick(Sender: TObject);
var
  mV: Integer;
  lookupC, calcedC: Double;
begin
  // step through array of mV2C values and test the functions
  // log each
  for mV:= Low(kmV2C) to High(kmV2C) do
  begin
    lookupC := kmV2C[mV];
    calcedC := TTempSensor.mV2C(mV);
    LogThis(Format('%4dmV = %4.1f°C  %4.1f°C %4.3f°C ',[mV,lookupC,calcedC,lookupC-calcedC]));
  end;
end;

procedure TfrmMain.btnVentFanClick(Sender: TObject);
begin
  // togglr mode
end;

procedure TfrmMain.cbSchedulesChange(Sender: TObject);
var
  schedule: TSchedule;
begin
  if cbSchedules.ItemIndex > -1 then
  begin
    schedule := TSchedule.Schedules[cbSchedules.Items[cbSchedules.ItemIndex]];
    LoadSchedule(schedule);
    fKiln.Schedule := schedule;
  end;
end;

procedure TfrmMain.FormClose(Sender: TObject; var CloseAction: TCloseAction);
begin
  // shut down elements
  fKiln.Elements[1].TurnOff;
  fKiln.Elements[2].TurnOff;
  fKiln.Elements[3].TurnOff;
end;

procedure TfrmMain.FormCloseQuery(Sender: TObject; var CanClose: boolean);
begin
  // if schedule not done then ask
end;

procedure TfrmMain.FormCreate(Sender: TObject);
var
  recentScheduleName: String;
  slConfig: TStringList;
  fn: String;
begin
  TMonitoredObject.OnLogPost := @PostLog;
  TMonitoredObject.OnMessagePost := @PostMessage;

  // make sure needed folders exist
  ForceDirectories(ExpandFileName(kAppDataFolder));
  ForceDirectories(ExpandFileName(kAppLogFolder));
  ForceDirectories(ExpandFileName(kAppScheduleFolder));

  NewLog;

  LoadScheduleList;

  // build kiln
  fKiln := TKiln.Create;
  fKiln.OnHeartBeatEnter := @HeartBeatEnter;
  fKiln.OnHeartBeatExit := @HeartBeatExit;

  // attach event methods to each relay and temp sensor
  fKiln.TempSensors[1].TempChangeEvent := @TempSensorChange1;
  fKiln.TempSensors[2].TempChangeEvent := @TempSensorChange2;
  fKiln.TempSensors[3].TempChangeEvent := @TempSensorChange3;
  fKiln.TempSensors[1].ErrorEvent := @TempSensorError1;
  fKiln.TempSensors[2].ErrorEvent := @TempSensorError2;
  fKiln.TempSensors[3].ErrorEvent := @TempSensorError3;
  fKiln.VentFan.ToggleEvent := @VentFanToggle;
  fKiln.Elements[1].ToggleEvent := @ElementToggle1;
  fKiln.Elements[2].ToggleEvent := @ElementToggle2;
  fKiln.Elements[3].ToggleEvent := @ElementToggle3;

  fDisplayTempScale := tsFahrenheit; // for display. All internal calcs are in °C

  // config
  slConfig := TStringList.Create;
  try
    fn := ExpandFileName(kAppConfigFilename);
    if FileExists(fn) then
    begin
      slConfig.LoadFromFile(fn);
      fConfig := GetJSON(slConfig.Text) as TJSONObject;
    end
    else
    begin
      fConfig := GetJSON('{"recents":{"schedule-title": ""}}') as TJSONObject;
    end;
  finally
    slConfig.Free;
  end;

  fRecents := fConfig.Get('recents',TJSONObject(nil));

  // load last used schedule
  recentScheduleName := fRecents.Get('schedule-title','');
  // look up in list and load
  if (recentScheduleName <> '') and (TSchedule.Schedules.IndexOf(recentScheduleName) > -1) then
    LoadSchedule(TSchedule.Schedules[recentScheduleName]);

  pcMain.ActivePage := tabMonitor;

  UpdateButtons;
end;

procedure TfrmMain.FormDestroy(Sender: TObject);
var
  slConfig: TStringList;
begin
  slConfig := TStringList.Create;
  try
    slConfig.Text := fConfig.FormatJSON;
    slConfig.SaveToFile(ExpandFileName(kAppConfigFilename));
  finally
    slConfig.Free;
  end;

  fKiln.Free;
  fConfig.Free;
end;

procedure TfrmMain.lblTargetTempClick(Sender: TObject);
begin
  ToggleDisplayTempScale;
end;

procedure TfrmMain.rgFanModeClick(Sender: TObject);
begin

end;

procedure TfrmMain.HeartBeatEnter(Sender: TObject);
begin
  //
end;

procedure TfrmMain.HeartBeatExit(Sender: TObject);
begin
  if fKiln.Mode <> kmOff then
    UpdateScheduleGraph(fKiln.ElapsedTimeSeconds,fKiln.TempSensors[2].AsCelcius);

  UpdateMonitor;
  UpdateButtons;
end;

procedure TfrmMain.TempSensorChange1(Sender: TObject; aNewTempC: Double);
begin
  pnlTemp1.Caption := TempCToDisplayStr(aNewTempC);
  // change color dependent on how far off target we are
  pnlTemp1.Font.Color := clStatusNeutral;
end;

procedure TfrmMain.TempSensorChange2(Sender: TObject; aNewTempC: Double);
begin
  pnlTemp2.Caption := TempCToDisplayStr(aNewTempC);
end;

procedure TfrmMain.TempSensorChange3(Sender: TObject; aNewTempC: Double);
begin
  pnlTemp3.Caption := TempCToDisplayStr(aNewTempC);
end;

procedure TfrmMain.TempSensorError1(Sender: TObject; aErrors: TTempSensorErrorSet);
begin
  pnlTemp1.Font.Color := clSensorError;
  pnlTemp1.Caption := TTempSensor.ErrorString(aErrors);
end;

procedure TfrmMain.TempSensorError2(Sender: TObject; aErrors: TTempSensorErrorSet);
begin
  pnlTemp2.Font.Color := clSensorError;
  pnlTemp2.Caption := TTempSensor.ErrorString(aErrors);
end;

procedure TfrmMain.TempSensorError3(Sender: TObject; aErrors: TTempSensorErrorSet);
begin
  pnlTemp3.Font.Color := clSensorError;
  pnlTemp3.Caption := TTempSensor.ErrorString(aErrors);
end;

procedure TfrmMain.VentFanToggle(Sender: TObject; aIsOn: Boolean);
var
  s: String;
begin
  if aIson then
  begin
    btnVentFan.ImageIndex := 2;
    s := 'On';
  end
  else
  begin
    btnVentFan.ImageIndex := 3;
    s := 'Off';
  end;
  // also need to append mode to s

  btnVentFan.Caption := s;
end;

procedure TfrmMain.ElementToggle1(Sender: TObject; aIsOn: Boolean);
begin
  if aIsOn then
    pnlTemp1.BevelColor := clRelayOn
  else
    pnlTemp1.BevelColor := clRelayOff;
end;

procedure TfrmMain.ElementToggle2(Sender: TObject; aIsOn: Boolean);
begin
  if aIsOn then
    pnlTemp2.BevelColor := clRelayOn
  else
    pnlTemp2.BevelColor := clRelayOff;
end;

procedure TfrmMain.ElementToggle3(Sender: TObject; aIsOn: Boolean);
begin
  if aIsOn then
    pnlTemp3.BevelColor := clRelayOn
  else
    pnlTemp3.BevelColor := clRelayOff;
end;


procedure TfrmMain.btnKilnPowerClick(Sender: TObject);
begin
  case fKiln.mode of
    kmOff:     fKiln.Start;
    kmRunning: fKiln.Stop;
    kmIdle:    fKiln.Start;
  end;
  UpdateButtons;
end;

procedure TfrmMain.sgFiringCurveGetEditMask(Sender: TObject; ACol, ARow: Integer;
  var Value: string);
begin
  // cols 0-2 are int only
  // 3 is Boolean
  // 4 is string
  case ACol of
    iRateCol,
    iTempCol:  Value := '9999';
    iHoldCol:  Value := '999';
  end;
end;

procedure TfrmMain.tabTestsContextPopup(Sender: TObject; MousePos: TPoint;
  var Handled: Boolean);
begin

end;

procedure TfrmMain.NewLog;
begin
  memoLog.Clear;
  fnLog := ExpandFileName(kAppLogFolder + FormatDateTime(kDateFormat,Now) + '.log');
  memoLog.Lines.SaveToFile(fnLog);
end;

procedure TfrmMain.LogThis(aMsg: String);
begin
  memoLog.Lines.Add(FormatDateTime(kDateTimeFormat,Now) + ': ' + aMsg);
  memoLog.Lines.SaveToFile(fnLog);
end;

procedure TfrmMain.LoadScheduleList;
var
  iKey: Integer;
begin
  cbSchedules.Clear;
  for iKey := 0 to TSchedule.Schedules.Count-1 do
    cbSchedules.Items.Add(TSchedule.Schedules.Keys[iKey]);
end;

procedure TfrmMain.LoadSchedule(aSchedule: TSchedule);
var
  iRow, iPoints, nPoints: Integer;
  points: TXYPairArray;
  maxF: Double;
  maxHrs: Integer;
  title: String;
begin
  vleScheduleMetadata.Clear;
  seriesActual.Clear;
  seriesPlanned.Clear;
  sgFiringCurve.RowCount := 1;

  fKiln.Schedule := aSchedule;

  if aSchedule <> nil then
  begin
    vleScheduleMetadata.Strings.Assign(aSchedule.MetadataList);

    sgFiringCurve.RowCount := aSchedule.NoSegments + 1;

    for iRow := 1 to sgFiringCurve.RowCount-1 do
    begin
      sgFiringCurve.Cells[iRateCol,iRow] := FloatToStr(aSchedule.Rates[iRow-1]);
      sgFiringCurve.Cells[iTempCol,iRow] := FloatToStr(aSchedule.Temps[iRow-1]);
      sgFiringCurve.Cells[iHoldCol,iRow] := FloatToStr(aSchedule.HoldTimes[iRow-1]);
      sgFiringCurve.Cells[iFanCol,iRow] := BoolToStr(aSchedule.FanOns[iRow-1]);
      sgFiringCurve.Cells[iNoteCol,iRow] := aSchedule.Notes[iRow-1];
    end;

    // now build graph
    points := aSchedule.AsXYGraph(true);
    nPoints := Length(points);
    maxF := 0;

    for iPoints := 0 to nPoints -1 do
    begin
      seriesPlanned.AddXY(points[iPoints].x/60,points[iPoints].y); // x stored in minutes - charted in hrs
      if maxF < points[iPoints].y then
        maxF := points[iPoints].y;
    end;

    // adjust x/y ranges to suit, but make them pretty
    maxF := Math.Ceil((maxF + 100)/100)*100; //some headroom and multiple of 100
    chartSchedule.AxisList[0].Range.Max := maxF;

    maxHrs := Math.Ceil(1.1 * points[nPoints-1].x/60); // some side room for cool down
    chartSchedule.AxisList[1].Range.Max := maxHrs;
    chartSchedule.AxisList[1].Intervals.Count := maxHrs;
    if maxHrs > 11 then
      chartSchedule.AxisList[1].Minors[0].Intervals.Count := 2
    else if MaxHrs > 6 then
      chartSchedule.AxisList[1].Minors[0].Intervals.Count := 4
    else
      chartSchedule.AxisList[1].Minors[0].Intervals.Count := 6;

    // update UI, persist, and log
    title := aSchedule.Metadata['title'];
    cbSchedules.Caption := title;
    fRecents['schedule-title'].AsString := title;
    LogThis('Schedule "' + title + '" loaded.');
  end;
end;

procedure TfrmMain.SaveSchedule(aSchedule: TSchedule);
var
  iRow: Integer;
  nSegments: Integer;
begin
  aSchedule.MetadataList.Assign(vleScheduleMetadata.Strings);
  aSchedule.Metadata['modified'] := FormatDateTime(kDateTimeFormat, Now);

  // remove any bogus rows from string grid
  // because of the edit mask values are either blank or an integer
  for iRow:= sgFiringCurve.RowCount-1 downto 1 do
    if (sgFiringCurve.Cells[iRateCol,iRow] = '')
       or (sgFiringCurve.Cells[iTempCol,iRow] = '')
       or (sgFiringCurve.Cells[iHoldCol,iRow] = '')
       or (StrToFloat(sgFiringCurve.Cells[iTempCol,iRow]) = 0) // need a real temp
       or ((StrToFloat(sgFiringCurve.Cells[iRateCol,iRow]) = 0) and (StrToFloat(sgFiringCurve.Cells[iHoldCol,iRow]) = 0)) then  // need either rate or hold
      sgFiringCurve.DeleteRow(iRow);

  nSegments := sgFiringCurve.RowCount-1;
  aSchedule.NoSegments := nSegments;

  for iRow := 1 to nSegments do
  begin
    aSchedule.Rates[iRow-1] := StrToFloat(sgFiringCurve.Cells[iRateCol,iRow]);
    aSchedule.Temps[iRow-1] := StrToFloat(sgFiringCurve.Cells[iTempCol,iRow]);
    aSchedule.HoldTimes[iRow-1] := StrToFloat(sgFiringCurve.Cells[iHoldCol,iRow]);

    aSchedule.FanOns[iRow-1] := sgFiringCurve.Cells[iFanCol,iRow] = '1';
    aSchedule.Notes[iRow-1] := sgFiringCurve.Cells[iNoteCol,iRow];
  end;
end;

procedure TfrmMain.UpdateButtons;
begin
  // check kiln mode
  // if kiln active kill scheule edit and testing
  btnKilnPower.Enabled := (fKiln.Schedule <> nil); // maybe add kiln error test
  btnVentFan.Enabled := fKiln.mode <> kmOff;

  case fKiln.mode of
    kmOff:     btnKilnPower.Caption := 'Off';
    kmRunning: btnKilnPower.Caption := 'On';
    kmIdle:    btnKilnPower.Caption := 'Idle';
  end;

  case fKiln.FanMode of
    fmOff:  btnVentFan.Caption := 'Off';
    fmAuto: if fKiln.VentFan.IsOn then
              btnVentFan.Caption := 'On (auto)'
            else
              btnVentFan.Caption := 'Off (auto)';
    fmOn:   btnVentFan.Caption := 'On';
  end;
end;

procedure TfrmMain.UpdateMonitor;
var
  schedule: TSchedule;
  kWatts: Double;
begin
  schedule := fKiln.Schedule;
  if schedule <> nil then
  begin
    kWatts := fKiln.ElapsedPowerKWHr;
    lblTargetTemp.Caption := TempCToDisplayStr(schedule.TargetTempC(fKiln.TempSensors[2].AsCelcius));
    lblCone.Caption := OrtonConeFromIndex(fKiln.Schedule.MaxConeIndex);
    lblCost.Caption := Format('%.1f kWh $%0.2f',[kWatts, kWatts * kCostPerKW]);
    lblElapsedTime.Caption := FormatDateTime(kElapsedTimeFormat, fKiln.ElapsedTime);
    lblTimeFinished.Caption := FormatDateTime(kClockTimeFormat, Time + fKiln.Schedule.TimeLeftHrs/24);
  end
  else
  begin
    lblTargetTemp.Caption := '-';
    lblCone.Caption := '-';
    lblCost.Caption := '0.00';
    lblElapsedTime.Caption := FormatDateTime(kElapsedTimeFormat, 0);
    lblTimeFinished.Caption := '-';
  end;
end;

procedure TfrmMain.UpdateScheduleGraph(aTempC: Double; aTimeSecs: Double);
var
  hrs: Double;
  n: Integer;
  maxHrs: Integer;
begin
  // only update if it has been at least 30 seconds
  n := seriesActual.Count;
  if (n > 0) and (seriesActual.XValue[n-1]*60*60 + 30 > aTimeSecs/60) then exit;

  hrs := aTimeSecs/(60*60);
  // make sure room for plot
  maxHrs := Math.Ceil(hrs);
  if maxHrs > chartSchedule.AxisList[1].Range.Max then
  begin
    chartSchedule.AxisList[1].Range.Max := maxHrs;
    chartSchedule.AxisList[1].Intervals.Count := maxHrs;
    if maxHrs > 11 then
      chartSchedule.AxisList[1].Minors[0].Intervals.Count := 2
    else if MaxHrs > 6 then
      chartSchedule.AxisList[1].Minors[0].Intervals.Count := 4
    else
      chartSchedule.AxisList[1].Minors[0].Intervals.Count := 6;
  end;
  // add to series
  seriesActual.AddXY(hrs, C2F(aTempC));
end;

procedure TfrmMain.PostMessage(Sender: TObject; aMsg: String);
begin
  memoMessages.Lines.Add(aMsg);
end;

procedure TfrmMain.PostLog(Sender: TObject; aMsg: String);
begin
  LogThis(aMsg);
end;

procedure TfrmMain.sgFiringCurveColRowInserted(Sender: TObject;
  IsColumn: Boolean; sIndex, tIndex: Integer);
begin
  if not IsColumn then
  begin
    sgFiringCurve.Cells[iRateCol,tIndex] := '0';
    sgFiringCurve.Cells[iTempCol,tIndex] := '0';
    sgFiringCurve.Cells[iHoldCol,tIndex] := '0';
    sgFiringCurve.Cells[iFanCol,tIndex]  := '0';
  end;
end;

procedure TfrmMain.ToggleDisplayTempScale;
begin
  case fDisplayTempScale of
    tsFahrenheit: fDisplayTempScale := tsCelcius;
    tsCelcius:    fDisplayTempScale := tsFahrenheit;
  end;
end;

function  TfrmMain.TempCToDisplayStr(aTempC: Double): String;
begin
  // only interested in decimal part
  case fDisplayTempScale of
    tsFahrenheit: result := IntToStr(Round(aTempC*9/5 + 32)) + '°F';
    tsCelcius:    result := IntToStr(Round(aTempC)) + '°C';
  end;
end;


end.

