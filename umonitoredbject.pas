unit umonitoredbject;

{$mode delphi}

interface

uses
  Classes, SysUtils;

type
  TLogPostEvent = procedure (ASender: TObject; aMsg: String) of object;
  TMessagePostEvent = procedure (ASender: TObject; aMsg: String) of object;

  TMonitoredObject = class(TObject)
  private
    class var fOnLogPost: TLogPostEvent;
    class var fOnMessagePost: TMessagePostEvent;
  public
    procedure LogThis(aLogMsg: String);
    // general stuff for immediate display
    procedure MsgThis(aMsg: String);
   class property OnLogPost: TLogPostEvent write fOnLogPost;
    class property OnMessagePost: TMessagePostEvent write fOnMessagePost;
    class constructor Create;
    // detailed info for log file
  end;

implementation

class constructor TMonitoredObject.Create;
begin
  fOnLogPost := nil;
  fOnMessagePost := nil;
end;

procedure TMonitoredObject.LogThis(aLogMsg: String);
begin
  if Assigned(fOnLogPost) then
    fOnLogPost(self, aLogMsg);
end;

procedure TMonitoredObject.MsgThis(aMsg: String);
begin
  if Assigned(fOnMessagePost) then
    fOnMessagePost(self, aMsg);
end;

end.

