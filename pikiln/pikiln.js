'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { Kiln } = require('./lib/kiln');
const { Schedule } = require('./lib/schedule');
const { Logger } = require('./lib/logger');
const { PerfLog } = require('./lib/perf-log');

// ── Config ──────────────────────────────────────────────────────────────

const DATA_DIR = process.env.PIKILN_DATA_DIR || path.join(__dirname, 'data');
const SCHEDULES_DIR = path.join(DATA_DIR, 'schedules');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const PERF_DIR = path.join(DATA_DIR, 'perf');
// Per-firing logs: one file per firing run with summary + notes header, kept
// alongside the daily system logs but in their own directory so retention
// policy can differ (firing logs are mirrored to the VPS, see relay-server.js,
// and never deleted locally).
const FIRINGS_DIR = path.join(DATA_DIR, 'firings');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
// Touched while a schedule is running. The Pi-side update script reads this
// to refuse updates mid-firing.
const FIRING_LOCK = path.join(DATA_DIR, '.firing.lock');

function loadConfig() {
  const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8'));
  let user = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch { /* use defaults */ }
  return deepMerge(defaults, user);
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
        target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function saveUserConfig(config) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ── Setup ───────────────────────────────────────────────────────────────

fs.mkdirSync(SCHEDULES_DIR, { recursive: true });
fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(PERF_DIR, { recursive: true });
fs.mkdirSync(FIRINGS_DIR, { recursive: true });

// Seed schedules from the shipped seed-schedules/ directory on first run.
// Same marker-file semantics as pi/pikiln-update.sh: gated by .schedules-seeded
// so user edits/deletions persist across restarts, and to force a re-seed you
// delete the marker. Lets the VPS sim container (which doesn't run the
// bootstrap script) populate its initial set the same way the Pi does.
(() => {
  const marker = path.join(DATA_DIR, '.schedules-seeded');
  const seedDir = path.join(__dirname, 'seed-schedules');
  if (fs.existsSync(marker) || !fs.existsSync(seedDir)) return;
  let n = 0;
  for (const f of fs.readdirSync(seedDir)) {
    if (!f.endsWith('.json')) continue;
    const dst = path.join(SCHEDULES_DIR, f);
    if (fs.existsSync(dst)) continue;
    fs.copyFileSync(path.join(seedDir, f), dst);
    n++;
  }
  fs.writeFileSync(marker, new Date().toISOString());
  if (n > 0) console.log(`Seeded ${n} schedule(s) from ${seedDir}`);
})();

const config = loadConfig();
const logger = new Logger(LOGS_DIR, FIRINGS_DIR);
const perfLog = new PerfLog(PERF_DIR);    // never rotated — see lib/perf-log.js
const kiln = new Kiln(config, logger, perfLog);

// Bounded retention for the *system* log only (perf-log is kept forever).
// Default 60 days, override via config.logs.retentionDays. <=0 disables cleanup.
function cleanupSystemLogs() {
  const days = config.logs?.retentionDays ?? 60;
  if (days <= 0) return;
  const cutoff = Date.now() - days * 86400 * 1000;
  for (const f of fs.readdirSync(LOGS_DIR)) {
    if (!/^\d{8}\.log$/.test(f)) continue;
    const full = path.join(LOGS_DIR, f);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.unlinkSync(full);
        logger.log(`Cleaned up old system log: ${f}`);
      }
    } catch { /* ignore */ }
  }
}
cleanupSystemLogs();
setInterval(cleanupSystemLogs, 24 * 3600 * 1000).unref();

// ── Bootstrap script self-update ───────────────────────────────────────
//
// `pikiln-update.sh` and `pikiln-launch.sh` live at `/opt/pikiln/bin/` and
// are installed ONCE by pi/install.sh during the original bootstrap. The
// relay's update tarball ships pikiln.js + lib + web, but NOT these scripts
// — so fixes to them (e.g. the stale-firing.lock check we just discovered
// breaks every reboot-during-firing) can't reach the Pi without console or
// SSH access.
//
// To close that gap, the tarball now also ships canonical copies of these
// scripts under `pikiln/bin/`. On every start, we compare each one against
// the installed copy at /opt/pikiln/bin/<name>; if they differ, we copy
// the new content over (preserving the 0755 exec bit). The next service
// restart will then run the updated script.
//
// Failure modes are deliberately quiet — bootstrap-script update is a
// nice-to-have, not safety-critical, and we never want a permission glitch
// to keep the kiln from starting.
(function selfBootstrapScripts() {
  // Resolved path of the install dir: /opt/pikiln/bin (or sibling if we're
  // running out of a non-standard layout). __dirname is the release dir
  // (e.g. /opt/pikiln/releases/<id>); installed scripts live at
  // /opt/pikiln/bin which is two levels up + /bin.
  const releaseDir = __dirname;
  const sourceBinDir = path.join(releaseDir, 'bin');
  if (!fs.existsSync(sourceBinDir)) return;  // older bundle without bin/

  // /opt/pikiln/bin — try to detect it relative to releases/<id>
  const pikilnHome = path.resolve(releaseDir, '..', '..');
  const targetBinDir = path.join(pikilnHome, 'bin');
  if (!fs.existsSync(targetBinDir)) return;  // not the production layout

  const scripts = ['pikiln-update.sh', 'pikiln-launch.sh'];
  for (const name of scripts) {
    const src = path.join(sourceBinDir, name);
    if (!fs.existsSync(src)) continue;
    // /opt/pikiln/bin/pikiln-update (no .sh — install.sh renames on copy)
    const installedName = name.replace(/\.sh$/, '');
    const dst = path.join(targetBinDir, installedName);

    try {
      const srcContent = fs.readFileSync(src);
      const dstContent = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
      if (dstContent && srcContent.equals(dstContent)) continue;

      // Atomic-ish replace: write to .new then rename. Preserves the
      // executable bit (0755). If we can't write — likely a permissions
      // issue (we're not running as root, or the dir is read-only) — log
      // and move on; pikiln itself still starts normally.
      const tmp = dst + '.new';
      fs.writeFileSync(tmp, srcContent, { mode: 0o755 });
      fs.renameSync(tmp, dst);
      logger.log(`Bootstrap script updated: ${installedName} (takes effect on next service restart)`);
    } catch (e) {
      logger.log(`Bootstrap script update for ${installedName} failed: ${e.message}`);
    }
  }
})();

