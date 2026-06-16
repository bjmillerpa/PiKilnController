# Pi-side install: PiKiln controller

One-time setup on the Raspberry Pi at the kiln. Lays the controller out under
`/opt/pikiln`, installs a systemd unit, and points it at the VPS relay so the
Pi pulls the latest server + UI from the relay host before each start.

## Prerequisites

- Raspberry Pi running a recent Linux (Raspberry Pi OS 12+ or similar)
- Node.js 18 or newer (`apt install nodejs npm` may give too old; prefer NodeSource)
- The kiln relay running on the VPS, with its `KILN_RELAY_TOKEN`
- The `pigpio` C library — needed by the npm `pigpio` package (which is just
  a wrapper over `libpigpio.so`). Packaging varies by Pi OS release:
  - **Bookworm and older:** `sudo apt install pigpio`
  - **Trixie:** the `pigpio` meta-package was dropped; install
    `sudo apt install libpigpio1 libpigpio-dev pigpiod`, or build upstream
    pigpio from source (`git clone https://github.com/joan2937/pigpio && cd
    pigpio && make && sudo make install && sudo ldconfig`).
  - `install.sh` tries all three paths automatically. Without `libpigpio.so`
    the controller falls back to simulation mode and won't drive GPIO.

## Install

Copy this whole `pi/` directory onto the Pi (e.g. via `scp -r` or the
git repo) and run:

```bash
sudo ./install.sh <KILN_RELAY_TOKEN> --relay-url https://your-relay-host
```

What that does, in order:

1. Creates `/opt/pikiln/{bin,releases,data/{schedules,logs,perf}}`
2. Installs the launch + update scripts under `/opt/pikiln/bin/`
3. Writes `/opt/pikiln/.env` (chmod 600) with the relay token + URL
4. Runs the first update — fetches the latest pikiln tree from the relay,
   verifies its sha256, extracts to `releases/<id>/`, runs `npm install`,
   and points `current` at it
5. Installs the systemd unit and enables it on boot

Then:

```bash
sudo systemctl start pikiln
journalctl -u pikiln -f          # follow the logs
```

## Filesystem layout after install

```
/opt/pikiln/
├── bin/
│   ├── pikiln-update          # ExecStartPre — fetches latest from relay
│   └── pikiln-launch          # ExecStart — runs node pikiln.js
├── releases/
│   └── 20260523T105512Z-9f991d48/   # one full pikiln/ tree per release
├── current   → releases/...   # active release (atomic symlink)
├── previous  → releases/...   # one swap back
├── last-good → releases/...   # blessed after STARTUP_GRACE seconds of uptime
├── data/                       # persistent across releases
│   ├── schedules/             # JSON schedules (user-editable via UI)
│   ├── logs/                  # YYYYMMDD.log (system log, bounded retention)
│   ├── perf/                  # perf-YYYY-MM.jsonl (telemetry, kept forever)
│   ├── config.json            # user config overrides
│   ├── .schedules-seeded      # marker (timestamp) — set after first seed
│   └── .firing.lock           # touched while a schedule is running
├── installed.sha256            # sha of currently-installed tarball
├── start-failures              # counter the launcher manages
└── .env                        # token + relay URL (chmod 600)
```

## Schedule seeding (first install only)

The relay tarball ships a `seed-schedules/` directory inside each release with
the production schedules. On install, `pikiln-update` copies any of those that
don't already exist into `data/schedules/`, then writes
`data/.schedules-seeded` so it never touches them again.

