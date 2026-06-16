# Pi Commands

Common commands for managing the kiln controller on the Raspberry Pi.
You'll need SSH or a keyboard/monitor at the Pi for these.

## Service control

```bash
sudo systemctl restart pikiln    # restart the controller (also runs pikiln-update)
sudo systemctl stop    pikiln    # stop, e.g. for maintenance
sudo systemctl start   pikiln
sudo systemctl status  pikiln    # is it running? recent restarts?
```

A restart triggers `pikiln-update.sh` as a pre-start hook, which fetches the
latest release from the VPS relay and atomically swaps it into place. If the
new release fails to survive 60 s, the previous one is auto-restored on the
next start.

## Watching the logs

```bash
sudo journalctl -u pikiln -f                  # live tail
sudo journalctl -u pikiln -n 80 --no-pager    # last 80 lines
sudo journalctl -u pikiln --since "10 min ago"
```

The Pi process writes its own logs under `/opt/pikiln/data/logs/<date>.log`
and per-firing logs under `/opt/pikiln/data/firings/<id>.log`. The journal
(`journalctl`) is the systemd view — useful when pikiln itself isn't writing
to disk (e.g. SD card failure).

## Verifying the installed version

```bash
cat /opt/pikiln/installed.sha256              # which release is current
ls -lt /opt/pikiln/releases/ | head           # release history
readlink /opt/pikiln/current                  # which release is active
readlink /opt/pikiln/last-good                # last release that survived startup
```

The relay's current build SHA is at `https://your-relay-host/update/manifest`.
If `installed.sha256` doesn't match the manifest, the next `systemctl restart`
will pull the new build.

## Manual update trigger

```bash
sudo /opt/pikiln/bin/pikiln-update            # fetch & install without restarting
sudo systemctl restart pikiln                  # then restart to run the new code
```

`pikiln-update` is a no-op if the installed SHA already matches the relay's
manifest, or if `.firing.lock` is held by a live pikiln process (mid-firing).
Stale locks from a previous reboot-during-firing are detected by PID and
cleaned automatically.

## Unsticking after a reboot during a firing

If a reboot mid-firing leaves stale lock files and the kiln won't recover or
update:

```bash
sudo rm -f /opt/pikiln/data/.firing.lock           # blocks updates
sudo rm -f /opt/pikiln/data/firing-state.json      # forces no auto-resume
sudo systemctl restart pikiln
```

Then watch the journal — you should see `[pikiln-update]` lines pulling the
latest manifest, followed by pikiln starting fresh with no auto-recovery.
The recovery banner in the UI will let you choose Resume or Abort if there
was meaningful state to recover.

## SSH access

If `ssh` connection refused:

```bash
# At the Pi console (keyboard/monitor):
sudo systemctl status ssh
sudo systemctl start  ssh
sudo systemctl enable ssh        # autostart on boot
```

If openssh isn't installed:

```bash
sudo apt install openssh-server
```

## Updating bootstrap scripts (rarely needed)

`pikiln-update.sh` and `pikiln-launch.sh` are now shipped inside the release
tarball under `bin/`. On each pikiln start they're copied from the active
release into `/opt/pikiln/bin/` automatically — so fixes to them flow through
the normal manifest update without console access.

Before that mechanism existed, the only way to update them was:

```bash
scp ~/kilncontroller/pikiln/bin/pikiln-update.sh <user>@<pi>:/tmp/
ssh <user>@<pi> sudo install -m 0755 /tmp/pikiln-update.sh /opt/pikiln/bin/pikiln-update
```

Keep that recipe in mind for one-off recovery scenarios where the running
pikiln itself is broken in a way that prevents the self-bootstrap from
running.

## Inspecting firing data

```bash
ls -lt /opt/pikiln/data/firings/              # per-firing log files
tail -20 /opt/pikiln/data/firings/<id>.log    # tail of a specific firing
grep "EMERGENCY STOP" /opt/pikiln/data/firings/*.log
grep "slow tick:"     /opt/pikiln/data/firings/*.log    # SD/event-loop stalls
grep "Ring [123] sensor faulted" /opt/pikiln/data/firings/*.log
```

The VPS relay also mirrors each firing's log under `~/kilncontroller/firings/`
on the VPS host — useful when the Pi's SD card is the problem.

## SD card health

```bash
df -h /                                       # free space
dmesg | grep -i 'mmc\|i/o error\|read-only'   # I/O errors / read-only filesystem
```

A failing SD card surfaces as `EMERGENCY STOP: Heartbeat timeout — control
loop stalled` events and Pushover alerts about disk write failures. The
kiln will keep running through transient SD issues — the alerts let you
know to replace the card after the current run cools down.

## Config overrides

User config lives at `/opt/pikiln/data/config.json` (merged on top of
`pikiln/config.default.json`). Common overrides:

```jsonc
{
  "pid": {
    "rings": [
      { "p": 5, "i": 3, "d": 3 },
      { "p": 5, "i": 3, "d": 3 },
      { "p": 5, "i": 3, "d": 3 }
    ]
  },
  "safety": {
    "maxTempC": 1300,
    "heartbeatTimeoutMs": 15000,
    "allSensorsFaultedTimeoutSec": 30
  },
  "balance": {
    "maxRingSpreadF": 15,
    "endSpreadF": 3,
    "endWithinF": 25
  },
  "fanBalance": { "onF": 8, "offF": 3 }
}
```

After editing, `sudo systemctl restart pikiln` to pick up the changes.