// Load schedules
let schedules = Schedule.loadAll(SCHEDULES_DIR);
let userConfig = {};
try {
  if (fs.existsSync(CONFIG_FILE)) {
    userConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
} catch { /* ignore */ }

logger.log(`PiKiln starting${kiln.simulation ? ' (SIMULATION MODE)' : ''}`);
logger.log(`Loaded ${schedules.size} schedule(s)`);

// ── Outage-recovery state ──────────────────────────────────────────────
//
// We persist `firing-state.json` once every ~5 seconds during a firing so
// that if power is lost and the Pi reboots, we can decide whether to
// auto-resume. The `firing.lock` file (the update bootstrap also watches it)
// is our crash signal: present on entry == previous run was killed mid-firing.
//
// Decision rules:
//   - max sensor reading > PIKILN_MIN_WARM_TEMP_F (default 200°F)
//       → kiln was definitely hot, auto-resume immediately, Pushover
//   - kiln cool or no sensor reading
//       → leave idle, surface `pendingRecovery` in state so the UI banner
//         can prompt for [Resume] / [Abort]
// PIKILN_MAX_OUTAGE_SECONDS (default 300s) sets the boundary between an
// info Pushover ("quick recovery") and a warn Pushover ("long outage, check
// ware for thermal stress").

const FIRING_STATE_FILE = path.join(DATA_DIR, 'firing-state.json');
const MAX_OUTAGE_SECONDS = parseInt(process.env.PIKILN_MAX_OUTAGE_SECONDS || '300', 10);
const MIN_WARM_TEMP_F = parseInt(process.env.PIKILN_MIN_WARM_TEMP_F || '200', 10);

// Pending recovery: set when we detect a crash but can't auto-resume. The UI
// reads it from state to show a banner; recoveryResume / recoveryAbort commands
// clear it.
let pendingRecovery = null;

// Read-only monitor share key. Generated at startup; rotated on demand via
// the Settings-tab refresh button (rotateMonitorKey command). Until rotated
// the URL is stable, so the operator can share it once and the recipient
// can keep the page open across multiple firings. Rotating it invalidates
// the old link immediately (the relay drops any monitor connections that
// no longer match). Operator auth (htpasswd cookie) is what gates control;
// the monitor URL grants read-only access without a login so it's safely
// shareable.
let monitorKey = crypto.randomBytes(8).toString('hex');

// On startup, read the firing-state and firing.lock BEFORE clearing them.
// Their presence is the crash signal we use for recovery.
const crashSignal = (() => {
  const lockPresent = fs.existsSync(FIRING_LOCK);
  let state = null;
  try {
    const raw = fs.readFileSync(FIRING_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.version === 1) state = parsed;
  } catch { /* no state file, or unreadable */ }
  return { lockPresent, state };
})();

// Now safe to clear the lock; we'll set a fresh one if we auto-resume.
try { fs.unlinkSync(FIRING_LOCK); } catch { /* didn't exist */ }

kiln.on('firing-state-change', (firing) => {
  try {
    if (firing) fs.writeFileSync(FIRING_LOCK, String(process.pid));
    else fs.unlinkSync(FIRING_LOCK);
  } catch { /* best-effort; safety is in the launcher */ }
});

// ── Firing-state persistence ────────────────────────────────────────────

// Async to avoid blocking the heartbeat. SD-card sync stalls can be multi-
// second and used to trip the safety watchdog (e-stop "heartbeat timeout —
// control loop stalled" mid-cool-down, with no element firing happening).
// `_writingFiringState` debounces concurrent calls (the 5-Hz heartbeat
// broadcaster fires this every 5 beats; we shouldn't pile up writes if
// the previous one hasn't finished). Atomic-ish via tmp+rename so a crash
// mid-write doesn't leave a half-written firing-state.json.
let _writingFiringState = false;
function writeFiringState() {
  if (kiln.mode !== 'running' && kiln.mode !== 'cooling') return;
  if (_writingFiringState) return;
  _writingFiringState = true;
  const s = kiln.schedule;
  const state = {
    version: 1,
    schedule: s?.metadata?.title || null,
    mode: kiln.mode,
    holdState: kiln.holdState,
    fanMode: kiln.fanMode,
    currentSegment: s?.currentSegment ?? 0,
    segmentStartTime: s?._segmentStartTime ?? 0,
    startTime: s?._startTime ?? 0,
    startTempC: s?._startTempC ?? null,
    maxTempC: kiln._currentMaxTempC(),
    ts: new Date().toISOString(),
  };
  const tmp = FIRING_STATE_FILE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(state), (err) => {
    if (err) {
      _writingFiringState = false;
      console.error(`[firing-state] write failed: ${err.message}`);
      return;
    }
    fs.rename(tmp, FIRING_STATE_FILE, (err2) => {
      _writingFiringState = false;
      if (err2) console.error(`[firing-state] rename failed: ${err2.message}`);
    });
  });
}

function clearFiringState() {
  try { fs.unlinkSync(FIRING_STATE_FILE); } catch { /* didn't exist */ }
}

kiln.on('stopped', clearFiringState);
kiln.on('cool-down-complete', clearFiringState);

// Load last-used schedule
const recentTitle = userConfig.recents?.scheduleTitle;
if (recentTitle && schedules.has(recentTitle)) {
  const sched = schedules.get(recentTitle);
  sched.logger = logger;
  kiln.schedule = sched;
  logger.log(`Loaded recent schedule: "${recentTitle}"`);
}

// ── HTTP Server ─────────────────────────────────────────────────────────

const WEB_DIR = path.join(__dirname, 'web');
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API endpoints
  if (req.method === 'GET' && req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(kiln.getStatus()));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/schedules') {
    const list = Array.from(schedules.keys());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  const schedMatch = req.url.match(/^\/api\/schedule\/(.+)$/);
  if (req.method === 'GET' && schedMatch) {
    const title = decodeURIComponent(schedMatch[1]);
    const sched = schedules.get(title);
    if (sched) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(sched.asJSON());
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Schedule not found' }));
    }
    return;
  }

  // Static file serving
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(WEB_DIR, filePath);

  // Security: prevent path traversal
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// ── WebSocket Server ────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

// Push current kiln state to every client we know about: LAN browsers via the
// local WS server, plus the relay (which fans it out to remote browsers).
// Used by every command handler that mutates state, and by the lifecycle
// event handlers below. The heartbeat broadcaster has its own throttled
// version (1-in-5) and stays separate to avoid flooding viewers.
function currentStatus() {
  // Pull live kiln state and decorate with user-config bits the UI needs to
  // render the controls (e.g. the progress-notifications toggle) and the
  // recovery banner.
  const s = kiln.getStatus();
  s.notifications = userConfig.notifications || { progress: true };
  s.pendingRecovery = pendingRecovery;
  // Read-only share key for the current firing — present whenever a firing
  // is active, null otherwise. The operator's UI renders this as a copy-
  // able link the relay can validate without a login.
  s.monitorKey = monitorKey;
  // Persistent firing notes (operator-editable in the Run tab). Baked into
  // the firing log header on kiln.start(); see logger.startFiring.
  s.firingNotes = userConfig.firingNotes || '';
  // Active firing log metadata — null when idle. Useful for the UI to show
  // "currently logging to firings/<file>.log" status.
  s.activeFiring = logger.activeFiring ? {
    firingId: logger.activeFiring.firingId,
    startedAt: logger.activeFiring.meta?.startedAt,
    title: logger.activeFiring.meta?.title,
  } : null;
  // Pin assignments — exposed so the Tests-tab debug panel can show them
  // alongside the manual-toggle controls.
  s.gpioConfig = {
    heat:     require('./lib/constants').GPIO_HEAT,
    ventFan:  require('./lib/constants').GPIO_VENT_FAN,
    spiClock: require('./lib/constants').GPIO_SPI_CLOCK,
    spiData:  require('./lib/constants').GPIO_SPI_DATA,
    spiCs:    require('./lib/constants').GPIO_SPI_CS,
  };
  // Physical position label per ring index (0..2). UI uses to render the
  // temperature tiles with bottom/mid/top labels in physical-stack order.
  s.ringPositionLabels = require('./lib/constants').RING_POSITION_LABELS;
  return s;
}

