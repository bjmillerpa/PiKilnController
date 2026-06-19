# Operator UI guide

What every tab is for, what the dashboard tiles mean, and the small bits of
behavior that aren't obvious from looking.

The UI is six tabs across the top: **Run · Settings · Log · Schedules ·
Tests · Help**. The relay also serves a read-only **Monitor** view at a
shareable URL; that's covered at the end. Tab choice persists in the URL
hash so reloading the page keeps you where you were.

## Header status

The top-right of the header shows two chips:

- **Role:** `LIVE` (real Pi) or `SIM` (simulator on the VPS). The sim takes
  over whenever the Pi is offline so the UI never sits empty.
- **Connection:** one of
  - `Connected` — WebSocket open, controller responding
  - `Reconnecting…` — controller dropped, transient (sim usually takes over
    within ~3 s)
  - `Kiln offline` — no controller for >10 s; commands won't go anywhere
  - `Disconnected` — browser's WS to the relay is closed

## Run tab

The primary surface during a firing. Top to bottom:

### Dashboard tiles

A row of tiles showing live state. Three of them are the ring temperatures
(rendered **Top → Mid → Bottom** matching the physical kiln stack), each
with a colored accent strip that ties back to the firing curve below.
Other tiles:

- **Segment** — current schedule segment number and target temp; appends
  "hold" while in the hold portion of a segment
- **Cone** — current accumulated Orton cone from Arrhenius heat-work
  integration. Reads `-` when far below the table, `<018` when above
  ambient but below the lowest cone, then real cone strings (`018`,
  `06`, `6`, …) once meaningful heat work has accumulated
- **Time left** — physical-model estimate, capped at the kiln's modeled
  max rate at each temperature. Drops as the firing progresses; "slipping
  behind" segments are reflected honestly
- **Power** — total kWh delivered this firing, with cost at the configured
  `$/kWh`
- **Fan** — current fan state and mode

### Firing curve

A live chart of actual ring temps over the planned schedule. Three colored
lines (one per ring) with a dashed line for the planned trajectory. The
y-axis auto-scales to fit the active firing range.

### Schedule picker

Visible only when the kiln is idle. Lists every schedule synced from the
master and lets you pick one to load. The currently-loaded schedule's
preview chart shows below as you mouse over options.

### Controls

- **Start** — begins the loaded schedule (greyed out while running)
- **Hold** — locks the target at the current temp until you press Resume.
  Schedule clock is frozen. Useful for "I want to look at the cones with
  my flashlight" moments
- **Pause** — drops the PID target to 0 (elements off; kiln coasts down).
  Schedule clock also pauses. Resume restarts from where you left off
- **Stop** — ends the firing immediately, transitions to cool-down
  monitoring
- **Fan:** `off · auto · on · balance` — `auto` follows the schedule's
  per-segment `fanon` flag; `balance` enables dynamic temperature
  balancing using the downdraft (see Settings tab)

## Settings tab

Things that don't change run-to-run. Hidden in the read-only monitor view.

### Notifications

Pushover progress notifications fire once when the kiln crosses each
200°F threshold on the way up (200, 400, 600, …). One-shot per threshold
per firing. Errors and safety events always notify regardless of this
toggle.

### Kiln load

Operator estimate of ware + furniture mass in kg (0–100). Adds to the
bare-brick heat capacity at 900 J/(kg·K), which is what drives:

- Time-to-cool predictions
- The duty cap that limits over-firing on slow ramps
- The sim's thermal evolution

