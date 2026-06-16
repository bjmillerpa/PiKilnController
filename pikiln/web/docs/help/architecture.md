# Architecture

How the pieces fit together — the Pi at the kiln, the VPS relay, the browser
in your hand, and the data files that connect them all.

## Three processes, three roles

```
   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
   │   Pi controller  │   │    VPS relay     │   │  Browser UI      │
   │                  │   │                  │   │                  │
   │  - GPIO + SPI    │ ←─→  - WS bridge     │ ←─→  - Preact app    │
   │  - Control loop  │   │  - Firing-log    │   │  - Charts, log,  │
   │  - Heartbeat     │   │    mirror        │   │    schedules     │
   │  - PID, safety   │   │  - Pushover      │   │  - Read-only     │
   │  - Schedule eng. │   │    proxy         │   │    monitor view  │
   └──────────────────┘   └──────────────────┘   └──────────────────┘
        kiln.local                your-relay-host
        port 8080                 :443 (Traefik)
```

The **Pi controller** is the only piece that has anything safety-critical:
it owns the GPIO, runs the 1 Hz heartbeat, drives the PID, and watches the
safety conditions (over-temp, all-sensors-faulted, element-on-too-long,
heartbeat-stall). Everything else can fall over and the kiln keeps firing.

The **VPS relay** is a stateless bridge. Browsers anywhere on the internet
connect to it and reach the Pi through it. Without the relay, you can still
control the kiln from a browser on the same LAN as the Pi
(`http://kiln.local:8080`) — the relay just makes it reachable from a phone,
a friend's monitor link, etc.

The **browser** holds session state (which tab is open, the rolling log
buffer, draft notes) but no canonical data. Closing the tab loses nothing.

## Sim controller as a fallback

A separate `kiln-sim` Docker container on the VPS runs the same `pikiln.js`
code in `PIKILN_SIMULATE=1` mode. It connects to the relay's `/controller`
endpoint exactly like a real Pi would, but identifies itself as
`role: "sim"`. The relay's priority rule is:

- A connected real Pi outranks any sim. A sim trying to connect while a
  real Pi is active gets told to yield; it polls back every few seconds.
- When no real Pi is connected, the sim takes over and browsers see a
  simulated kiln they can drive through the UI.

This lets you edit schedules, exercise the firing curve chart, and tune
the UI when the kiln itself is powered off. The thermal model is fit to
L&L Easy-Fire HVAC data and is reasonably realistic.

## WebSocket protocol

There are three kinds of WebSocket connection to the relay:

1. **Controller**: the Pi (or sim) dials out to `wss://your-relay-host/controller`.
   First message must be `{type: "identify", client: "controller", token, role}`.
   Token is a long random string in `/opt/pikiln/.env` (`KILN_RELAY_TOKEN`)
   and the relay's environment (same value).

2. **Operator viewer**: the browser connects to `wss://your-relay-host/` after
   authenticating via the cookie issued by `/login` (htpasswd at the relay).
   Sends `{type: "command", action, params}`; receives `state`, `log`,
   `message`, `relay`, `response` messages.

3. **Monitor viewer**: a read-only share link `/monitor/<key>` opens a
   WebSocket at `/monitor-ws?key=<key>`. The relay validates the key
   against the Pi's current `monitorKey` (rotated only when the controller
   restarts) and accepts the connection without a login. Inbound messages
   from monitor connections are dropped — no commands flow.

The Pi's HTTP+WS server on port 8080 serves the same web bundle to LAN
clients without going through the relay at all. Useful when the internet
is out or you want to bypass the share-link latency.

## Message types

| Type | Direction | Purpose |
|---|---|---|
| `state` | Pi → relay → viewers | Full kiln state snapshot, every 5 s |
| `log` | Pi → relay → viewers | Human-readable log lines (also persisted) |
| `message` | Pi → relay → viewers | Operator messages (shown with `>>` prefix) |
| `relay` | relay → viewers | Lifecycle: `controller-connected`/`disconnected` |
| `firing-log-start` | Pi → relay | Open a new mirrored firing log file |
| `firing-log-append` | Pi → relay | Append a line to the mirror |
| `firing-log-complete` | Pi → relay | Final summary block (atomic replace) |
| `command` | viewer → relay → Pi | `start`, `stop`, `hold`, `setFanMode`, etc. |
| `response` | Pi → relay → viewer | Per-command ack/error |
| `pushover` | Pi → relay → api.pushover.net | Phone notifications via Pushover proxy |
| `schedules-sync` | relay → Pi (on connect) | Push canonical schedule set to controller |
| `schedule-update` / `schedule-deleted` | Pi → relay | Mirror schedule edits to master |

The relay caches the last `state` message and a 200-frame ring buffer of
`log`/`message` frames so newly-connecting viewers see recent context
immediately instead of a blank UI until the next 5-second heartbeat.

## Data storage

### On the Pi (`/opt/pikiln/data/`)

| Path | Contents | Retention |
|---|---|---|
| `schedules/` | Live working copy of all known schedules. Wiped + repopulated from the relay's master on each connect. | Synced |
| `logs/YYYYMMDD.log` | Daily system log. Every `logger.log()` line. | Configurable (default 60 days) |
| `firings/<id>.log` | One file per firing — summary header + notes + event log. | Kept forever |
| `perf/perf-YYYY-MM.jsonl` | Structured monthly JSONL telemetry: ring updates, segment transitions, faults, e-stops. | Kept forever |
| `config.json` | User overrides for PID, safety, balance, fan, notifications, firingNotes. | Until edited |
| `firing-state.json` | Atomically written every 5 s during a firing. Used for outage recovery on next boot. | Until cool-down complete / start |
| `.firing.lock` | PID of the live controller during a firing. Read by `pikiln-update.sh` to refuse updates mid-firing (stale locks detected by PID). | Until cool-down complete |

