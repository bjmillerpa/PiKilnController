# PiKilnController

A complete kiln-firing controller for hobby and small-studio ceramics work,
running on a Raspberry Pi with a browser-based operator UI accessible from
anywhere via an optional VPS relay.

> **Status:** running on the author's L&L Easy-Fire kiln; published in the
> hope that other ceramicists or hardware hackers find it useful. Open issues
> and PRs welcome — but read the safety section before connecting anything
> to mains power.

## What it does

- Drives three independent heating zones with per-ring PID, sister-element
  balancing, and per-segment duty caps that match the kiln's real thermal
  envelope (no overshoot at the top of slow ramps).
- Runs programmable firing schedules: multi-segment ramp / hold / cool, with
  optional **hold-to-cone** (soak until accumulated Arrhenius heat work hits
  the target cone, capped by a max-time safety).
- Tracks Orton cone progress live via Arrhenius integration of measured
  temperatures — not chart interpolation.
- Active fan balance: vents heat down from the top ring when the column
  goes asymmetric, with hysteresis sliders the operator can tune mid-firing.
- Per-firing log (header + operator notes + every ring update) mirrored to
  the VPS in real time, so SD-card failure on the Pi never costs a firing
  record.
- Recovers gracefully from outages: per-firing state written every 5 s,
  and on next boot the kiln auto-resumes into the schedule segment that
  matches its current temperature.
- Read-only share link (`/monitor/<key>`) for friends/clients to watch a
  firing without operator access.
- Push notifications via Pushover (optional): start, every 200°F threshold,
  cool-down complete, any safety event.
- Offline calibration tools: an [analyzer](pikiln/scripts/analyze-thermal.js)
  extracts your kiln's real heat-loss curve and thermal mass from a single
  firing log; coefficients then feed back into the live model.

## Repository layout

| Path | Contents |
|------|----------|
| `pikiln/` | The controller. Node.js service for the Pi + the browser bundle (Preact, vendored). |
| `pikiln/lib/` | Control modules — PID, schedule, safety, thermal model, logger, etc. |
| `pikiln/web/` | Operator UI (no build step; ESM + vendored htm/Preact). |
| `pikiln/web/docs/help/` | In-product help docs (architecture, setup, Pi commands, thermal analysis). |
| `pikiln/test/` | `node:test` suite (132 tests). |
| `pikiln/scripts/analyze-thermal.js` | Offline thermal-model calibration. |
| `pi/` | One-shot install script + systemd unit for the Pi. |
| `relay/` | VPS relay (Docker + Traefik). Serves the same UI to remote browsers. |

## Three-process architecture

```
   Pi (at the kiln)               VPS relay              Browser (anywhere)
   ─────────────────              ─────────              ──────────────────
   pikiln server  ── outbound WSS ▶ kiln-relay ◀── HTTPS  browser
                    /controller                  (cookie auth)
                    (token-authed)

   Or local LAN: browser ── direct WS ▶ pikiln server (no relay needed)
```

The Pi owns all GPIO and safety. The relay is a stateless bridge so browsers
behind home NAT can still reach the kiln. The browser holds no canonical
state. See [`pikiln/web/docs/help/architecture.md`](pikiln/web/docs/help/architecture.md)
for the full breakdown.

## Getting started

### To run the simulator (no hardware needed)

```bash
git clone https://github.com/bjmillerpa/PiKilnController.git
cd PiKilnController/pikiln
npm install
PIKILN_SIMULATE=1 npm start
# UI at http://localhost:8080/
```

### To deploy on real hardware

You'll need: a Raspberry Pi 4, three MAX31855 thermocouple breakouts,
three low-power relays driving three high-power contactors, K-type
thermocouples, and a kiln with three independent element zones.

Wiring details, BCM pin assignments, and a checklist are in
[`pikiln/web/docs/help/setup.md`](pikiln/web/docs/help/setup.md).
Once wired:

```bash
sudo pi/install.sh <KILN_RELAY_TOKEN> --relay-url https://your-relay-host
sudo systemctl status pikiln
```

If you don't want remote access, you can skip the relay entirely — the Pi
serves the same UI on its LAN at `http://kiln.local:8080`.

### To run the VPS relay

```bash
cd relay
cp .env.example .env  # then edit: KILN_RELAY_TOKEN, KILN_HOST, KILN_HTPASSWD_FILE
docker compose up -d kiln-relay
# Optional sim that takes over when the Pi is off:
docker compose up -d kiln-sim
```

The compose file uses Traefik labels keyed off `${KILN_HOST}`; adjust if
you're behind nginx/Caddy. See [`relay/README.md`](relay/README.md).

## Safety

**This software drives mains-voltage contactors that switch kiln elements.
A bug, a wiring mistake, or a hardware failure can start a fire.** The
design assumes:

1. Hardware fail-open at every stage: Pi GPIO → low-power NO relay →
   high-power NO contactor → element. Loss of drive at any stage opens the
   circuit. **Mechanical NO contactors only; do not use SSRs that can fail
   closed in a kiln application.**
2. Independent over-temperature interlock recommended (not provided by
   this software) — e.g. a snap-action thermal fuse in series with the
   contactor coils.
3. The kiln is supervised at first by an experienced operator who can
   read the firing curve and intervene; only run unattended after enough
   firings to trust the configuration.

Software safety in `pikiln/lib/safety.js` covers over-temp, element-on-too-
long, heartbeat-stall, and all-sensors-failed e-stops — but those are the
last line, not the first.

## Calibration

The thermal model's loss curve and assumed thermal mass are calibrated
against an empty-kiln test firing and updated whenever anything changes
(new insulation, vent work, element replacement). The `Thermal Calibration`
schedule in `pikiln/seed-schedules/` is the standard test: holds at
300 / 500 / 700°C, free cool-down. See
[`pikiln/web/docs/help/thermal-analysis.md`](pikiln/web/docs/help/thermal-analysis.md).

The shipped coefficients are fit to the author's L&L Easy-Fire kiln
(2026-06-12 calibration). Your kiln *will* differ — re-run the calibration
once you've assembled your install.

## Tests

```bash
cd pikiln && npm test
```

132 tests covering schedule, PID, cones, safety, temp-sensor, thermal-model,
logger, and lifecycle scenarios.

## License

GPLv3. See [`LICENSE`](LICENSE). You're free to use, modify, and redistribute
under the same terms; the safety section above is advisory but the license
is what it is.

## Acknowledgments

- L&L Kilns for publishing the HVAC data this project started from
- Orton Ceramic Foundation for the cone temperature tables
- pigpio (joan2937) for the Pi GPIO driver
- Preact + htm + uPlot for the UI

## Contributing

The project lives at <https://github.com/bjmillerpa/PiKilnController>. Issues
and PRs welcome. Worth reading [`CLAUDE.md`](CLAUDE.md) first — it's a
developer-oriented map of the codebase. Run the test suite before PRs.