function broadcastState(extra) {
  const status = currentStatus();
  const payload = { type: 'state', data: status, ...(extra || {}) };
  const json = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(json);
  }
  if (relaySend) relaySend(payload);
}

wss.on('connection', (ws) => {
  // Send current state immediately
  ws.send(JSON.stringify({ type: 'state', data: currentStatus() }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: 'response', action: 'error', message: 'Invalid JSON' }));
      return;
    }

    if (msg.type === 'command') {
      handleCommand(msg, ws);
    }
  });

  ws.on('error', (err) => {
    logger.error(`WebSocket error: ${err.message}`);
  });
});

function handleCommand(msg, ws) {
  const { action, params } = msg;
  const respond = (data) => {
    ws.send(JSON.stringify({ type: 'response', action, data }));
  };
  const respondError = (message) => {
    ws.send(JSON.stringify({ type: 'response', action: 'error', message }));
  };

  try {
    switch (action) {
      case 'start':
        // An explicit Start is an implicit dismissal of any pending recovery
        // prompt — the operator has chosen to start fresh rather than resume.
        // Also wipe the stale firing-state.json (the post-resume kiln.start()
        // would overwrite it on the next heartbeat anyway, but clearing here
        // makes the "no crash signal" state consistent if start() throws).
        if (pendingRecovery) {
          logger.log(`Dismissing pending recovery (operator started fresh): ${pendingRecovery.reason}`);
          pendingRecovery = null;
          clearFiringState();
        }
        kiln.start();
        respond({ ok: true });
        break;

      case 'stop':
        kiln.stop();
        respond({ ok: true });
        break;

      case 'setLoadKg': {
        // Operator-specified kiln load in kg (ware + furniture). Adds to the
        // bare-brick m·c so time-to-cool, max-fire-rate, and the sim's
        // thermal evolution all reflect the actual chamber mass. Persisted
        // in userConfig so the setting survives restarts.
        const kg = Number(params?.kg);
        if (!Number.isFinite(kg) || kg < 0 || kg > 100) {
          respondError('loadKg must be a number between 0 and 100');
          return;
        }
        kiln.setLoadKg(kg);
        userConfig.loadKg = kiln._loadKg;
        saveUserConfig(userConfig);
        respond({ ok: true, loadKg: kiln._loadKg });
        broadcastState();
        break;
      }

      case 'setFanBalanceThresholds': {
        // Operator slider input from the Controls tab. We accept partial
        // updates (either field optional) and let the kiln clamp the values
        // (ON > OFF, both within sane bounds). Persisted in userConfig so
        // the next firing starts with the operator's chosen values.
        const onF  = params?.onF;
        const offF = params?.offF;
        kiln.setFanBalanceThresholds({ onF, offF });
        if (!userConfig.fanBalance) userConfig.fanBalance = {};
        userConfig.fanBalance.onF  = kiln._fanBalance.onF;
        userConfig.fanBalance.offF = kiln._fanBalance.offF;
        saveUserConfig(userConfig);
        respond({ ok: true, fanBalance: { ...kiln._fanBalance } });
        broadcastState();
        break;
      }

      case 'setFanMode':
        if (!params || !['off', 'auto', 'on', 'balance'].includes(params.mode)) {
          respondError('Invalid fan mode');
          return;
        }
        // kiln.setFanMode mutates state AND immediately applies it to the
        // relay. The old "just assign kiln.fanMode" never moved the relay
        // when the kiln was idle/cooling, so off/on/auto buttons appeared
        // dead from the Run tab.
        try { kiln.setFanMode(params.mode); }
        catch (e) { respondError(e.message); return; }
        respond({ ok: true, fanMode: params.mode });
        broadcastState();
        break;

      case 'hold':
        try {
          kiln.hold();
          respond({ ok: true, holdState: kiln.holdState });
          broadcastState();
          sendPushover('info', 'PiKiln', `Holding at ${(kiln._holdTargetC * 9/5 + 32).toFixed(0)}°F`);
        } catch (e) { respondError(e.message); }
        break;

      case 'pause':
        try {
          kiln.pause();
          respond({ ok: true, holdState: kiln.holdState });
          broadcastState();
          sendPushover('info', 'PiKiln', 'Firing paused');
        } catch (e) { respondError(e.message); }
        break;

      case 'resume':
        try {
          const prev = kiln.holdState;
          kiln.resume();
          respond({ ok: true });
          broadcastState();
          sendPushover('info', 'PiKiln', `Resumed (was ${prev})`);
        } catch (e) { respondError(e.message); }
        break;

      case 'rotateMonitorKey': {
        // Generate a fresh read-only share key and broadcast. The relay
        // notices the change in the next state frame, drops monitor
        // connections that no longer match, and starts validating new
        // /monitor-ws requests against the new key.
        monitorKey = crypto.randomBytes(8).toString('hex');
        logger.log(`Monitor share key rotated`);
        respond({ ok: true, monitorKey });
        broadcastState();
        break;
      }

      case 'setNotifications':
        if (!params || typeof params.progress !== 'boolean') {
          respondError('Missing progress boolean');
          return;
        }
        if (!userConfig.notifications) userConfig.notifications = {};
        userConfig.notifications.progress = params.progress;
        saveUserConfig(userConfig);
        respond({ ok: true, notifications: userConfig.notifications });
        broadcastState();
        break;

      case 'setDiagnosticMode': {
        // Tests-tab toggle. Disables every software fault filter so the
        // operator can see EMI/wiring issues directly during cap/ferrite
        // tuning. NOT persisted — defaults to off on every restart so we
        // don't accidentally leave the kiln running with all safeties
        // softened. The kiln logs the transition for the firing record.
        const enabled = !!params?.enabled;
        kiln.setDiagnosticMode(enabled);
        respond({ ok: true, diagnosticMode: enabled });
        broadcastState();
        break;
      }

      case 'setFiringNotes': {
        // Persistent across restarts; captured into the next firing's log
        // header at kiln.start(). Mid-firing edits don't update the active
        // log — they take effect on the next start.
        const notes = typeof params?.notes === 'string' ? params.notes : '';
        userConfig.firingNotes = notes;
        saveUserConfig(userConfig);
        respond({ ok: true, firingNotes: notes });
        broadcastState();
        break;
      }

      case 'addFiringNote': {
        // Append an annotation to the active firing log inline (as an event
        // line). Used for "the kiln smelled funny at this point" mid-run
        // notes that should be timestamped where they happened.
        const text = typeof params?.text === 'string' ? params.text.trim() : '';
        if (!text) { respondError('note text required'); return; }
        logger.addNote(text);
        respond({ ok: true });
        break;
      }

      case 'recoveryResume': {
        if (!pendingRecovery) { respondError('Nothing to recover'); return; }
        const title = pendingRecovery.savedSchedule;
        if (!title || !schedules.has(title)) {
          respondError(`Saved schedule "${title}" no longer available`);
          return;
        }
        const sched = schedules.get(title);
        sched.logger = logger;
        kiln.schedule = sched;
        try {
          kiln.start();  // resume-from-current-temp picks the right segment
          const cleared = pendingRecovery;
          pendingRecovery = null;
          respond({ ok: true });
          broadcastState();
          sendPushover('info', 'PiKiln',
            `Manual recovery: resumed "${title}" (kiln at ${cleared.maxTempF?.toFixed(0) ?? '?'}°F)`);
        } catch (e) { respondError(e.message); }
        break;
      }

      case 'simResetTemps': {
        if (!kiln.simulation) { respondError('Only available in simulation mode'); return; }
        const ambientC = (kiln._config?.ambient ?? 21);
        for (const s of kiln.tempSensors) {
          s.simulatedTempC = ambientC;
          s._lastReadingC = ambientC;
        }
        logger.log(`Sim temps reset to ambient (${(ambientC * 9/5 + 32).toFixed(0)}°F)`);
        respond({ ok: true });
        broadcastState();
        break;
      }

      // ── Hardware bring-up debug commands ─────────────────────────────
      // All refuse while running (no chance of disturbing a firing). They
      // hit the GPIO directly via the gpio-provider, bypassing the relay/
      // schedule abstractions — useful when you suspect the pin assignments
      // themselves are wrong.
      case 'debugGpioWrite': {
        if (kiln.mode === 'running') { respondError('Refusing during firing'); return; }
        const pin = Number(params?.pin);
        const level = !!params?.level;
        if (!Number.isFinite(pin) || pin < 0 || pin > 53) { respondError('Pin 0..53 required'); return; }
        try {
          const r = kiln._gpioProvider.debugWrite(pin, level);
          logger.log(`debug: write GPIO ${pin} = ${level ? 1 : 0}`);
          respond(r);
        } catch (e) { respondError(e.message); }
        break;
      }
      case 'debugGpioPulse': {
        if (kiln.mode === 'running') { respondError('Refusing during firing'); return; }
        const pin = Number(params?.pin);
        const durationMs = Number(params?.durationMs) || 500;
        if (!Number.isFinite(pin) || pin < 0 || pin > 53) { respondError('Pin 0..53 required'); return; }
        logger.log(`debug: pulse GPIO ${pin} HIGH for ${durationMs}ms`);
        kiln._gpioProvider.debugPulse(pin, durationMs)
          .then(r => respond(r))
          .catch(e => respondError(e.message));
        break;
      }
      case 'debugGpioSweep': {
        if (kiln.mode === 'running') { respondError('Refusing during firing'); return; }
        const startPin = Number(params?.startPin ?? 2);
        const endPin   = Number(params?.endPin   ?? 27);
        const durationMs = Number(params?.durationMs) || 400;
        const gapMs      = Number(params?.gapMs)      || 200;
        logger.log(`debug: sweep GPIO ${startPin}..${endPin} (${durationMs}ms on, ${gapMs}ms off)`);
        kiln._gpioProvider.debugSweep(startPin, endPin, durationMs, gapMs)
          .then(r => respond(r))
          .catch(e => respondError(e.message));
        break;
      }
      case 'debugSpiRead': {
        if (kiln.mode === 'running') { respondError('Refusing during firing'); return; }
        const clockPin = Number(params?.clockPin);
        const dataPin  = Number(params?.dataPin);
        const csPin    = Number(params?.csPin);
        if (![clockPin, dataPin, csPin].every(n => Number.isFinite(n) && n >= 0 && n <= 53)) {
          respondError('clockPin/dataPin/csPin (0..53) required');
          return;
        }
        kiln._gpioProvider.debugSpiRead(clockPin, dataPin, csPin)
          .then(r => {
            logger.log(`debug: SPI read clk=${clockPin} data=${dataPin} cs=${csPin} → 0x${r.hex}`);
            respond(r);
          })
          .catch(e => respondError(e.message));
        break;
      }

      case 'simSetTemp': {
        if (!kiln.simulation) { respondError('Only available in simulation mode'); return; }
        const tempF = Number(params?.tempF);
        if (!Number.isFinite(tempF) || tempF < -40 || tempF > 2500) {
          respondError('Invalid tempF (expected number between -40 and 2500)');
          return;
        }
        const tempC = (tempF - 32) * 5 / 9;
        for (const s of kiln.tempSensors) {
          s.simulatedTempC = tempC;
          s._lastReadingC = tempC;
        }
        logger.log(`Sim temps set to ${tempF.toFixed(0)}°F`);
        respond({ ok: true, tempF });
        broadcastState();
        break;
      }

      case 'recoveryAbort': {
        if (!pendingRecovery) { respondError('Nothing to recover'); return; }
        const cleared = pendingRecovery;
        pendingRecovery = null;
        clearFiringState();
        try { fs.unlinkSync(FIRING_LOCK); } catch {}
        respond({ ok: true });
        broadcastState();
        sendPushover('info', 'PiKiln',
          `Manual recovery: aborted previous firing "${cleared.savedSchedule}"`);
        break;
      }

      case 'getScheduleList':
        respond(Array.from(schedules.keys()));
        break;

      case 'getSchedule': {
        const sched = schedules.get(params?.title);
        if (sched) respond(JSON.parse(sched.asJSON()));
        else respondError(`Schedule "${params?.title}" not found`);
        break;
      }

      case 'loadSchedule': {
        const sched = schedules.get(params?.title);
        if (!sched) {
          respondError(`Schedule "${params?.title}" not found`);
          return;
        }
        if (kiln.mode === 'running') {
          respondError('Cannot change schedule while running');
          return;
        }
        sched.logger = logger;
        kiln.schedule = sched;
        // Loading a new schedule is a fresh-firing setup gesture — default
        // the fan back to 'auto' so per-segment fanon: flags in the schedule
        // take effect. The operator can override after loading; this is just
        // the right starting point rather than carrying over whatever 'on'
        // or 'off' was left from the previous firing.
        kiln.setFanMode('auto');
        // Persist as recent
        if (!userConfig.recents) userConfig.recents = {};
        userConfig.recents.scheduleTitle = params.title;
        saveUserConfig(userConfig);
        logger.log(`Schedule "${params.title}" loaded`);
        respond({ ok: true });
        broadcastState();
        break;
      }

      case 'saveSchedule': {
        if (!params?.schedule) {
          respondError('Missing schedule data');
          return;
        }
        const newSched = new Schedule(params.schedule);
        const title = newSched.metadata.title || 'untitled';
        const filename = title.replace(/[^a-zA-Z0-9]/g, '') + '.json';
        const filepath = path.join(SCHEDULES_DIR, filename);
        newSched.save(filepath);
        schedules.set(title, newSched);
        logger.log(`Schedule "${title}" saved`);
        respond({ ok: true });
        // Also push the updated schedule list to every client so the picker
        // can refresh without the user clicking Refresh.
        const listMsg = JSON.stringify({
          type: 'response', action: 'getScheduleList',
          data: Array.from(schedules.keys()),
        });
        for (const c of wss.clients) {
          if (c.readyState === WebSocket.OPEN) c.send(listMsg);
        }
        if (relaySend) relaySend(JSON.parse(listMsg));
        // Mirror the change upstream to the relay's master schedule directory
        // so the next controller-on-connect sync includes it. Relay reads this
        // message type and writes the file; if relaySend isn't wired (no relay)
        // this is a no-op.
        if (relaySend) relaySend({ type: 'schedule-update', title, data: params.schedule });
        // If the saved schedule was the currently-loaded one, refresh kiln.schedule
        // to the new version so its segments don't diverge from what's on disk.
        // If we're mid-firing, also fast-forward the new schedule to the
        // current kiln temperature — otherwise the new schedule would restart
        // from ambient and the kiln would wait (cooling) for the schedule to
        // catch up. Mid-firing edits are a common workflow (tweak a hold or
        // rate on the fly) and the user's expectation is "apply from here".
        if (kiln.schedule && kiln.schedule.metadata.title === title) {
          newSched.logger = logger;
          kiln.schedule = newSched;
          if (kiln.mode === 'running') {
            kiln._resumeScheduleAtCurrentTemp();
            // Reset the segment-advance tracker so the next heartbeat doesn't
            // spuriously log a segment transition from "old position" to
            // "new fast-forwarded position".
            kiln._lastSegment = newSched.currentSegment;
          }
        }
        broadcastState();
        break;
      }

      case 'deleteSchedule': {
        const title = params?.title;
        if (!title) { respondError('Missing title'); return; }
        const sched = schedules.get(title);
        if (!sched) { respondError(`Schedule "${title}" not found`); return; }
        if (kiln.mode === 'running' && kiln.schedule && kiln.schedule.metadata.title === title) {
          respondError('Cannot delete the schedule that is currently firing');
          return;
        }
        // Remove from disk if we know where the file is
        if (sched.filename) {
          try { fs.unlinkSync(sched.filename); }
          catch (e) { logger.error(`deleteSchedule: unlink failed: ${e.message}`); }
        }
        schedules.delete(title);
        // If this was the loaded schedule, unload it
        if (kiln.schedule && kiln.schedule.metadata.title === title) {
          kiln.schedule = null;
        }
        // If it was the recent one, drop the pointer
        if (userConfig.recents?.scheduleTitle === title) {
          delete userConfig.recents.scheduleTitle;
          saveUserConfig(userConfig);
        }
        logger.log(`Schedule "${title}" deleted`);
        // Include the title in the response so the UI knows which one is gone
        respond({ ok: true, title });
        // Mirror upstream to the relay's master directory
        if (relaySend) relaySend({ type: 'schedule-deleted', title });
        // Push refreshed list + state to every client
        const listMsg = JSON.stringify({
          type: 'response', action: 'getScheduleList',
          data: Array.from(schedules.keys()),
        });
        for (const c of wss.clients) {
          if (c.readyState === WebSocket.OPEN) c.send(listMsg);
        }
        if (relaySend) relaySend(JSON.parse(listMsg));
        broadcastState();
        break;
      }

      case 'testRelay': {
        if (kiln.mode === 'running') {
          respondError('Cannot test relays while running');
          return;
        }
        const { relay, on } = params || {};
        if (relay === 'fan') {
          if (on) kiln.ventFan.turnOn(); else kiln.ventFan.turnOff();
        } else if (relay === 'heat1') {
          if (on) kiln.elements[0].turnOn(); else kiln.elements[0].turnOff();
        } else if (relay === 'heat2') {
          if (on) kiln.elements[1].turnOn(); else kiln.elements[1].turnOff();
        } else if (relay === 'heat3') {
          if (on) kiln.elements[2].turnOn(); else kiln.elements[2].turnOff();
        } else {
          respondError(`Unknown relay: ${relay}`);
          return;
        }
        respond({ ok: true });
        broadcastState();
        break;
      }

      default:
        respondError(`Unknown command: ${action}`);
    }
  } catch (err) {
    respondError(err.message);
  }
}

