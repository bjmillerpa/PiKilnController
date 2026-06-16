#!/usr/bin/env bash
#
# pikiln-launch — wrapper around `node pikiln.js` that handles the rollback
# heuristic. Called by systemd as ExecStart.
#
# Logic:
#   1. Source env file
#   2. Increment the start-failure counter (used by pikiln-update on next boot)
#   3. exec node /opt/pikiln/current/pikiln.js
#   4. (Background) after STARTUP_GRACE seconds of uptime, bless the release
#      as last-known-good and reset the counter.

set -u

: "${PIKILN_HOME:=/opt/pikiln}"
: "${STARTUP_GRACE:=60}"

if [ -f "$PIKILN_HOME/.env" ]; then
  # shellcheck disable=SC1091
  set -a; source "$PIKILN_HOME/.env"; set +a
fi

COUNTER_FILE="$PIKILN_HOME/start-failures"
LAST_GOOD="$PIKILN_HOME/last-good"
CURRENT="$PIKILN_HOME/current"

# Bump the start-failure counter. pikiln-update on next boot rolls back if
# this gets to 2 (i.e. we failed to survive STARTUP_GRACE twice in a row).
COUNT=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
echo $((COUNT + 1)) > "$COUNTER_FILE"

# Background watchdog: after STARTUP_GRACE seconds, if our exec'd Node is
# still alive, bless this release as last-known-good and clear the counter.
( sleep "$STARTUP_GRACE"
  if kill -0 $$ 2>/dev/null; then
    ln -sfn "$(readlink "$CURRENT")" "$LAST_GOOD.new" && mv -Tf "$LAST_GOOD.new" "$LAST_GOOD"
    rm -f "$COUNTER_FILE"
  fi
) &
disown $!

# Point data dir at the persistent location regardless of release
export PIKILN_DATA_DIR="$PIKILN_HOME/data"

# Hand off to Node
cd "$CURRENT"
exec /usr/bin/env node pikiln.js
