unit uRelays;

{$mode objfpc}{$H+}

interface

uses
  Classes, SysUtils, DateUtils, extctrls {TTimer}, fpgpio;

type

  TRelayToggleEvent = procedure (ASender: TObject; aIsOn: Boolean) of object;

  TRelay = class(TObject)
  private
    fGPIO_Relay: TGpioPin;
    fRelayToggleEvent: TRelayToggleEvent;
    fTrackingOnTime: Boolean;
    fStartTime: TDateTime;
    fLastAccumulationTime: TDateTime;
    fSecondsOn: Double; // seconds
    fSecondsOnLastChecked: Double;
    procedure AccumulateSecondsOn;
    function GetSecondsOnSinceLastChecked: Double;
    procedure SetIsOn(aValue: Boolean);
  public
    constructor Create(aGPIOPinNo: Integer);
    destructor Destroy; override;
    procedure TurnOn;
    procedure TurnOff;
    property IsOn: Boolean read fTrackingOnTime write SetIsOn;
    property ToggleEvent: TRelayToggleEvent read fRelayToggleEvent write fRelayToggleEvent;
    property SecondsOn: Double read fSecondsOn;
    property SecondsOnSinceLastChecked: Double read GetSecondsOnSinceLastChecked;
  end;

  TElement = class(TRelay)
  private
    fOffTimer: TTimer;
    fWatts: Double;
    procedure OnTimerHalt(Sender: TObject);
  public
    constructor Create(aGPIOPinNo: Integer);
    destructor Destroy; override;
    procedure Start(aDuration: Double);  // seconds
    property Watts: Double read fWatts write fWatts;
  end;

implementation

uses
  uConstants
{$IFNDEF LINUX}, uFauxGPioLinux{$ENDIF};

constructor TRelay.Create(aGPIOPinNo: Integer);
begin
  inherited Create;

  fGPIO_Relay := TGPioLinuxPin.Create(aGPIOPinNo);
  fGPIO_Relay.Direction := TGpioDirection.gdOut;
  fGPIO_Relay.Value := false;
  fRelayToggleEvent := nil;

  // usage tracking
  fSecondsOn := 0;
  fTrackingOnTime := false;
  fStartTime := 0;
  fLastAccumulationTime := 0;
  fSecondsOnLastChecked := 0;
end;

destructor TRelay.Destroy;
begin
  fGPIO_Relay.Value := false;
  fGPIO_Relay.Free;

  inherited;
end;

procedure TRelay.SetIsOn(aValue: Boolean);
begin
  if aValue = fTrackingOnTime then exit;

  if aValue then
    TurnOn
  else
    TurnOff;
end;

procedure TRelay.TurnOn;
begin
  fGPIO_Relay.Value := true;
  fTrackingOnTime := true;
  fStartTime := Now;
  fLastAccumulationTime := fStartTime;
  if Assigned(fRelayToggleEvent) then
    fRelayToggleEvent(self, true);
end;

procedure TRelay.TurnOff;
begin
  fGPIO_Relay.Value := false;
  AccumulateSecondsOn;
  // fTrackingOnTime allows us to leave off-timer running, a safer option than not
  fTrackingOnTime := false;
  if Assigned(fRelayToggleEvent) then
    fRelayToggleEvent(self, false);
end;

procedure TRelay.AccumulateSecondsOn;
var
  tNow: TDateTime;
begin
  if fTrackingOnTime then
  begin
    tNow := Now;
    fSecondsOn := fSecondsOn + MillisecondsBetween(tNow, fLastAccumulationTime) / 1000;
    fLastAccumulationTime := tNow;
  end;
end;

function TRelay.GetSecondsOnSinceLastChecked: Double;
begin
  AccumulateSecondsOn; // adjust for current run
  result := fSecondsOn - fSecondsOnLastChecked;
  fSecondsOnLastChecked := fSecondsOn;
end;


constructor TElement.Create(aGPIOPinNo: Integer);
begin
  inherited;

  fOffTimer := TTimer.Create(nil);
  fOffTimer.OnTimer := @OnTimerHalt;
  fOffTimer.Enabled := false;

  fWatts := 240*16;
end;

destructor TElement.Destroy;
begin
  fOffTimer.Free;

  inherited;
end;

procedure TElement.OnTimerHalt(Sender: TObject);
begin
  TurnOff;
end;

procedure TElement.Start(aDuration: Double);  // seconds
begin
  If aDuration <= 0 then
  begin
    // turn off timer
    fOffTimer.Enabled := false;
    TurnOff;
  end
  else
  begin
    // set up timer
    fOffTimer.Enabled := false;
    // if max duration then overlap so relay stays on
    if aDuration >= kCycleLengthSeconds then
      aDuration := kCycleLengthSeconds*1.2;
    fOffTimer.Interval := Round(aDuration * 1000);
    fOffTimer.Enabled := true;
    TurnOn;
  end;
end;


end.