// ── Heartbeat Broadcast ─────────────────────────────────────────────────

let heartbeatCount = 0;
kiln.on('heartbeat', (_status) => {
  heartbeatCount++;
  // Broadcast every 5th heartbeat (~5 seconds) to reduce bandwidth
  if (heartbeatCount % 5 !== 0) return;

  // Persist firing-state on the same cadence — used by outage-recovery on the
  // next boot. Atomic write-then-rename; OS will flush within a few seconds.
  writeFiringState();

  // Use currentStatus() (not the raw `status` from kiln.getStatus()) so the
  // heartbeat payload carries the same fields as the connect-time state:
  // ringPositionLabels, firingNotes, activeFiring, pendingRecovery,
  // gpioConfig, notifications. Earlier the heartbeat sent the bare kiln
  // status, which clobbered those fields on the client after the first tick
  // — the UI would show physical-position labels for ~5 s then revert to
  // "Ring N", and similarly for the notes textarea and recovery banner.
  const enriched = currentStatus();
  const msg = JSON.stringify({ type: 'state', data: enriched });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
  if (relaySend) relaySend({ type: 'state', data: enriched });
});

// Broadcast log and message events — same pattern as broadcastState(): push
// to both LAN clients AND the relay so browsers viewing through the relay
// see the log feed too, not just LAN browsers.
logger.on('log', (line) => {
  const payload = { type: 'log', message: line };
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
  if (relaySend) relaySend(payload);
});

