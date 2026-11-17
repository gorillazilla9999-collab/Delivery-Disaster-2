// Delivery Disaster - Express + Socket.IO server (serves the game AND multiplayer).
'use strict';
// Load a local .env file if there is one (works on any Node version); real environment variables (e.g. on Render) win.
let ENV_FILE_LOADED = false;
try {
  const text = require('fs').readFileSync(require('path').join(__dirname, '..', '.env'), 'utf8').replace(/^\uFEFF/, '');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  ENV_FILE_LOADED = true;
} catch (_) { /* no .env file: fine */ }
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const compression = require('compression');
const { Server } = require('socket.io');
const { RoomManager, PUNCH } = require('./rooms');

const ROOT = path.join(__dirname, '..');
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = '0.0.0.0';                                    // required by Render
const MAX_PLAYERS = Math.max(1, Math.min(12, parseInt(process.env.MAX_PLAYERS, 10) || 12));
const TICK_HZ = 20;
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '').trim();
const PUBLIC_SERVER_URL = (process.env.PUBLIC_SERVER_URL || '').trim().replace(/\/+$/, '');

// ---- admin code: lets its holder join ANY room (even locked / full ones), kick players and change room codes ----
// Set ADMIN_CODE in the environment. If it is missing a random one is generated and printed in the server log.
// Fallback used when ADMIN_CODE is not set anywhere. Change it (or set ADMIN_CODE) before sharing the project/source publicly.
const DEFAULT_ADMIN_CODE = 'fdiugfigyeygiuehgewuhkgewiuh';
let ADMIN_CODE = (process.env.ADMIN_CODE || '').trim();
const ADMIN_FROM_ENV = !!ADMIN_CODE;
if (!ADMIN_CODE) ADMIN_CODE = DEFAULT_ADMIN_CODE;
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
const ADMIN_HASH = sha(ADMIN_CODE);
const checkAdminCode = (v) => typeof v === 'string' && v.length <= 200 && crypto.timingSafeEqual(sha(v), ADMIN_HASH);
const failures = new Map();                                 // ip -> { n, until }   (brute-force protection)

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
  code: room.code, max: rooms.maxPlayers, hostId: room.hostId, locked: room.locked, players: rooms.publicPlayers(room),
});

