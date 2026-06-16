#!/usr/bin/env bash
#
# pikiln-update — fetch and install the latest pikiln release from the VPS relay.
#
# Called by systemd as ExecStartPre. Designed to be safe to interrupt at any
# point: the active release is only swapped after the new one is fully
# extracted and `npm install` succeeded, and the swap itself is an atomic
# symlink rename. If anything fails (network down, bad sha256, npm error,
# we're mid-firing) the active release is left untouched and exit code is 0
# so systemd still starts the existing version — a network blip must never
# block the kiln from running on what it already has.

set -u

# ── Config ─────────────────────────────────────────────────────────────
: "${PIKILN_HOME:=/opt/pikiln}"           # root of the install
: "${RELAY_URL:=}"                        # required; set in /opt/pikiln/.env
: "${KILN_RELAY_TOKEN:=}"                 # required; set in /opt/pikiln/.env
: "${UPDATE_TIMEOUT:=20}"                 # seconds for the manifest/download
: "${STARTUP_GRACE:=60}"                  # seconds before a release is marked good

# Source environment file if present (token, RELAY_URL overrides)
if [ -f "$PIKILN_HOME/.env" ]; then
  # shellcheck disable=SC1091
  set -a; source "$PIKILN_HOME/.env"; set +a
fi

RELEASES_DIR="$PIKILN_HOME/releases"
DATA_DIR="$PIKILN_HOME/data"
CURRENT="$PIKILN_HOME/current"
PREVIOUS="$PIKILN_HOME/previous"
INSTALLED_SHA="$PIKILN_HOME/installed.sha256"
LAST_GOOD="$PIKILN_HOME/last-good"

mkdir -p "$RELEASES_DIR" "$DATA_DIR/schedules" "$DATA_DIR/logs" "$DATA_DIR/perf"

