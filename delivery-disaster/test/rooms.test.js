import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager, normalizeCode, cleanName, sanitizeState, CODE_LENGTH } from '../server/rooms.js';

test('room codes are unique, well-formed and unambiguous', () => {
  const m = new RoomManager();
  const codes = new Set();
  for (let i = 0; i < 300; i++) {
    const r = m.createRoom({ id: 'p' + i, name: 'x' });
    assert.match(r.code, /^[A-HJKMNP-Z2-9]{5}$/);
    assert.equal(r.code.length, CODE_LENGTH);
    codes.add(r.code);
  }
  assert.equal(codes.size, 300);
});

test('normalizeCode is forgiving about case/spaces but strict about length', () => {
  assert.equal(normalizeCode(' ab c-d2 '), 'ABCD2');
  assert.equal(normalizeCode('abc'), null);
  assert.equal(normalizeCode(null), null);
});

test('cleanName strips junk and limits length', () => {
  assert.equal(cleanName('  <b>Bob</b>\n'), 'bBob/b');   // angle brackets/control chars removed
});

test('cleanName edge cases', () => {
  assert.equal(cleanName('A'.repeat(40)).length, 16);
  assert.equal(cleanName(undefined), '');
  assert.equal(cleanName('a    b'), 'a b');
});

test('join: not found, invalid, full, duplicate names, slots', () => {
  const m = new RoomManager({ maxPlayers: 3 });
  const room = m.createRoom({ id: 'a', name: 'Sam' });
  assert.deepEqual(m.join('zzzzz', { id: 'b', name: 'x' }), { ok: false, error: 'ROOM_NOT_FOUND' });
  assert.deepEqual(m.join('ab', { id: 'b', name: 'x' }), { ok: false, error: 'INVALID_CODE' });
  const j = m.join(room.code.toLowerCase(), { id: 'b', name: 'Sam' });
  assert.ok(j.ok);
  assert.equal(j.player.name, 'Sam 2');
  assert.equal(j.player.slot, 1);
  assert.ok(m.join(room.code, { id: 'c', name: 'C' }).ok);
  assert.deepEqual(m.join(room.code, { id: 'd', name: 'D' }), { ok: false, error: 'ROOM_FULL' });
});

test('maxPlayers is capped at 12 even if configured higher', () => {
  assert.equal(new RoomManager({ maxPlayers: 50 }).maxPlayers, 12);
});

test('leave: slot is freed, host migrates, empty room is deleted', () => {
  const m = new RoomManager();
  const room = m.createRoom({ id: 'a', name: 'A' });
  m.join(room.code, { id: 'b', name: 'B' });
  m.join(room.code, { id: 'c', name: 'C' });
  const r1 = m.leave('a');
  assert.equal(r1.newHostId !== null, true);
  assert.equal(room.hostId, r1.newHostId);
  const nj = m.join(room.code, { id: 'd', name: 'D' });
  assert.equal(nj.player.slot, 0, 'lowest free slot is reused');
  m.leave('b'); m.leave('c');
  const last = m.leave('d');
  assert.equal(last.roomDeleted, true);
  assert.equal(m.stats().rooms, 0);
  assert.equal(m.leave('nobody'), null);
});

test('a player cannot be in two rooms', () => {
  const m = new RoomManager();
  const r1 = m.createRoom({ id: 'a', name: 'A' });
  const r2 = m.createRoom({ id: 'z', name: 'Z' });
  assert.equal(m.join(r2.code, { id: 'a', name: 'A' }).error, 'ALREADY_IN_ROOM');
  assert.equal(r1.players.size, 1);
});

test('sanitizeState clamps and rejects garbage', () => {
  assert.equal(sanitizeState(null), null);
  assert.equal(sanitizeState({ x: 'abc' }), null);
  assert.equal(sanitizeState({ x: NaN, y: 0, z: 0, yaw: 0, byaw: 0, pitch: 0, vx: 0, vz: 0 }), null);
  const s = sanitizeState({ x: 9999, y: 1, z: -9999, yaw: 1, byaw: 1, pitch: 9, vx: 500, vz: 0, g: true });
  assert.equal(s.x, 150); assert.equal(s.z, -150); assert.equal(s.pitch, 1.6); assert.equal(s.vx, 40);
  assert.equal(s.g, 1); assert.equal(s.r, 0);
});

test('collectDirty batches only changed players, then clears', () => {
  const m = new RoomManager();
  const room = m.createRoom({ id: 'a', name: 'A' });
  m.join(room.code, { id: 'b', name: 'B' });
  m.setState('a', { x: 1 });
  let d = m.collectDirty();
  assert.equal(d.length, 1);
  assert.deepEqual(Object.keys(d[0].players), ['a']);
  assert.equal(m.collectDirty().length, 0);
});
