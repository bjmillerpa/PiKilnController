# Setup from scratch

Bring a new kiln, Pi, and VPS together into a working installation.

This is the long version — read it once to understand the pieces, then use
the checklist at the end for actual builds. If you've already done some of
the steps, skip ahead.

## What you'll need

### Hardware

- **Raspberry Pi 4** (any RAM size; 2 GB is plenty) with power supply
- **SD card**, 32 GB or larger, A2 class (faster random writes)
- **3 × MAX31855 K-type thermocouple amplifier breakouts** — Adafruit P/N 269
  or equivalent
- **3 × K-type thermocouples** — sheathed, rated above your peak firing
  temperature (cone 10 = 2350°F so look for ≥2500°F-rated probes)
- **3 × low-power relay modules** — solid-state or mechanical, 3.3 V control,
  rated for the contactor coil current (usually <500 mA at 12 V or 24 V)
- **3 × high-power contactors** — mechanical, normally-open, rated above
  the element current (240 V × 16 A = 3.84 kW per element on Bruce's L&L;
  check yours). One per heating zone.
- **1 × low-power relay for the vent fan**
- **24 V DC power supply** for the contactor coils (or whatever voltage your
  contactors want)
- **Hookup wire**, fuses, terminal blocks, ground bonding
- **Twisted-pair K-type thermocouple extension wire** (the noise immunity
  matters near element wiring — see Diagnostics doc once that's written)

### Network

- A **VPS** with Docker installed and ~1 GB RAM. Hostinger, DigitalOcean,
  Linode all fine.
- A **domain name** (or subdomain) you control. Point an A record at the
  VPS IP. Set `KILN_HOST` in `relay/.env` to that hostname.
- A reverse proxy on the VPS for HTTPS — Traefik, Caddy, or nginx. The
  docker-compose example assumes Traefik with the network name `coolify`.

### Accounts

- A **Pushover account** if you want phone notifications (optional but
  recommended). You'll need a user key and three application tokens
  (info/warn/error), set as environment variables on the relay.

## Hardware wiring

Fail-safe principle: **loss of drive at any stage must open the circuit**.

```
   Pi GPIO (3.3 V)
        │  drives a small MOSFET or transistor
        ▼
   Low-power relay (12 V or 24 V coil, NO contacts)
        │  switches contactor coil power
        ▼
   High-power contactor (NO contacts)
        │  switches mains to the element
        ▼
   Heating element
```

If the Pi crashes, GPIO floats low → MOSFET off → low-power relay drops →
contactor coil unpowered → contactor opens → element off. Contactors are
mechanical and fail open by gravity if their coil loses power.

### GPIO pin assignments

These live in [`lib/constants.js`](../../lib/constants.js). Default values
(BCM numbering; see [pinout.xyz](https://pinout.xyz)):

| Function | BCM pin | Physical pin |
|---|---|---|
| Heat ring 1 (Bottom) | 21 | 40 |
| Heat ring 2 (Mid) | 20 | 38 |
| Heat ring 3 (Top) | 26 | 37 |
| Vent fan | 16 | 36 |
| SPI clock (shared) | 11 | 23 |
| SPI MISO (shared) | 9 | 21 |
| Thermocouple ring 1 CS | 17 | 11 |
| Thermocouple ring 2 CS | 18 | 12 |
| Thermocouple ring 3 CS | 27 | 13 |

The three MAX31855 breakouts share clock and MISO; each has its own chip
select line. The kernel SPI driver must be **disabled** because BCM 9/10/11
are the hardware SPI0 pins and the kernel will claim them otherwise — we
bit-bang SPI in user space via pigpio. Disable via `sudo raspi-config` →
Interface Options → SPI → Disable.

Re-wire the pins by editing `lib/constants.js` if your install is different.

## VPS setup

### 1. Install Docker

Skip if you already have Docker. On a fresh Ubuntu:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in for the group change to take effect
```

### 2. Clone the repo and create the relay config

```bash
mkdir -p ~/kilncontroller && cd ~/kilncontroller
git clone <repo> .
cd relay
```

Create `.env` with:

```bash
KILN_RELAY_TOKEN=$(openssl rand -hex 32)
# Optional — Pushover phone notifications
PUSHOVER_USER=your-pushover-user-key
PUSHOVER_INFO=your-info-app-token
PUSHOVER_WARN=your-warn-app-token
PUSHOVER_ERROR=your-error-app-token
```

Keep `KILN_RELAY_TOKEN` safe — it's the Pi's password to the relay.

### 3. Create the htpasswd file (browser login)

```bash
mkdir -p ~/.passwords
htpasswd -c ~/.passwords/.htpasswd-kiln <username>
```

(Install `apache2-utils` if you don't have `htpasswd`.) Set the path in
`relay/.env` as `KILN_HTPASSWD_FILE`.

### 4. Set up the reverse proxy

The provided `relay/docker-compose.yml` uses Traefik labels driven by
`${KILN_HOST}` from `.env`. If you're using a different proxy (Caddy,
nginx), point it at the `kiln-relay` container's port 8080.

### 5. Start the relay and (optionally) the sim

```bash
docker compose up -d kiln-relay
# Optional — keeps the UI working when the Pi is off
docker compose up -d kiln-sim
```

Verify with `docker ps`; both containers should be `Up`. The relay's
`/health` endpoint at `https://your-domain/health` should return JSON.

### 6. Create the master-schedules directory

```bash
mkdir -p ~/kilncontroller/master-schedules
chown -R 1001:1001 ~/kilncontroller/master-schedules
```

(The relay container runs as UID 1001 — adjust if your VPS user has a
different UID.) The first Pi or sim connection seeds this directory from
its bundled `seed-schedules/`.

## Pi setup

### 1. Flash and prepare the SD card

- Use the **Raspberry Pi Imager** to flash **Raspberry Pi OS Lite (64-bit)**.
  No desktop needed — the Pi runs headless.
- Pre-configure via the imager's settings dialog:
  - Set a hostname (e.g. `kiln`)
  - Enable SSH and set a password
  - Set your Wi-Fi credentials (or plan to wire ethernet)
  - Set locale and timezone

### 2. First boot and OS prep

Boot the Pi. SSH in (`ssh <user>@kiln.local`). Then:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nodejs npm git
```

Disable the kernel SPI driver (we bit-bang in user space):

```bash
sudo raspi-config
# Interface Options → SPI → No
```

### 3. Install pikiln

```bash
cd ~ && git clone <repo> kilncontroller
cd kilncontroller/pi
sudo ./install.sh
```

The installer:
- Creates `/opt/pikiln/` with `data/`, `releases/`, `bin/`
- Copies `pikiln-update` and `pikiln-launch` into `/opt/pikiln/bin/`
- Installs the systemd unit
- Triggers the first `pikiln-update` to pull the current release from the
  relay (this only works if you've already created `.env` in the next step)

If install.sh complains about a missing token, finish the .env creation and
re-run it. The script is idempotent.

### 4. Create `/opt/pikiln/.env`

```bash
sudo tee /opt/pikiln/.env >/dev/null <<EOF
RELAY_URL=https://your-domain
KILN_RELAY_TOKEN=<same token you put in relay/.env on the VPS>
EOF
sudo chmod 600 /opt/pikiln/.env
```

### 5. Start the service

```bash
sudo systemctl enable pikiln
sudo systemctl start  pikiln
sudo journalctl -u pikiln -f
```

You should see:

```
[pikiln-update] manifest fetch: <sha>
[pikiln-update] installed ...
PiKiln starting
Connecting to relay as real: wss://your-domain/controller
Connected to relay
schedules-sync: synced N from master
```

If you see `Relay yielding to real controller; polling /health for slot`
instead — that's the **sim** identifying as real because role logic flipped.
Make sure `KILN_RELAY_ROLE` is *not* set on the Pi; it should default to
"real". (The sim has `KILN_RELAY_ROLE=sim` in its docker-compose env.)

## First firing — the Tests-tab walkthrough

**Before powering anything beyond the Pi:**

1. Open `http://kiln.local:8080` from your laptop (LAN) or the relay URL.
2. Go to the **Tests** tab.
3. Verify the GPIO pin assignments at the top match your wiring.
4. With kiln power **off**, click each Heat button briefly. You should hear
   the corresponding contactor click. If a wrong contactor clicks, fix
   the wiring or edit `GPIO_HEAT` in `lib/constants.js`.
5. Click the Fan button. Vent fan should run.

**Then with the kiln warm but not firing:**

1. Turn on kiln power (no schedule running).
2. From the Tests tab, turn one Heat relay on for ~5 seconds.
3. Watch the corresponding ring's thermocouple reading climb. If it
   doesn't, or if a *different* ring climbs, the thermocouple-to-element
   mapping is swapped. Fix wiring or edit constants.
4. Repeat for all three rings.

**Then a first real firing:**

1. Schedules tab → pick "Candle 2 Hour" (slow, low-temp, hard to damage
   anything with).
2. Run tab → Start.
3. Watch the firing curve and log for the first 20 minutes. The temp
   should climb smoothly toward 200°F.
4. If anything looks wrong, Stop and investigate.

Once "Candle 2 Hour" runs cleanly end-to-end, try a real bisque or glaze
schedule on a non-precious load.

## Optional: monitor share link

When a firing is active, **Settings tab → Share read-only monitor**. Copy
the link, send it to whoever wants to watch. The link works without a
login, is read-only (no buttons), and rotates only when the Pi service
restarts.

## Setup checklist

For your second build, skip the prose and use this:

- [ ] VPS: Docker installed, repo cloned, `relay/.env` created with
      token, htpasswd file in place, reverse-proxy configured, `docker
      compose up -d kiln-relay kiln-sim`
- [ ] DNS: A record points to VPS, HTTPS cert issuing
- [ ] Pi: Raspberry Pi OS Lite flashed, SSH/Wi-Fi pre-configured,
      hostname set
- [ ] Pi: `sudo apt install nodejs npm git`, kernel SPI disabled
- [ ] Pi: repo cloned to `~/kilncontroller`, `sudo pi/install.sh`
- [ ] Pi: `/opt/pikiln/.env` created with `RELAY_URL` and token,
      perms 600
- [ ] Pi: `sudo systemctl enable --now pikiln`, journal shows
      "Connected to relay"
- [ ] Relay UI: log in via htpasswd at `https://your-domain/`
- [ ] Tests tab: each Heat/Fan relay clicks correctly with kiln power off
- [ ] Tests tab: thermocouple-to-ring mapping verified with brief warm
      pulses
- [ ] First firing: "Candle 2 Hour" runs to completion
- [ ] Pushover (optional): tokens in `relay/.env`, restart kiln-relay,
      verify "Started" notification arrives

## Common gotchas

- **Kernel SPI claiming the GPIOs**: symptom is all three thermocouples
  showing 32°F (= 0°C, the chip's not responding pattern). Fix: disable
  kernel SPI via raspi-config.
- **Wrong BCM vs wiringPi pin numbering**: the constants are BCM. If a
  contactor doesn't click, double-check the physical pin map at
  pinout.xyz against the BCM number.
- **Pi reading `.env` not loaded by systemd**: pikiln-launch.sh sources
  `/opt/pikiln/.env`. If you put the relay token elsewhere, it won't be
  picked up. Make sure the path is exactly `/opt/pikiln/.env`.
- **Sim taking over while real Pi connects**: if both the sim and the
  real Pi connect simultaneously, the sim yields. Check
  `KILN_RELAY_ROLE` env var — should be unset on the Pi, set to `sim` on
  the sim container only.
- **Browser can't reach kiln.local**: mDNS resolution is fussy. Use the
  Pi's IP address (`ip addr` on the Pi to find it) if `.local` doesn't
  work for your OS.
