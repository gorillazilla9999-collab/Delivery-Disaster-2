// Unit tests for room logic: node server/test-rooms.js
'use strict';
const assert = require('assert');
const { RoomManager } = require('./rooms');

const m = new RoomManager({ maxPlayers: 12 });
const a = m.create('A', 'Alice');
assert.ok(a.room && /^[A-HJ-NP-Z2-9]{5}$/.test(a.room.code), 'code format');
const code = a.room.code;

// join up to 12, 13th rejected
for (let i = 1; i < 12; i++) assert.ok(m.join('P' + i, code.toLowerCase(), 'Alice').room, 'join ' + i);
assert.strictEqual(m.rooms.get(code).players.size, 12);
assert.strictEqual(m.join('X', code, 'Late').error, 'ROOM_FULL');
// duplicate names get unique
const names = [...m.rooms.get(code).players.values()].map((p) => p.name);
assert.strictEqual(new Set(names.map((n) => n.toLowerCase())).size, 12, 'unique names');
// bad / unknown codes
assert.strictEqual(m.join('Y', 'zz', 'n').error, 'BAD_CODE');
assert.strictEqual(m.join('Y', 'ABCDE', 'n').error, 'NOT_FOUND');
// cannot be in two rooms
assert.strictEqual(m.create('A', 'x').error, 'ALREADY_IN_ROOM');
// leave frees a slot
const l = m.leave('P3'); assert.ok(l && !l.closed);
assert.ok(m.join('X', code, 'Late').room, 'slot freed');

// room isolation
const b = m.create('B', 'Bob');
assert.notStrictEqual(b.room.code, code);
const now = 1000;
assert.ok(m.setState('B', [1, 0, 2, 0.5, 0, 3, 0, 1], now));
assert.ok(m.setState('A', [9, 0, 9, 0, 0, 0, 0, 1], now));
const snapB = m.snapshot(b.room);
assert.deepStrictEqual(Object.keys(snapB), ['B'], 'room B snapshot only holds B');
assert.ok(!('A' in snapB));
assert.strictEqual(m.snapshot(b.room), null, 'no dirty -> no snapshot');

// state validation / clamping / rate limit
assert.strictEqual(m.setState('B', [1, 0, 2, 0, 0, 0, 0, 0], now + 5), false, 'rate limited');
assert.strictEqual(m.setState('B', ['x'], now + 100), false, 'malformed');
m.setState('B', [1e9, NaN, -1e9, 0, 99, 0, 0, 1], now + 200);
const st = m.rooms.get(b.room.code).players.get('B').state;
assert.strictEqual(st[0], 100); assert.strictEqual(st[1], 0); assert.strictEqual(st[2], -100); assert.strictEqual(st[4], 1.6);

// room closes when empty; host migrates
const c = m.create('C', 'C1'); m.join('D', c.room.code, 'D1');
m.leave('C'); assert.strictEqual(m.rooms.get(c.room.code).hostId, 'D');
assert.ok(m.leave('D').closed); assert.ok(!m.rooms.has(c.room.code));
assert.strictEqual(m.leave('nobody'), null);

// codes are unique across many rooms
const m2 = new RoomManager(); const seen = new Set();
for (let i = 0; i < 2000; i++) { const r = m2.create('s' + i, 'n'); assert.ok(!seen.has(r.room.code)); seen.add(r.room.code); }
console.log('All room tests passed.');
