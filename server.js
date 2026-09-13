// server.js
// Pixel Race - multiplayer racing game server
// A single Node process serves the static client (plain http + fs, no
// framework needed) and runs a ws WebSocketServer that handles room
// creation/joining via 4-digit PINs and relays live game state.

const path = require('path');
const fs = require('fs');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const MAX_ROOMS = 200;                     // hard cap on concurrent rooms
const MAX_PLAYERS_PER_ROOM = 8;
const ROOM_EMPTY_GRACE_MS = 30 * 1000;     // delete empty room after this long
const ROOM_MAX_AGE_MS = 3 * 60 * 60 * 1000; // force-close very old rooms (3h)
const CLEANUP_INTERVAL_MS = 15 * 1000;
const HEARTBEAT_INTERVAL_MS = 20 * 1000;
const STATE_TICK_MS = 60;                  // ~16Hz state broadcast
const LAP_COOLDOWN_MS = 4000;
const TOTAL_LAPS = 3;
const NAME_MAX_LEN = 16;

const PLAYER_COLORS = [
  0xff4d4d, 0x4d94ff, 0x4dff88, 0xffd24d,
  0xd24dff, 0x4dffe6, 0xff914d, 0xc2ff4d
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
/** @type {Map<string, Room>} */
const rooms = new Map();

function makeRoom(pin) {
  return {
    pin,
    players: new Map(),   // playerId -> player
    hostId: null,
    state: 'lobby',        // lobby | racing | finished
    createdAt: Date.now(),
    lastActivity: Date.now(),
    emptySince: null,
    finishOrder: [],
  };
}

function makePlayer(id, ws, name, colorIndex) {
  return {
    id, ws, name,
    color: PLAYER_COLORS[colorIndex % PLAYER_COLORS.length],
    x: 46, y: 0, z: 0, rotY: 0, speed: 0,
    laps: 0,
    lastLapTime: 0,
    finished: false,
    finishTime: null,
    lastUpdate: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore broken socket */ }
  }
}

function broadcastRoom(room, obj, excludeWs) {
  const payload = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.ws !== excludeWs && p.ws.readyState === WebSocket.OPEN) {
      try { p.ws.send(payload); } catch (e) { /* ignore */ }
    }
  }
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return 'Player';
  const cleaned = raw.replace(/[^\x20-\x7E]/g, '').trim().slice(0, NAME_MAX_LEN);
  return cleaned.length ? cleaned : 'Player';
}

function isValidPin(pin) {
  return typeof pin === 'string' && /^[0-9]{4}$/.test(pin);
}

function genPin() {
  let pin;
  let attempts = 0;
  do {
    pin = String(1000 + Math.floor(Math.random() * 9000));
    attempts++;
  } while (rooms.has(pin) && attempts < 50);
  return pin;
}

function safeNum(v, fallback, min, max) {
  if (typeof v !== 'number' || !isFinite(v)) return fallback;
  if (typeof min === 'number' && v < min) return min;
  if (typeof max === 'number' && v > max) return max;
  return v;
}

function publicPlayer(p) {
  return {
    id: p.id, name: p.name, color: p.color,
    x: p.x, y: p.y, z: p.z, rotY: p.rotY, speed: p.speed,
    laps: p.laps, finished: p.finished, finishTime: p.finishTime,
  };
}

function roomLobbyPayload(room) {
  return {
    type: 'lobby_update',
    pin: room.pin,
    hostId: room.hostId,
    state: room.state,
    players: Array.from(room.players.values()).map(publicPlayer),
  };
}

function deleteRoom(pin, reason) {
  const room = rooms.get(pin);
  if (!room) return;
  for (const p of room.players.values()) {
    safeSend(p.ws, { type: 'room_closed', reason: reason || 'closed' });
    p.ws.roomPin = null;
    p.ws.playerId = null;
  }
  rooms.delete(pin);
}

