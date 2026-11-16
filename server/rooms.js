// Pure room logic (no sockets in here) so it can be unit-tested.
'use strict';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const CODE_LENGTH = 5;
const WORLD_LIMIT = 100;

function clampNum(v, lo, hi, fallback = 0) {
  v = Number(v);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, v));
}

function cleanName(raw, fallback) {
  const s = String(raw ?? '').replace(/[^\p{L}\p{N} _\-.]/gu, '').trim().slice(0, 16);
  return s || fallback;
}

class RoomManager {
  constructor({ maxPlayers = 12 } = {}) {
    this.maxPlayers = Math.max(1, Math.min(12, maxPlayers | 0 || 12));
    this.rooms = new Map();          // code -> Room
    this.byPlayer = new Map();       // socketId -> code
  }

  generateCode() {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let c = '';
      for (let i = 0; i < CODE_LENGTH; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
    throw new Error('Could not generate a unique room code');
  }

  normaliseCode(code) {
    return String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
  }

  create(id, name) {
    if (this.byPlayer.has(id)) return { error: 'ALREADY_IN_ROOM', message: 'Leave your current room first.' };
    const code = this.generateCode();
    const room = { code, players: new Map(), createdAt: Date.now(), hostId: id };
    this.rooms.set(code, room);
    return this._add(room, id, name);
  }

  join(id, rawCode, name) {
    if (this.byPlayer.has(id)) return { error: 'ALREADY_IN_ROOM', message: 'Leave your current room first.' };
    const code = this.normaliseCode(rawCode);
    if (code.length !== CODE_LENGTH) return { error: 'BAD_CODE', message: 'Room codes have 5 letters/numbers.' };
    const room = this.rooms.get(code);
    if (!room) return { error: 'NOT_FOUND', message: `No room with code ${code}.` };
    if (room.players.size >= this.maxPlayers) return { error: 'ROOM_FULL', message: `Room ${code} is full (${this.maxPlayers}/${this.maxPlayers}).` };
    return this._add(room, id, name);
  }

  _add(room, id, name) {
    const taken = new Set([...room.players.values()].map((p) => p.name.toLowerCase()));
    let base = cleanName(name, 'Courier');
    let final = base, n = 2;
    while (taken.has(final.toLowerCase())) final = `${base.slice(0, 13)} ${n++}`;
    const player = { id, name: final, joinedAt: Date.now(), state: null, dirty: false, lastStateAt: 0 };
    room.players.set(id, player);
    this.byPlayer.set(id, room.code);
    return { room, player };
  }

  // Returns { room, player, closed } or null if the socket was not in a room.
  leave(id) {
    const code = this.byPlayer.get(id);
    if (!code) return null;
    this.byPlayer.delete(id);
    const room = this.rooms.get(code);
    if (!room) return null;
    const player = room.players.get(id);
    room.players.delete(id);
    let closed = false;
    if (room.players.size === 0) { this.rooms.delete(code); closed = true; }
    else if (room.hostId === id) room.hostId = room.players.keys().next().value;
    return { room, player, closed };
  }

  roomOf(id) {
    const code = this.byPlayer.get(id);
    return code ? this.rooms.get(code) : null;
  }

  // state packet: [x, y, z, yaw, pitch, speed, vy, flags]; flags bit0 grounded, bit1 reaching
  setState(id, s, now = Date.now()) {
    const room = this.roomOf(id);
    if (!room) return false;
    const p = room.players.get(id);
    if (!p || !Array.isArray(s) || s.length < 8) return false;
    if (now - p.lastStateAt < 20) return false;            // rate limit ~50/s
    p.lastStateAt = now;
    p.state = [
      clampNum(s[0], -WORLD_LIMIT, WORLD_LIMIT),
      clampNum(s[1], -50, 200),
      clampNum(s[2], -WORLD_LIMIT, WORLD_LIMIT),
      clampNum(s[3], -1e4, 1e4),
      clampNum(s[4], -1.6, 1.6),
      clampNum(s[5], 0, 30),
      clampNum(s[6], -60, 60),
      clampNum(s[7], 0, 3) | 0,
    ];
    p.dirty = true;
    return true;
  }

  publicPlayers(room) {
    return [...room.players.values()].map((p) => ({ id: p.id, name: p.name, state: p.state }));
  }

  // Builds the per-room snapshot (only players whose state changed or who are new)
  snapshot(room) {
    const out = {};
    let any = false;
    for (const p of room.players.values()) {
      if (p.state && p.dirty) { out[p.id] = p.state; p.dirty = false; any = true; }
    }
    return any ? out : null;
  }
}

module.exports = { RoomManager, CODE_ALPHABET, CODE_LENGTH, cleanName };
