# PiKilnController

Raspberry Pi 4 kiln controller with GUI and WebSocket data relay server.

## Project Overview

A ceramics kiln controller that manages 3 independent heating zones (rings), each with its own thermocouple sensor, heating element relay, and PID controller. Supports programmable multi-segment firing schedules with ramp rates, target temperatures, hold times, and Orton cone tracking. Includes a kiln simulation mode for development/testing off-hardware.

The project is being migrated to a Node.js service (`pikiln/`) that replaces the Pascal app and serves a web UI.

## Architecture

### Desktop App (Pascal / Lazarus)
- **IDE/Compiler**: Lazarus IDE with Free Pascal Compiler (FPC), Delphi syntax mode
- **Target**: Raspberry Pi 4 (ARM Linux), also compiles on macOS/Windows with faux GPIO stubs
- **GUI Framework**: LCL (Lazarus Component Library) with TAChart for firing curve visualization
- **Hardware IO**: PascalIO library (`../../others/pascalio/`) for GPIO and SPI access

### Key Units
| Unit | Purpose |
|---|---|
| `umain.pas` | Main form — UI, event wiring, schedule editor, chart, logging |
| `ukiln.pas` | `TKiln` — central controller: heartbeat loop, PID dispatch, element firing, energy tracking, thermal simulation |
| `uschedule.pas` | `TSchedule` — multi-segment firing schedules (JSON), target temp calculation, cone progress, history |
| `utempsensor.pas` | `TTempSensor` — MAX31855 thermocouple reader via SPI, cold-junction compensation, NIST polynomial correction |
| `urelays.pas` | `TRelay` / `TElement` — GPIO relay control with on-time tracking; `TElement` adds timed firing via TTimer |
| `upid.pas` | `TPid` — PID controller with sister-element balancing (prevents one ring from hogging when another is maxed) |
| `uortoncones.pas` | Orton cone index calculation from temperature and firing rate, interpolated across 3 rate tables |
| `uconstants.pas` | Hardware pin assignments, PID defaults, timing, cost, temp conversion functions (`F2C`, `C2F`, `FpH2CpH`, `CpH2FpH`) |
| `utypes.pas` | `TTemperature = Double` type alias |
| `umonitoredbject.pas` | `TMonitoredObject` — base class providing `LogThis` / `MsgThis` class-level event hooks |
| `utiming.pas` | Virtual time wrappers (currently passthrough to `Now` / `MillisecondsBetween`) |
| `ufauxgpiolinux.pas` | Faux `TGpioLinuxPin` and `TSPILinuxDevice` stubs for non-Linux development |
| `utests.pas` | mV-to-Celsius lookup table for validating thermocouple correction polynomials |

### Control Loop
The kiln runs a heartbeat timer at `kCycleLengthSeconds / kHeartBeatsPerCycle` (1 second intervals, 15 beats per 15-second cycle). On specific beats (1, 6, 11) it updates one of the 3 rings:
1. Read thermocouple temperature
2. Get target temp from schedule (handles ramp interpolation, holds, segment transitions)
3. PID computes duty cycle (0..1)
4. Element fires for `duty * kCycleLengthSeconds` seconds, then auto-shuts off via TTimer

### Thermal Simulation
When not on Linux, temp sensors run in simulation mode. The heartbeat calculates watt-seconds from element on-time, subtracts modeled heat loss (polynomial regression from L&L Kilns HVAC data), and updates simulated temperatures using estimated kiln heat capacity (140 kg * 545 J/kg*K).

### Data Storage
- Schedules: JSON files in `~/Documents/PiKilnController/schedules/`
- Logs: Daily log files in `~/Documents/PiKilnController/logs/`
- Config: `~/Documents/PiKilnController/config.json`
- PID tuning: `~/Documents/PiKilnController/config.ini`

### Schedule JSON Format
```json
{
  "title": "Cone 6 Glaze",
  "cone": "6",
  "units-temp": "F",
  "units-rate": "F/hr",
  "units-hold": "min",
  "segments": [
    { "rate": 200, "temp": 250, "hold": 0, "fanon": false, "note": "initial" },
    { "rate": 300, "temp": 2232, "hold": 15, "fanon": false, "note": "to cone 6" }
  ]
}
```
All internal calculations use Celsius. F/C conversion happens at schedule load/save and display boundaries.

## Server (Node.js WebSocket Relay)

Located in `server/`. A lightweight JSON data relay that enables remote monitoring of the kiln.

### Running
```bash
cd server
npm install   # only dependency: ws
npm start     # default port 8080, override with PORT env var
```

### How It Works
- **Host** (the kiln controller) connects via WebSocket, registers as `role: "host"`, and publishes JSON data to named channels
- **Viewers** (browsers, other clients) connect as `role: "viewer"` and receive real-time updates
- Only one host allowed at a time; unlimited viewers
- HTTP polling fallback: `GET /poll/<channel>` returns cached data
- `GET /status` returns connection info