This means:
- A fresh Pi comes up with all the production schedules ready to fire.
- Your edits (via the UI's saveSchedule) are never overwritten by subsequent
  updates.
- Schedules you intentionally delete stay deleted across updates.
- To force a re-seed (e.g. after wiping the data dir): delete the
  `.schedules-seeded` marker and re-run `pikiln-update`.

## Outage recovery

Pikiln writes `data/firing-state.json` every ~5 s during a firing, recording
the schedule title, segment position, current temperature, and a timestamp.
On startup it checks for that file plus the `data/.firing.lock` marker —
together they're the "we were firing when we died" signal.

Two env vars (in `/opt/pikiln/.env`) tune the decision:

| Variable | Default | Effect |
|---|---:|---|
| `PIKILN_MIN_WARM_TEMP_F` | 200 | Below this the kiln is treated as "not firing" — manual recovery via UI banner. Above it, auto-resume. Set higher in a hot shed where ambient might be 130°F. |
| `PIKILN_MAX_OUTAGE_SECONDS` | 300 | Boundary between an info-priority Pushover ("quick recovery") and a warn-priority one ("long outage — check ware for thermal stress"). Doesn't change whether we resume. |
| `PIKILN_MAX_RING_SPREAD_F` | 15 | Maximum allowed temperature spread between rings during the bulk of a firing. The ring being updated is force-skipped (element off) for the cycle if it's more than this much above the coolest other ring. Stops the lighter-loaded ring from running away at climb rates the kiln can't sustain. |
| `PIKILN_END_SPREAD_F` | 3 | Tighter spread cap used during the end-approach window. Matching cones at the finish matters more than tracking the ramp. |
| `PIKILN_END_WITHIN_F` | 25 | How close (in °F) to the schedule's peak segment-temp triggers the tighter `PIKILN_END_SPREAD_F` cap. The peak is `max(schedule.segment.temp)`, not necessarily the last segment. |

Behaviors:

- **Brief power blip** (Pi reboots, kiln still hot): pikiln auto-resumes via
  `kiln.start()`, which fast-forwards through the schedule to the segment
  matching the current kiln temp. Pushover info.
- **Longer outage but kiln still warm**: same as above, Pushover warn.
- **Kiln cooled below the warm threshold**: pikiln stays idle. The Run tab
  shows a red banner with the schedule title, outage duration, and
  before/after temperatures, plus **Resume from current temperature** and
  **Abort** buttons. Pushover warn.
- **Was in cool-down mode**: pikiln re-enters cool-down monitoring directly
  (no schedule restart). Pushover info; another when 120°F is reached.
- **Clean stop or normal completion**: `firing-state.json` is removed, so
  the next boot has no recovery to do.

Pushovers fired before the relay's WS authenticates are queued in-process
(up to 50) and flushed when the relay accepts our identify. They survive a
relay restart but not a pikiln restart — if pikiln keeps dying you'll only
get notifications when a single instance manages to connect.

## How the update cycle works on each boot

Each `systemctl start pikiln` runs the pre-start script, then the launcher:

1. **pikiln-update** — if the previous boot recorded ≥2 start-failures, roll
   `current` back to `last-good` first. Then:
   - Refuse if `data/.firing.lock` exists (a schedule is running) → exit 0.
   - Refuse if no `KILN_RELAY_TOKEN` is set → exit 0.
   - `GET /update/manifest` from the relay (with `Authorization: Bearer`).
   - Compare `manifest.sha256` with `installed.sha256`. If same → no-op.
   - Otherwise download `/update/pikiln.tar.gz`, verify the sha256, extract
     into `releases/<timestamp>-<sha8>/`, link `data/` to the persistent dir,
     run `npm install --omit=dev`, then atomically swap `current` to the new
     release.
   - Prune releases beyond the most-recent 5 (never deletes current,
     previous, or last-good).
   - **Always exits 0** — a failed update never blocks the kiln from running
     on whatever release is already installed.

2. **pikiln-launch** — bumps `start-failures`, schedules a background "bless
   as last-good in `STARTUP_GRACE` seconds" task, exports
   `PIKILN_DATA_DIR=/opt/pikiln/data`, then `exec node pikiln.js` from
   `current/`.

3. If pikiln survives `STARTUP_GRACE` (60 s by default), the background task
   updates `last-good → current` and clears the failure counter. Otherwise
   systemd restarts; if the counter reaches 2, the next pre-start rolls back.

## Rotating the token

On the VPS, edit `~/kilncontroller/relay/.env`, restart the relay
(`docker compose restart kiln-relay`). On the Pi, edit `/opt/pikiln/.env`
to match and `sudo systemctl restart pikiln`.

## Manual operations

```bash
# Trigger an update right now (won't break a running firing)
sudo /opt/pikiln/bin/pikiln-update

# See what release is active
ls -la /opt/pikiln/current

# Roll back one release manually
sudo ln -sfn "$(readlink /opt/pikiln/previous)" /opt/pikiln/current.new
sudo mv -Tf /opt/pikiln/current.new /opt/pikiln/current
sudo systemctl restart pikiln

# Wipe the install (preserving data — schedules + logs + perf):
sudo systemctl stop pikiln
sudo rm -rf /opt/pikiln/{releases,current,previous,last-good,installed.sha256,start-failures}
sudo /opt/pikiln/bin/pikiln-update    # reinstall fresh
```
