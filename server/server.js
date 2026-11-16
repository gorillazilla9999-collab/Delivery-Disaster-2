// Delivery Disaster - Express + Socket.IO server (serves the game AND multiplayer).
'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const compression = require('compression');
const { Server } = require('socket.io');
const { RoomManager } = require('./rooms');

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = '0.0.0.0';                                    // required by Render
const MAX_PLAYERS = Math.max(1, Math.min(12, parseInt(process.env.MAX_PLAYERS, 10) || 12));
const TICK_HZ = 20;
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '').trim();
const PUBLIC_SERVER_URL = (process.env.PUBLIC_SERVER_URL || '').trim().replace(/\/+$/, '');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(compression());

// ---- health check (point Render's Health Check Path at /healthz) ----
const rooms = new RoomManager({ maxPlayers: MAX_PLAYERS });
const startedAt = Date.now();
app.get(['/healthz', '/health'], (_req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: Math.round((Date.now() - startedAt) / 1000),
    rooms: rooms.rooms.size,
    players: rooms.byPlayer.size,
  });
});

// ---- runtime config for the browser (no secrets) ----
app.get('/config.js', (_req, res) => {
  res.type('application/javascript').set('Cache-Control', 'no-store');
  res.send(`window.DD_ENV = ${JSON.stringify({ serverUrl: PUBLIC_SERVER_URL, maxPlayers: MAX_PLAYERS })};`);
});

// ---- static game files (only the public folders; server code is never exposed) ----
app.get('/', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.get('/index.html', (_req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.use('/js', express.static(path.join(ROOT, 'js'), { maxAge: 0, etag: true }));
app.use('/css', express.static(path.join(ROOT, 'css'), { maxAge: 0, etag: true }));
app.use('/assets', express.static(path.join(ROOT, 'assets'), { maxAge: '1h', etag: true }));
app.use((_req, res) => res.status(404).type('text/plain').send('Not found'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: CORS_ORIGIN ? { origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',').map((s) => s.trim()) } : undefined,
  pingInterval: 10000,
  pingTimeout: 10000,
  maxHttpBufferSize: 1e4,                                   // packets are tiny; reject anything big
});

const emitRoster = (room) => io.to(room.code).emit('roster', {
  code: room.code, max: rooms.maxPlayers, hostId: room.hostId, players: rooms.publicPlayers(room),
});

io.on('connection', (socket) => {
  socket.emit('hello', { id: socket.id, maxPlayers: MAX_PLAYERS, serverTime: Date.now() });

  const enter = (res, ack) => {
    if (res.error) return ack?.({ ok: false, error: res.error, message: res.message });
    const { room, player } = res;
    socket.join(room.code);
    ack?.({ ok: true, code: room.code, you: socket.id, name: player.name, max: rooms.maxPlayers });
    socket.to(room.code).emit('player-joined', { id: player.id, name: player.name });
    emitRoster(room);
  };

  socket.on('create-room', (data, ack) => {
    if (typeof ack !== 'function') ack = null;
    try { enter(rooms.create(socket.id, data && data.name), ack); }
    catch (e) { console.error(e); ack?.({ ok: false, error: 'SERVER', message: 'Could not create room.' }); }
  });

  socket.on('join-room', (data, ack) => {
    if (typeof ack !== 'function') ack = null;
    try { enter(rooms.join(socket.id, data && data.code, data && data.name), ack); }
    catch (e) { console.error(e); ack?.({ ok: false, error: 'SERVER', message: 'Could not join room.' }); }
  });

  const leave = (reason) => {
    const res = rooms.leave(socket.id);
    if (!res) return;
    socket.leave(res.room.code);
    if (!res.closed) {
      io.to(res.room.code).emit('player-left', { id: socket.id, name: res.player && res.player.name, reason });
      emitRoster(res.room);
    }
  };

  socket.on('leave-room', (_d, ack) => { leave('left'); if (typeof ack === 'function') ack({ ok: true }); });
  socket.on('disconnect', () => leave('disconnected'));

  socket.on('state', (s) => { rooms.setState(socket.id, s); });

  // one-shot animations (poke etc.), relayed only inside the sender's room
  socket.on('action', (a) => {
    const room = rooms.roomOf(socket.id);
    if (!room || !a || (a.type !== 'poke')) return;
    const side = a.side === 'left' ? 'left' : 'right';
    socket.to(room.code).emit('action', { id: socket.id, type: 'poke', side });
  });

  socket.on('ping-check', (ack) => { if (typeof ack === 'function') ack(Date.now()); });
});

// ---- one batched snapshot per room per tick ----
setInterval(() => {
  const t = Date.now();
  for (const room of rooms.rooms.values()) {
    const snap = rooms.snapshot(room);
    if (snap) io.to(room.code).volatile.emit('snapshot', { t, p: snap });
  }
}, 1000 / TICK_HZ);

server.listen(PORT, HOST, () => {
  console.log(`Delivery Disaster server listening on http://${HOST}:${PORT} (max ${MAX_PLAYERS} players/room)`);
});

function shutdown() {
  console.log('Shutting down...');
  io.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
