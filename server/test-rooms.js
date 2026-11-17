// Unit tests for room logic: node server/test-rooms.js
'use strict';
const assert = require('assert');
const { PUNCH, RoomManager } = require('./rooms');

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

// ---- crate ownership ----
{
  const m = new RoomManager();
  const a = m.create('A', 'A'); const code = a.room.code; m.join('B', code, 'B');
  let t = 10000;
  let acc = m.crateUpdate('A', [[3, 1, 0, 2, 4, 0, 0, 0]], t);
  assert.strictEqual(acc.length, 1, 'A claims free crate 3');
  assert.strictEqual(m.crateUpdate('B', [[3, 9, 0, 9, 0, 0, 0, 0]], t + 50).length, 0, 'B cannot take owned crate');
  assert.strictEqual(m.crateUpdate('A', [[3, 2, 0, 2, 0, 0, 0, 1]], t + 100).length, 1, 'A releases');
  assert.strictEqual(m.crateOwner(a.room, 3), null);
  assert.strictEqual(m.crateUpdate('B', [[3, 5, 0, 5, 1, 0, 0, 0]], t + 200).length, 1, 'B can take released crate');
  assert.strictEqual(m.crateUpdate('A', [[3, 0, 0, 0, 0, 0, 0, 0]], t + 300).length, 0, 'A blocked while B active');
  assert.strictEqual(m.crateUpdate('A', [[3, 0, 0, 0, 0, 0, 0, 0]], t + 2000).length, 1, 'stale owner can be taken over');
  assert.strictEqual(m.crateUpdate('A', [[99, 0, 0, 0, 0, 0, 0, 0]], t + 3000).length, 0, 'bad index rejected');
  assert.strictEqual(m.crateUpdate('A', [[2, 1, 0, 1, 0, 0, 0, 0]], t + 3005).length, 0, 'rate limited');
  m.crateUpdate('A', [[2, 1, 0, 1, 0, 0, 0, 0]], t + 3100);
  const init = m.crateInit(a.room); assert.ok(init.length >= 2 && init.find((e) => e[0] === 2)[7] === 'A', 'late-joiner init carries owners');
  // orientation + spin ride along with the state (and are normalised / clamped by the server)
  const rotAcc = m.crateUpdate('A', [[2, 1, 0, 1, 0, 0, 0, 0, 0, 0, 2, 2, 0.5, 100, 0]], t + 3200);
  assert.strictEqual(rotAcc.length, 1, 'rotation entry accepted');
  const qa = rotAcc[0].slice(8, 12), ql = Math.hypot(...qa);
  assert.ok(Math.abs(ql - 1) < 1e-9 && rotAcc[0].length === 15, 'quaternion normalised, 15 numbers relayed');
  assert.strictEqual(rotAcc[0][13], 40, 'spin clamped');
  const init2 = m.crateInit(a.room).find((e) => e[0] === 2);
  assert.ok(init2.length === 15 && init2[7] === 'A', 'late joiners get the orientation too');
  const l = m.leave('A'); assert.ok(l.releasedCrates.includes(2) && l.releasedCrates.includes(3), 'leaving releases owned crates');
  assert.strictEqual(m.crateOwner(a.room, 2), null);
  // other room has its own crates
  const o = m.create('O', 'O'); assert.strictEqual(m.crateInit(o.room).length, 0, 'crate state is per room');
  console.log('Crate ownership tests passed.');
}

// ---- punching ----
{
  const m = new RoomManager();
  const a = m.create('A', 'A'); const code = a.room.code; m.join('B', code, 'B'); m.join('C', code, 'C');
  const st = (x, z) => [x, 0, z, 0, 0, 0, 0, 1];
  let t = 100000;
  m.setState('A', st(0, 0), t); m.setState('B', st(1.5, 0), t); m.setState('C', st(50, 0), t);
  assert.strictEqual(m.punch('A', 'A', t), null, 'cannot punch yourself');
  assert.strictEqual(m.punch('A', 'C', t - 1000), null, 'out of range rejected');
  let r = m.punch('A', 'B', t); assert.ok(r && r.hp === 66 && !r.ko, 'first hit');
  assert.ok(Math.abs(r.d[0] - 1) < 1e-6, 'knockback points away from attacker');
  assert.strictEqual(m.punch('A', 'B', t + 50), null, 'attacker cooldown');
  r = m.punch('A', 'B', t + 300); assert.ok(r && r.hp === 32 && !r.ko, 'second hit');
  r = m.punch('A', 'B', t + 600); assert.ok(r && r.ko && r.hp === 0, 'third hit knocks out');
  assert.strictEqual(m.punch('A', 'B', t + 900), null, 'cannot hit a KO\'d player');
  assert.strictEqual(m.punch('B', 'A', t + 900), null, 'KO\'d player cannot punch');
  assert.strictEqual(m.punch('A', 'B', t + 600 + PUNCH.koMs + 100), null, 'invulnerable right after waking');
  r = m.punch('A', 'B', t + 600 + PUNCH.koMs + PUNCH.invulnMs + 100); assert.ok(r && r.hp === 66, 'full health after KO');
  r = m.punch('A', 'B', t + 600 + PUNCH.koMs + PUNCH.invulnMs + 100 + PUNCH.regenAfterMs + 500); assert.ok(r && r.hp === 66, 'health regenerates when left alone');
  const o = m.create('X', 'X'); m.setState('X', st(0, 0), t);
  assert.strictEqual(m.punch('X', 'B', t + 99999), null, 'cannot punch players in another room');
  console.log('Punch tests passed.');
}

