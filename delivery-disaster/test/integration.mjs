// End-to-end test against the REAL server (Express + Socket.IO) using real socket.io-client connections.
// Needs:  npm install   then   npm run test:integration
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';

const PORT = 4100 + Math.floor(Math.random() * 500);
const URL = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/server.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'inherit' });

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(URL + '/health'); if (r.ok) return r.json(); } catch (_) {}
    await wait(100);
  }
  throw new Error('server did not start');
}
const connect = () => new Promise((res, rej) => {
  const s = io(URL, { transports: ['websocket'] });
  s.snaps = []; s.updates = []; s.actions = [];
  s.on('snap', (m) => s.snaps.push(m)); s.on('room:update', (u) => s.updates.push(u)); s.on('player:action', (a) => s.actions.push(a));
  s.on('connect', () => res(s)); s.on('connect_error', rej);
});
const req = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const st = (x) => ({ x, y: 0, z: 0, yaw: 0, byaw: 0, pitch: 0, vx: 0, vz: 0, g: 1, r: 0, e: 0 });
const all = [];

try {
  const health = await waitForHealth();
  assert.equal(health.status, 'ok');
  console.log('health ok', health);

  const html = await fetch(URL + '/'); assert.equal(html.status, 200);
  const glb = await fetch(URL + '/assets/person.glb'); assert.equal(glb.status, 200);
  assert.equal((await fetch(URL + '/server/server.js')).status, 404, 'server code must not be public');
  assert.equal((await fetch(URL + '/package.json')).status, 404, 'package.json must not be public');
  console.log('static files ok');

  const a = await connect(), b = await connect(); all.push(a, b);
  const ra = await req(a, 'room:create', { name: 'Alice' });
  assert.ok(ra.ok); console.log('room code', ra.code);
  const rb = await req(b, 'room:join', { code: ra.code, name: 'Bob' });
  assert.ok(rb.ok); assert.equal(rb.players.length, 2);
  await wait(100);
  assert.equal(a.updates.at(-1).event.type, 'join');

  const c = await connect(), d = await connect(); all.push(c, d);
  const rc = await req(c, 'room:create', { name: 'Carol' });
  await req(d, 'room:join', { code: rc.code, name: 'Dave' });

  a.emit('player:state', st(7)); c.emit('player:state', st(42)); a.emit('player:action', { type: 'poke', side: 'left' });
  await wait(250);
  assert.ok(b.snaps.some((m) => m.players[a.id]?.x === 7), 'Bob sees Alice');
  assert.ok(!b.snaps.some((m) => m.players[c.id]), 'Bob must not see Carol (other room)');
  assert.ok(d.snaps.some((m) => m.players[c.id]?.x === 42), 'Dave sees Carol');
  assert.equal(b.actions.length, 1); assert.equal(d.actions.length, 0);
  console.log('sync + isolation ok');

  const extras = [];
  for (let i = 0; i < 10; i++) { const s = await connect(); all.push(s); extras.push(s); assert.ok((await req(s, 'room:join', { code: ra.code, name: 'P' + i })).ok); }
  const over = await connect(); all.push(over);
  assert.equal((await req(over, 'room:join', { code: ra.code, name: 'Late' })).error, 'ROOM_FULL');
  console.log('12-player limit ok');

  extras[0].disconnect();
  await wait(200);
  assert.equal(a.updates.at(-1).event.type, 'leave');
  assert.equal(a.updates.at(-1).event.reason, 'connection lost');
  assert.ok((await req(over, 'room:join', { code: ra.code, name: 'Late' })).ok, 'freed slot reusable');
  console.log('disconnect handling ok');
  console.log('\nALL INTEGRATION CHECKS PASSED');
} catch (e) {
  console.error('INTEGRATION FAILED:', e);
  process.exitCode = 1;
} finally {
  all.forEach((s) => s.disconnect());
  server.kill('SIGTERM');
}
