#!/usr/bin/env bash
#
# install.sh — one-time setup on the Pi. Lays out /opt/pikiln, installs the
# scripts and systemd unit, runs the first update, and starts the service.
#
# Usage:
#   sudo ./install.sh <KILN_RELAY_TOKEN> --relay-url https://your-relay-host
#
# Idempotent: safe to re-run to update scripts + .env.

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "must run as root (try: sudo $0 ...)"
  exit 1
fi

TOKEN="${1:-}"
shift || true
RELAY_URL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --relay-url) RELAY_URL="$2"; shift 2 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

if [ -z "$TOKEN" ] || [ -z "$RELAY_URL" ]; then
  echo "usage: sudo $0 <KILN_RELAY_TOKEN> --relay-url https://your-relay-host"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required; please install it first (https://nodejs.org/)."
  exit 1
fi
NODE_VER=$(node --version | sed 's/v//;s/\..*//')
if [ "$NODE_VER" -lt 18 ]; then
  echo "Node.js 18+ required (found $(node --version))"
  exit 1
fi

# Ensure the pigpio C library is present. The npm pigpio package is a native
# binding to libpigpio.so and won't load without it — the controller would
# crash-loop on startup with "pigpio.gpioInitialise is not a function". The
# packaging story changes between Pi OS versions:
#   - Bookworm and older: `apt install pigpio` (a meta-package)
#   - Trixie:             pigpio was dropped; install libpigpio1 + libpigpio-dev,
#                         or build from source if even those are missing
if ! ldconfig -p 2>/dev/null | grep -q libpigpio; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    echo ">> Installing pigpio C library"
    if apt-get install -y pigpio 2>/dev/null; then
      :
    elif apt-get install -y libpigpio1 libpigpio-dev 2>/dev/null; then
      :
    else
      echo ">> apt has no pigpio packages on this release — building from source"
      apt-get install -y build-essential unzip wget
      TMP=$(mktemp -d) && (
        cd "$TMP"
        wget -q https://github.com/joan2937/pigpio/archive/master.zip
        unzip -q master.zip
        cd pigpio-master
        make -j"$(nproc)"
        make install
        ldconfig
      ) || echo "!! pigpio source build failed; controller will run in simulation only"
      rm -rf "$TMP"
    fi
  else
    echo "!! libpigpio not found and apt-get unavailable."
    echo "!! Install the pigpio C library manually, otherwise the controller"
    echo "!! will only run in simulation mode."
  fi
fi

PIKILN_HOME=/opt/pikiln
HERE=$(cd "$(dirname "$0")" && pwd)

echo ">> Creating $PIKILN_HOME and subdirs"
install -d -m 0755 \
  "$PIKILN_HOME" "$PIKILN_HOME/bin" "$PIKILN_HOME/releases" \
  "$PIKILN_HOME/data" "$PIKILN_HOME/data/schedules" \
  "$PIKILN_HOME/data/logs" "$PIKILN_HOME/data/perf"

echo ">> Installing scripts to $PIKILN_HOME/bin"
install -m 0755 "$HERE/pikiln-update.sh"  "$PIKILN_HOME/bin/pikiln-update"
install -m 0755 "$HERE/pikiln-launch.sh"  "$PIKILN_HOME/bin/pikiln-launch"

echo ">> Writing $PIKILN_HOME/.env (chmod 600)"
# Preserve any existing env vars (tunables the user has customized) rather
# than overwriting blindly. If the file exists we update only the values we
# know about and leave the rest alone.
if [ -f "$PIKILN_HOME/.env" ]; then
  # Update or append KILN_RELAY_TOKEN
  grep -v '^KILN_RELAY_TOKEN=' "$PIKILN_HOME/.env" | grep -v '^RELAY_URL=' > "$PIKILN_HOME/.env.new"
  echo "KILN_RELAY_TOKEN=$TOKEN" >> "$PIKILN_HOME/.env.new"
  echo "RELAY_URL=$RELAY_URL"   >> "$PIKILN_HOME/.env.new"
  mv "$PIKILN_HOME/.env.new" "$PIKILN_HOME/.env"
else
  cat > "$PIKILN_HOME/.env" <<EOF
# Created by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
KILN_RELAY_TOKEN=$TOKEN
RELAY_URL=$RELAY_URL

# ── Outage-recovery tunables (optional) ────────────────────────────────
# When pikiln boots and finds firing-state.json from a previous run, it
# decides whether to auto-resume the firing:
#   - If kiln max sensor > PIKILN_MIN_WARM_TEMP_F → auto-resume + Pushover
#   - Otherwise → leave idle, send warning, show UI banner for manual decision
# PIKILN_MAX_OUTAGE_SECONDS sets the boundary between info Pushover
# ("quick recovery") and warn Pushover ("long outage, check ware").
#PIKILN_MAX_OUTAGE_SECONDS=300
#PIKILN_MIN_WARM_TEMP_F=200

# ── Ring-balance tunables (optional) ───────────────────────────────────
# Normal max spread between rings — if a ring is more than this much hotter
# than the coolest other ring, its element is forced off for the cycle.
# Stops the lightest-loaded ring from racing ahead at climb rates the kiln
# can't sustain.
#PIKILN_MAX_RING_SPREAD_F=15
# Tighter spread used during the end-approach to the schedule's peak temp.
# Matching cones at the finish matters more than tracking the ramp, so the
# cap clamps down once the kiln is within PIKILN_END_WITHIN_F of peak.
#PIKILN_END_SPREAD_F=3
#PIKILN_END_WITHIN_F=25
EOF
fi
chmod 600 "$PIKILN_HOME/.env"

echo ">> Running first update"
"$PIKILN_HOME/bin/pikiln-update" || true

if [ ! -L "$PIKILN_HOME/current" ]; then
  echo "!! No release installed yet — check connectivity to $RELAY_URL and the token."
  echo "!! You can re-run the update with: $PIKILN_HOME/bin/pikiln-update"
fi

echo ">> Installing systemd unit"
install -m 0644 "$HERE/pikiln.service" /etc/systemd/system/pikiln.service
systemctl daemon-reload
systemctl enable pikiln.service

echo ">> Done. Start with: systemctl start pikiln"
echo "   Logs:           journalctl -u pikiln -f"
echo "   Manual update:  $PIKILN_HOME/bin/pikiln-update"