io.on('connection', (socket) => {
  socket.emit('hello', { id: socket.id, maxPlayers: MAX_PLAYERS, serverTime: Date.now() });
  socket.data.admin = false;
  const ip = String(socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '').split(',').pop().trim();

  const enter = (res, ack) => {
    if (res.error) return ack?.({ ok: false, error: res.error, message: res.message });
    const { room, player } = res;
    socket.join(room.code);
    ack?.({ ok: true, code: room.code, you: socket.id, name: player.name, max: rooms.maxPlayers, locked: room.locked, token: player.token, admin: socket.data.admin });
    socket.emit('crate-init', rooms.crateInit(room));                 // current state of every moved crate
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
    try { enter(rooms.join(socket.id, data && data.code, data && data.name, { admin: socket.data.admin, token: data && data.token }), ack); }
    catch (e) { console.error(e); ack?.({ ok: false, error: 'SERVER', message: 'Could not join room.' }); }
  });

  const leave = (reason) => {
    const res = rooms.leave(socket.id, reason);
    if (!res) return;
    socket.leave(res.room.code);
    if (!res.closed) {
      if (res.releasedCrates.length) io.to(res.room.code).emit('crates-released', res.releasedCrates);
      io.to(res.room.code).emit('player-left', { id: socket.id, name: res.player && res.player.name, reason });
      emitRoster(res.room);
    }
  };

  socket.on('leave-room', (_d, ack) => { leave('left'); if (typeof ack === 'function') ack({ ok: true }); });
  socket.on('disconnect', () => leave('disconnected'));

  // ---- host controls: the host (or an admin) can lock the room and change its code ----
  // data.target (admin only) lets an admin act on a room they are not inside.
  const controlledRoom = (data) => {
    if (socket.data.admin && data && data.target) return rooms.rooms.get(rooms.normaliseCode(data.target)) || null;
    const room = rooms.roomOf(socket.id);
    if (!room) return null;
    return (room.hostId === socket.id || socket.data.admin) ? room : null;
  };

  socket.on('room-set-lock', (data, ack) => {
    if (typeof ack !== 'function') ack = null;
    const room = controlledRoom(data);
    if (!room) return ack?.({ ok: false, message: 'Only the room host can do that.' });
    const locked = rooms.setLocked(room, data && data.locked);
    io.to(room.code).emit('room-lock', { locked });
    emitRoster(room);
    ack?.({ ok: true, locked });
  });

  socket.on('room-set-code', (data, ack) => {
    if (typeof ack !== 'function') ack = null;
    const room = controlledRoom(data);
    if (!room) return ack?.({ ok: false, message: 'Only the room host can do that.' });
    const res = rooms.setCode(room, data && data.newCode);
    if (res.error) return ack?.({ ok: false, message: res.message });
    // move every socket of the room onto the new Socket.IO channel
    io.in(res.oldCode).socketsJoin(res.code);
    io.in(res.oldCode).socketsLeave(res.oldCode);
    io.to(res.code).emit('room-code', { code: res.code, oldCode: res.oldCode });
    emitRoster(room);
    ack?.({ ok: true, code: res.code });
  });

  // ---- admin ----
  socket.on('admin-login', (data, ack) => {
    if (typeof ack !== 'function') ack = null;
    const f = failures.get(ip) || { n: 0, until: 0 };
    if (Date.now() < f.until) return ack?.({ ok: false, message: 'Too many wrong codes. Wait a bit and try again.' });
    if (!checkAdminCode(data && data.code)) {
      const typed = data && typeof data.code === 'string' ? data.code : '';
      console.log(`Admin login FAILED: you typed ${typed.length} characters, the server expects ${ADMIN_CODE.length} (${ADMIN_FROM_ENV ? 'from ADMIN_CODE' : 'built-in default'}).`);
      f.n++; if (f.n >= 5) { f.until = Date.now() + 30000; f.n = 0; }
      failures.set(ip, f);
      return ack?.({ ok: false, message: 'Wrong admin code.' });
    }
    failures.delete(ip);
    socket.data.admin = true;
    ack?.({ ok: true });
  });

  socket.on('admin-logout', (_d, ack) => { socket.data.admin = false; if (typeof ack === 'function') ack({ ok: true }); });

  socket.on('admin-rooms', (_d, ack) => {
    if (typeof ack !== 'function') return;
    if (!socket.data.admin) return ack({ ok: false, message: 'Not an admin.' });
    ack({ ok: true, rooms: rooms.adminList() });
  });

  socket.on('admin-kick', (data, ack) => {
    if (typeof ack !== 'function') ack = null;
    if (!socket.data.admin) return ack?.({ ok: false, message: 'Not an admin.' });
    const id = data && typeof data.id === 'string' ? data.id : '';
    if (!id || id === socket.id) return ack?.({ ok: false, message: 'You cannot kick yourself (use Leave Room).' });
    const target = io.sockets.sockets.get(id);
    const res = rooms.leave(id, 'kicked');
    if (!res) return ack?.({ ok: false, message: 'That player is no longer in a room.' });
    if (target) { target.emit('kicked', { code: res.room.code }); target.leave(res.room.code); }
    if (!res.closed) {
      if (res.releasedCrates.length) io.to(res.room.code).emit('crates-released', res.releasedCrates);
      io.to(res.room.code).emit('player-left', { id, name: res.player && res.player.name, reason: 'kicked' });
      emitRoster(res.room);
    }
    ack?.({ ok: true, name: res.player && res.player.name });
  });

  // ---- text chat: validated + rate limited by the server, relayed to everyone in the room (sender included) ----
  socket.on('chat', (data, ack) => {
    if (typeof ack !== 'function') ack = null;
    const res = rooms.chat(socket.id, data && data.text);
    if (res.error) return ack?.({ ok: false, message: res.message });
    io.to(res.room.code).emit('chat', {
      id: socket.id, name: res.player.name, text: res.text, t: Date.now(),
      host: res.room.hostId === socket.id, admin: !!socket.data.admin,
    });
    ack?.({ ok: true });
  });

  socket.on('state', (s) => { rooms.setState(socket.id, s); });

  // one-shot animations (poke etc.), relayed only inside the sender's room
  socket.on('action', (a) => {
    const room = rooms.roomOf(socket.id);
    if (!room || !a || (a.type !== 'poke')) return;
    const side = a.side === 'left' ? 'left' : 'right';
    socket.to(room.code).emit('action', { id: socket.id, type: 'poke', side });
  });

  // punches: the server validates the hit, then tells the whole room (victim reacts, everyone sees the effect)
  socket.on('punch', (d) => {
    if (!d || typeof d.to !== 'string') return;
    const res = rooms.punch(socket.id, d.to);
    if (!res) return;
    io.to(res.room.code).emit('hit', {
      from: socket.id, to: res.target.id, d: res.d, hp: res.hp, ko: res.ko, koMs: PUNCH.koMs,
      fromName: res.attacker.name, toName: res.target.name,
    });
  });

  // crates: only the current owner's updates are accepted; accepted ones are relayed to everybody else in the room
  socket.on('crates', (entries) => {
    const room = rooms.roomOf(socket.id);
    if (!room) return;
    const accepted = rooms.crateUpdate(socket.id, entries);
    if (accepted.length) socket.to(room.code).emit('crates', { t: Date.now(), from: socket.id, c: accepted });
  });

  // poking a crate somebody else is simulating: forward the impulse to its owner
  socket.on('crate-impulse', (d) => {
    const room = rooms.roomOf(socket.id);
    if (!room || !d || !Array.isArray(d.d)) return;
    const idx = Number(d.idx) | 0;
    const owner = rooms.crateOwner(room, idx);
    if (!owner || owner === socket.id) return;
    const v = d.d.slice(0, 3).map((n) => (Number.isFinite(+n) ? Math.max(-1, Math.min(1, +n)) : 0));
    // optional world-space point of impact (so off-centre hits spin the crate)
    const p = Array.isArray(d.p) && d.p.length >= 3 ? d.p.slice(0, 3).map((n) => (Number.isFinite(+n) ? Math.max(-200, Math.min(200, +n)) : 0)) : undefined;
    io.to(owner).emit('crate-impulse', { idx, d: v, m: Math.max(0, Math.min(150, Number(d.m) || 0)), p });
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
  console.log(`.env file: ${ENV_FILE_LOADED ? 'loaded' : 'not found (using real environment variables only)'}`);
  if (ADMIN_FROM_ENV) console.log(`Admin code: set via ADMIN_CODE (${ADMIN_CODE.length} characters).`);
  else console.log('Admin code: ADMIN_CODE not set, using the built-in default from server/server.js.');
  console.log('Server build: admin-v4');
});

function shutdown() {
  console.log('Shutting down...');
  io.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