logger.on('message', (text) => {
  const payload = { type: 'message', message: text };
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
  if (relaySend) relaySend(payload);
});

// ── Mirror per-firing log files to the VPS ──────────────────────────────
//
// SD cards on the Pi are volatile; a controller failure or card corruption
// could lose the entire firing record. We push each firing's log to the
// relay incrementally — start sends the header, every event line streams
// up as it lands, and complete sends the final file with the SUMMARY block
// prepended. Relay-side handler in relay-server.js writes to /srv/firings/,
// which lives on the host's bind-mounted directory outside Docker.
//
// Failure handling: if the relay is unreachable, events queue locally in
// the on-disk firing log file as normal. There's no replay protocol — if
// the WS drops mid-firing, the VPS-side file will be missing the lines that
// went out during the disconnect. The firingComplete message at the end
// re-sends the entire final file (including summary), so VPS storage is
// always consistent after a clean completion. Catastrophic Pi failure mid-
// firing leaves the VPS-side with at most a few seconds of data missing.
// SD-failure alerts. Logger now writes async — when writes start failing,
// it counts errors and (after WRITE_FAILURE_THRESHOLD) disables file logging
// entirely. The kiln keeps running through this; the alerts here let the
// operator know they're flying blind on local recording. Relay-side
// firing-log mirror means the firing record survives even when the SD
// card doesn't (the relay writes to its own volume on the VPS).
logger.on('write-error', ({ which, message }) => {
  sendPushover('warn', 'PiKiln',
    `Disk write failed (${which}): ${message}. Kiln still running; check the SD card.`);
});
logger.on('writes-disabled', ({ failures, lastError }) => {
  sendPushover('error', 'PiKiln',
    `SD card writes disabled after ${failures} consecutive failures (last: ${lastError}). Kiln still firing — the VPS relay has the firing log. Replace the SD card after this run.`);
});
logger.on('writes-recovered', ({ afterFailures }) => {
  sendPushover('info', 'PiKiln',
    `Disk writes recovered after ${afterFailures} failures. Local logging back online.`);
});

logger.on('firing-log-start', (evt) => {
  if (relaySend) relaySend({ type: 'firing-log-start', data: evt });
});
logger.on('firing-log-append', (evt) => {
  if (relaySend) relaySend({ type: 'firing-log-append', data: evt });
});
logger.on('firing-log-complete', (evt) => {
  if (relaySend) relaySend({ type: 'firing-log-complete', data: evt });
});