function removePlayerFromRoom(ws) {
  const pin = ws.roomPin;
  const playerId = ws.playerId;
  ws.roomPin = null;
  ws.playerId = null;
  if (!pin) return;
  const room = rooms.get(pin);
  if (!room) return;
  const wasHost = room.hostId === playerId;
  room.players.delete(playerId);

  if (room.players.size === 0) {
    room.emptySince = Date.now();
    return;
  }

  if (wasHost) {
    room.hostId = room.players.keys().next().value;
  }
  broadcastRoom(room, { type: 'player_left', id: playerId, newHostId: room.hostId });
}

// ---------------------------------------------------------------------------
// Minimal static file server (no framework dependency) + WebSocket setup
// ---------------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.obj': 'text/plain; charset=utf-8',
  '.mtl': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';

  // Resolve safely inside PUBLIC_DIR, blocking path traversal.
  const resolved = path.normalize(path.join(PUBLIC_DIR, reqPath));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.stat(resolved, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(resolved)
      .on('error', () => { res.end(); })
      .pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: process.uptime() }));
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.roomPin = null;
  ws.playerId = null;

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => { /* swallow - close handler will clean up */ });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return; // ignore malformed JSON, never crash
    }
    if (!msg || typeof msg.type !== 'string') return;

    try {
      handleMessage(ws, msg);
    } catch (e) {
      console.error('Error handling message', msg.type, e);
      safeSend(ws, { type: 'error', message: 'Internal error, please try again.' });
    }
  });

  ws.on('close', () => {
    try { removePlayerFromRoom(ws); } catch (e) { console.error(e); }
  });
});

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'create': return onCreate(ws, msg);
    case 'join': return onJoin(ws, msg);
    case 'leave': return onLeave(ws);
    case 'start': return onStart(ws);
    case 'restart': return onRestart(ws);
    case 'state': return onState(ws, msg);
    case 'lap': return onLap(ws);
    case 'ping': return safeSend(ws, { type: 'pong' });
    default: return; // unknown message types are ignored
  }
}

function onCreate(ws, msg) {
  if (ws.roomPin) return safeSend(ws, { type: 'error', message: 'Already in a room.' });
  if (rooms.size >= MAX_ROOMS) {
    return safeSend(ws, { type: 'error', message: 'Server is full. Please try again shortly.' });
  }
  const name = sanitizeName(msg.name);
  const pin = genPin();
  const room = makeRoom(pin);
  const playerId = `${pin}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const player = makePlayer(playerId, ws, name, 0);
  room.players.set(playerId, player);
  room.hostId = playerId;
  rooms.set(pin, room);

  ws.roomPin = pin;
  ws.playerId = playerId;

  safeSend(ws, {
    type: 'created', pin, playerId,
    players: Array.from(room.players.values()).map(publicPlayer),
    hostId: room.hostId,
  });
}

function onJoin(ws, msg) {
  if (ws.roomPin) return safeSend(ws, { type: 'error', message: 'Already in a room.' });
  const pin = typeof msg.pin === 'string' ? msg.pin.trim() : '';
  if (!isValidPin(pin)) return safeSend(ws, { type: 'error', message: 'Enter a valid 4-digit PIN.' });

  const room = rooms.get(pin);
  if (!room) return safeSend(ws, { type: 'error', message: 'Room not found.' });
  if (room.state !== 'lobby') return safeSend(ws, { type: 'error', message: 'Race already in progress.' });
  if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
    return safeSend(ws, { type: 'error', message: 'Room is full.' });
  }

  const name = sanitizeName(msg.name);
  const playerId = `${pin}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const player = makePlayer(playerId, ws, name, room.players.size);
  room.players.set(playerId, player);
  room.emptySince = null;

  ws.roomPin = pin;
  ws.playerId = playerId;

  safeSend(ws, {
    type: 'joined', pin, playerId,
    players: Array.from(room.players.values()).map(publicPlayer),
    hostId: room.hostId,
  });
  broadcastRoom(room, { type: 'player_joined', player: publicPlayer(player) }, ws);
}

function onLeave(ws) {
  removePlayerFromRoom(ws);
  safeSend(ws, { type: 'left' });
}

function getRoomAndPlayer(ws) {
  if (!ws.roomPin || !ws.playerId) return {};
  const room = rooms.get(ws.roomPin);
  if (!room) return {};
  const player = room.players.get(ws.playerId);
  if (!player) return { room };
  return { room, player };
}