### WebSocket Protocol
```
Register:  { "type": "register", "role": "host" | "viewer" }
Publish:   { "type": "publish", "channel": "kiln", "data": {...} }  (host only)
Update:    { "type": "update", "channel": "...", "data": {...} }     (sent to viewers)
```

### Web Clients
- `index.html` — Landing page with links to host and viewer
- `host.html` — Connect as host, edit/load JSON, publish to channel
- `viewer.html` — Connect as viewer, syntax-highlighted JSON display, auto HTTP polling fallback
- `dummy-data.json` — Example kiln telemetry payload for testing

### Planned: Bidirectional Commands
Viewers should be able to send commands back to the host to control the kiln (start/stop, change schedule, fan control, etc.). This is not yet implemented in the relay protocol.

## Hardware Configuration (from uconstants.pas)

- **3 heating elements**: GPIO pins 29, 28, 25 (240V/16A each = 3.84kW per element)
- **3 K-type thermocouples**: MAX31855 via software SPI (clock GPIO 22, data GPIO 17, CS pins 0/1/2)
- **Vent fan**: GPIO pin 27
- **PID defaults**: P=5, I=3, D=3 (configurable per-ring via config.ini)

## Build

Open `PiKilnController.lpi` in Lazarus IDE. Cross-compile targeting ARM Linux for Raspberry Pi deployment. The macOS/Windows build uses faux GPIO stubs and simulation mode automatically via `{$IFNDEF LINUX}` conditionals.

## Conventions

- All internal temperatures are in Celsius; Fahrenheit only at display/storage boundaries
- Unit naming: `u<name>.pas` prefix convention
- Pascal `{$mode objfpc}` with `{$H+}` (AnsiStrings). Some units use `{$mode delphi}`
- Class constructors/destructors used for shared resources (GPIO pins, schedule list)
- Events follow Delphi convention: `procedure (ASender: TObject; ...) of object`

## Node.js Migration (`pikiln/`)

The replacement kiln controller running as a Node.js service on the Pi.

### Running
```bash
cd pikiln
npm install                    # installs ws; pigpio only on Pi
PIKILN_SIMULATE=1 npm start    # simulation mode (Mac/dev)
npm start                      # real hardware (Pi, requires root)
```

### Architecture
- **Pi service** (`pikiln.js`): HTTP + WebSocket server, serves web UI, runs control loop
- **VPS relay** (`relay/relay-server.js`): bridges remote clients to Pi (planned Phase 3)
- **Web UI** (`web/`): single-page dashboard, all clients are equal (no host/viewer roles)
- **GPIO**: pigpio for real hardware, auto-fallback to mock stubs in simulation

### Module Map (lib/)
| Module | Ported From | Purpose |
|---|---|---|
| `constants.js` | `uconstants.pas` | Pin assignments, timing, conversions |
| `gpio-provider.js` | `ufauxgpiolinux.pas` | Real pigpio or mock GPIO factory |
| `temp-sensor.js` | `utempsensor.pas` | MAX31855 SPI read + NIST correction |
| `pid.js` | `upid.pas` | PID with sister balancing |
| `relay.js` | `urelays.pas` | Relay + Element with auto-shutoff |
| `schedule.js` | `uschedule.pas` | Multi-segment schedule engine |
| `orton-cones.js` | `uortoncones.pas` | Cone index calculation |
| `kiln.js` | `ukiln.pas` | Central controller + heartbeat loop |
| `simulation.js` | `ukiln.pas` | Thermal model for off-Pi dev |
| `safety.js` | NEW | Watchdog, over-temp, element timeout |
| `logger.js` | `umonitoredbject.pas` | File + event logging |

### WebSocket Protocol
```
State:    { "type": "state", "data": { mode, temps[], elements[], schedule, ... } }
Command:  { "type": "command", "action": "start|stop|loadSchedule|...", "params": {} }
Response: { "type": "response", "action": "...", "data": ... }
```

### API Endpoints
- `GET /api/status` — current kiln status JSON
- `GET /api/schedules` — list schedule titles
- `GET /api/schedule/:title` — get schedule JSON

### Data Storage
- `pikiln/data/schedules/` — JSON schedule files (same format as Pascal)
- `pikiln/data/logs/` — daily log files
- `pikiln/data/config.json` — user overrides
- `pikiln/config.default.json` — shipped defaults

### Implementation Status
- Phase 1 (Core control loop): COMPLETE — all lib/ modules ported, simulation verified
- Phase 2 (Web UI): Minimal dashboard exists, full Preact UI planned
- Phase 3 (VPS relay): Not started
- Phase 4 (Hardware integration): Not started
- Phase 5 (Hardening): Not started
