'use strict';
//
// PiKiln VPS relay
// ────────────────
// Sits on a public-facing VPS and bridges:
//   - exactly one controller (the Pi, dials out over WSS to `/controller`)
//   - many viewers (browsers, behind Traefik basicauth at `/`)
//
// The Pi can't be reached from the public internet (home NAT), but it can
// always dial *out* — so the Pi initiates and holds a long-lived WebSocket
// to this relay. Browsers reach the relay through Traefik (TLS + basicauth);
// the relay forwards their commands down to the Pi and the Pi's state up
// to every connected browser.
//
// Path layout (matched by Traefik):
//   GET  /health              → liveness JSON (no auth, used by Traefik/uptime)
//   WS   /controller          → controller endpoint, token-authed at app layer
//   WS   /                    → viewer endpoint, browser WS (basicauth at edge)
//   GET  /                    → serves the same web/ bundle the Pi serves
//
// The controller token is read from KILN_RELAY_TOKEN at startup. Only the
// holder of that token may register as the controller; without it the
// connection is closed immediately. Browsers never carry the token — the
// edge basicauth is what gates them.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');
const { loadHtpasswd, verifyCredentials } = require('./lib/htpasswd');
const session = require('./lib/session');

const PORT = parseInt(process.env.PORT || '8080', 10);
const TOKEN = process.env.KILN_RELAY_TOKEN || '';
const WEB_DIR = process.env.WEB_DIR || path.join(__dirname, 'web');
// Pushover keys live here so the controller never needs them. The relay
// is the only thing that talks to api.pushover.net. Missing keys → no-op.
const PUSHOVER_USER  = process.env.PUSHOVER_USER  || '';
const PUSHOVER_INFO  = process.env.PUSHOVER_INFO  || '';
const PUSHOVER_WARN  = process.env.PUSHOVER_WARN  || '';
const PUSHOVER_ERROR = process.env.PUSHOVER_ERROR || '';

// Browser auth: bind-mount the host's htpasswd here. Replaces the Traefik
// basicauth middleware so we can issue long-lived cookies that survive iOS
// Safari's habit of dropping basic-auth credentials on WS reconnect.
const HTPASSWD_FILE  = process.env.HTPASSWD_FILE  || '/etc/pikiln-htpasswd';
const SESSION_KEY    = session.deriveKey(TOKEN);
let htpasswd = loadHtpasswd(HTPASSWD_FILE);
if (htpasswd.size === 0) {
  console.error(`WARN: htpasswd file at ${HTPASSWD_FILE} is empty or unreadable; browser logins will all fail`);
}
// Re-read on SIGHUP so password rotations don't need a relay restart.
process.on('SIGHUP', () => {
  htpasswd = loadHtpasswd(HTPASSWD_FILE);
  console.log(`[${new Date().toISOString()}] htpasswd reloaded (${htpasswd.size} user(s))`);
});
// The directory we serve to the Pi as an update. Defaults to the parent of
// WEB_DIR (i.e. the whole `pikiln/` tree). The Pi will extract this and run it.
const UPDATE_SRC_DIR = process.env.UPDATE_SRC_DIR || path.dirname(WEB_DIR);
// Canonical schedules directory. The relay pushes this to each controller on
// connect, and mirrors edits coming back upstream. If unset, schedule-sync
// features are disabled (the relay just forwards messages as before).
const MASTER_SCHEDULES_DIR = process.env.MASTER_SCHEDULES_DIR || '';
// Per-firing log mirror directory. Survives Pi SD-card failure: the Pi pushes
// each firing's log incrementally (start → append → complete), the relay
// writes it here, and a separate volume on the host preserves the records
// even if the relay container is rebuilt. If unset, firing-log mirroring is
// silently disabled (the controller still keeps local copies).
const FIRINGS_DIR = process.env.FIRINGS_DIR || '';

if (!TOKEN) {
  console.error('FATAL: KILN_RELAY_TOKEN env var is required');
  process.exit(1);
}

// ── State ───────────────────────────────────────────────────────────────
//
// Controller priority: at most one controller is "active" at a time. Real
// controllers (the Pi at the kiln) outrank sim controllers (the always-on
// VPS simulator). When the Pi powers up, the relay supersedes the sim with
// it; when the Pi drops, the sim reconnects and resumes serving the UI.

