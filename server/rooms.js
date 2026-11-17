// Pure room logic (no sockets in here) so it can be unit-tested.
'use strict';
const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const CODE_LENGTH = 5;
const WORLD_LIMIT = 100;
const MAX_CRATES = 64;
const PUNCH = {
  damage: 34,            // 3 clean hits = knocked out
  maxHp: 100,
  koMs: 5000,            // how long a knocked-out player stays down
  regenAfterMs: 4000,    // no hits for this long -> back to full health
  invulnMs: 1500,        // protection right after getting back up
  cooldownMs: 220,       // per attacker
  maxRange: 5,           // metres between the two players' last known positions (lag tolerant)
};
const REJOIN_GRACE = 60000;      // ms a dropped player may come back into a LOCKED room with their rejoin token
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
    const room = { code, players: new Map(), createdAt: Date.now(), hostId: id, crates: new Map(), locked: false, tokens: new Map() };
    this.rooms.set(code, room);
    return this._add(room, id, name);
  }

  // opts.admin: the caller has the admin code -> bypasses lock and player cap.
  // opts.token: rejoin token from an earlier visit (lets a dropped player back into a locked room).
  join(id, rawCode, name, opts = {}) {
    if (this.byPlayer.has(id)) return { error: 'ALREADY_IN_ROOM', message: 'Leave your current room first.' };
    const code = this.normaliseCode(rawCode);
    if (code.length !== CODE_LENGTH) return { error: 'BAD_CODE', message: 'Room codes have 5 letters/numbers.' };
    const room = this.rooms.get(code);
    if (!room) return { error: 'NOT_FOUND', message: `No room with code ${code}.` };
    if (room.locked && !opts.admin && !this.hasToken(room, opts.token)) return { error: 'ROOM_LOCKED', message: `Room ${code} is locked by its host.` };
    if (room.players.size >= this.maxPlayers && !opts.admin) return { error: 'ROOM_FULL', message: `Room ${code} is full (${this.maxPlayers}/${this.maxPlayers}).` };
    if (opts.token) room.tokens.delete(opts.token);                  // rejoin tokens are single-use; a fresh one is issued on entry
    return this._add(room, id, name);
  }

  _add(room, id, name) {
    const taken = new Set([...room.players.values()].map((p) => p.name.toLowerCase()));
    let base = cleanName(name, 'Courier');
    let final = base, n = 2;
    while (taken.has(final.toLowerCase())) final = `${base.slice(0, 13)} ${n++}`;
    const player = { id, name: final, joinedAt: Date.now(), state: null, dirty: false, lastStateAt: 0, lastCratesAt: 0,
      hp: PUNCH.maxHp, lastHitAt: 0, koUntil: 0, invulnUntil: 0, lastPunchAt: 0,
      token: crypto.randomBytes(12).toString('hex') };
    room.players.set(id, player);
    room.tokens.set(player.token, Infinity);
    this.byPlayer.set(id, room.code);
    return { room, player };
  }

  hasToken(room, token) {
    if (typeof token !== 'string') return false;
    const exp = room.tokens.get(token);
    if (exp === undefined) return false;
    if (exp < Date.now()) { room.tokens.delete(token); return false; }
    return true;
  }

  // Returns { room, player, closed } or null if the socket was not in a room.
  // `reason`: 'disconnected' keeps the rejoin token alive for a short grace period; anything else (left, kicked) revokes it.
  leave(id, reason = 'left') {
    const code = this.byPlayer.get(id);
    if (!code) return null;
    this.byPlayer.delete(id);
    const room = this.rooms.get(code);
    if (!room) return null;
    const player = room.players.get(id);
    const releasedCrates = this.releaseCrates(id, room);
    if (player && player.token) {
      if (reason === 'disconnected') room.tokens.set(player.token, Date.now() + REJOIN_GRACE);
      else room.tokens.delete(player.token);
    }
    room.players.delete(id);
    let closed = false;
    if (room.players.size === 0) { this.rooms.delete(code); closed = true; }
    else if (room.hostId === id) room.hostId = room.players.keys().next().value;
    return { room, player, closed, releasedCrates };
  }

  // ---- host / admin controls ----
  setLocked(room, locked) { room.locked = !!locked; return room.locked; }

  // Change a room's code (empty / null = random). Players stay in the room; the old code stops working.
  setCode(room, raw) {
    const oldCode = room.code;
    let code;
    if (raw == null || String(raw).trim() === '') code = this.generateCode();
    else {
      code = this.normaliseCode(raw);
      if (code.length !== CODE_LENGTH) return { error: 'BAD_CODE', message: 'Room codes have 5 letters/numbers.' };
    }
    if (code === oldCode) return { error: 'SAME_CODE', message: 'That is already the room code.' };
    if (this.rooms.has(code)) return { error: 'CODE_TAKEN', message: `Code ${code} is already used by another room.` };
    this.rooms.delete(oldCode);
    room.code = code;
    this.rooms.set(code, room);
    for (const pid of room.players.keys()) this.byPlayer.set(pid, code);
    return { room, oldCode, code };
  }

  // Admin overview: every room with its players.
  adminList() {
    return [...this.rooms.values()].map((r) => ({
      code: r.code, locked: r.locked, hostId: r.hostId, max: this.maxPlayers,
      players: [...r.players.values()].map((p) => ({ id: p.id, name: p.name })),
    }));
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

  // ---- punching: the server decides whether a punch counts (range, cooldowns, KO, invulnerability) ----
  // Returns null if rejected, otherwise { room, attacker, target, hp, ko, d:[x,z] }.
  punch(attackerId, targetId, now = Date.now()) {
    const room = this.roomOf(attackerId);
    if (!room || attackerId === targetId) return null;
    const a = room.players.get(attackerId), t = room.players.get(targetId);
    if (!a || !t) return null;
    if (now < a.koUntil) return null;                               // knocked-out players can't punch
    if (now - a.lastPunchAt < PUNCH.cooldownMs) return null;
    a.lastPunchAt = now;
    if (now < t.koUntil || now < t.invulnUntil) return null;       // already down / just got up
    if (!a.state || !t.state) return null;
    const dx = t.state[0] - a.state[0], dz = t.state[2] - a.state[2], dy = t.state[1] - a.state[1];
    const dist = Math.hypot(dx, dz);
    if (dist > PUNCH.maxRange || Math.abs(dy) > 3) return null;
    if (now - t.lastHitAt > PUNCH.regenAfterMs || t.hpResetOnWake) t.hp = PUNCH.maxHp;
    t.hpResetOnWake = false;
    t.hp -= PUNCH.damage;
    t.lastHitAt = now;
    let ko = false;
    if (t.hp <= 0) {
      ko = true;
      t.hp = 0;
      t.koUntil = now + PUNCH.koMs;
      t.invulnUntil = t.koUntil + PUNCH.invulnMs;
      t.hpResetOnWake = true;
    }
    const l = dist || 1;
    return { room, attacker: a, target: t, hp: t.hp, ko, d: [dx / l, dz / l] };
  }

  // Called by the server when a KO'd player's timer has passed (also lazily on the next hit).
  wake(room, id, now = Date.now()) {
    const p = room.players.get(id);
    if (p && p.hpResetOnWake && now >= p.koUntil) { p.hp = PUNCH.maxHp; p.hpResetOnWake = false; }
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

module.exports = { REJOIN_GRACE, PUNCH, RoomManager, MAX_CRATES, CODE_ALPHABET, CODE_LENGTH, cleanName };
