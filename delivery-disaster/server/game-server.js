// All Socket.IO event handling. Takes an `io` instance so tests can pass an in-memory fake.
import { RoomManager, cleanName, sanitizeState } from './rooms.js';

export function attachGameServer(io, options = {}) {
  const maxPlayers = Math.min(12, Math.max(1, options.maxPlayers ?? 12));
  const tickMs = options.tickMs ?? 50;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const rooms = new RoomManager({ maxPlayers });

  const reply = (ack, payload) => { if (typeof ack === 'function') ack(payload); };

  // Simple fixed-window rate limiter, per socket per key.
  function allow(socket, key, limit, windowMs) {
    const rl = (socket.data.rl ??= {});
    const t = now();
    let b = rl[key];
    if (!b || t - b.start >= windowMs) b = rl[key] = { start: t, count: 0 };
    b.count++;
    return b.count <= limit;
  }

  const roomView = (room) => ({
    code: room.code,
    hostId: room.hostId,
    maxPlayers,
    players: rooms.listPlayers(room),
  });

  function broadcastUpdate(room, event) {
    io.to(room.code).emit('room:update', { ...roomView(room), event });
  }

  function removeFromRoom(socket, reason) {
    const res = rooms.leave(socket.id);
    if (!res) return;
    if (socket.leave) socket.leave(res.room.code);
    log(`[room ${res.room.code}] ${res.player?.name} left (${reason}); ${res.room.players.size} remaining`);
    if (!res.roomDeleted) {
      broadcastUpdate(res.room, {
        type: 'leave', id: res.player.id, name: res.player.name, reason, newHostId: res.newHostId,
      });
    } else {
      log(`[room ${res.room.code}] closed (empty)`);
    }
  }

  io.on('connection', (socket) => {
    socket.data.rl = {};

    socket.on('net:ping', (_p, ack) => reply(ack, now()));

    socket.on('room:create', (payload, ack) => {
      if (!allow(socket, 'roomop', 10, 10000)) return reply(ack, { ok: false, error: 'RATE_LIMIT' });
      if (rooms.getRoomOf(socket.id)) return reply(ack, { ok: false, error: 'ALREADY_IN_ROOM' });
      const room = rooms.createRoom({ id: socket.id, name: cleanName(payload?.name) });
      socket.join(room.code);
      const me = room.players.get(socket.id);
      log(`[room ${room.code}] created by ${me.name}`);
      reply(ack, { ok: true, you: socket.id, ...roomView(room) });
    });

    socket.on('room:join', (payload, ack) => {
      if (!allow(socket, 'roomop', 10, 10000)) return reply(ack, { ok: false, error: 'RATE_LIMIT' });
      const res = rooms.join(payload?.code, { id: socket.id, name: cleanName(payload?.name) });
      if (!res.ok) return reply(ack, { ok: false, error: res.error });
      socket.join(res.room.code);
      log(`[room ${res.room.code}] ${res.player.name} joined (${res.room.players.size}/${maxPlayers})`);
      reply(ack, { ok: true, you: socket.id, ...roomView(res.room) });
      socket.to(res.room.code).emit('room:update', {
        ...roomView(res.room),
        event: { type: 'join', id: res.player.id, name: res.player.name },
      });
    });

    socket.on('room:leave', (_p, ack) => {
      removeFromRoom(socket, 'left');
      reply(ack, { ok: true });
    });

    socket.on('player:state', (payload) => {
      if (!allow(socket, 'state', 60, 1000)) return;
      if (!rooms.getRoomOf(socket.id)) return;
      const clean = sanitizeState(payload);
      if (!clean) return;
      clean.ts = now();
      rooms.setState(socket.id, clean);
    });

    socket.on('player:action', (payload) => {
      if (!allow(socket, 'action', 20, 1000)) return;
      const room = rooms.getRoomOf(socket.id);
      if (!room || !payload || payload.type !== 'poke') return;
      const side = payload.side === 'left' ? 'left' : 'right';
      socket.to(room.code).emit('player:action', { id: socket.id, type: 'poke', side });
    });

    socket.on('disconnect', (reason) => {
      const label = reason === 'client namespace disconnect' || reason === 'server namespace disconnect'
        ? 'left' : 'connection lost';
      removeFromRoom(socket, label);
    });
  });

  // Batched snapshots: one message per room per tick instead of one per player update.
  const timer = setInterval(() => {
    for (const { room, players } of rooms.collectDirty()) {
      io.to(room.code).volatile.emit('snap', { players });
    }
  }, tickMs);
  if (timer.unref) timer.unref();

  return { rooms, stop: () => clearInterval(timer) };
}