Below the slider, the **Apparent m·c / load** badge shows what the kiln
*actually* is — back-calculated live from observed power input and
temperature rate against the calibrated loss curve. Use it as a sanity
check on the slider value. The badge dims and shows "paused N s ago"
during holds (the back-calculation can't work at zero dT/dt).

### Fan balance

Two sliders, ON and OFF (in °F), that control when the downdraft vent
engages in `balance` mode. The fan kicks in when the top ring is ON°F
hotter than the coolest other ring, releases when the gap drops below
OFF. Constrained so OFF < ON to prevent relay chatter at the threshold.
Tunable mid-firing.

### Share read-only monitor

Generates a `/monitor/<key>` URL safe to send to anyone. The recipient
sees Run + Log + Help only — no controls, no Settings, no Schedules
edit. The key is stable across firings; press **Refresh** to rotate it
(invalidates the old link immediately, kicks any current viewers).

## Log tab

Two sections:

### Firing notes

Free-text editor for what's being fired, how the kiln was loaded, glaze
batch info — anything worth recording with the firing. Auto-saves to the
controller with a 600 ms debounce; flushes immediately on blur (so
clicking Start captures the latest edit).

Notes are baked into the firing log header at `kiln.start()`. Later edits
during an active firing won't update its log (the file is already written);
use **Add inline note** instead — that records a one-line timestamped note
into the in-progress firing log.

### Live log

The rolling buffer of every log line emitted by the controller. State
persists in the App component so switching tabs doesn't drop entries
arriving while you're elsewhere. Bounded to ~500 lines.

Inline-note entries you add appear in this stream prefixed with `>>`.

## Schedules tab

Schedule editor. The left column lists schedules synced from the master
store on the VPS; the right is the editor for the picked schedule.

Each segment has columns:

- **Rate** °F/hr — climb rate to the target
- **Temp** °F — target temperature
- **Hold min** — hold duration at target; also the safety cap when a
  cone target is set
- **Cone target** — optional, e.g. `6` or `04`. When set, the segment soaks
  until accumulated heat work hits that cone *or* Hold min elapses
  (whichever first). Type a cone here and Hold flips from 0 → 30 by
  default
- **Fan** — turns the vent on for this segment when fan mode is `auto`

Below the editor, a preview chart shows the planned trajectory using max
hold times (so cone-target holds show as their worst case).

See the **Schedules** doc (left pane) for the JSON format and a few patterns.

## Tests tab

Hidden in the read-only monitor view. Use for hardware verification and
diagnostics:

- **Manual relay tests** — pulse each heating element or the vent fan for
  a few seconds. Use during installation to verify the wire-up (each
  click should produce one contactor click)
- **GPIO sweep / read** — debugging tools for the SPI bus and the heat
  GPIOs
- **Diagnostic mode** — disables fault debounce, sister-ring fallback,
  and tightens the all-sensors-failed e-stop window from 30 s → 5 s.
  Use only for cap/ferrite tuning when investigating thermocouple noise.
  Resets to off on every restart so the kiln doesn't run unattended with
  safeties softened
- **Sensor reading panel** — shows each thermocouple's raw vs corrected
  reading and current fault state

## Help tab

This documentation, plus the markdown files alongside it. Picks the doc
from the left pane and renders it on the right. Doc list comes from
`web/docs/help/index.json` so adding a new doc is one file plus one
index entry.

## Read-only Monitor view

The relay serves the same UI under `/monitor/<key>`. Differences:

- Header reads "PiKiln — Monitor"
- Only Run, Log, and Help tabs are visible
- Run tab hides Schedule picker and Controls — just the dashboard + curve
- Log tab is read-only (no notes editor, no Add inline note)
- WebSocket goes to `/monitor-ws?key=…` instead of the operator path;
  inbound commands from monitor connections are dropped server-side

Designed for sharing with collaborators or clients watching a firing.
No login required, but the key can be rotated from the operator's
Settings tab.

## Recovery

If the controller restarts mid-firing (Pi reboot, power blip, crash) it
writes `firing-state.json` every 5 seconds while a firing is active. On
the next start, if the kiln is still warm (>200°F) and a recent firing
state file is present, the UI shows a **recovery banner** offering to
resume. Recovery jumps into the schedule segment that matches the
kiln's current temperature — no wasted re-ramp from the bottom.
