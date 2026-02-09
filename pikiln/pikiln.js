'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { Kiln } = require('./lib/kiln');
const { Schedule } = require('./lib/schedule');
const { Logger } = require('./lib/logger');

// ── Config ──────────────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, 'data');
const SCHEDULES_DIR = path.join(DATA_DIR, 'schedules');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

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

const config = loadConfig();
const logger = new Logger(LOGS_DIR);
const kiln = new Kiln(config, logger);

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
  '.css': 'text/css',
  '.json': 'application/json',
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

wss.on('connection', (ws) => {
  // Send current state immediately
  ws.send(JSON.stringify({ type: 'state', data: kiln.getStatus() }));

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
        kiln.start();
        respond({ ok: true });
        break;

      case 'stop':
        kiln.stop();
        respond({ ok: true });
        break;

      case 'setFanMode':
        if (!params || !['off', 'auto', 'on'].includes(params.mode)) {
          respondError('Invalid fan mode');
          return;
        }
        kiln.fanMode = params.mode;
        respond({ ok: true, fanMode: params.mode });
        break;

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
        // Persist as recent
        if (!userConfig.recents) userConfig.recents = {};
        userConfig.recents.scheduleTitle = params.title;
        saveUserConfig(userConfig);
        logger.log(`Schedule "${params.title}" loaded`);
        respond({ ok: true });
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
kiln.on('heartbeat', (status) => {
  heartbeatCount++;
  // Broadcast every 5th heartbeat (~5 seconds) to reduce bandwidth
  if (heartbeatCount % 5 !== 0) return;

  const msg = JSON.stringify({ type: 'state', data: status });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
  if (relaySend) relaySend({ type: 'state', data: status });
});

// Broadcast log and message events
logger.on('log', (line) => {
  const msg = JSON.stringify({ type: 'log', message: line });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
});

logger.on('message', (text) => {
  const msg = JSON.stringify({ type: 'message', message: text });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
});

// Broadcast mode changes immediately
for (const event of ['started', 'stopped', 'schedule-complete']) {
  kiln.on(event, () => {
    const msg = JSON.stringify({ type: 'state', data: kiln.getStatus() });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  });
}

kiln.on('emergency-stop', (reason) => {
  const msg = JSON.stringify({
    type: 'state',
    data: kiln.getStatus(),
    alert: `EMERGENCY STOP: ${reason}`,
  });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
});

// ── VPS Relay Connection ────────────────────────────────────────────────

let relaySend = null;

if (config.relay?.enabled && config.relay?.url) {
  let relayWs = null;
  let reconnectDelay = 1000;

  function connectRelay() {
    logger.log(`Connecting to relay: ${config.relay.url}`);
    relayWs = new WebSocket(config.relay.url);

    relayWs.on('open', () => {
      logger.log('Connected to relay');
      reconnectDelay = 1000;
      relayWs.send(JSON.stringify({ type: 'identify', client: 'controller' }));
    });

    relayWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'command') {
          // Create a fake ws that sends responses back through the relay
          const fakeWs = {
            send: (data) => {
              if (relayWs && relayWs.readyState === WebSocket.OPEN) {
                relayWs.send(data);
              }
            },
          };
          handleCommand(msg, fakeWs);
        }
      } catch { /* ignore parse errors */ }
    });

    relayWs.on('close', () => {
      logger.log(`Relay disconnected, reconnecting in ${reconnectDelay / 1000}s`);
      setTimeout(connectRelay, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    });

    relayWs.on('error', () => { /* will trigger close */ });
  }

  relaySend = (msg) => {
    if (relayWs && relayWs.readyState === WebSocket.OPEN) {
      relayWs.send(JSON.stringify(msg));
    }
  };

  connectRelay();
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
httpServer.listen(PORT, () => {
  logger.log(`PiKiln server running on http://localhost:${PORT}`);
  logger.log(`  Dashboard: http://localhost:${PORT}/`);
  logger.log(`  API status: http://localhost:${PORT}/api/status`);
});
