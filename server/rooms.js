// Pure room logic (no sockets in here) so it can be unit-tested.
'use strict';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const CODE_LENGTH = 5;
const WORLD_LIMIT = 100;
const MAX_CRATES = 64;
const OWNER_TIMEOUT = 800;      // ms without updates before another player may take a crate over

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
    const room = { code, players: new Map(), createdAt: Date.now(), hostId: id, crates: new Map() };
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
    const player = { id, name: final, joinedAt: Date.now(), state: null, dirty: false, lastStateAt: 0, lastCratesAt: 0 };
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
    const releasedCrates = this.releaseCrates(id, room);
    room.players.delete(id);
    let closed = false;
    if (room.players.size === 0) { this.rooms.delete(code); closed = true; }
    else if (room.hostId === id) room.hostId = room.players.keys().next().value;
    return { room, player, closed, releasedCrates };
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

  // ---- shared objects (crates): per-crate ownership. The owner simulates and streams; others follow. ----
  // entry: [idx, x, y, z, vx, vy, vz, release(0|1)].  Returns the accepted entries (to relay to the room).
  crateUpdate(id, entries, now = Date.now()) {
    const room = this.roomOf(id);
    const p = room && room.players.get(id);
    if (!p || !Array.isArray(entries)) return [];
    if (now - p.lastCratesAt < 15) return [];
    p.lastCratesAt = now;
    const accepted = [];
    for (const e of entries.slice(0, MAX_CRATES)) {
      if (!Array.isArray(e) || e.length < 8) continue;
      const idx = Number(e[0]) | 0;
      if (idx < 0 || idx >= MAX_CRATES) continue;
      const c = room.crates.get(idx) || { s: null, owner: null, at: 0 };
      const ownedByOther = c.owner && c.owner !== id && room.players.has(c.owner) && now - c.at <= OWNER_TIMEOUT;
      if (ownedByOther) continue;
      c.s = [
        clampNum(e[1], -WORLD_LIMIT, WORLD_LIMIT), clampNum(e[2], -5, 100), clampNum(e[3], -WORLD_LIMIT, WORLD_LIMIT),
        clampNum(e[4], -60, 60), clampNum(e[5], -60, 60), clampNum(e[6], -60, 60),
      ];
      c.at = now;
      const rel = e[7] === 1;
      c.owner = rel ? null : id;
      room.crates.set(idx, c);
      accepted.push([idx, ...c.s, rel ? 1 : 0]);
    }
    return accepted;
  }

  releaseCrates(id, room = this.roomOf(id)) {
    const out = [];
    if (!room) return out;
    for (const [idx, c] of room.crates) if (c.owner === id) { c.owner = null; out.push(idx); }
    return out;
  }

  crateOwner(room, idx) { const c = room.crates.get(idx); return c ? c.owner : null; }

  // everything a late joiner needs: [idx, x,y,z, vx,vy,vz, ownerId|null]
  crateInit(room) {
    const out = [];
    for (const [idx, c] of room.crates) if (c.s) out.push([idx, ...c.s, c.owner]);
    return out;
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

module.exports = { RoomManager, MAX_CRATES, CODE_ALPHABET, CODE_LENGTH, cleanName };