log() { echo "[pikiln-update] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# Always exit 0 — we never want to block the kiln from starting on existing
# code just because the update path is unhealthy.
trap 'log "exiting OK"; exit 0' EXIT

# ── 0. Roll back if the previous boot failed early ─────────────────────
# The launch wrapper bumps a counter on each start and resets it after
# STARTUP_GRACE seconds. If we see a counter > 1 here, the previous boot
# crashed in under STARTUP_GRACE — fall back to the last-known-good release.
COUNTER_FILE="$PIKILN_HOME/start-failures"
if [ -f "$COUNTER_FILE" ] && [ "$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)" -ge 2 ]; then
  if [ -L "$LAST_GOOD" ] && [ "$(readlink "$LAST_GOOD")" != "$(readlink "$CURRENT" 2>/dev/null)" ]; then
    log "previous boot failed; rolling back to $(readlink "$LAST_GOOD")"
    ln -sfn "$(readlink "$LAST_GOOD")" "$CURRENT.new" && mv -Tf "$CURRENT.new" "$CURRENT"
    rm -f "$COUNTER_FILE"
  fi
fi

# ── 1. Refuse to update mid-firing ─────────────────────────────────────
# Only honor the lock if its PID is actually running. A reboot or hard
# crash leaves the lock pointing at a long-dead PID — without the liveness
# check, pikiln would refuse to update forever after a mid-firing crash,
# which is exactly the case where we most want a fresh fix to land.
if [ -f "$DATA_DIR/.firing.lock" ]; then
  LOCK_PID=$(cat "$DATA_DIR/.firing.lock" 2>/dev/null || echo "")
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    log "firing in progress (.firing.lock pid=$LOCK_PID is live); skipping update"
    exit 0
  fi
  log "stale .firing.lock (pid=$LOCK_PID not running) — removing and proceeding"
  rm -f "$DATA_DIR/.firing.lock"
fi

# ── 2. Need the token to talk to the relay ─────────────────────────────
if [ -z "$KILN_RELAY_TOKEN" ]; then
  log "no KILN_RELAY_TOKEN set; skipping update"
  exit 0
fi

# ── 3. Fetch manifest ──────────────────────────────────────────────────
MANIFEST=$(curl -fsS --max-time "$UPDATE_TIMEOUT" \
  -H "Authorization: Bearer $KILN_RELAY_TOKEN" \
  "$RELAY_URL/update/manifest" 2>/dev/null) || {
  log "manifest fetch failed; using existing release"
  exit 0
}

REMOTE_SHA=$(echo "$MANIFEST" | grep -o '"sha256":"[a-f0-9]*"' | head -1 | cut -d'"' -f4)
if [ -z "$REMOTE_SHA" ]; then
  log "manifest missing sha256; aborting update"
  exit 0
fi

INSTALLED=$(cat "$INSTALLED_SHA" 2>/dev/null || echo "")
if [ "$REMOTE_SHA" = "$INSTALLED" ]; then
  log "already at $REMOTE_SHA — no update needed"
  exit 0
fi

log "update available: ${REMOTE_SHA:0:12} (installed: ${INSTALLED:0:12})"

# ── 4. Download tarball + verify integrity ─────────────────────────────
STAGE="$PIKILN_HOME/staging"
rm -rf "$STAGE"; mkdir -p "$STAGE"
TARBALL="$STAGE/pikiln.tar.gz"

curl -fsS --max-time 60 \
  -H "Authorization: Bearer $KILN_RELAY_TOKEN" \
  -o "$TARBALL" \
  "$RELAY_URL/update/pikiln.tar.gz" || {
  log "download failed; aborting"; rm -rf "$STAGE"; exit 0;
}

LOCAL_SHA=$(sha256sum "$TARBALL" | cut -d' ' -f1)
if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
  log "sha256 mismatch ($LOCAL_SHA vs $REMOTE_SHA); aborting"; rm -rf "$STAGE"; exit 0;
fi

# ── 5. Extract into a new release dir ──────────────────────────────────
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-${REMOTE_SHA:0:8}"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
mkdir -p "$RELEASE_DIR"
tar -xzf "$TARBALL" -C "$RELEASE_DIR" --strip-components=1 || {
  log "tar extract failed; aborting"; rm -rf "$RELEASE_DIR" "$STAGE"; exit 0;
}

# Link the release's data/ to the persistent data dir so it survives swaps
rm -rf "$RELEASE_DIR/data" && ln -s "$DATA_DIR" "$RELEASE_DIR/data"

# ── 6. Install npm deps (production only) ──────────────────────────────
if command -v npm >/dev/null 2>&1; then
  log "running npm install in $RELEASE_DIR"
  ( cd "$RELEASE_DIR" && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -5 ) || {
    log "npm install failed; aborting"; rm -rf "$RELEASE_DIR" "$STAGE"; exit 0;
  }
fi

# ── 7. Atomic swap: previous ← current, current ← new ──────────────────
if [ -L "$CURRENT" ]; then
  CURRENT_TARGET=$(readlink "$CURRENT")
  ln -sfn "$CURRENT_TARGET" "$PREVIOUS.new" && mv -Tf "$PREVIOUS.new" "$PREVIOUS"
fi
ln -sfn "$RELEASE_DIR" "$CURRENT.new" && mv -Tf "$CURRENT.new" "$CURRENT"
echo "$REMOTE_SHA" > "$INSTALLED_SHA"

# Reset the failure counter; if this release survives STARTUP_GRACE seconds
# the launch wrapper will mark it as last-good.
rm -f "$COUNTER_FILE"

log "installed $RELEASE_ID — current → $RELEASE_DIR"

# ── 7a. Seed schedules on first install only ───────────────────────────
# A fresh /opt/pikiln/data/schedules is empty; ship the production set so
# the user has something to fire on day one. We use a marker file so
# subsequent updates never overwrite the user's edits or re-add schedules
# they've intentionally deleted.
SEED_MARKER="$DATA_DIR/.schedules-seeded"
SEED_DIR="$RELEASE_DIR/seed-schedules"
if [ ! -f "$SEED_MARKER" ] && [ -d "$SEED_DIR" ]; then
  count=0
  for f in "$SEED_DIR"/*.json; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    # Only copy if the user doesn't already have a file with that name
    if [ ! -f "$DATA_DIR/schedules/$name" ]; then
      cp -p "$f" "$DATA_DIR/schedules/$name"
      count=$((count + 1))
    fi
  done
  date -u +%Y-%m-%dT%H:%M:%SZ > "$SEED_MARKER"
  log "seeded $count schedules from $SEED_DIR"
fi

# ── 8. Prune old releases (keep last 5) ────────────────────────────────
ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | tail -n +6 | while read -r old; do
  # never delete the current or previous targets
  if [ "$(readlink -f "$CURRENT" 2>/dev/null)" = "$(readlink -f "$old" 2>/dev/null)" ]; then continue; fi
  if [ "$(readlink -f "$PREVIOUS" 2>/dev/null)" = "$(readlink -f "$old" 2>/dev/null)" ]; then continue; fi
  if [ "$(readlink -f "$LAST_GOOD" 2>/dev/null)" = "$(readlink -f "$old" 2>/dev/null)" ]; then continue; fi
  log "pruning old release $old"
  rm -rf "$old"
done

rm -rf "$STAGE"

# ── 9. Schedule sync ───────────────────────────────────────────────────
# Pull the master schedule set from the relay before pikiln starts. This way
# the Pi sees laptop edits made while it was powered off, without waiting for
# the WS schedules-sync to arrive after process startup. Skipped if firing
# (covered above) or the relay endpoint isn't reachable.
SCHEDULES_INSTALLED_SHA="$PIKILN_HOME/schedules-installed.sha256"
SCHEDULES_DIR="$DATA_DIR/schedules"

S_MANIFEST=$(curl -fsS --max-time "$UPDATE_TIMEOUT" \
  -H "Authorization: Bearer $KILN_RELAY_TOKEN" \
  "$RELAY_URL/update/schedules-manifest" 2>/dev/null) || S_MANIFEST=""

if [ -n "$S_MANIFEST" ]; then
  S_REMOTE_SHA=$(echo "$S_MANIFEST" | grep -o '"sha256":"[a-f0-9]*"' | head -1 | cut -d'"' -f4)
  S_INSTALLED=$(cat "$SCHEDULES_INSTALLED_SHA" 2>/dev/null || echo "")
  if [ -n "$S_REMOTE_SHA" ] && [ "$S_REMOTE_SHA" != "$S_INSTALLED" ]; then
    log "schedules update available: ${S_REMOTE_SHA:0:12} (installed: ${S_INSTALLED:0:12})"
    S_STAGE="$PIKILN_HOME/schedules-staging"
    rm -rf "$S_STAGE"; mkdir -p "$S_STAGE"
    if curl -fsS --max-time 60 \
        -H "Authorization: Bearer $KILN_RELAY_TOKEN" \
        -o "$S_STAGE/schedules.tar.gz" \
        "$RELAY_URL/update/schedules.tar.gz"
    then
      S_LOCAL_SHA=$(sha256sum "$S_STAGE/schedules.tar.gz" | cut -d' ' -f1)
      if [ "$S_LOCAL_SHA" = "$S_REMOTE_SHA" ]; then
        # Extract to temp, then replace SCHEDULES_DIR atomically-ish
        mkdir -p "$S_STAGE/extracted"
        if tar -xzf "$S_STAGE/schedules.tar.gz" -C "$S_STAGE/extracted" --strip-components=1; then
          mkdir -p "$SCHEDULES_DIR"
          # Replace contents: rsync would be nicest, but the busybox-on-pi
          # situation varies. Simple approach: copy in everything from the
          # tarball, then remove any *.json file in SCHEDULES_DIR whose title
          # isn't represented in the new set (the pikiln process does the
          # title-based removal at startup via Schedule.loadAll — here we just
          # wipe and replace, which is fine because edits while-offline aren't
          # supported).
          rm -f "$SCHEDULES_DIR"/*.json 2>/dev/null
          cp -p "$S_STAGE/extracted"/*.json "$SCHEDULES_DIR/" 2>/dev/null
          echo "$S_REMOTE_SHA" > "$SCHEDULES_INSTALLED_SHA"
          log "schedules synced ($(ls "$SCHEDULES_DIR"/*.json 2>/dev/null | wc -l) files)"
        else
          log "schedules: tar extract failed"
        fi
      else
        log "schedules: sha mismatch ($S_LOCAL_SHA vs $S_REMOTE_SHA)"
      fi
    else
      log "schedules: download failed"
    fi
    rm -rf "$S_STAGE"
  else
    log "schedules: already at ${S_REMOTE_SHA:0:12}"
  fi
else
  log "schedules-manifest fetch failed; using local schedules"
fi
