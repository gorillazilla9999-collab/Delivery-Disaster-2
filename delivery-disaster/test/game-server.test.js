import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeIO } from './fake-io.js';
import { attachGameServer } from '../server/game-server.js';

function setup(opts = {}) {
  const io = new FakeIO();
  const game = attachGameServer(io, { tickMs: 5, ...opts });
  return { io, game };
}
const state = (x) => ({ x, y: 0, z: 3, yaw: 0.5, byaw: 0.4, pitch: 0.1, vx: 4, vz: 0, g: 1, r: 0, e: 0 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('create -> join -> both see each other; join broadcast reaches existing player only', () => {
  const { io, game } = setup();
  const a = io.connect(), b = io.connect();
  const created = a.request('room:create', { name: 'Alice' });
  assert.ok(created.ok);
  assert.equal(created.players.length, 1);
  assert.equal(created.you, a.id);
  assert.equal(created.maxPlayers, 12);

  const joined = b.request('room:join', { code: created.code, name: 'Bob' });
  assert.ok(joined.ok);
  assert.deepEqual(joined.players.map((p) => p.name), ['Alice', 'Bob']);
  assert.equal(joined.players[0].host, true);

  const upd = a.last('room:update');
  assert.equal(upd.event.type, 'join');
  assert.equal(upd.event.name, 'Bob');
  assert.equal(b.last('room:update'), undefined, 'joiner learns state from the ack, not a broadcast');
  game.stop();
});

test('error cases: bad code, unknown room, already in room, bad ack', () => {
  const { io, game } = setup();
  const a = io.connect();
  assert.equal(a.request('room:join', { code: 'x' }).error, 'INVALID_CODE');
  assert.equal(a.request('room:join', { code: 'ABCDE' }).error, 'ROOM_NOT_FOUND');
  const r = a.request('room:create', { name: 'A' });
  assert.equal(a.request('room:create', { name: 'A' }).error, 'ALREADY_IN_ROOM');
  assert.equal(a.request('room:join', { code: r.code }).error, 'ALREADY_IN_ROOM');
  assert.doesNotThrow(() => a.emit('room:join', { code: 'ABCDE' }));   // no ack callback -> must not crash
  assert.doesNotThrow(() => a.emit('room:create', null, undefined));
  game.stop();
});

test('12-player limit: 12 join, the 13th is rejected, and a freed slot can be reused', () => {
  const { io, game } = setup();
  const host = io.connect();
  const { code } = host.request('room:create', { name: 'Host' });
  const clients = [host];
  for (let i = 1; i < 12; i++) {
    const c = io.connect();
    const res = c.request('room:join', { code, name: 'P' + i });
    assert.ok(res.ok, 'player ' + (i + 1) + ' should fit');
    clients.push(c);
  }
  const slots = new Set(host.last('room:update').players.map((p) => p.slot));
  assert.equal(slots.size, 12);

  const extra = io.connect();
  assert.equal(extra.request('room:join', { code, name: 'Extra' }).error, 'ROOM_FULL');
  assert.equal(game.rooms.getRoomOf(extra.id), null);

  clients[5].disconnect();
  const retry = extra.request('room:join', { code, name: 'Extra' });
  assert.ok(retry.ok, 'slot freed by disconnect can be reused');
  game.stop();
});

test('room isolation: snapshots, actions and updates never cross rooms', async () => {
  const { io, game } = setup();
  const a1 = io.connect(), a2 = io.connect(), b1 = io.connect(), b2 = io.connect();
  const ra = a1.request('room:create', { name: 'A1' });
  a2.request('room:join', { code: ra.code, name: 'A2' });
  const rb = b1.request('room:create', { name: 'B1' });
  b2.request('room:join', { code: rb.code, name: 'B2' });
  assert.notEqual(ra.code, rb.code);

  a1.emit('player:state', state(11));
  b1.emit('player:state', state(99));
  a1.emit('player:action', { type: 'poke', side: 'left' });
  await wait(30);

  const aSees = a2.all('snap').flatMap((s) => Object.values(s.players).map((p) => p.x));
  const bSees = b2.all('snap').flatMap((s) => Object.values(s.players).map((p) => p.x));
  assert.deepEqual([...new Set(aSees)], [11]);
  assert.deepEqual([...new Set(bSees)], [99]);
  assert.equal(a2.all('player:action').length, 1);
  assert.equal(b2.all('player:action').length, 0);
  assert.equal(b1.all('room:update').filter((u) => u.players.some((p) => p.name === 'A1')).length, 0);
  game.stop();
});

test('state: relayed with server timestamp, sanitised, ignored outside a room', async () => {
  const { io, game } = setup({ now: () => 12345 });
  const a = io.connect(), b = io.connect(), lone = io.connect();
  const r = a.request('room:create', { name: 'A' });
  b.request('room:join', { code: r.code, name: 'B' });
  a.emit('player:state', { ...state(1), x: 1e9, pitch: 50 });
  a.emit('player:state', { x: 'bad' });
  lone.emit('player:state', state(5));
  await wait(30);
  const snaps = b.all('snap');
  assert.ok(snaps.length >= 1);
  const s = snaps[0].players[a.id];
  assert.equal(s.x, 150); assert.equal(s.pitch, 1.6); assert.equal(s.ts, 12345);
  assert.equal(lone.all('snap').length, 0);
  game.stop();
});

test('leaving: others are told, host migrates, empty rooms are removed', () => {
  const { io, game } = setup();
  const a = io.connect(), b = io.connect(), c = io.connect();
  const r = a.request('room:create', { name: 'A' });
  b.request('room:join', { code: r.code, name: 'B' });
  c.request('room:join', { code: r.code, name: 'C' });

  assert.ok(a.request('room:leave').ok);
  let u = b.last('room:update');
  assert.equal(u.event.type, 'leave');
  assert.equal(u.event.reason, 'left');
  assert.equal(u.newHostId, undefined);
  assert.equal(u.event.newHostId, b.id);
  assert.equal(u.hostId, b.id);
  assert.equal(a.last('room:update')?.event?.type === 'leave', false, 'leaver is not notified about their own leave');

  c.disconnect();                                  // unexpected drop
  u = b.last('room:update');
  assert.equal(u.event.reason, 'connection lost');
  assert.deepEqual(u.players.map((p) => p.name), ['B']);

  b.disconnect();
  assert.equal(game.rooms.stats().rooms, 0);
  assert.equal(game.rooms.stats().players, 0);
  game.stop();
});

test('a player who left can create/join again', () => {
  const { io, game } = setup();
  const a = io.connect(), b = io.connect();
  const r = a.request('room:create', { name: 'A' });
  b.request('room:join', { code: r.code, name: 'B' });
  b.request('room:leave');
  assert.ok(b.request('room:join', { code: r.code, name: 'B' }).ok);
  game.stop();
});

test('rate limiting stops code brute-forcing', () => {
  const { io, game } = setup();
  const a = io.connect();
  let limited = 0;
  for (let i = 0; i < 20; i++) if (a.request('room:join', { code: 'ABCDE' }).error === 'RATE_LIMIT') limited++;
  assert.ok(limited >= 10);
  game.stop();
});

test('ping ack returns server time; unknown action types are dropped', async () => {
  const { io, game } = setup({ now: () => 777 });
  const a = io.connect(), b = io.connect();
  assert.equal(a.request('net:ping'), 777);
  const r = a.request('room:create', { name: 'A' });
  b.request('room:join', { code: r.code, name: 'B' });
  a.emit('player:action', { type: 'explode' });
  assert.equal(b.all('player:action').length, 0);
  game.stop();
});