// Apply a master-schedule sync from the relay. Replaces local data/schedules/
// contents (writing new files, removing any local files whose schedules aren't
// in the sync set), reloads the in-memory map, and refreshes the currently-
// loaded schedule if its title still exists.
//
// Safety: if a firing is in progress (kiln.mode === 'running') we still write
// new files to disk so they're current on next firing, but we don't touch
// `kiln.schedule` — the firing keeps using its in-memory Schedule object.
function applySchedulesSync(remote) {
  if (!Array.isArray(remote)) return;
  // Full replace — wipe and rewrite. Edits made locally while the relay was
  // unreachable would be lost here; that's by design (sync direction is
  // master→controller, with controllers pushing changes upstream as they
  // happen via schedule-update). Wiping first also dedupes the directory
  // when seed-derived filenames (e.g. BRTF6.json) and title-derived names
  // (BartlettFastGlazeCone6.json) coexisted.
  for (const f of fs.readdirSync(SCHEDULES_DIR)) {
    if (!f.endsWith('.json')) continue;
    try { fs.unlinkSync(path.join(SCHEDULES_DIR, f)); } catch { /* ignore */ }
  }
  for (const item of remote) {
    if (!item || !item.title || !item.data) continue;
    const filename = item.title.replace(/[^a-zA-Z0-9]/g, '') + '.json';
    const filepath = path.join(SCHEDULES_DIR, filename);
    try { fs.writeFileSync(filepath, JSON.stringify(item.data, null, 2)); }
    catch (e) { logger.error(`schedules-sync: write ${filename} failed: ${e.message}`); }
  }
  // Reload the in-memory map
  const fresh = Schedule.loadAll(SCHEDULES_DIR);
  schedules.clear();
  for (const [t, s] of fresh) schedules.set(t, s);
  // Refresh the currently-loaded schedule if it still exists and we're idle
  if (kiln.mode !== 'running' && kiln.schedule) {
    const title = kiln.schedule.metadata.title;
    if (schedules.has(title)) {
      const s = schedules.get(title);
      s.logger = logger;
      kiln.schedule = s;
    } else {
      logger.log(`schedules-sync: previously-loaded "${title}" no longer in master; unloaded`);
      kiln.schedule = null;
    }
  }
  logger.log(`schedules-sync: synced ${remote.length} from master`);
  // Push the new list + state to LAN viewers so UIs refresh immediately
  const listMsg = JSON.stringify({
    type: 'response', action: 'getScheduleList',
    data: Array.from(schedules.keys()),
  });
  for (const c of wss.clients) {
    if (c.readyState === WebSocket.OPEN) c.send(listMsg);
  }
  broadcastState();
}

// Broadcast lifecycle events immediately — these need to reach the relay too
// (the existing event handlers only hit local LAN clients, which left remote
// browsers stuck on stale state until the next heartbeat).
for (const event of ['started', 'stopped', 'schedule-complete', 'cool-down-complete', 'hold-state-change']) {
  kiln.on(event, () => broadcastState());
}

kiln.on('emergency-stop', (reason) => {
  // Finalize the firing log even on emergency stop. The summary block notes
  // endReason='emergency-stop' so post-mortem analysis can distinguish a
  // crash from a normal completion. Wrap in try/catch — if the I/O fails
  // during a SIGTERM-triggered shutdown, we still want the alert to fire.
  if (logger.activeFiring) {
    try { logger.endFiring(kiln.getFiringSummary('emergency-stop')); }
    catch { /* shutdown path; best-effort */ }
  }
  broadcastState({ alert: `EMERGENCY STOP: ${reason}` });
  sendPushover('error', 'PiKiln', `EMERGENCY STOP: ${reason}`);
});

// ── Pushover notifications ─────────────────────────────────────────────
//
// We send by emitting a {type:"pushover"} frame upstream to the relay, which
// has the API keys in its .env and POSTs to api.pushover.net on our behalf.
// The controller never sees those keys directly. Three "apps" (info/warn/error)
// give the phone different sounds/icons. Skipped silently if relaySend isn't
// wired (no relay, or sim that's been yielded).

// Queue Pushovers fired before the relay has had a chance to authenticate
// (e.g. recovery notifications at startup). Flushed once `relayAuthed`
// flips true.
const pendingPushovers = [];
const PENDING_PUSHOVER_CAP = 50;

function sendPushover(priority, title, message) {
  const payload = { type: 'pushover', priority, title, message };
  if (relaySend && relayAuthed) {
    relaySend(payload);
  } else {
    pendingPushovers.push(payload);
    if (pendingPushovers.length > PENDING_PUSHOVER_CAP) pendingPushovers.shift();
  }
}

function flushPendingPushovers() {
  if (!relaySend || !relayAuthed) return;
  while (pendingPushovers.length) {
    relaySend(pendingPushovers.shift());
  }
}

kiln.on('started', () => {
  const t = kiln.schedule?.metadata?.title || '(untitled)';
  // Open a fresh per-firing log. Notes captured in userConfig.firingNotes
  // (operator-edited in the Run tab) get baked into the file header at this
  // moment — subsequent edits to the notes textarea won't update an
  // in-progress firing log, only the next one.
  const capturedNotes = userConfig.firingNotes || '';
  logger.startFiring({
    title: t,
    startedAt: new Date(),
    notes: capturedNotes,
    mode: kiln.simulation ? 'simulation' : 'real',
  });
  // Now that the notes are committed to the log, clear the textarea so the
  // next firing starts blank (operator's load-specific annotations from this
  // firing don't carry over). The notes are preserved in the firing log file.
  if (capturedNotes) {
    userConfig.firingNotes = '';
    saveUserConfig(userConfig);
  }
  sendPushover('info', 'PiKiln', `Started: ${t}`);
});

kiln.on('schedule-complete', () => {
  sendPushover('info', 'PiKiln', 'Schedule complete — cooling down');
});

kiln.on('cool-down-complete', ({ atTempC }) => {
  const f = atTempC * 9 / 5 + 32;
  // Cool-down finished normally — finalize the firing log with the SUMMARY
  // block prepended. This is the canonical "firing record" file.
  try { logger.endFiring(kiln.getFiringSummary('completed')); }
  catch (e) { logger.error(`endFiring failed: ${e.message}`); }
  sendPushover('info', 'PiKiln', `Cool-down complete (${f.toFixed(0)}°F) — safe to open`);
});

// A user-initiated Stop interrupts the firing before cool-down completes.
// Finalize the log anyway with endReason="stopped" so the partial record is
// preserved with whatever summary fields we have.
kiln.on('stopped', () => {
  if (!logger.activeFiring) return;
  try { logger.endFiring(kiln.getFiringSummary('stopped')); }
  catch (e) { logger.error(`endFiring (stopped) failed: ${e.message}`); }
});

kiln.on('progress-threshold', ({ tempF }) => {
  if (userConfig.notifications?.progress === false) return;
  sendPushover('info', 'PiKiln', `Reached ${tempF}°F`);
});

