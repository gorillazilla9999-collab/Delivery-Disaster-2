// Two simulated clients + the real server room logic: does a crate that tumbles on one screen tumble the same way
// on the other, and do both end up with it lying in the same place? Run: npm run test:sync
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PhysicsWorld, Body } from '../js/physics.js';
import { CrateSync } from '../js/crates-sync.js';
import { CONFIG } from '../js/config.js';

const { RoomManager } = createRequire(import.meta.url)('../server/rooms.js');
const M = CONFIG.materials;

// ---- fake clock (CrateSync reads performance.now, the server logic reads Date.now) ----
let simMs = 1_000_000;
Object.defineProperty(globalThis, 'performance', { value: { now: () => simMs }, configurable: true });
Date.now = () => simMs;

const rooms = new RoomManager();
const created = rooms.create('A', 'A'); rooms.join('B', created.room.code, 'B');
const inbox = { A: [], B: [] };
const LATENCY = 60;

class FakeNet {
  constructor(id) { this.id = id; this.myId = id; }
  renderTimeSec() { return simMs / 1000 - 0.12 - LATENCY / 1000 * 0; }
  sendCrates(entries) {
    const acc = rooms.crateUpdate(this.id, entries, simMs);
    if (!acc.length) return;
    const other = this.id === 'A' ? 'B' : 'A';
    inbox[other].push({ at: simMs + LATENCY, msg: { t: simMs, from: this.id, c: acc } });
  }
  sendCrateImpulse(idx, d, m, p) {
    const owner = rooms.crateOwner(created.room, idx);
    if (!owner || owner === this.id) return;
    inbox[owner].push({ at: simMs + LATENCY, impulse: { idx, d, m, p } });
  }
}

function client(id) {
  const physics = new PhysicsWorld();
  physics.add(new Body({ size: [800, 10, 800], position: [0, -10, 0], name: 'ground', ...M.ground })).rayIgnore = true;
  const crates = [];
  const crate = (size, x, z) => {
    const b = physics.add(new Body({ size: [size, size, size], position: [x, size / 2 + 0.001, z], mass: M.crate.density * size ** 3, dynamic: true, baseOrigin: false, friction: M.crate.friction, restitution: M.crate.restitution }));
    b.home = [x, size / 2 + 0.001, z]; crates.push(b); return b;
  };
  const barrel = (x, z) => {
    const b = physics.add(new Body({ shape: 'cyl', radius: 0.3, height: 0.9, position: [x, 0.451, z], mass: M.barrel.mass, dynamic: true, baseOrigin: false, friction: M.barrel.friction, restitution: M.barrel.restitution }));
    b.home = [x, 0.451, z]; crates.push(b); return b;
  };
  crate(0.8, -2, 0); crate(0.6, 2, 0); barrel(0, 0); barrel(3.5, 0.1);
  const pooled = crate(0.5, 0, 0); pooled.home = [0, -49, 0]; pooled.pool = 'crate-s';        // spawn-pool item: starts parked
  const net = new FakeNet(id);
  const sync = new CrateSync(crates, physics, net);
  sync.resetToHome(); sync.setActive(true);
  return { id, physics, crates, sync, net };
}

const A = client('A'), B = client('B');
const frame = (dt) => {
  simMs += dt * 1000;
  for (const c of [A, B]) {
    const q = inbox[c.id];
    for (let i = q.length - 1; i >= 0; i--) if (q[i].at <= simMs) {
      const it = q.splice(i, 1)[0];
      if (it.msg) c.sync.onRemote(it.msg); else c.sync.onImpulse(it.impulse);
    }
    c.sync.beforePhysics(dt);
    for (let k = 0; k < 2; k++) c.physics.step(dt / 2);
    c.sync.afterPhysics(dt);
  }
};
const settle = (secs) => { for (let i = 0; i < secs * 60; i++) frame(1 / 60); };

let passed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; } }
console.log('crate sync');

settle(1.5);
test('both clients start from the same quiet layout', () => {
  A.crates.forEach((b, i) => { assert.ok(b.sleeping && B.crates[i].sleeping, `crate ${i} should be asleep on both`); assert.ok(Math.hypot(b.pos.x - B.crates[i].pos.x, b.pos.z - B.crates[i].pos.z) < 1e-9); });
});

// Player A whacks the standing barrel high up: it tips over and rolls. Player B watches.
const bar = 2;
const hitPoint = { x: 0, y: 0.451 + 0.35, z: 0 };
A.sync.poke(A.crates[bar], { x: 1, y: 0, z: 0 }, 80, hitPoint);

