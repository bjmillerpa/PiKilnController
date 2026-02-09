unit utiming;

{$mode delphi}

interface

uses
  Classes, SysUtils;

function VirtualNow: TDateTime;
function VirtualMillisecondsBetween(aNow, aThen: TDateTime): Int64;

implementation

uses
  dateutils;

function VirtualNow: TDateTime;
begin
  result := Now;
end;

function VirtualMillisecondsBetween(aNow, aThen: TDateTime): Int64;
begin
  result := MillisecondsBetween(aNow, aThen);
end;

end.