// ── VPS Relay Connection ────────────────────────────────────────────────
//
// The Pi dials out to the VPS so remote browsers can reach the kiln through
// the relay host. Auto-enabled whenever a token+URL pair is available: the
// install script writes `KILN_RELAY_TOKEN` and `RELAY_URL` into /opt/pikiln/.env,
// pikiln-launch exports them, and we pick them up here. Set `relay.enabled: false`
// in data/config.json to explicitly disable (e.g. for an offline test).

let relaySend = null;
// Hoisted out of the if (relayEnabled) block so sendPushover can read it to
// decide whether to send immediately or queue for later.
let relayAuthed = false;

const relayToken = process.env.KILN_RELAY_TOKEN || config.relay?.token || '';
const relayUrl = process.env.KILN_RELAY_URL || process.env.RELAY_URL || config.relay?.url || '';
// Default-on when we have credentials; user can opt out with `enabled: false`.
const relayUrlForWs = (() => {
  // RELAY_URL is the relay's HTTPS base (e.g. https://your-relay-host) from
  // .env; for the controller WebSocket we need wss://your-relay-host/controller.
  if (!relayUrl) return '';
  if (relayUrl.startsWith('ws://') || relayUrl.startsWith('wss://')) return relayUrl;
  const u = relayUrl.replace(/\/+$/, '');
  if (/^https:\/\//.test(u)) return 'wss://' + u.slice('https://'.length) + '/controller';
  if (/^http:\/\//.test(u))  return 'ws://'  + u.slice('http://'.length)  + '/controller';
  return u;
})();
const relayEnabled = !!(relayToken && relayUrlForWs && config.relay?.enabled !== false);

if (relayEnabled) {
  let relayWs = null;
  let reconnectDelay = 1000;
  let slotPollTimer = null;
  // `relayAuthed` is defined at module scope so sendPushover can see it.
  // Role identifies us to the relay: "real" controllers (the Pi at the kiln)
  // outrank "sim" controllers (the always-on VPS simulator). Default to "real";
  // the sim's container sets KILN_RELAY_ROLE=sim explicitly.
  const relayRole = process.env.KILN_RELAY_ROLE === 'sim' ? 'sim' : 'real';

  // Derive an HTTP base for /health from the WS URL we already have.
  // wss://your-relay-host/controller → https://your-relay-host/health
  // http://kiln-relay:8080/controller → http://kiln-relay:8080/health (the sim)
  const relayHealthUrl = (() => {
    let u = relayUrlForWs;
    if (u.startsWith('wss://'))     u = 'https://' + u.slice('wss://'.length);
    else if (u.startsWith('ws://')) u = 'http://'  + u.slice('ws://'.length);
    return u.replace(/\/[^/]*$/, '') + '/health';
  })();

  // After being yielded to a real controller (close code 4002), poll the
  // relay's /health endpoint at a low cadence and reconnect as soon as the
  // controller slot opens. This replaces the previous 30-second fixed wait,
  // shrinking the LIVE→SIM transition gap to a few seconds.
  function startSlotPoll() {
    if (slotPollTimer) return;
    const intervalMs = 3000;
    slotPollTimer = setInterval(async () => {
      try {
        const res = await fetch(relayHealthUrl);
        if (!res.ok) return;
        const data = await res.json();
        if (!data.controllerConnected) {
          clearInterval(slotPollTimer);
          slotPollTimer = null;
          logger.log('Relay controller slot free — reconnecting');
          connectRelay();
        }
      } catch { /* relay unreachable, keep polling */ }
    }, intervalMs);
    slotPollTimer.unref?.();
  }

  function connectRelay() {
    logger.log(`Connecting to relay as ${relayRole}: ${relayUrlForWs}`);
    relayWs = new WebSocket(relayUrlForWs);

    relayWs.on('open', () => {
      logger.log('Connected to relay');
      reconnectDelay = 1000;
      relayWs.send(JSON.stringify({
        type: 'identify', client: 'controller', token: relayToken, role: relayRole,
      }));
    });

    relayWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'identified') {
          relayAuthed = true;
          // Send any Pushovers that were queued while we weren't connected
          // (e.g. outage-recovery notifications from startup).
          flushPendingPushovers();
          // Push the current state immediately so the relay's lastState
          // cache (which it forwards to newly-connecting viewers) is
          // fresh. Without this, the relay holds stale pre-disconnect
          // state until the next 5 s heartbeat broadcast — which manifests
          // on the browser as "kiln is running but no temps or log
          // streaming" right after a Pi reboot/reconnect.
          try { broadcastState(); } catch (e) {
            logger.log(`Failed to broadcast post-identify state: ${e.message}`);
          }
        } else if (msg.type === 'command') {
          // Create a fake ws that sends responses back through the relay
          const fakeWs = {
            send: (data) => {
              if (relayWs && relayWs.readyState === WebSocket.OPEN) {
                relayWs.send(data);
              }
            },
          };
          handleCommand(msg, fakeWs);
        } else if (msg.type === 'schedules-sync') {
          applySchedulesSync(msg.schedules || []);
        }
      } catch { /* ignore parse errors */ }
    });

    relayWs.on('close', (code, reason) => {
      relayAuthed = false;
      // 4002 = relay told us a real controller is active (we're a sim).
      // Start polling /health so we can pounce the moment the slot opens
      // instead of waiting a flat 30 seconds.
      if (code === 4002) {
        logger.log('Relay yielding to real controller; polling /health for slot');
        startSlotPoll();
        return;
      }
      logger.log(`Relay disconnected (${code} ${reason || ''}), reconnecting in ${reconnectDelay / 1000}s`);
      setTimeout(connectRelay, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    });

    relayWs.on('error', () => { /* will trigger close */ });
  }

  relaySend = (msg) => {
    // Gate on relayAuthed: until the relay has acked our identify, any frame
    // we send (a log line, a state, a schedule-update) would be the first thing
    // it sees on this socket and would fail the bad-identify check, closing us.
    if (relayWs && relayWs.readyState === WebSocket.OPEN && relayAuthed) {
      relayWs.send(JSON.stringify(msg));
    }
  };

  connectRelay();
} else if (config.relay?.enabled !== false && (relayToken || relayUrl)) {
  // Partial config — likely a misconfiguration. Log so it's discoverable.
  logger.log(`Relay not connecting: token=${relayToken ? 'set' : 'missing'} url=${relayUrlForWs || 'missing'}`);
}

// ── Graceful Shutdown ───────────────────────────────────────────────────

