// Socket.IO wiring for vehicles. Kept out of server.js so it can be tested with fake sockets (test/vehicle-sync.test.mjs).
// All decisions are made by server/vehicles.js; this file only validates the shape of messages and relays results.
'use strict';
const V = require('./vehicles');

const roomOf = (rooms, socket) => rooms.roomOf(socket.id);
const idOf = (d) => (d && typeof d.id === 'string' ? d.id.slice(0, 32) : '');

// tell everybody in the room who drives / owns a vehicle now (info comes from V.describe)
function broadcastInfo(io, room, info) {
  if (info) io.to(room.code).emit('vehicle-driver', { ...info, t: Date.now() });
}
function broadcastChanges(io, room, changes) {
  for (const info of changes || []) broadcastInfo(io, room, info);
}

function registerVehicleHandlers({ io, socket, rooms }) {
  const ackFn = (a) => (typeof a === 'function' ? a : () => {});

  socket.on('vehicle-enter', (d, ack) => {
    ack = ackFn(ack);
    const room = roomOf(rooms, socket);
    if (!room) return ack({ ok: false, message: 'Join a room first.' });
    const res = V.enter(room, socket.id, idOf(d));
    if (!res.ok) return ack({ ok: false, error: res.error, message: res.message });
    ack({ ok: true, info: res.info });
    broadcastInfo(io, room, res.info);
  });

  socket.on('vehicle-exit', (d, ack) => {
    ack = ackFn(ack);
    const room = roomOf(rooms, socket);
    if (!room) return ack({ ok: false });
    const res = V.exit(room, socket.id, idOf(d));
    if (!res.ok) return ack({ ok: false, error: res.error, message: res.message });
    ack({ ok: true, info: res.info });
    broadcastInfo(io, room, res.info);
  });

  // the owner streams the car's state; everybody else in the room receives it. Anybody else's updates are dropped.
  socket.on('vehicle-state', (d) => {
    const room = roomOf(rooms, socket);
    if (!room || !d) return;
    const res = V.update(room, socket.id, idOf(d), d.s);
    if (res.ok) socket.to(room.code).emit('vehicle-state', { t: Date.now(), id: res.vehicle.id, from: socket.id, s: res.s });
    else if (res.error === 'NOT_OWNER') socket.emit('vehicle-denied', { id: idOf(d), owner: (room.vehicles.get(idOf(d)) || {}).owner || null });
    else if (res.error === 'TELEPORT' || res.error === 'RESET_RATE') socket.emit('vehicle-denied', { id: idOf(d), owner: socket.id, resync: room.vehicles.get(idOf(d)) && room.vehicles.get(idOf(d)).s });
  });

  socket.on('vehicle-release', (d, ack) => {
    ack = ackFn(ack);
    const room = roomOf(rooms, socket);
    if (!room || !d) return ack({ ok: false });
    const res = V.release(room, socket.id, idOf(d), d.s);
    if (!res.ok) return ack({ ok: false, error: res.error });
    ack({ ok: true });
    broadcastInfo(io, room, res.info);
  });

  socket.on('vehicle-claim', (d, ack) => {
    ack = ackFn(ack);
    const room = roomOf(rooms, socket);
    if (!room) return ack({ ok: false });
    const res = V.claim(room, socket.id, idOf(d));
    if (!res.ok) return ack({ ok: false, owner: res.owner || null });
    ack({ ok: true });
    broadcastInfo(io, room, res.info);
  });
}

module.exports = { registerVehicleHandlers, broadcastInfo, broadcastChanges };