### On the VPS (`~/kilncontroller/`)

| Path | Contents | Source of truth? |
|---|---|---|
| `master-schedules/*.json` | Canonical schedule set, pushed to each controller on connect. Edits from any controller propagate back here. | Yes — bind-mounted into the relay at `/srv/schedules` |
| `firings/<id>.log` | Mirror of each firing's log from the Pi. Survives Pi SD-card failure. | No (the Pi's local copy is authoritative until clean shutdown) |

### In the release tarball (`pikiln/`)

| Path | Contents |
|---|---|
| `lib/` | The control modules — `kiln.js`, `pid.js`, `temp-sensor.js`, `safety.js`, etc. |
| `web/` | The browser bundle — `index.html`, `app.js`, components, vendored Preact/uPlot |
| `web/docs/help/` | These help docs |
| `bin/` | Self-bootstrap scripts — `pikiln-update.sh`, `pikiln-launch.sh`. Copied to `/opt/pikiln/bin/` on each start so fixes flow through updates without console access. |
| `seed-schedules/` | Production schedules shipped with the release. Used to seed the master once at deployment time. |
| `config.default.json` | Defaults merged under `data/config.json`. |

## Update flow

The relay serves the latest pikiln tarball at `/update/pikiln.tar.gz` (Bearer
token auth) with a manifest at `/update/manifest` exposing the sha256. The
Pi's systemd unit runs `pikiln-update.sh` as `ExecStartPre`:

1. Fetch manifest. If the sha256 matches what's already installed, nothing
   to do.
2. Check `.firing.lock` — if a live pikiln process owns it, refuse the
   update. (Stale locks from previous crashes are detected by PID liveness
   and cleaned automatically.)
3. Download the tarball, verify sha256, extract into a new
   `/opt/pikiln/releases/<timestamp>-<sha>/` directory.
4. Run `npm install --omit=dev` in the new release.
5. Atomically flip the `/opt/pikiln/current` symlink to the new release.
6. Save the manifest's sha to `installed.sha256`.

`pikiln-launch.sh` then `exec`s `node /opt/pikiln/current/pikiln.js`. A
start-failure counter persists across boots: if a new release fails to
survive 60 s startup grace twice in a row, the next `pikiln-update` rolls
back to the previous "last-good" release.

On its first heartbeat each pikiln start, the controller also copies any
updated bootstrap scripts from `current/bin/*.sh` to `/opt/pikiln/bin/`. So
fixes to `pikiln-update.sh` or `pikiln-launch.sh` flow through the regular
manifest update path — no SSH or console access needed.

## Safety architecture

Defense in depth, with hardware as the bottom layer:

### Hardware (the floor)

```
   Pi GPIO  →  low-power relay  →  high-power relay (contactor)  →  element
   (3.3 V)     (12 V coil)         (240 V, ~30 A)
```

Loss of drive at **any** stage opens the circuit. If the Pi crashes, GPIO
floats low, low-power relay drops out, contactor opens, elements off. The
contactor itself is a normally-open mechanical device with no electronics
between it and the heating elements — if it physically fails, it fails
open (no current).

### Software watchdogs ([safety.js](../../lib/safety.js))

1. **Over-temperature**: any sensor above `MAX_TEMP_C` (default 1300°C) →
   immediate e-stop.
2. **Element on too long**: any element continuously on for more than
   `ELEMENT_MAX_ON_SECONDS` (default 30 s) without a control-loop
   intervention → e-stop. Normal max per-element on-time is one full cycle
   (15 s), so 30 s is genuinely anomalous.
3. **Heartbeat stall**: the control loop hasn't run for more than
   `heartbeatTimeoutMs` (default 15 s) — event loop blocked somehow → e-stop.
4. **All sensors failed (persistent)**: if all three thermocouples report
   `hasError` for a sustained `allSensorsFaultedTimeoutSec` (default 30 s)
   → e-stop. Briefer simultaneous faults (EMI from element switching) are
   tolerated; only persistent failure trips this.

### Per-firing recovery

Every 5 s during a firing, the Pi writes `firing-state.json` with mode,
segment, peak temp, and timestamp. On boot, if the kiln is still warm
(>200°F) and the saved state shows a running firing, recovery
auto-resumes — including jumping into the schedule segment that matches
the current temperature, so PID doesn't waste cycles re-ramping from the
bottom. Cool kilns with brief saved firings (<5 min) are treated as test
residue and discarded; longer firings show a recovery banner in the UI for
operator decision.

## Why this design

A few things drove the split:

- **The Pi must be safe to run unattended.** Putting the UI on the Pi
  means a browser bug or a UI runaway can't affect the control loop. The
  Pi just owns GPIO; the UI is in a separate process (the relay) on
  separate hardware (the VPS).

- **Internet access shouldn't be required.** The Pi serves the same web
  bundle locally at `http://kiln.local:8080`. If the relay is down, you
  can still drive a firing from the LAN.

- **Catastrophic Pi failure shouldn't lose the firing record.** Per-firing
  logs are mirrored to the VPS in real time. Even if the SD card dies,
  the firing record up to the moment of failure is on the VPS.

- **Sharing should be safe.** The monitor share link is read-only and
  validated server-side; you can give it to anyone without worrying about
  them accidentally stopping a firing.

- **Updates shouldn't require visiting the kiln.** The Pi pulls updates
  from the relay automatically on each restart. Bootstrap scripts
  self-update from the tarball, so even fixes to the update mechanism
  itself can ship through the same channel.