let controllerWs = null;       // the single active controller, if any
let controllerRole = null;     // 'real' | 'sim'
let controllerSince = null;    // ISO timestamp of when it last connected
let lastState = null;          // last state message we forwarded — sent to new viewers
// Ring buffer of the last N log/message frames, replayed to any newly-
// connecting viewer so they see recent context immediately rather than a
// blank log until the next message arrives. Caps at LOG_BUFFER_SIZE to
// bound memory. Bruce hit this after a Pi reboot: kiln was firing fine
// but the browser's log panel stayed empty because all the log lines
// during recovery happened before the viewer reconnected.
const LOG_BUFFER_SIZE = 200;
const logBuffer = [];
const viewers = new Set();     // browser sockets (authed via cookie)
const monitorViewers = new Set();  // read-only sockets gated by monitorKey

// Custom WS close codes (RFC 6455 reserves 4000-4999 for application use)
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_SUPERSEDED   = 4000;
const CLOSE_YIELD_TO_REAL = 4002;  // sim told to step aside; back off and retry

const startedAt = new Date().toISOString();
let viewerCount = 0;           // total viewer connections seen (not concurrent)

// Per-firing read-only share key. The Pi sends `monitorKey` inside every
// state message while a firing is active; we track the latest value here.
// /monitor/:key serves the UI without auth when key matches; /monitor-ws
// opens a viewer-equivalent WS that rejects any incoming commands. Both
// fail closed when the key is null (no active firing) or stale (a new
// firing has rotated the key).
let currentMonitorKey = null;

// ── Auth gate ──────────────────────────────────────────────────────────
//
// Bypassed paths (no cookie required):
//   /health                        — liveness, leaks only "is the relay up?"
//   /login, /auth/login, /auth/logout  — the auth flow itself
//   /controller                    — controller WS; gated by KILN_RELAY_TOKEN
//   /update/*                      — Pi bootstrap; gated by Bearer token
//   /monitor/*                     — read-only firing share; gated by key in URL
//   static assets (.js/.css/etc)   — public code bundle, no secrets in it,
//                                    needed by the monitor URL to load the UI
// Everything else needs a valid session cookie or it 302s to /login (for
// GETs) or 401s (for non-GETs and WS upgrades).

// Static asset extensions that are part of the public web bundle. We unauth
// these so the /monitor/:key page can load /app.js, /components/*.js, etc.
// without a cookie. There are no secrets in this code — anyone with the
// repo can read it — but real-time data flows through WS which is still
// gated (either by cookie or by monitor-key).
const STATIC_EXTS = new Set([
  '.js', '.mjs', '.css', '.png', '.svg', '.ico', '.map', '.woff', '.woff2',
  // Help-tab content: docs are static markdown files indexed by a JSON
  // manifest. Bypass auth so monitor viewers (share-link, no login) can
  // also browse the docs.
  '.md', '.json',
]);

function isAuthBypassPath(urlPath) {
  if (urlPath === '/health') return true;
  if (urlPath === '/login' || urlPath === '/auth/login' || urlPath === '/auth/logout') return true;
  if (urlPath === '/controller') return true;
  if (urlPath.startsWith('/update')) return true;
  if (urlPath.startsWith('/monitor/') || urlPath === '/monitor-ws') return true;
  const ext = path.extname(urlPath).toLowerCase();
  if (STATIC_EXTS.has(ext)) return true;
  return false;
}

// Returns the session payload if the request carries a valid cookie, else null.
function authedUser(req) {
  const tok = session.readCookie(req);
  if (!tok) return null;
  return session.verify(tok, SESSION_KEY);
}

function readBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function renderLoginHtml(errorMessage = '', redirectTo = '/') {
  const safeRedirect = (redirectTo || '/').replace(/[<>"'`]/g, '');
  const errBlock = errorMessage
    ? `<div class="error">${errorMessage.replace(/[<>&]/g, '')}</div>` : '';
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PiKiln — Sign in</title>
<style>
* { box-sizing: border-box; }
body { font-family: -apple-system, system-ui, sans-serif; background: #1a1a2e;
  color: #e0e0e0; margin: 0; padding: 0; min-height: 100vh; display: flex;
  align-items: center; justify-content: center; }
.box { width: min(360px, 92vw); padding: 28px 24px; background: #16213e;
  border-radius: 10px; box-shadow: 0 4px 24px rgba(0,0,0,0.4); }
h1 { color: #e94560; margin: 0 0 18px; font-size: 1.6em; }
label { display: block; margin: 14px 0 4px; font-size: 12px; color: #888;
  text-transform: uppercase; letter-spacing: 0.5px; }
input { width: 100%; padding: 12px; background: #0f0f23; color: #e0e0e0;
  border: 1px solid #444; border-radius: 6px; font-size: 16px; }
input:focus { outline: none; border-color: #e94560; }
button { width: 100%; padding: 13px; margin-top: 22px; background: #e94560;
  color: #fff; border: none; border-radius: 6px; font-size: 16px;
  font-weight: 600; cursor: pointer; }
button:hover { background: #c73650; }
.error { background: #4a1a1a; border: 1px solid #e94560; color: #ffcccc;
  padding: 10px 12px; border-radius: 6px; font-size: 13px; margin-bottom: 4px; }
.foot { margin-top: 18px; color: #555; font-size: 11px; text-align: center; }
</style>
</head><body>
<div class="box">
<h1>PiKiln</h1>
${errBlock}
<form method="POST" action="/auth/login">
<input type="hidden" name="r" value="${safeRedirect}">
<label>Username</label>
<input type="text" name="user" required autocomplete="username" autofocus>
<label>Password</label>
<input type="password" name="pass" required autocomplete="current-password">
<button type="submit">Sign in</button>
</form>
<div class="foot">Session lasts 90 days on this device.</div>
</div>
</body></html>`;
}

function broadcastToViewers(payload) {
  // Authed cookie-based viewers AND monitor-key viewers both see the same
  // real-time stream. The difference is in the OPPOSITE direction —
  // monitorViewers' incoming messages are dropped (see monitor-ws connection
  // handler below) so they can't issue control commands.
  for (const ws of viewers) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
  for (const ws of monitorViewers) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ── HTTP ────────────────────────────────────────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.md':   'text/markdown; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

const httpServer = http.createServer(async (req, res) => {
  // Health endpoint — no auth, used by Traefik/uptime
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      startedAt,
      controllerConnected: controllerWs !== null,
      controllerRole,
      controllerSince,
      viewers: viewers.size,
      lifetimeViewerConnections: viewerCount,
    }));
    return;
  }

  // Update endpoints — token-authed, used by the Pi's pre-start bootstrap.
  // Live alongside /controller (no basicauth at edge); the bearer token is the gate.
  if (req.url === '/update/manifest' || req.url === '/update/pikiln.tar.gz' ||
      req.url === '/update/schedules-manifest' || req.url === '/update/schedules.tar.gz') {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    try {
      if (req.url === '/update/schedules-manifest' || req.url === '/update/schedules.tar.gz') {
        if (!MASTER_SCHEDULES_DIR) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'schedule sync not configured' }));
          return;
        }
        const { buf, sha256, builtAt } = await getSchedulesTarball();
        if (req.url === '/update/schedules-manifest') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ sha256, builtAt, size: buf.length, source: MASTER_SCHEDULES_DIR }));
        } else {
          res.writeHead(200, {
            'Content-Type': 'application/gzip',
            'Content-Length': buf.length,
            'X-Update-SHA256': sha256,
          });
          res.end(buf);
        }
        return;
      }
      const { buf, sha256, builtAt } = await getUpdateTarball();
      if (req.url === '/update/manifest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          sha256, builtAt, size: buf.length, source: UPDATE_SRC_DIR,
        }));
      } else {
        res.writeHead(200, {
          'Content-Type': 'application/gzip',
          'Content-Length': buf.length,
          'X-Update-SHA256': sha256,
        });
        res.end(buf);
      }
    } catch (e) {
      log(`update: build failed: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  const urlPathOnly = req.url.split('?')[0];

  // ── Login flow ────────────────────────────────────────────────────────
  if (urlPathOnly === '/login' && req.method === 'GET') {
    // If already authed, bounce to the redirect target (default /)
    if (authedUser(req)) {
      res.writeHead(302, { 'Location': '/' });
      res.end();
      return;
    }
    const q = new URL(req.url, 'http://x').searchParams;
    const redirectTo = q.get('r') || '/';
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(renderLoginHtml('', redirectTo));
    return;
  }
  if (urlPathOnly === '/auth/login' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); }
    catch {
      res.writeHead(413); res.end('body too large'); return;
    }
    const params = new URLSearchParams(body);
    const user = params.get('user') || '';
    const pass = params.get('pass') || '';
    const redirectTo = params.get('r') || '/';
    if (!verifyCredentials(htpasswd, user, pass)) {
      // Small artificial delay to slow brute-forcing
      await new Promise(r => setTimeout(r, 350));
      log(`login: failed for "${user}" from ${req.socket.remoteAddress}`);
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderLoginHtml('Invalid username or password.', redirectTo));
      return;
    }
    const tok = session.sign(session.makeSession(user), SESSION_KEY);
    res.writeHead(302, {
      'Location': redirectTo,
      'Set-Cookie': session.setCookieHeader(tok),
    });
    res.end();
    log(`login: ${user} from ${req.socket.remoteAddress}`);
    return;
  }
  if (urlPathOnly === '/auth/logout') {
    res.writeHead(302, {
      'Location': '/login',
      'Set-Cookie': session.clearCookieHeader(),
    });
    res.end();
    return;
  }

  // ── Auth gate (everything past here) ──────────────────────────────────
  if (!isAuthBypassPath(urlPathOnly)) {
    if (!authedUser(req)) {
      if (req.method === 'GET') {
        // Send the user to /login with a redirect back to where they wanted
        // to go, so refresh-from-bookmark lands them on the right page.
        const r = encodeURIComponent(urlPathOnly + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''));
        res.writeHead(302, { 'Location': `/login?r=${r}` });
        res.end();
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
      }
      return;
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }

  // Static file serving — same web bundle as the Pi
  let urlPath = urlPathOnly;
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  // /monitor/<key> → serve index.html. The key check happens at the WS
  // upgrade (where real-time data starts flowing) rather than here, so the
  // page can render a clean "this firing has ended" message instead of a
  // bare 404 when an old link is opened. The browser detects the /monitor/
  // path prefix and switches into read-only mode.
  if (urlPath.startsWith('/monitor/')) urlPath = '/index.html';

  // Normalize and constrain to WEB_DIR
  const filePath = path.normalize(path.join(WEB_DIR, urlPath));
  if (!filePath.startsWith(WEB_DIR + path.sep) && filePath !== WEB_DIR) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
});

// ── Update tarball builder ─────────────────────────────────────────────
//
// Builds a tar.gz of UPDATE_SRC_DIR (the pikiln/ tree) on demand and caches it.
// We compare the cache's max source mtime against the live tree on each
// request; if anything's changed we rebuild. The tarball excludes runtime
// state and dev artifacts.

let cachedTarball = null;     // { buf, sha256, builtAt, sourceMtime }

async function getUpdateTarball() {
  const sourceMtime = await maxMtime(UPDATE_SRC_DIR);
  if (cachedTarball && cachedTarball.sourceMtime === sourceMtime) {
    return cachedTarball;
  }
  const buf = await new Promise((resolve, reject) => {
    const parent = path.dirname(UPDATE_SRC_DIR);
    const name = path.basename(UPDATE_SRC_DIR);
    execFile('tar', [
      '-czf', '-',
      '-C', parent,
      '--exclude', `${name}/data`,
      '--exclude', `${name}/node_modules`,
      '--exclude', `${name}/test`,
      '--exclude', '.git',
      '--exclude', '*.log',
      name,
    ], { maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  cachedTarball = { buf, sha256, builtAt: new Date().toISOString(), sourceMtime };
  log(`update: built tarball ${sha256.slice(0,12)} (${buf.length} bytes)`);
  return cachedTarball;
}

// ── Master schedules ───────────────────────────────────────────────────
//
// Read all schedule JSONs from MASTER_SCHEDULES_DIR and return them as
// [{title, data}], ready to send in a schedules-sync message. Files with
// missing/unparseable JSON or no title are skipped (logged once).

function readMasterSchedules() {
  if (!MASTER_SCHEDULES_DIR) return [];
  const out = [];
  let files;
  try { files = fs.readdirSync(MASTER_SCHEDULES_DIR); }
  catch (e) { log(`master: readdir failed: ${e.message}`); return []; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const fp = path.join(MASTER_SCHEDULES_DIR, f);
    try {
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (!data.title) continue;
      out.push({ title: data.title, data });
    } catch (e) {
      log(`master: skipping ${f}: ${e.message}`);
    }
  }
  return out;
}

function safeFilename(title) {
  return title.replace(/[^a-zA-Z0-9]/g, '') + '.json';
}

// Mirror an incoming firing-log message to FIRINGS_DIR. Each firing is one
// file named `<firingId>.log`. The Pi sends three message types:
//   firing-log-start    → create file with the initial header
//   firing-log-append   → append one event line (streamed live)
//   firing-log-complete → replace file with final content (summary prepended)
// On disconnect mid-firing, the file holds whatever was streamed up to that
// point — partial but useful for post-mortem analysis. On clean completion,
// the file matches the Pi's local copy byte-for-byte.
function mirrorFiringLog(type, data) {
  if (!FIRINGS_DIR || !data?.firingId) return;
  // Filename hardening: no path separators, no .. — just the basename of the
  // Pi-supplied firingId. Logger.js produces "<YYYY-MM-DD_HHMMSS>_<slug>" so
  // this normally passes through unchanged; the guard is for defense.
  const safeId = String(data.firingId).replace(/[^a-zA-Z0-9_\-]/g, '_');
  if (!safeId || safeId.startsWith('.')) {
    log(`firing-log: rejected unsafe firingId "${data.firingId}"`);
    return;
  }
  const fp = path.join(FIRINGS_DIR, safeId + '.log');
  if (type === 'firing-log-start') {
    fs.writeFileSync(fp, data.header || '');
    log(`firing-log: opened ${safeId}.log`);
  } else if (type === 'firing-log-append') {
    if (typeof data.line === 'string' && data.line.length > 0) {
      fs.appendFileSync(fp, data.line + '\n');
    }
  } else if (type === 'firing-log-complete') {
    // The Pi sends the entire final file (with SUMMARY prepended) so the
    // mirrored copy is consistent regardless of any append messages we may
    // have missed during a transient disconnect.
    const tmp = fp + '.tmp';
    fs.writeFileSync(tmp, data.content || '');
    fs.renameSync(tmp, fp);
    log(`firing-log: finalized ${safeId}.log`);
  }
}

function writeMasterSchedule(title, data) {
  if (!MASTER_SCHEDULES_DIR || !title) return;
  // Drop any existing file with the same title (possibly under a different
  // filename, e.g. seed files like BRTF6.json with title "Bartlett Fast Glaze
  // Cone 6"). This keeps the master at one-file-per-title.
  const wantName = safeFilename(title);
  for (const f of fs.readdirSync(MASTER_SCHEDULES_DIR)) {
    if (!f.endsWith('.json') || f === wantName) continue;
    const fp = path.join(MASTER_SCHEDULES_DIR, f);
    try {
      const existing = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (existing.title === title) {
        fs.unlinkSync(fp);
        log(`master: dropped duplicate ${f} (title="${title}")`);
      }
    } catch { /* ignore */ }
  }
  const fp = path.join(MASTER_SCHEDULES_DIR, wantName);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
  log(`master: wrote ${path.basename(fp)} (title="${title}")`);
}

// Normalize the master directory on startup: rename files to their
// canonical title-derived filename, dropping duplicates. Idempotent.
function normalizeMaster() {
  if (!MASTER_SCHEDULES_DIR) return;
  let files;
  try { files = fs.readdirSync(MASTER_SCHEDULES_DIR); }
  catch (e) { log(`master: normalize readdir failed: ${e.message}`); return; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const fp = path.join(MASTER_SCHEDULES_DIR, f);
    try {
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (!data.title) continue;
      const want = safeFilename(data.title);
      if (f === want) continue;
      const wantFp = path.join(MASTER_SCHEDULES_DIR, want);
      if (fs.existsSync(wantFp)) {
        fs.unlinkSync(fp);
        log(`master: normalize dropped duplicate ${f} (canonical: ${want})`);
      } else {
        fs.renameSync(fp, wantFp);
        log(`master: normalize renamed ${f} → ${want}`);
      }
    } catch { /* ignore */ }
  }
}

function deleteMasterSchedule(title) {
  if (!MASTER_SCHEDULES_DIR || !title) return;
  // Find any file whose JSON title matches — don't trust the filename
  // (the controller may have used a different filename scheme).
  let removed = false;
  for (const f of fs.readdirSync(MASTER_SCHEDULES_DIR)) {
    if (!f.endsWith('.json')) continue;
    const fp = path.join(MASTER_SCHEDULES_DIR, f);
    try {
      const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (data.title === title) {
        fs.unlinkSync(fp);
        log(`master: deleted ${f} (title="${title}")`);
        removed = true;
      }
    } catch { /* ignore */ }
  }
  if (!removed) log(`master: delete requested for "${title}" but no matching file`);
}

// Cached tarball of the master schedules directory — for /update/schedules
// endpoints used by the Pi's pre-start bootstrap.
let cachedSchedTarball = null;
async function getSchedulesTarball() {
  const mtime = await maxMtime(MASTER_SCHEDULES_DIR);
  if (cachedSchedTarball && cachedSchedTarball.sourceMtime === mtime) return cachedSchedTarball;
  const buf = await new Promise((resolve, reject) => {
    const parent = path.dirname(MASTER_SCHEDULES_DIR);
    const name = path.basename(MASTER_SCHEDULES_DIR);
    execFile('tar', ['-czf', '-', '-C', parent, name],
      { maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout) => err ? reject(err) : resolve(stdout));
  });
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  cachedSchedTarball = { buf, sha256, builtAt: new Date().toISOString(), sourceMtime: mtime };
  log(`schedules tarball built: ${sha256.slice(0,12)} (${buf.length} bytes)`);
  return cachedSchedTarball;
}

async function maxMtime(dir) {
  // Cheap recursive walk; the pikiln tree is small (~hundreds of files).
  let max = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === 'data' || e.name === '.git') continue;
      const full = path.join(d, e.name);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs > max) max = st.mtimeMs;
        if (e.isDirectory()) stack.push(full);
      } catch { /* ignore */ }
    }
  }
  return max;
}

// ── Pushover ───────────────────────────────────────────────────────────
//
// POST to api.pushover.net using the app token matching the requested priority.
// Three "apps" let the phone differentiate info / warn / error sounds.
// If any key is missing or PUSHOVER_USER is unset, we silently no-op so the
// controller doesn't need to know whether keys are configured.

const PUSHOVER_TOKENS = { info: PUSHOVER_INFO, warn: PUSHOVER_WARN, error: PUSHOVER_ERROR };

async function sendPushover(priority, title, message) {
  const appToken = PUSHOVER_TOKENS[priority] || PUSHOVER_INFO;
  if (!PUSHOVER_USER || !appToken) {
    log(`pushover: skipping (${priority}) — no keys configured`);
    return;
  }
  const body = new URLSearchParams({
    token: appToken,
    user: PUSHOVER_USER,
    title: title.slice(0, 250),
    message: message.slice(0, 1024),
  }).toString();
  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  log(`pushover (${priority}): "${title}" — ${message.slice(0, 60)}`);
}

// ── WebSocket ──────────────────────────────────────────────────────────
//
// One WSS, two paths. We do the upgrade ourselves so we can dispatch by
// pathname to two different handlers without spinning up two servers.

const controllerWss = new WebSocketServer({ noServer: true });
const viewerWss     = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const urlPath = req.url.split('?')[0];

  if (urlPath === '/controller') {
    // Controller WS auth-gated at the application layer (identify + token).
    controllerWss.handleUpgrade(req, socket, head, (ws) => {
      controllerWss.emit('connection', ws, req);
    });
  } else if (urlPath === '/' || urlPath === '/viewer') {
    // Viewer WS: same session cookie as the HTML page. Browsers send the
    // cookie on the upgrade request automatically. Reject if missing/invalid.
    if (!authedUser(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    viewerWss.handleUpgrade(req, socket, head, (ws) => {
      viewerWss.emit('connection', ws, req);
    });
  } else if (urlPath === '/monitor-ws') {
    // Read-only viewer gated by the per-firing share key. The key arrives in
    // the query string; we accept the upgrade only if it matches the active
    // firing's key. No cookie required — this is the whole point of the
    // share link. The monitor connection joins monitorViewers (read-only)
    // rather than the regular viewers set, and its inbound messages are
    // dropped (no commands).
    const qs = new URL(req.url, 'http://x').searchParams;
    const key = qs.get('key') || '';
    if (!currentMonitorKey || key !== currentMonitorKey) {
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    viewerWss.handleUpgrade(req, socket, head, (ws) => {
      ws._monitorViewer = true;     // marker — connection handler reads this
      viewerWss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ── Controller (the Pi) ─────────────────────────────────────────────────

controllerWss.on('connection', (ws, req) => {
  // The controller must send
  //   {type:"identify", client:"controller", token:"...", role:"real"|"sim"}
  // as its first message within a few seconds, or we drop it. `role` defaults
  // to "real" if omitted (backwards-compat with the existing Pi code).
  let authed = false;
  let role = null;
  const authTimer = setTimeout(() => {
    if (!authed) {
      log('controller: identify timeout, closing');
      try { ws.close(CLOSE_UNAUTHORIZED, 'identify timeout'); } catch {}
    }
  }, 5000);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch {
      ws.send(JSON.stringify({ type: 'response', action: 'error', message: 'Invalid JSON' }));
      return;
    }

    if (!authed) {
      if (msg.type === 'identify' && msg.client === 'controller' && msg.token === TOKEN) {
        role = msg.role === 'sim' ? 'sim' : 'real';

        // Priority logic: real outranks sim. A sim trying to take over while
        // a real controller is active gets told to yield; it'll back off and
        // retry. Anything else supersedes the current holder.
        if (controllerWs && controllerWs !== ws && controllerWs.readyState === WebSocket.OPEN) {
          if (role === 'sim' && controllerRole === 'real') {
            log(`controller: rejecting sim (real Pi is active)`);
            try { ws.send(JSON.stringify({ type: 'rejected', reason: 'real-controller-active' })); } catch {}
            try { ws.close(CLOSE_YIELD_TO_REAL, 'real controller is active'); } catch {}
            return;
          }
          log(`controller: ${controllerRole} → ${role} (superseding previous)`);
          try { controllerWs.close(CLOSE_SUPERSEDED, 'superseded'); } catch {}
        }
        authed = true;
        clearTimeout(authTimer);
        controllerWs = ws;
        controllerRole = role;
        controllerSince = new Date().toISOString();
        log(`controller (${role}): connected (${req.socket.remoteAddress})`);

        ws.send(JSON.stringify({ type: 'identified', role: 'controller', controllerRole: role }));
        // Push the master schedule set to the freshly-connected controller so
        // it can reconcile its local data/schedules/ before any commands flow.
        if (MASTER_SCHEDULES_DIR) {
          try {
            const schedules = readMasterSchedules();
            ws.send(JSON.stringify({ type: 'schedules-sync', schedules }));
            log(`controller (${role}): pushed ${schedules.length} schedules`);
          } catch (e) {
            log(`controller (${role}): schedules-sync failed: ${e.message}`);
          }
        }
        // Let viewers know the controller is back, with the role so the UI
        // can show "simulation" vs "live" without guessing.
        broadcastToViewers(JSON.stringify({
          type: 'relay', event: 'controller-connected', controllerRole: role,
        }));
        return;
      }
      log(`controller: bad identify from ${req.socket.remoteAddress}, closing`);
      try { ws.close(CLOSE_UNAUTHORIZED, 'unauthorized'); } catch {}
      return;
    }

    // Authed: most messages from the controller are forwarded verbatim to
    // viewers. Schedule mutations mirror to the master directory; pushover
    // messages get POSTed to api.pushover.net using keys from .env.
    if (msg.type === 'schedule-update') {
      try { writeMasterSchedule(msg.title, msg.data); }
      catch (e) { log(`master: write failed for "${msg.title}": ${e.message}`); }
      return; // not forwarded to viewers — they get the controller's broadcast separately
    }
    if (msg.type === 'schedule-deleted') {
      try { deleteMasterSchedule(msg.title); }
      catch (e) { log(`master: delete failed for "${msg.title}": ${e.message}`); }
      return;
    }
    if (msg.type === 'pushover') {
      sendPushover(msg.priority || 'info', msg.title || 'PiKiln', msg.message || '')
        .catch(e => log(`pushover: ${e.message}`));
      return;
    }
    if (msg.type === 'firing-log-start' || msg.type === 'firing-log-append' ||
        msg.type === 'firing-log-complete') {
      try { mirrorFiringLog(msg.type, msg.data); }
      catch (e) { log(`firing-log mirror: ${e.message}`); }
      // Forward to viewers too so the UI can show the active-firing badge,
      // append lines to a live LogViewer, etc.
      broadcastToViewers(raw.toString());
      return;
    }
    // Stash log/message frames in the ring buffer so newly-connecting
    // viewers see recent context. State messages aren't buffered (lastState
    // handles that); commands and pushovers aren't buffered (no viewer
    // value).
    if (msg.type === 'log' || msg.type === 'message') {
      logBuffer.push(raw.toString());
      if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
    }
    if (msg.type === 'state') {
      lastState = raw.toString();
      // Track the per-firing share key. The Pi sets it on kiln.start() and
      // clears it on stop/cool-down-complete. A null key disables /monitor
      // access; a value rotation invalidates the previous firing's link.
      const newKey = (msg.data && typeof msg.data.monitorKey === 'string')
        ? msg.data.monitorKey
        : null;
      if (newKey !== currentMonitorKey) {
        log(`monitor key: ${currentMonitorKey ? 'rotated' : 'set'} (${newKey ? newKey.slice(0, 8) + '…' : 'cleared'})`);
        currentMonitorKey = newKey;
        // Drop any monitor connections that no longer match. If newKey is
        // non-null they were on the previous firing's key; if null the
        // firing just ended. Either way they should reconnect to learn
        // the new state.
        for (const c of monitorViewers) {
          try { c.close(1000, 'monitor key rotated'); } catch {}
        }
      }
    }
    broadcastToViewers(raw.toString());
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (controllerWs === ws) {
      controllerWs = null;
      controllerRole = null;
      controllerSince = null;
      log(`controller (${role}): disconnected`);
      broadcastToViewers(JSON.stringify({ type: 'relay', event: 'controller-disconnected' }));
    }
  });

  ws.on('error', (err) => {
    log(`controller: error ${err.message}`);
  });
});

// ── Viewers (browsers, gated by Traefik basicauth at the edge) ─────────

viewerWss.on('connection', (ws, req) => {
  const isMonitor = ws._monitorViewer === true;
  if (isMonitor) {
    monitorViewers.add(ws);
    log(`monitor viewer: connected (${req.socket.remoteAddress}, ${monitorViewers.size} now)`);
  } else {
    viewers.add(ws);
    viewerCount++;
    log(`viewer: connected (${req.socket.remoteAddress}, ${viewers.size} now)`);
  }

  // Hand the new browser the last-known state immediately so the UI
  // populates without waiting for the next 5-second broadcast.
  if (lastState) {
    try { ws.send(lastState); } catch {}
  }
  // Replay buffered log/message frames so the viewer sees recent context
  // (especially important after a Pi reboot — the recovery log lines and
  // any post-reboot ring updates that landed before this viewer connected
  // would otherwise be lost). Capped at LOG_BUFFER_SIZE on the producer
  // side.
  for (const frame of logBuffer) {
    try { ws.send(frame); } catch {}
  }
  // Tell the viewer whether the controller is currently connected
  ws.send(JSON.stringify({
    type: 'relay',
    event: controllerWs ? 'controller-connected' : 'controller-disconnected',
  }));

  ws.on('message', (raw) => {
    // Monitor viewers are read-only — silently drop everything they send.
    // (Their UI hides the buttons anyway, but a manually-crafted command
    // shouldn't slip through.)
    if (isMonitor) return;

    // Browsers send commands — forward to the Pi if we have one.
    let msg;
    try { msg = JSON.parse(raw); } catch {
      ws.send(JSON.stringify({ type: 'response', action: 'error', message: 'Invalid JSON' }));
      return;
    }
    if (msg.type !== 'command') {
      // Browsers shouldn't be sending anything else; ignore.
      return;
    }
    if (!controllerWs || controllerWs.readyState !== WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'response', action: msg.action,
        message: 'Kiln controller is not connected',
      }));
      return;
    }
    try {
      controllerWs.send(raw.toString());
    } catch (e) {
      ws.send(JSON.stringify({
        type: 'response', action: 'error',
        message: `Forward failed: ${e.message}`,
      }));
    }
  });

  ws.on('close', () => {
    if (isMonitor) {
      monitorViewers.delete(ws);
      log(`monitor viewer: disconnected (${monitorViewers.size} left)`);
    } else {
      viewers.delete(ws);
      log(`viewer: disconnected (${viewers.size} left)`);
    }
  });

  ws.on('error', () => { /* close handler will fire */ });
});

// ── Lifecycle ──────────────────────────────────────────────────────────

normalizeMaster();

httpServer.listen(PORT, () => {
  log(`PiKiln relay listening on :${PORT}`);
  log(`  controller WS: /controller  (token-authed)`);
  log(`  update API:    /update/*    (Bearer token)`);
  log(`  viewer WS:     /            (cookie auth, via /login)`);
  log(`  login:         /login       (htpasswd from ${HTPASSWD_FILE}, ${htpasswd.size} user(s))`);
  log(`  health:        /health      (public)`);
  log(`  web dir:       ${WEB_DIR}`);
  if (MASTER_SCHEDULES_DIR) log(`  master schedules: ${MASTER_SCHEDULES_DIR}`);
});

function shutdown(sig) {
  log(`${sig} received, shutting down`);
  try { controllerWs && controllerWs.close(1001, 'relay shutting down'); } catch {}
  for (const ws of viewers) { try { ws.close(1001, 'relay shutting down'); } catch {} }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