let maxLag = 0, sawRotationOnB = false, bKinematic = false;
for (let i = 0; i < 4 * 60; i++) {
  frame(1 / 60);
  const a = A.crates[bar], b = B.crates[bar];
  if (b.kinematic) bKinematic = true;
  if (Math.abs(b.R[4]) < 0.9) sawRotationOnB = true;            // B has seen the barrel lean over
  if (i > 30) maxLag = Math.max(maxLag, Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z));
}
test('the barrel is knocked over on A', () => assert.ok(Math.abs(A.crates[bar].R[4]) < 0.2, `up.y=${A.crates[bar].R[4].toFixed(2)}`));
test('B sees it tip over too, as a network-driven kinematic body', () => { assert.ok(bKinematic, 'kinematic'); assert.ok(sawRotationOnB, 'rotation was streamed'); });
test('while it moves, B shows it within a short distance of A (network delay)', () => assert.ok(maxLag < 1.2, `lag ${maxLag.toFixed(2)} m`));
settle(6);
test('after it comes to rest, both clients agree on where everything is and which way up', () => {
  A.crates.forEach((a, i) => {
    const b = B.crates[i];
    const d = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z);
    const dq = Math.abs(a.quat.x * b.quat.x + a.quat.y * b.quat.y + a.quat.z * b.quat.z + a.quat.w * b.quat.w);   // 1 = same orientation
    assert.ok(d < 0.1 && dq > 0.99, `crate ${i}: ${d.toFixed(3)} m apart, orientation match ${dq.toFixed(4)}`);
  });
  assert.ok(A.crates.every((b) => !A.sync.st[A.crates.indexOf(b)].owner), 'ownership released');
});

// B pokes a crate that A just left lying: B owns it, A follows
B.sync.poke(B.crates[0], { x: 0, y: 0, z: 1 }, 150, { x: -2, y: 0.4, z: -0.4 });
settle(3);
test('a poke on the other client works the same way, in both directions', () => {
  assert.ok(B.crates[0].pos.z > 0.3, 'B shoved the crate');
  const a = A.crates[0], b = B.crates[0];
  assert.ok(Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z) < 0.1, 'A agrees');
});

// ---- spawn tool + crusher: parked pool items, spawning, despawning ----
const poolIdx = A.crates.length - 1;
test('pool items start parked (invisible, no collisions) on both clients', () => {
  assert.ok(A.crates[poolIdx].parked && B.crates[poolIdx].parked);
  assert.ok(A.crates[poolIdx].pos.y < -40);
});
A.sync.spawn(A.crates[poolIdx], 5, 2, 3, { x: 0, y: 0, z: 0 }, null);
settle(0.6);
test('a spawned item appears on the other client too and falls', () => {
  assert.ok(!B.crates[poolIdx].parked, 'unparked on B');
  assert.ok(Math.hypot(A.crates[poolIdx].pos.x - B.crates[poolIdx].pos.x, A.crates[poolIdx].pos.z - B.crates[poolIdx].pos.z) < 0.3);
});
settle(4);
test('it lands and both clients agree where it came to rest', () => {
  const a = A.crates[poolIdx], b = B.crates[poolIdx];
  assert.ok(Math.abs(a.min.y) < 0.02, `rest height ${a.min.y}`);
  assert.ok(Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y, a.pos.z - b.pos.z) < 0.05);
});
test('a late joiner is told about the spawned item (and about parked ones)', () => {
  const init = rooms.crateInit(created.room);
  const e = init.find((x) => x[0] === poolIdx);
  assert.ok(e && e[2] > -1 && e[7] === null, 'spawned item present with position, no owner');
});
A.sync.park(A.crates[poolIdx]);                              // crushed / removed
settle(0.5);
test('despawning parks it for everybody and frees the slot', () => {
  assert.ok(A.crates[poolIdx].parked && B.crates[poolIdx].parked);
  const init = rooms.crateInit(created.room).find((x) => x[0] === poolIdx);
  assert.ok(init && init[2] < -48, 'server remembers it as parked');
});
A.sync.spawn(A.crates[poolIdx], -5, 1, 3, null, null);       // the slot can be reused
settle(1);
test('a freed slot can be spawned again', () => assert.ok(!A.crates[poolIdx].parked && !B.crates[poolIdx].parked));
// a map crate that gets crushed comes back at home
A.sync.park(A.crates[1]); settle(0.3);
A.sync.restore(A.crates[1], A.crates[1].home[0], A.crates[1].home[1], A.crates[1].home[2]); settle(1);
test('a crushed map crate respawns at its home on both clients', () => {
  for (const c of [A, B]) { const b = c.crates[1]; assert.ok(!b.parked && Math.hypot(b.pos.x - 2, b.pos.z) < 0.05, `${c.id} at ${b.pos.x},${b.pos.z}`); }
});

console.log(`${passed} passed`);
