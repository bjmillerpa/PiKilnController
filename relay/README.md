# PiKiln VPS Relay

Bridges the Pi kiln controller (sitting behind home NAT) to remote browsers,
via an outbound WebSocket the Pi opens to this VPS.

```
   Pi (at the kiln)                    VPS (your-relay-host)              You (anywhere)
   ─────────────────                   ──────────────────────              ───────────────
   pikiln server  ──── outbound WSS ──▶ kiln-relay container ◀── HTTPS ── browser
                       /controller                            (cookie auth)
                       (token-authed)

   Local LAN:   browser ──── direct WS ──▶ pikiln server (no relay involved)
```

The same UI bundle (`../pikiln/web/`) is served by both the Pi and the relay,
so remote and local UIs are identical and stay in sync.

## Routing & auth

| Path | Auth | Purpose |
|------|------|---------|
| `wss://your-relay-host/controller` | App-level **shared token** in the WS `identify` message (`KILN_RELAY_TOKEN`) | The Pi dials in here. Bypasses cookie auth because the Pi can't do an interactive login. |
| `https://your-relay-host/update/...` | **Same shared token** as `Authorization: Bearer` | Pi's bootstrap fetches `/update/manifest`, `/update/pikiln.tar.gz`, `/update/schedules-manifest`, `/update/schedules.tar.gz`. |
| `https://your-relay-host/health` | **Public** | Liveness check (just exposes whether a controller is connected; no sensitive data). |
| `https://your-relay-host/login` and `/auth/*` | **Public** | The login form and its POST endpoint. |
| Everything else (`/`, `/app.js`, `/lib/...`, `wss://your-relay-host/`) | **Cookie auth** | After POSTing valid credentials to `/auth/login`, the relay sets a signed `kiln_session` cookie (HMAC-SHA256, 90-day TTL). All subsequent HTTP requests and WebSocket upgrades inherit it. |

Single Traefik HTTPS router with no middleware — auth is entirely the relay's
concern. Was previously Traefik basicauth, but iOS Safari drops basic-auth
credentials on every WebSocket reconnect, making mobile monitoring painful.

## Cookie auth

The relay reads your htpasswd file (path from `KILN_HTPASSWD_FILE`, bind-
mounted at `/etc/pikiln-htpasswd`) and verifies APR1-MD5 hashes against the
submitted password — the same Apache hash format the file already uses:

```bash
htpasswd "$KILN_HTPASSWD_FILE" <username>            # update on host
docker kill -s HUP kiln-relay                        # re-read without restart
```

The session cookie is signed with a key derived from `KILN_RELAY_TOKEN`
(`sha256("kiln-relay-session-v1:" + token)`), so rotating that token also
invalidates all sessions. Cookie attributes: `HttpOnly; SameSite=Lax;
Secure; Max-Age=7776000` (90 days).

## Update endpoints (used by the Pi)

The relay builds a tarball of the live `pikiln/` tree (excluding `data/`,
`node_modules/`, `test/`, `.git`, `*.log`) on demand and caches it,
invalidating the cache on any source mtime change.

- `GET /update/manifest` → `{sha256, builtAt, size, source}`
- `GET /update/pikiln.tar.gz` → the gzipped tarball; the `X-Update-SHA256`
  response header mirrors the manifest sha.

Both require `Authorization: Bearer <KILN_RELAY_TOKEN>`. The Pi's
`pikiln-update` script (see `pi/README.md`) calls these, verifies the sha256,
extracts to `/opt/pikiln/releases/...`, atomically swaps `current`, and
rolls back if startup fails twice in a row.

## Deploying on the VPS

```bash
cd <repo>/relay
cp .env.example .env
# Edit .env — set KILN_RELAY_TOKEN (openssl rand -hex 32), KILN_HOST (your DNS),
# KILN_HTPASSWD_FILE (path to your htpasswd file).
docker compose build
docker compose up -d
docker logs -f kiln-relay
```

Verify it's healthy:

```bash
curl -s https://your-relay-host/health
```

To rotate the token:

```bash
openssl rand -hex 32             # new token
$EDITOR .env                     # paste it in
docker compose restart kiln-relay
# …then update the Pi's /opt/pikiln/.env (KILN_RELAY_TOKEN) and restart pikiln.
```

To rotate a user's password: re-run `htpasswd "$KILN_HTPASSWD_FILE" <user>`
on the host, then `docker kill -s HUP kiln-relay` to re-read the file
without a container restart.

## Deploying on the Pi

See [`pi/README.md`](../pi/README.md) for the install script. In short:

```bash
sudo ./install.sh <KILN_RELAY_TOKEN> --relay-url https://your-relay-host
```

The Pi reads `/opt/pikiln/.env` (`KILN_RELAY_TOKEN`, `RELAY_URL`). Or set
the token via env and skip persistence:

```bash
KILN_RELAY_TOKEN=… RELAY_URL=https://your-relay-host node pikiln.js
PIKILN_SIMULATE=1 node pikiln.js   # sim mode for dev (no token needed)
```

The Pi connects to `/controller`, sends `{type:"identify", client:"controller", token:"…"}`,
and on `{type:"identified"}` starts forwarding state. If the connection drops,
it reconnects with exponential backoff (1s → 30s).

## Protocol

| Direction | Message | Notes |
|-----------|---------|-------|
| Pi → relay | `{type:"identify", client:"controller", token:"…"}` | First message; must arrive within 5s of WS open. |
| relay → Pi | `{type:"identified", role:"controller"}` | Auth OK. Bad/missing token closes the socket with code 4401. |
| Pi → relay → all viewers | `{type:"state", data:{…}}` <br> `{type:"log", message:"…"}` <br> `{type:"message", message:"…"}` <br> `{type:"response", action:"…", data:{…}}` | Relay forwards verbatim. The latest `state` is cached and replayed to new viewers immediately. |
| viewer → relay → Pi | `{type:"command", action:"start\|stop\|loadSchedule\|saveSchedule\|setFanMode\|testRelay", params:{…}}` | If the Pi isn't connected the relay synthesizes `{type:"response", action:"…", message:"Kiln controller is not connected"}` back to the viewer. |
| relay → viewers | `{type:"relay", event:"controller-connected\|controller-disconnected"}` | UI uses this to display a "Pi offline" banner. |

## Files

- `relay-server.js` — the relay itself (~200 lines, only dep is `ws`)
- `Dockerfile` — node:20-alpine, runs as `node` user
- `docker-compose.yml` — labels for Traefik + bind-mounts `../pikiln/web` read-only
- `.env` — `KILN_RELAY_TOKEN=…`, `KILN_PIKILN_DIR=…` (chmod 600, gitignored)
- `.env.example` — template