function onStart(ws) {
  const { room, player } = getRoomAndPlayer(ws);
  if (!room || !player) return;
  if (room.hostId !== player.id) {
    return safeSend(ws, { type: 'error', message: 'Only the host can start the race.' });
  }
  if (room.state === 'racing') return;

  for (const p of room.players.values()) {
    p.laps = 0;
    p.finished = false;
    p.finishTime = null;
    p.lastLapTime = 0;
  }
  room.finishOrder = [];
  room.state = 'racing';
  room.lastActivity = Date.now();

  const startTime = Date.now() + 3000; // 3s countdown on the client
  broadcastRoom(room, { type: 'race_start', startTime, totalLaps: TOTAL_LAPS });
}

function onRestart(ws) {
  const { room, player } = getRoomAndPlayer(ws);
  if (!room || !player) return;
  if (room.hostId !== player.id) {
    return safeSend(ws, { type: 'error', message: 'Only the host can reset the room.' });
  }
  for (const p of room.players.values()) {
    p.laps = 0;
    p.finished = false;
    p.finishTime = null;
    p.lastLapTime = 0;
  }
  room.finishOrder = [];
  room.state = 'lobby';
  broadcastRoom(room, roomLobbyPayload(room));
}

function onState(ws, msg) {
  const { room, player } = getRoomAndPlayer(ws);
  if (!room || !player) return;
  player.x = safeNum(msg.x, player.x, -1000, 1000);
  player.y = safeNum(msg.y, player.y, -100, 100);
  player.z = safeNum(msg.z, player.z, -1000, 1000);
  player.rotY = safeNum(msg.rotY, player.rotY, -1000, 1000);
  player.speed = safeNum(msg.speed, 0, -500, 500);
  player.lastUpdate = Date.now();
  room.lastActivity = Date.now();
}

function onLap(ws) {
  const { room, player } = getRoomAndPlayer(ws);
  if (!room || !player) return;
  if (room.state !== 'racing' || player.finished) return;
  const now = Date.now();
  if (now - player.lastLapTime < LAP_COOLDOWN_MS) return; // debounce
  player.lastLapTime = now;
  player.laps += 1;
  room.lastActivity = now;

  if (player.laps >= TOTAL_LAPS) {
    player.finished = true;
    player.finishTime = now;
    room.finishOrder.push(player.id);
  }

  broadcastRoom(room, {
    type: 'lap_update',
    id: player.id,
    laps: player.laps,
    finished: player.finished,
    rank: player.finished ? room.finishOrder.length : null,
  });

  const everyoneDone = Array.from(room.players.values()).every((p) => p.finished);
  if (everyoneDone && room.state === 'racing') {
    room.state = 'finished';
    const results = room.finishOrder.map((id, i) => {
      const p = room.players.get(id);
      return p ? { id: p.id, name: p.name, laps: p.laps, rank: i + 1, finishTime: p.finishTime } : null;
    }).filter(Boolean);
    broadcastRoom(room, { type: 'race_finished', results });
  }
}

// ---------------------------------------------------------------------------
// Background loops: state broadcast, heartbeat, room cleanup
// ---------------------------------------------------------------------------
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.players.size === 0) continue;
    const payload = {
      type: 'state_update',
      players: Array.from(room.players.values()).map(publicPlayer),
    };
    broadcastRoom(room, payload);
  }
}, STATE_TICK_MS);

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (e) { /* ignore */ }
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  });
}, HEARTBEAT_INTERVAL_MS);

setInterval(() => {
  const now = Date.now();
  for (const [pin, room] of rooms) {
    if (room.players.size === 0 && room.emptySince && now - room.emptySince > ROOM_EMPTY_GRACE_MS) {
      rooms.delete(pin);
      continue;
    }
    if (now - room.createdAt > ROOM_MAX_AGE_MS) {
      deleteRoom(pin, 'expired');
    }
  }
}, CLEANUP_INTERVAL_MS);

// Never let one bad message or edge case take the whole server down.
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));

server.listen(PORT, () => {
  console.log(`Pixel Race server listening on port ${PORT}`);
});
