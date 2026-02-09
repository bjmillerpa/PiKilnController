const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

// In-memory cache of JSON data keyed by channel name
const cache = new Map();

// Track connected clients
let hostSocket = null;
const viewers = new Set();

const server = http.createServer((req, res) => {
  // CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve static client files
  if (req.method === 'GET' && req.url === '/') {
    serveFile(res, 'index.html', 'text/html');
    return;
  }
  if (req.method === 'GET' && req.url === '/host.html') {
    serveFile(res, 'host.html', 'text/html');
    return;
  }
  if (req.method === 'GET' && req.url === '/viewer.html') {
    serveFile(res, 'viewer.html', 'text/html');
    return;
  }

  // HTTP polling endpoint: GET /poll/:channel
  const pollMatch = req.url.match(/^\/poll\/([a-zA-Z0-9_-]+)$/);
  if (req.method === 'GET' && pollMatch) {
    const channel = pollMatch[1];
    const entry = cache.get(channel);
    if (entry) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        channel,
        timestamp: entry.timestamp,
        data: entry.data,
      }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No data for channel', channel }));
    }
    return;
  }

  // GET /poll — list all cached channels
  if (req.method === 'GET' && req.url === '/poll') {
    const channels = {};
    for (const [ch, entry] of cache) {
      channels[ch] = { timestamp: entry.timestamp };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ channels }));
    return;
  }

  // GET /status — server info
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      hostConnected: hostSocket !== null,
      viewerCount: viewers.size,
      cachedChannels: Array.from(cache.keys()),
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

function serveFile(res, filename, contentType) {
  const filePath = path.join(__dirname, filename);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// WebSocket server
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  let clientRole = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    // Registration message: { type: "register", role: "host" | "viewer" }
    if (msg.type === 'register') {
      if (msg.role === 'host') {
        if (hostSocket && hostSocket !== ws && hostSocket.readyState === 1) {
          ws.send(JSON.stringify({ error: 'A host is already connected' }));
          ws.close();
          return;
        }
        clientRole = 'host';
        hostSocket = ws;
        ws.send(JSON.stringify({ type: 'registered', role: 'host' }));
        console.log('Host connected');
      } else if (msg.role === 'viewer') {
        clientRole = 'viewer';
        viewers.add(ws);
        ws.send(JSON.stringify({ type: 'registered', role: 'viewer' }));
        console.log(`Viewer connected (${viewers.size} total)`);
      } else {
        ws.send(JSON.stringify({ error: 'Invalid role. Use "host" or "viewer".' }));
      }
      return;
    }

    // Data message from host: { type: "publish", channel: "...", data: {...} }
    if (msg.type === 'publish') {
      if (clientRole !== 'host') {
        ws.send(JSON.stringify({ error: 'Only the host can publish' }));
        return;
      }

      const channel = msg.channel || 'default';
      const payload = msg.data;

      if (payload === undefined) {
        ws.send(JSON.stringify({ error: 'Missing "data" field' }));
        return;
      }

      // Cache it
      const timestamp = new Date().toISOString();
      cache.set(channel, { data: payload, timestamp });

      // Relay to all viewers
      const relay = JSON.stringify({
        type: 'update',
        channel,
        timestamp,
        data: payload,
      });

      for (const viewer of viewers) {
        if (viewer.readyState === 1) {
          viewer.send(relay);
        }
      }

      ws.send(JSON.stringify({
        type: 'published',
        channel,
        timestamp,
        viewerCount: viewers.size,
      }));
      return;
    }

    ws.send(JSON.stringify({ error: `Unknown message type: ${msg.type}` }));
  });

  ws.on('close', () => {
    if (clientRole === 'host') {
      hostSocket = null;
      console.log('Host disconnected');
      // Notify viewers
      const notice = JSON.stringify({ type: 'host_disconnected' });
      for (const viewer of viewers) {
        if (viewer.readyState === 1) {
          viewer.send(notice);
        }
      }
    } else if (clientRole === 'viewer') {
      viewers.delete(ws);
      console.log(`Viewer disconnected (${viewers.size} remaining)`);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

server.listen(PORT, () => {
  console.log(`Relay server running on http://localhost:${PORT}`);
  console.log(`  Host client:   http://localhost:${PORT}/host.html`);
  console.log(`  Viewer client: http://localhost:${PORT}/viewer.html`);
  console.log(`  HTTP polling:  GET http://localhost:${PORT}/poll/<channel>`);
  console.log(`  Server status: GET http://localhost:${PORT}/status`);
});
