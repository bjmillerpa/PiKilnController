# PiKilnController

Raspberry Pi 4 ceramics kiln controller with WebSocket relay and web UI.

## Project Overview

Manages three independent heating zones (rings), each with its own thermocouple, heating element relay, and PID controller. Supports programmable multi-segment firing schedules with ramp rates, target temperatures, hold times, hold-to-cone with cap, Arrhenius cone tracking, and fan-balance. Includes a simulation mode for development/testing off-hardware.

History: originally a Lazarus/FPC desktop app (deleted in the open-source cleanup — see git history if you want the Pascal source). The Node.js port in `pikiln/` is what runs in production. Each Node.js module under `pikiln/lib/` cites its Pascal counterpart in a "Ported From" comment.

## Architecture

Three processes — one on the Pi, one on a VPS, one in the browser:

- **Pi controller** (`pikiln/pikiln.js`): HTTP + WebSocket server. Owns GPIO, runs the 1 Hz heartbeat, drives PID, watches safety conditions. Serves the same web bundle to LAN clients directly.
- **VPS relay** (`relay/relay-server.js`): bridges remote browsers to the controller via an outbound WSS the Pi opens to `/controller`. Browsers reach the relay over HTTPS behind a reverse proxy (the supplied compose file uses Traefik); relay uses cookie auth backed by an htpasswd file.
- **VPS sim** (`kiln-sim` container in `relay/docker-compose.yml`): same `pikiln.js` in simulation mode. Identifies as `role=sim`; yields whenever a real Pi is connected. Lets the laptop UI exercise the system when the kiln is powered off.

For the long-form architecture story see [`pikiln/web/docs/help/architecture.md`](pikiln/web/docs/help/architecture.md) — the same doc that's served as a Help tab inside the running UI.

## Running

```bash
cd pikiln
npm install                    # installs ws; pigpio only on Pi
PIKILN_SIMULATE=1 npm start    # simulation mode (Mac/dev)
npm start                      # real hardware (Pi, requires root)
npm test                       # node:test suite
```

For Pi deployment see [`pi/README.md`](pi/README.md) (install.sh + systemd unit).
For the VPS relay see [`relay/README.md`](relay/README.md).

## Module Map (`pikiln/lib/`)

| Module | Purpose |
|---|---|
| `constants.js` | Pin assignments, timing, conversions |
| `gpio-provider.js` | Real pigpio or mock GPIO factory |
| `temp-sensor.js` | MAX31855 SPI read + NIST correction |
| `pid.js` | PID with sister balancing + cap-aware anti-windup |
| `relay.js` | Relay + Element with auto-shutoff |
| `schedule.js` | Multi-segment schedule engine + hold-to-cone |
| `orton-cones.js` | Arrhenius cone index + Orton table |
| `kiln.js` | Central controller + heartbeat loop |
| `simulation.js` | Thermal model for off-Pi dev |
| `safety.js` | Watchdog, over-temp, element timeout |
| `logger.js` | Per-firing + system log (human-readable, retention-bounded) |
| `perf-log.js` | Structured telemetry stream (JSONL, monthly, kept forever) |
| `thermal-model.js` | Calibrated heat-loss curve + load-adjusted m·c |

## Hardware Configuration

See [`pikiln/lib/constants.js`](pikiln/lib/constants.js) for the canonical pin map. Defaults:

- **3 heating elements**: BCM GPIO 21 (Bottom), 20 (Mid), 26 (Top), 240V/16A each (3.84 kW per element)
- **3 K-type thermocouples**: MAX31855 via software SPI, clock GPIO 11, MISO GPIO 9, CS pins 17 / 18 / 27
- **Vent fan**: GPIO 16
- **PID defaults**: P=5, I=3, D=3 (configurable per-ring via `config.pid`)

Hardware fail-safe is in the wiring: Pi GPIO → low-power NO relay → high-power NO contactor → element. Loss of drive at any stage opens the circuit.

## WebSocket Protocol

```
State:    { "type": "state", "data": { mode, temps[], elements[], schedule, … } }
Command:  { "type": "command", "action": "start|stop|loadSchedule|…", "params": {} }
Response: { "type": "response", "action": "…", "data": … }
```

The relay forwards verbatim; full message table in [`pikiln/web/docs/help/architecture.md`](pikiln/web/docs/help/architecture.md).

## Schedule JSON Format

```json
{
  "title": "Cone 6 Glaze",
  "cone": "6",
  "units-temp": "°F",
  "units-rate": "°F/hr",
  "units-hold": "min",
  "segments": [
    { "rate": 200, "temp": 250,  "hold": 0,  "fanon": false, "note": "candle" },
    { "rate": 300, "temp": 2232, "hold": 30, "fanon": false, "note": "peak", "holdToCone": "6" }
  ]
}
```

All internal calculations in Celsius. F↔C conversion at load/save and display boundaries. `holdToCone` is optional: when set, the segment soaks until accumulated Arrhenius heat work hits that cone OR `hold` minutes elapse (whichever first); `hold` is the safety cap.

## Data Storage

- `relay/master-schedules/` — canonical schedule set on the VPS, bind-mounted into the relay. Pushed to each controller on connect via `schedules-sync`. Edits from any controller mirror back.
- `pikiln/seed-schedules/` — schedules shipped with the release. Seed the master once at deployment.
- `pikiln/data/schedules/` — working copy on each controller, wiped + rewritten from master on connect.
- `pikiln/data/logs/` — daily human-readable system log (`YYYYMMDD.log`), retention `config.logs.retentionDays` (default 60).
- `pikiln/data/firings/` — one log per firing, header + notes + event stream. Kept indefinitely.
- `pikiln/data/perf/` — append-only telemetry, JSONL, one file per month (`perf-YYYY-MM.jsonl`). Never rotated.
- `pikiln/data/config.json` — user overrides; `pikiln/config.default.json` — shipped defaults.

## Conventions

- Internal temperatures: Celsius. Fahrenheit only at display/storage boundaries.
- `f2c` / `c2f` / `fph2cph` / `cph2fph` in `constants.js` handle the conversions.
- Each `pikiln/lib/*.js` module cites its Pascal predecessor in a top-of-file comment for cross-reference against the original implementation in git history.
- Tests: `node --test` (built-in). One file per module under `pikiln/test/`.

## Operator UI

Six tabs: **Run** (dashboard + firing curve), **Settings** (notifications, fan-balance thresholds, kiln load, share-monitor link), **Log** (firing notes + live log), **Schedules** (editor), **Tests** (manual relay/sensor tests + diagnostic mode), **Help** (the docs under `pikiln/web/docs/help/`).

Read-only share link at `/monitor/<key>` — same UI minus the control surfaces. Key rotates on operator request from the Settings tab.

## Calibration

The thermal model's loss curve is calibrated against an empty-kiln calibration firing using [`pikiln/scripts/analyze-thermal.js`](pikiln/scripts/analyze-thermal.js). See [`pikiln/web/docs/help/thermal-analysis.md`](pikiln/web/docs/help/thermal-analysis.md) for how to re-calibrate when anything about the kiln changes.
