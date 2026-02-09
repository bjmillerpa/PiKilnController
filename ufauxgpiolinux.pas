// a fake TGPioLinuxPin to allow UI testing off the Pi

unit uFauxGPioLinux;

{$mode objfpc}{$H+}

interface

uses
  Classes, SysUtils, fpgpio, fpspi;

{$IFNDEF LINUX}
  type

  { TGpioLinuxPin }

  TGpioLinuxPin = class(TGpioPin)
  private
    fPinID: Longword;
  protected
    function GetActiveLow: Boolean; override;
    class function ReadFromFile(const aFileName: String; aChars: SizeInt; out CharsRead: SizeInt): String;
    class function ReadFromFile(const aFileName: String; aChars: SizeInt): String;
    procedure SetActiveLow(AValue: Boolean); override;
    class procedure WriteToFile(const aFileName: String; const aBuffer; aCount: SizeInt);
    class procedure WriteToFile(const aFileName: String; const aBuffer: String);
    class procedure SetExport(aExport: Boolean; aPin: Longword);
    class function GetEdgeString(aInterruptMode: TGpioInterruptMode): String;
    class function EdgeStringToInterruptMode(const aValue: String): TGpioInterruptMode;
  protected
    function GetDirection: TGpioDirection; override;
    function GetInterruptMode: TGpioInterruptMode; override;
    function GetValue: Boolean; override;
    procedure SetDirection(AValue: TGpioDirection); override;
    procedure SetInterruptMode(AValue: TGpioInterruptMode); override;
    procedure SetValue(AValue: Boolean); override;
  public const
    INTERRUPT_WAIT_NONE     =  0;
    INTERRUPT_WAIT_INFINITE = -1;
  public
    constructor Create(aID: Longword);
    destructor Destroy; override;
    function WaitForInterrupt(timeout: LongInt; out NewValue: Boolean): Boolean; override;
    property PinID: Longword read fPinID;
  end;

{ TSPILinuxDevice }

TSPILinuxDevice = class(TSPIDevice)
private
  fBus: Longword;
  fCS: Longword;
protected
  function GetBitsPerWord: Byte; override;
  function GetLSBFirst: Boolean; override;
  function GetMaxFrequency: Longword; override;
  function GetMode: TSPIMode; override;
  procedure SetBitsPerWord(AValue: Byte); override;
  procedure SetLSBFirst(AValue: Boolean); override;
  procedure SetMaxFrequency(AValue: Longword); override;
  procedure SetMode(AValue: TSPIMode); override;

  function GetDevicePath: String;
public
  constructor Create(aBus: Longword; aChipSelect: Longword);
  destructor Destroy; override;

  function Read(var Buffer; Count: Longint): Longint; override;
  function Write(const Buffer; Count: Longint): Longint; override;
  procedure ReadAndWrite(const aWriteBuffer; aWriteCount: Longint;
    Var aReadBuffer; aReadCount: Longint); override;
//  procedure ReadAndWrite(in_out_data: TSPI_IOC_Transfer_Array);

  property Bus: Longword read fBus;
  property ChipSelect: Longword read fCS;
end;
{$ENDIF}

implementation

{$IFNDEF LINUX}

{ TGpioLinuxPin }

function TGpioLinuxPin.GetActiveLow: Boolean;
begin
  Result := false;
end;

class function TGpioLinuxPin.ReadFromFile(const aFileName: String; aChars: SizeInt; out
  CharsRead: SizeInt): String;
begin
  result := '';
end;

class function TGpioLinuxPin.ReadFromFile(const aFileName: String;
  aChars: SizeInt): String;
begin
  Result := '';
end;

procedure TGpioLinuxPin.SetActiveLow(AValue: Boolean);
begin
end;

class procedure TGpioLinuxPin.WriteToFile(const aFileName: String;
  const aBuffer; aCount: SizeInt);
begin
end;

class procedure TGpioLinuxPin.WriteToFile(const aFileName: String;
  const aBuffer: String);
begin
end;

class procedure TGpioLinuxPin.SetExport(aExport: Boolean; aPin: Longword);
begin
end;

class function TGpioLinuxPin.GetEdgeString(aInterruptMode: TGpioInterruptMode
  ): String;
begin
  Result := '';
end;

class function TGpioLinuxPin.EdgeStringToInterruptMode(const aValue: String
  ): TGpioInterruptMode;
begin
  Result := [];
end;

function TGpioLinuxPin.GetDirection: TGpioDirection;
begin
  Result := gdIn ;
end;

function TGpioLinuxPin.GetInterruptMode: TGpioInterruptMode;
begin
  Result := EdgeStringToInterruptMode('');
end;

function TGpioLinuxPin.GetValue: Boolean;
begin
  Result := false;
end;

procedure TGpioLinuxPin.SetDirection(AValue: TGpioDirection);
begin
end;

procedure TGpioLinuxPin.SetInterruptMode(AValue: TGpioInterruptMode);
begin
end;

procedure TGpioLinuxPin.SetValue(AValue: Boolean);
begin
end;

constructor TGpioLinuxPin.Create(aID: Longword);
begin
  fPinID := aID;
end;

destructor TGpioLinuxPin.Destroy;
begin
  inherited Destroy;
end;

function TGpioLinuxPin.WaitForInterrupt(timeout: LongInt; out NewValue: Boolean
  ): Boolean;
begin
  Result := false;
end;

{ TSPILinuxDevice }

function TSPILinuxDevice.GetBitsPerWord: Byte;
begin
  Result := 0;
end;

function TSPILinuxDevice.GetLSBFirst: Boolean;
begin
  Result := false;
end;

function TSPILinuxDevice.GetMaxFrequency: Longword;
begin
  Result := 0;
end;

function TSPILinuxDevice.GetMode: TSPIMode;
begin
//  Result := TSPIMode.;
end;

procedure TSPILinuxDevice.SetBitsPerWord(AValue: Byte);
begin
end;

procedure TSPILinuxDevice.SetLSBFirst(AValue: Boolean);
begin
end;

procedure TSPILinuxDevice.SetMaxFrequency(AValue: Longword);
begin
end;

procedure TSPILinuxDevice.SetMode(AValue: TSPIMode);
begin
end;

function TSPILinuxDevice.GetDevicePath: String;
begin
  Result := '';
end;

constructor TSPILinuxDevice.Create(aBus: Longword; aChipSelect: Longword);
begin
  fBus := aBus;
  fCS := aChipSelect;
end;

destructor TSPILinuxDevice.Destroy;
begin
  inherited Destroy;
end;

function TSPILinuxDevice.Read(var Buffer; Count: Longint): Longint;
begin
  Result := 0;
end;

function TSPILinuxDevice.Write(const Buffer; Count: Longint): Longint;
begin
  Result := 0;
end;

procedure TSPILinuxDevice.ReadAndWrite(const aWriteBuffer;
  aWriteCount: Longint; var aReadBuffer; aReadCount: Longint);
begin
end;


{$ENDIF}

end.

