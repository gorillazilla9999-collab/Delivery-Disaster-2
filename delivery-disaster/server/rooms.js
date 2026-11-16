// Pure room logic (no Socket.IO, no Express) so it can be unit-tested on its own.
import { randomInt } from 'node:crypto';

// No 0/O/1/I/L so codes are easy to read out loud.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 5;
export const MAX_NAME_LENGTH = 16;

export function normalizeCode(raw) {
  const code = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length === CODE_LENGTH ? code : null;
}

export function cleanName(raw) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>&"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

const num = (v, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
};
const r3 = (n) => Math.round(n * 1000) / 1000;

// Validates + clamps a client movement packet. Returns null if it is garbage.
export function sanitizeState(s) {
  if (!s || typeof s !== 'object') return null;
  const x = num(s.x, -150, 150), y = num(s.y, -5, 150), z = num(s.z, -150, 150);
  const yaw = num(s.yaw, -1e4, 1e4), byaw = num(s.byaw, -1e4, 1e4), pitch = num(s.pitch, -1.6, 1.6);
  const vx = num(s.vx, -40, 40), vz = num(s.vz, -40, 40);
  if ([x, y, z, yaw, byaw, pitch, vx, vz].some((v) => v === null)) return null;
  return {
    x: r3(x), y: r3(y), z: r3(z),
    yaw: r3(yaw), byaw: r3(byaw), pitch: r3(pitch),
    vx: r3(vx), vz: r3(vz),
    g: s.g ? 1 : 0, r: s.r ? 1 : 0, e: s.e ? 1 : 0,
  };
}

export class RoomManager {
  constructor({ maxPlayers = 12 } = {}) {
    this.maxPlayers = Math.min(12, Math.max(1, maxPlayers));
    this.rooms = new Map();        // code -> room
    this.playerRoom = new Map();   // socket id -> code
  }

  _newCode() {
    for (let i = 0; i < 1000; i++) {
      let code = '';
      for (let j = 0; j < CODE_LENGTH; j++) code += ALPHABET[randomInt(ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('Could not generate a unique room code');
  }

  _uniqueName(room, wanted) {
    const base = wanted || 'Courier';
    const taken = new Set([...room.players.values()].map((p) => p.name.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; n < 100; n++) {
      const candidate = `${base.slice(0, MAX_NAME_LENGTH - 3)} ${n}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return base;
  }

  _lowestFreeSlot(room) {
    const used = new Set([...room.players.values()].map((p) => p.slot));
    for (let i = 0; i < this.maxPlayers; i++) if (!used.has(i)) return i;
    return -1;
  }

  _addPlayer(room, id, name) {
    const player = {
      id, name: this._uniqueName(room, name),
      slot: this._lowestFreeSlot(room), joinedAt: Date.now(), state: null,
    };
    room.players.set(id, player);
    this.playerRoom.set(id, room.code);
    return player;
  }

  createRoom({ id, name }) {
    const room = { code: this._newCode(), players: new Map(), hostId: id, dirty: new Set() };
    this.rooms.set(room.code, room);
    this._addPlayer(room, id, name);
    return room;
  }

  // -> { ok:true, room, player } | { ok:false, error }
  join(rawCode, { id, name }) {
    const code = normalizeCode(rawCode);
    if (!code) return { ok: false, error: 'INVALID_CODE' };
    const room = this.rooms.get(code);
    if (!room) return { ok: false, error: 'ROOM_NOT_FOUND' };
    if (room.players.size >= this.maxPlayers) return { ok: false, error: 'ROOM_FULL' };
    if (this.playerRoom.has(id)) return { ok: false, error: 'ALREADY_IN_ROOM' };
    const player = this._addPlayer(room, id, name);
    return { ok: true, room, player };
  }

  // Removes a player (leave or disconnect). Deletes the room when empty; migrates the host.
  leave(id) {
    const code = this.playerRoom.get(id);
    if (!code) return null;
    this.playerRoom.delete(id);
    const room = this.rooms.get(code);
    if (!room) return null;
    const player = room.players.get(id);
    room.players.delete(id);
    room.dirty.delete(id);
    if (room.players.size === 0) {
      this.rooms.delete(code);
      return { room, player, roomDeleted: true, newHostId: null };
    }
    let newHostId = null;
    if (room.hostId === id) {
      const next = [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt || a.slot - b.slot)[0];
      room.hostId = next.id;
      newHostId = next.id;
    }
    return { room, player, roomDeleted: false, newHostId };
  }

  getRoomOf(id) {
    const code = this.playerRoom.get(id);
    return code ? this.rooms.get(code) || null : null;
  }

  listPlayers(room) {
    return [...room.players.values()]
      .sort((a, b) => a.slot - b.slot)
      .map((p) => ({ id: p.id, name: p.name, slot: p.slot, host: p.id === room.hostId }));
  }

  setState(id, state) {
    const room = this.getRoomOf(id);
    if (!room) return false;
    const p = room.players.get(id);
    p.state = state;
    room.dirty.add(id);
    return true;
  }

  // Returns [{ room, players: { id: state } }] for rooms that changed, and clears the dirty sets.
  collectDirty() {
    const out = [];
    for (const room of this.rooms.values()) {
      if (room.dirty.size === 0) continue;
      const players = {};
      for (const id of room.dirty) {
        const p = room.players.get(id);
        if (p && p.state) players[id] = p.state;
      }
      room.dirty.clear();
      if (Object.keys(players).length) out.push({ room, players });
    }
    return out;
  }

  stats() {
    return { rooms: this.rooms.size, players: this.playerRoom.size };
  }
}