// ---- lock / admin / code change / rejoin tokens ----
{
  const m = new RoomManager({ maxPlayers: 2 });
  const a = m.create('A', 'A'); const room = a.room; const code = room.code;
  assert.strictEqual(room.locked, false);
  assert.ok(m.join('B', code, 'B').room, 'unlocked: anyone joins');
  m.leave('B');
  m.setLocked(room, true);
  assert.strictEqual(m.join('C', code, 'C').error, 'ROOM_LOCKED', 'locked blocks joins');
  assert.strictEqual(m.join('C', code, 'C', { token: 'nope' }).error, 'ROOM_LOCKED', 'bad token blocked');
  const adm = m.join('ADM', code, 'Admin', { admin: true });
  assert.ok(adm.room, 'admin joins locked room');
  assert.ok(m.join('ADM2', code, 'Admin2', { admin: true }).room, 'admin bypasses the player cap (2/2)');
  assert.strictEqual(m.join('Z', code, 'Z', { admin: false }).error, 'ROOM_LOCKED');
  m.leave('ADM2'); m.leave('ADM');

  // a dropped player can come back to a locked room with their token (for a while), a kicked/left one cannot
  const tok = room.players.get('A').token; assert.ok(tok && tok.length >= 16);
  m.join('B', code, 'B', { admin: true }); const btok = room.players.get('B').token;
  m.leave('B', 'disconnected');
  assert.ok(m.join('B2', code, 'B', { token: btok }).room, 'token lets a dropped player back into a locked room');
  m.leave('B2', 'kicked');
  assert.strictEqual(m.join('B3', code, 'B', { token: btok }).error, 'ROOM_LOCKED', 'kicked: token revoked (old token)');
  assert.ok(!room.tokens.has(btok), 'used token is consumed');
  m.leave('B', 'disconnected'); // no-op, not in room
  room.tokens.set('old', Date.now() - 1);
  assert.strictEqual(m.hasToken(room, 'old'), false, 'expired token');

  // code change
  const m2 = new RoomManager();
  const r1 = m2.create('A', 'A').room, r2 = m2.create('B', 'B').room;
  m2.join('C', r1.code, 'C');
  const old = r1.code;
  assert.strictEqual(m2.setCode(r1, 'ab').error, 'BAD_CODE');
  assert.strictEqual(m2.setCode(r1, r2.code).error, 'CODE_TAKEN');
  assert.strictEqual(m2.setCode(r1, old).error, 'SAME_CODE');
  const res = m2.setCode(r1, 'zz9ab');
  assert.strictEqual(res.code, 'ZZ9AB');
  assert.ok(!m2.rooms.has(old) && m2.rooms.get('ZZ9AB') === r1, 'room re-keyed');
  assert.strictEqual(m2.join('X', old, 'X').error, 'NOT_FOUND', 'old code is dead');
  assert.strictEqual(m2.roomOf('A'), r1); assert.strictEqual(m2.roomOf('C'), r1, 'players stay in the room');
  assert.ok(m2.join('X', 'zz9ab', 'X').room, 'new code works');
  const rnd = m2.setCode(r1, ''); assert.ok(/^[A-HJ-NP-Z2-9]{5}$/.test(rnd.code), 'random code');
  assert.deepStrictEqual(m2.adminList().map((r) => r.code).sort(), [r1.code, r2.code].sort());
  assert.ok(m2.leave('C').room === r1, 'leave works after code change');
}
console.log('Lock/admin/code tests passed.');

// ---- chat ----
{
  const m = new RoomManager();
  const a = m.create('A', 'A').room; m.join('B', a.code, 'B');
  assert.strictEqual(m.chat('nobody', 'hi').error, 'NO_ROOM');
  const t0 = 1e6;
  const ok = m.chat('A', '  hello   \n world\u0000 ', t0);
  assert.strictEqual(ok.text, 'hello world', 'whitespace/control chars cleaned');
  assert.strictEqual(ok.room, a);
  assert.strictEqual(m.chat('A', '   ', t0 + 1000).error, 'EMPTY');
  assert.strictEqual(m.chat('A', 'x'.repeat(500), t0 + 1000).text.length, 200, 'long messages are cut');
  assert.strictEqual(m.chat('A', 'again', t0 + 1100).error, 'RATE', 'too fast (<300ms)');
  assert.ok(m.chat('A', 'again', t0 + 1400).text, 'ok after 300 ms');
  m.chat('A', '3', t0 + 1800); m.chat('A', '4', t0 + 2200);
  assert.strictEqual(m.chat('A', '6th in 5s', t0 + 2600).error, 'RATE', 'burst limit');
  assert.ok(m.chat('A', 'later', t0 + 7000).text, 'limit resets');
  assert.ok(m.chat('B', 'B is independent', t0 + 1100).text, 'limits are per player');
  assert.strictEqual(m.chat('B', '<b>hi</b>', t0 + 3000).text, '<b>hi</b>', 'markup kept as plain text (client uses textContent)');
}
console.log('Chat tests passed.');
