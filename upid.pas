unit uPid;

{$mode objfpc}{$H+}

interface

uses
  Classes, SysUtils, DateUtils;

type
  TPid = class(TObject)
  private
    fKp: Double;
    fKi: Double;
    fKd: Double;
    fLastNow: TDateTime;
    fIntegralSum: Double;
    fLastErr: Double;
    fLastOutput: Double;
    class var fSisters: Array of TPid;
  public
    class constructor Create;
    constructor Create(aKp,aKi,aKd: Double);
    function Compute(aTargetTemp, aActualTemp: Double): Double;
  end;

implementation

class constructor TPid.Create;
begin
  SetLength(fSisters,0);
end;

constructor TPid.Create(aKp,aKi,aKd: Double);
var
  n: Integer;
begin
  inherited Create;

  fKp := aKp;
  fKi := aKi;
  fKd := aKd;
  fLastNow := Now;
  fIntegralSum := 0;
  fLastErr := 0;
  fLastOutput := 0;

  // add to sisters
  n := Length(fSisters);
  SetLength(fSisters, n+1);
  fSisters[n] := self;
end;

function TPid.Compute(aTargetTemp, aActualTemp: Double): Double;
var
  dErr: Double;
  tNow: TDateTime;
  error: Double;
  seconds: Double;
  output: Double;
  iSister: Integer;
  sister: TPid;
  ratio: Double;
  sisterLastOutput: Double;
begin

  //error = desired_value – actual_value
  //integral = integral_prior + error * iteration_time
  //derivative = (error – error_prior) / iteration_time
  //output = KP*error + KI*integral + KD*derivative + bias
  //error_prior = error
  //integral_prior = integral
  //sleep(iteration_time)

  tNow := Now;
  seconds := MillisecondsBetween(tNow, fLastNow)/1000;
  error :=  aTargetTemp - aActualTemp;
  fIntegralSum := fIntegralSum + (error * seconds);
  dErr := (error - fLastErr)/seconds;

  output := (fKp*error + fKi*fIntegralSum + fKd*dErr)/100;
  fLastOutput := output; // used to balance between eleements when demand exceeds ability
  fLastErr := error;
  fLastNow := tNow;

  // constrain from -0 to +1  (0 to -1 could be used for active cooling, but we don't have it)
  if output < 0 then
    output := 0
  else if output > 1 then
    output := 1;

  // maybe further constrain based on its sisters
  ratio := 1;
  for iSister:=0 to Length(fSisters) -1 do
  begin
    // take ratio of worst performing sister
    sister := fSisters[iSister];
    if (self <> sister) then
    begin
      sisterLastOutput := sister.fLastOutput;
      if (sisterLastOutput > 1) and (sisterLastOutput > fLastOutput) and (fLastOutput/sisterLastOutput < ratio)then
        ratio := fLastOutput/sisterLastOutput;
    end;
  end;

  result := output * ratio;
end;


end.