function gracefulShutdown(signal) {
  logger.log(`Received ${signal}, shutting down...`);
  kiln.emergencyStop(`${signal} received`);
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}\n${err.stack}`);
  kiln.emergencyStop('Uncaught exception');
  setTimeout(() => process.exit(1), 1000);
});

// ── Start Server ────────────────────────────────────────────────────────

const PORT = config.http?.port || 8080;
// ── Outage recovery decision ────────────────────────────────────────────
//
// Run right before we start accepting connections. By now the schedules,
// recents, kiln, and relay client are all set up. The relay's WS may not
// be authed yet — that's fine, sendPushover queues until it is.
function recoverFromCrashIfNeeded() {
  const { lockPresent, state } = crashSignal;
  if (!lockPresent && !state) return;  // clean shutdown last time, nothing to do

  // If we have a state file but no lock, treat as suspicious: maybe the lock
  // was hand-cleared. Still try to recover if state is plausible.
  if (!state) {
    logger.log('Recovery: firing.lock present but no firing-state.json — clearing and idling');
    return;
  }

  const lastUpdate = Date.parse(state.ts);
  if (!Number.isFinite(lastUpdate)) {
    logger.error('Recovery: firing-state.json has invalid timestamp; ignoring');
    clearFiringState();
    return;
  }
  const outageSeconds = Math.max(0, Math.round((Date.now() - lastUpdate) / 1000));
  const outageMin = (outageSeconds / 60).toFixed(1);
  const stateMaxTempF = state.maxTempC != null ? state.maxTempC * 9 / 5 + 32 : null;

  // Stale-residue check. If the saved firing-state is more than 24 h old, no
  // real firing could plausibly still be in progress — the file is just left-
  // over from a long-ago SIGTERM/emergency-stop that didn't clean up after
  // itself. Wipe it silently so we don't ambush the operator with a recovery
  // banner days later.
  const STALE_SECONDS = parseInt(process.env.PIKILN_STALE_STATE_SECONDS || '86400', 10);
  if (outageSeconds > STALE_SECONDS) {
    logger.log(`Recovery: discarding stale firing-state (${(outageSeconds / 3600).toFixed(1)} h old)`);
    clearFiringState();
    return;
  }

  // The kiln's sensors won't have read yet — read them now to get our best
  // estimate of current temperature. In sim mode we trust the simulated temp;
  // on real hardware temp-sensor.js needs a readCelsius() call to populate.
  for (const s of kiln.tempSensors) {
    try { s.readCelsius?.(); } catch { /* fall back to whatever it has */ }
  }
  const currentMaxC = kiln._currentMaxTempC();
  const currentMaxF = Number.isFinite(currentMaxC) ? currentMaxC * 9 / 5 + 32 : null;

  // ── Was cooling? Re-enter cooling mode (no schedule restart needed). ──
  if (state.mode === 'cooling') {
    if (state.schedule && schedules.has(state.schedule)) {
      const sched = schedules.get(state.schedule);
      sched.logger = logger;
      kiln.schedule = sched;
    }
    logger.log(`Recovery: resuming cool-down monitoring (was cooling, kiln at ${currentMaxF?.toFixed(0) ?? '?'}°F)`);
    // Drive into cooling mode directly. The constructor already started the
    // 1 Hz heartbeat; it'll detect mode==='cooling' on the next beat and
    // handle <120°F completion. Do NOT start another setInterval here — that
    // was a leftover from when the heartbeat used to be start()-scoped.
    // Spawning a second timer doubles the heartbeat rate, which doubles the
    // element-trigger rate; with the configured 11.1s firings re-arming every
    // 7.5s, the elements end up effectively on continuously.
    kiln.mode = 'cooling';
    kiln._coolingStartTime = Date.now();
    kiln.safety.start();
    kiln.emit('firing-state-change', true);
    sendPushover('info', 'PiKiln',
      `Recovered into cool-down — kiln at ${currentMaxF?.toFixed(0) ?? '?'}°F`);
    return;
  }

  // ── Was running. Decide auto-resume vs manual recovery. ──
  if (state.mode !== 'running') {
    // Unknown saved mode — clean up.
    clearFiringState();
    return;
  }
  if (!state.schedule || !schedules.has(state.schedule)) {
    logger.log(`Recovery: saved schedule "${state.schedule}" not found in master; manual decision needed`);
    pendingRecovery = {
      reason: 'schedule-missing',
      savedSchedule: state.schedule,
      outageSeconds,
      maxTempF: currentMaxF,
      savedMaxTempF: stateMaxTempF,
    };
    sendPushover('warn', 'PiKiln',
      `Recovery: saved schedule "${state.schedule}" missing after ${outageMin} min outage — visit UI`);
    return;
  }

  const kilnWarm = currentMaxF != null && currentMaxF > MIN_WARM_TEMP_F;
  if (!kilnWarm) {
    // Kiln is cool *now*. If the saved state shows it was ALSO cool when
    // interrupted AND the firing only ran briefly, treat as test residue
    // and discard silently. The brief-firing check matters for low-temp
    // schedules (candle, bisque preheat, drying) that legitimately stay
    // below the 200°F warm threshold for their whole runtime — those
    // should still trigger a recovery banner so the operator can resume,
    // not get silently discarded.
    const savedWasCool = stateMaxTempF == null || stateMaxTempF <= MIN_WARM_TEMP_F;
    const elapsedMin = state.startTime
      ? (lastUpdate - state.startTime) / 60_000
      : 0;
    const briefTestRun = elapsedMin < 5;
    if (savedWasCool && briefTestRun) {
      logger.log(`Recovery: cool kiln + cool saved state (${stateMaxTempF?.toFixed(0) ?? '?'}°F at interrupt, ${currentMaxF?.toFixed(0) ?? '?'}°F now, ${elapsedMin.toFixed(1)} min of firing) — discarding stale state`);
      clearFiringState();
      return;
    }
    logger.log(`Recovery: kiln at ${currentMaxF?.toFixed(0) ?? '?'}°F is below ${MIN_WARM_TEMP_F}°F threshold; manual decision needed`);
    pendingRecovery = {
      reason: 'kiln-cool',
      savedSchedule: state.schedule,
      outageSeconds,
      maxTempF: currentMaxF,
      savedMaxTempF: stateMaxTempF,
    };
    sendPushover('warn', 'PiKiln',
      `Outage interrupted "${state.schedule}" — kiln at ${currentMaxF?.toFixed(0) ?? '?'}°F (was ${stateMaxTempF?.toFixed(0) ?? '?'}°F) after ${outageMin} min. UI to decide.`);
    return;
  }

  // Auto-resume.
  const sched = schedules.get(state.schedule);
  sched.logger = logger;
  kiln.schedule = sched;
  kiln.fanMode = state.fanMode || kiln.fanMode;
  try {
    kiln.start();
  } catch (e) {
    logger.error(`Recovery auto-resume failed: ${e.message}`);
    pendingRecovery = {
      reason: 'start-failed',
      error: e.message,
      savedSchedule: state.schedule,
      outageSeconds,
      maxTempF: currentMaxF,
      savedMaxTempF: stateMaxTempF,
    };
    sendPushover('error', 'PiKiln', `Auto-resume failed: ${e.message}`);
    return;
  }
  const priority = outageSeconds <= MAX_OUTAGE_SECONDS ? 'info' : 'warn';
  const tail = outageSeconds <= MAX_OUTAGE_SECONDS
    ? `quick recovery`
    : `${outageMin} min outage — check ware for thermal stress`;
  sendPushover(priority, 'PiKiln',
    `Auto-resumed "${state.schedule}" — kiln at ${currentMaxF.toFixed(0)}°F (${tail})`);
  logger.log(`Recovery: auto-resumed (outage ${outageSeconds}s, kiln ${currentMaxF.toFixed(0)}°F)`);
}

recoverFromCrashIfNeeded();

httpServer.listen(PORT, () => {
  logger.log(`PiKiln server running on http://localhost:${PORT}`);
  logger.log(`  Dashboard: http://localhost:${PORT}/`);
  logger.log(`  API status: http://localhost:${PORT}/api/status`);
});
