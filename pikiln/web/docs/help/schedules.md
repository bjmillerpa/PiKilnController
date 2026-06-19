# Schedules

How firing schedules are structured, how to edit them in the UI, and how
they sync between the Pi and the VPS master store.

## What a schedule is

A schedule is an ordered list of **segments**. Each segment has a
**rate** (°F/hr), an **end temperature** (°F), an optional **hold** at
that temperature (minutes), and an optional **fan** flag (vent on during
this segment).

The controller traverses segments top-to-bottom:

1. Ramp from the previous segment's end temp (or the kiln's current temp,
   for segment 0) toward the new end temp at the configured rate
2. Once the end temp is reached, hold for the configured duration
3. Advance to the next segment

When the last segment's hold finishes the schedule is complete and the
controller transitions to **cool-down monitoring** (no element activity;
just watches temps drop to the safe-open threshold).

## JSON format

Schedules are JSON files on disk. Example — a fast cone-6 glaze:

```json
{
  "title": "L&L Fast Glaze Cone 6",
  "cone": "6",
  "units-temp": "°F",
  "units-rate": "°F/hr",
  "units-hold": "min",
  "units-fanon": "true/false",
  "segments": [
    { "rate": 250, "temp": 250,  "hold": 30, "fanon": true,  "note": "candle / preheat" },
    { "rate": 400, "temp": 1850, "hold": 0,  "fanon": false },
    { "rate": 250, "temp": 2232, "hold": 15, "fanon": false, "note": "to cone 6", "holdToCone": "6" }
  ]
}
```

### Metadata

| Key | Meaning |
|---|---|
| `title` | Display name. Must be unique within the master store. |
| `cone` | The schedule's overall cone target. Used as a sanity reference and can shorten the final ramp when heat work is met early. Set to `-` if the schedule isn't aimed at a specific cone. |
| `units-temp` / `units-rate` / `units-hold` / `units-fanon` | Persisted units for human readability. The controller stores everything internally in Celsius and converts at load/save. |

### Segments

| Field | Required | Notes |
|---|---|---|
| `rate` | yes | Climb rate in `units-rate` (typically °F/hr). Use `0` for "full speed" — the controller fires unchecked up to its model max. A *descending* rate (target temp lower than the previous segment's) is fine; the controller cools to it under PID control. |
| `temp` | yes | End temperature of the segment in `units-temp`. |
| `hold` | optional, default 0 | Hold duration in minutes once `temp` is reached. Doubles as the maximum-time cap when `holdToCone` is set. |
| `holdToCone` | optional | Cone string (e.g. `"6"`, `"04"`). When present, hold ends as soon as accumulated Arrhenius heat work reaches that cone — or `hold` minutes elapse — whichever first. |
| `fanon` | optional, default false | When fan mode is `auto`, turns the vent on during this segment. |
| `note` | optional | Operator-facing comment, shown in the log when the segment starts. |

Internal storage is always Celsius. The UI reads `units-temp`/`units-rate`
from the file and converts at the boundary, so you can write schedules in
either unit system and the controller treats them the same.

## Hold-to-cone segments

A `holdToCone` segment is the right choice when:

- You care about *cone maturity*, not clock time — particularly at peak
- Your kiln's actual heat-up rate varies firing-to-firing and a fixed hold
  time would either undershoot the cone (too short) or over-soak the ware
  (too long)

Both conditions are evaluated independently and whichever fires first
ends the hold. The kiln logs which one ended it:

```
hold ended: reached cone 6 after 18.4 min
```

or

```
hold ended: max 30 min reached (target was cone 6; current cone 5.8)
```

The schedule's overall `cone` metadata is a *separate* mechanism (it can
shorten the *ramp* to the peak segment if heat work has already gotten
you there). `holdToCone` is segment-specific and governs the *hold*.

## Editing in the UI

The Schedules tab. Left column: list of schedules. Right column: editor
for the picked schedule.

To create a new schedule, click **+ New**. To rename, edit the Title
field. The Cone field is the overall metadata cone (leave blank or `-`
for non-cone-targeting schedules — annealing, calibration, etc.).

Each segment is one row in the table. The columns map directly to the
JSON fields. Add a row with **+ Segment**; delete with the `X` button on
the right.

When you type a value in **Cone target** for a segment whose Hold is
still 0, the editor seeds Hold to 30 minutes (the default cap). You can
adjust afterward. This avoids the trap of setting a cone target with no
cap and watching it run forever.

**Save** writes the schedule to the VPS master and pushes it to every
connected controller. Editing the schedule that's currently *running*
is allowed but only affects the next run.

Below the editor a preview chart shows the planned trajectory. For
`holdToCone` segments the preview uses the max-hold duration (worst case);
the real run will likely finish faster.

## Storage layout

Schedules live in three places:

| Location | Role |
|---|---|
| `relay/master-schedules/` (on the VPS, bind-mounted into the relay) | Canonical source. Pushed to each controller on connect. |
| `pikiln/data/schedules/` (on the Pi or sim) | Live working copy. Wiped + repopulated from master on each connect. |
| `pikiln/seed-schedules/` (in the release tarball) | Production schedules shipped with the release. Used to seed the master once at deployment time. |

Edits made through any connected UI (any browser on the operator side)
propagate to the master via `schedule-update` / `schedule-deleted`
WebSocket messages. The master is then pushed to all other controllers
on their next connect.

Editing files directly on disk works (drop a JSON into `master-schedules/`
on the VPS and restart the relay) but isn't the path the UI uses; bear
in mind any direct edits will be overwritten if the same title is later
saved through the UI.

## Patterns

A few schedules worth knowing about, all in `pikiln/seed-schedules/`:

- **Candle 2 Hour** / **Candle Overnight** — slow preheats to drive
  moisture out of greenware before bisque
- **L&L Fast Bisque Cone 08** / **L&L Slow Bisque Cone 08** — first
  firing for unfired clay
- **L&L Fast Glaze Cone 4/5/6** — second firing after glazing
- **Bartlett Fast / Slow Glaze Cone 6** — alternative cone-6 firings
  using Bartlett's published curves
- **Glass Slumping** / **Glass Full Fuse** / **Glass Medium Speed
  Slumping** — glass-specific schedules with controlled cool-down
  through the anneal range
- **Thermal Calibration** — three holds at 300/500/700°C plus a free
  cool-down. Use to (re-)calibrate the thermal model with
  `scripts/analyze-thermal.js`. See the **Thermal-loss analysis** doc.

## Common gotchas

- **A rate of 0 means "full speed".** That's intentional for "ramp as
  fast as the kiln can manage" but it can over-fire if combined with a
  too-high target and a soft hold. Use a finite rate when you care
  about the trajectory.
- **The first segment ramps from the kiln's current temp**, not from
  ambient. Starting a schedule with a warm kiln (recently fired,
  ambient day) will reach the first target faster than the rate
  predicts. Subsequent segments use the previous segment's *target* as
  the start, regardless of where the kiln actually is.
- **A descending segment (target lower than start) waits for the temp
  to drop *through* the target, not just below it.** That's deliberate
  — a glass annealing cool-down at -100°F/hr to 950°F should drop
  through 950 under controlled rate, not jump past it on residual heat
  the moment the kiln crosses 950.
- **`holdToCone` only works during a hold**, not during a ramp. The
  schedule's overall `cone` metadata governs early ramp termination.
- **Schedule edits during a running firing apply to the next run.** The
  in-progress firing uses the snapshot taken at `kiln.start()`.
