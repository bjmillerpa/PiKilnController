program PiKilnController;

{$mode objfpc}{$H+}

uses
  {$IFDEF UNIX}{$IFDEF UseCThreads}
  cthreads,
  {$ENDIF}{$ENDIF}
  Interfaces, // this includes the LCL widgetset
  Forms, uMain, tachartlazaruspkg, lazcontrols, uKiln, uConstants, uPid,
  uTempSensor, uSchedule, uOrtonCones, uRelays, uFauxGPioLinux, uTypes, uTests,
  umonitoredbject, utiming;

{$R *.res}

begin
  RequireDerivedFormResource:=True;
  Application.Scaled:=True;
  Application.Initialize;
  Application.CreateForm(TfrmMain, frmMain);
  Application.Run;
end.

