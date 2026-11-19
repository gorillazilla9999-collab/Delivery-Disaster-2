// Vehicle multiplayer: the REAL server logic (rooms.js, vehicles.js, vehicle-handlers.js) talking to several simulated clients,
// each with its own physics world and its own copy of the car, over a link with latency. Run: npm run test:vehicle-sync
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PhysicsWorld, Body } from '../js/physics.js';
import { CONFIG } from '../js/config.js';
import { Vehicle } from '../js/vehicle.js';
import { VehicleSync } from '../js/vehicle-sync.js';

const require = createRequire(import.meta.url);
const { RoomManager } = require('../server/rooms.js');
const V = require('../server/vehicles.js');
const { registerVehicleHandlers, broadcastChanges, broadcastInfo } = require('../server/vehicle-handlers.js');
const M = CONFIG.materials, H = 1 / 120, LAT = 60;
CONFIG.world.limit = 5000;

let simMs = 1_000_000;
Object.defineProperty(globalThis, 'performance', { value: { now: () => simMs }, configurable: true });
Date.now = () => simMs;

let passed = 0;
async function test(name, fn) {
  const t0 = process.hrtime.bigint();
  try { await fn(); passed++; console.log(`  ok   ${name}  (${Number((process.hrtime.bigint() - t0) / 1000000n)} ms)`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

// ---------------------------------------------------------------- the fake internet
function setup(names, { wait = true } = {}) {
  simMs += 100000;
  const rooms = new RoomManager();
  const clients = new Map();
  let pending = [];
  const later = (ms, fn) => pending.push({ at: simMs + ms, fn });
  const toClient = (id, ev, payload) => later(LAT, () => clients.get(id)?.receive(ev, payload));
  const io = { to: (code) => ({ emit: (ev, p) => { const r = rooms.rooms.get(code); if (r) for (const id of r.players.keys()) toClient(id, ev, p); } }) };
  const world = { rooms, clients, later, io, log: [] };

  const addClient = (id, first) => {
    const res = first ? rooms.create(id, id) : rooms.join(id, world.code, id);
    assert.ok(!res.error, JSON.stringify(res));
    if (first) world.code = res.room.code;
    const handlers = {};
    const socket = {
      id, on: (ev, fn) => { handlers[ev] = fn; }, emit: (ev, p) => toClient(id, ev, p),
      to: (code) => ({ emit: (ev, p) => { const r = rooms.rooms.get(code); for (const o of r.players.keys()) if (o !== id) toClient(o, ev, p); } }),
    };
    registerVehicleHandlers({ io, socket, rooms });
    const physics = new PhysicsWorld();
    physics.add(new Body({ size: [9000, 10, 9000], position: [0, -10, 0], name: 'ground', ...M.ground })).rayIgnore = true;
    const car = new Vehicle({ physics });
    const call = (ev, payload) => new Promise((resolve) => later(LAT, () => handlers[ev](payload, (ack) => later(LAT, () => resolve(ack)))));
    const net = {
      myId: id, room: true, renderTimeSec: () => simMs / 1000 - CONFIG.vehicle.net.interpDelay,
      vehicleEnter: (vid) => call('vehicle-enter', { id: vid }), vehicleExit: (vid) => call('vehicle-exit', { id: vid }),
      vehicleClaim: (vid) => call('vehicle-claim', { id: vid }), vehicleRelease: (vid, s) => call('vehicle-release', { id: vid, s }),
      sendVehicleState: (vid, s) => later(LAT, () => handlers['vehicle-state']({ id: vid, s })),
    };
    const sync = new VehicleSync([car], net);
    sync.resetToHome(); sync.setActive(true);
    const c = { id, physics, car, net, sync, handlers, pos: { x: 4, z: 16 }, history: [], events: [], forced: 0 };
    c.receive = (ev, p) => {
      c.events.push([ev, p]);
      if (ev === 'vehicle-init') sync.applyInit(p); else if (ev === 'vehicle-driver') sync.onDriver(p);
      else if (ev === 'vehicle-state') sync.onState(p); else if (ev === 'vehicle-denied') sync.onDenied(p);
    };
    sync.onForcedExit = () => { c.forced++; };
    clients.set(id, c);
    if (!first) toClient(id, 'vehicle-init', V.init(rooms.roomOf(id)));
    return c;
  };
  names.forEach((n, i) => addClient(n, i === 0));
  world.add = (id) => addClient(id, false);
  world.room = () => rooms.rooms.get(world.code);
  world.v = () => world.room().vehicles.get('car1');

  world.frame = async (dt = 1 / 60) => {
    simMs += dt * 1000;
    pending.sort((a, b) => a.at - b.at);
    while (pending.length && pending[0].at <= simMs) pending.shift().fn();
    for (const c of clients.values()) {
      if (Math.round(simMs / 1000 * 60) % 3 === 0) rooms.setState(c.id, [c.pos.x, 0, c.pos.z, 0, 0, 0, 0, 1], simMs);
      c.sync.beforePhysics(dt);
      for (let i = 0; i < Math.round(dt / H); i++) { c.car.fixedUpdate(H); c.physics.step(H); c.car.afterStep(H); }
      c.car.tickWheels(dt);
      c.sync.afterPhysics(dt);
      c.history.push([simMs, c.car.body.pos.x, c.car.body.pos.y, c.car.body.pos.z]);
      if (c.history.length > 120) c.history.shift();
    }
    await new Promise((r) => setImmediate(r));
  };
  world.run = async (secs) => { for (let i = 0; i < Math.round(secs * 60); i++) await world.frame(); };
  // where client c's car was `ms` ago
  world.at = (c, ms) => { const t = simMs - ms; let best = c.history[0]; for (const h of c.history) if (Math.abs(h[0] - t) < Math.abs(best[0] - t)) best = h; return best; };
  return world;
}
const dist = (a, b) => Math.hypot(a.body.pos.x - b.body.pos.x, a.body.pos.z - b.body.pos.z);

console.log('vehicle multiplayer');

await test('both clients start with the car at the same spot; nobody drives it; it is asleep and cheap on both', async () => {
  const w = setup(['A', 'B']); await w.run(3);
  const [A, B] = [w.clients.get('A'), w.clients.get('B')];
  assert.ok(dist(A.car, B.car) < 0.01);
  assert.equal(A.sync.driverOf('car1'), null);
  assert.ok(A.car.body.sleeping && B.car.body.sleeping, 'parked cars sleep');
  assert.ok(!A.car.body.kinematic && !B.car.body.kinematic);
});

await test('entering: the server seats one driver; the other client sees who it is and treats the car as someone else\'s', async () => {
  const w = setup(['A', 'B']); await w.run(1);
  const [A, B] = [w.clients.get('A'), w.clients.get('B')];
  const res = await (async () => { const p = A.sync.enter('car1'); await w.run(0.5); return p; })();
  assert.ok(res.ok);
  assert.equal(w.v().driver, 'A'); assert.equal(w.v().owner, 'A');
  assert.equal(A.sync.driverOf('car1'), 'me'); assert.equal(B.sync.driverOf('car1'), 'A');
  assert.ok(B.car.body.kinematic, 'B only follows the car');
  assert.ok(!A.car.body.kinematic);
});

await test('driving: B sees the same position and heading (within lag), the wheels spin and the front wheels steer', async () => {
  const w = setup(['A', 'B']); await w.run(1);
  const [A, B] = [w.clients.get('A'), w.clients.get('B')];
  const p = A.sync.enter('car1'); await w.run(0.5); await p;
  A.car.input.throttle = 1; await w.run(3);
  A.car.input.steer = 0.4; await w.run(2.5);
  const where = w.at(A, 180);      // B draws the car as it was ~(interpolation delay + latency) ago
  const err = Math.hypot(B.car.body.pos.x - where[1], B.car.body.pos.z - where[3]);
  assert.ok(A.car.speed > 15, `A should be moving fast: ${A.car.speed}`);
  assert.ok(err < 0.35, `B's car is ${err.toFixed(2)} m from where A's car was`);
  assert.ok(Math.abs(B.car.yaw() - A.car.yaw()) < 0.35, `heading differs: ${B.car.yaw().toFixed(2)} vs ${A.car.yaw().toFixed(2)}`);
  assert.ok(B.car.steerAngle > 0.03 && Math.abs(B.car.steerAngle - A.car.steerAngle) < 0.1, `B sees steering ${B.car.steerAngle.toFixed(3)} vs ${A.car.steerAngle.toFixed(3)}`);
  assert.ok(B.car.wheels[0].omega > 20 && B.car.wheels[3].omega > 20, 'wheels rotate on B');
  const spin0 = B.car.wheels[0].spin; await w.run(0.2);
  assert.notEqual(B.car.wheels[0].spin, spin0, 'visible wheel rotation advances on B');
  assert.ok(B.car.body.vel.length() > 15, 'the follower carries the real velocity, so it shoves what it hits');
});

await test('two players try to get in at the same moment: exactly one gets the seat, both screens agree', async () => {
  const w = setup(['A', 'B', 'C']); await w.run(1);
  const [A, B, C] = ['A', 'B', 'C'].map((i) => w.clients.get(i));
  const pa = A.sync.enter('car1'), pb = B.sync.enter('car1'), pc = C.sync.enter('car1');
  await w.run(0.6);
  const results = await Promise.all([pa, pb, pc]);
  const winners = results.filter((r) => r.ok).length;
  assert.equal(winners, 1, `winners: ${JSON.stringify(results)}`);
  const driver = w.v().driver;
  assert.ok(['A', 'B', 'C'].includes(driver));
  for (const c of [A, B, C]) {
    const expect = c.id === driver ? 'me' : driver;
    assert.equal(c.sync.driverOf('car1'), expect, `${c.id} thinks the driver is ${c.sync.driverOf('car1')}`);
    assert.equal(c.car.body.kinematic, c.id !== driver);
  }
  const loser = results.find((r) => !r.ok); assert.ok(loser.message, 'losers get a message to show');
});

await test('a client cannot overwrite a car it does not control: its state is dropped, nobody sees it, and it is told who does', async () => {
  const w = setup(['A', 'B']); await w.run(1);
  const [A, B] = [w.clients.get('A'), w.clients.get('B')];
  const p = A.sync.enter('car1'); await w.run(0.5); await p;
  A.car.input.throttle = 1; await w.run(1);
  const fake = A.car.getNetState(); fake[0] = 70; fake[2] = 70;
  B.events.length = 0; A.events.length = 0;
  B.handlers['vehicle-state']({ id: 'car1', s: fake });
  w.clients.get('B').net.sendVehicleState('car1', fake);
  await w.run(0.5);
  assert.ok(Math.abs(w.v().s[0] - 70) > 10 && Math.abs(A.car.body.pos.x - 70) > 10, 'the forged state must not stick');
  assert.ok(!A.events.some(([ev, p]) => ev === 'vehicle-state' && p.from === 'B'), 'and must not be relayed');
  assert.ok(B.events.some(([ev]) => ev === 'vehicle-denied'), 'B is told no');
  // B also cannot just claim/release/exit a car somebody drives
  assert.equal((await Promise.all([B.net.vehicleClaim('car1'), (w.run(0.5), 0)]))[0].ok, false);
  assert.equal((await (async () => { const pr = B.net.vehicleRelease('car1', fake); await w.run(0.5); return pr; })()).ok, false);
  assert.equal((await (async () => { const pr = B.net.vehicleExit('car1'); await w.run(0.5); return pr; })()).ok, false);
  assert.equal(w.v().driver, 'A');
});

await test('the server refuses a teleporting owner and a reset to a faraway spot, but accepts a nearby reset (the flip recovery)', async () => {
  const w = setup(['A']); await w.run(1);
  const A = w.clients.get('A');
  const p = A.sync.enter('car1'); await w.run(0.5); await p;
  await w.run(0.5);
  const room = w.room(), v = w.v();
  const base = A.car.getNetState();
  const jump = base.slice(); jump[0] += 60;
  assert.equal(V.update(room, 'A', 'car1', jump, simMs + 100).error, 'TELEPORT');
  const far = base.slice(); far[0] += 60; far[23] = 1;
  assert.equal(V.update(room, 'A', 'car1', far, simMs + 200).error, 'TELEPORT', 'a "reset" is not a free teleport');
  const near = base.slice(); near[0] += 6; near[23] = 1;
  assert.ok(V.update(room, 'A', 'car1', near, simMs + 300).ok, 'a nearby reset is fine');
  const again = near.slice(); again[23] = 2;
  assert.equal(V.update(room, 'A', 'car1', again, simMs + 400).error, 'RESET_RATE', 'resets are rate limited');
  const nan = base.slice(); nan[0] = NaN; nan[5] = Infinity;
  const ok = V.update(room, 'A', 'car1', nan, simMs + 3000);
  assert.ok(ok.ok && Number.isFinite(ok.s[0]) && Number.isFinite(ok.s[5]), 'garbage numbers are sanitised, never relayed');
  assert.equal(V.update(room, 'A', 'car1', 'nope', simMs + 4000).error, 'BAD_STATE');
});

await test('a reset on the driver\'s screen makes the other screen jump to the new spot (no gliding across the map)', async () => {
  const w = setup(['A', 'B']); await w.run(1);
  const [A, B] = [w.clients.get('A'), w.clients.get('B')];
  const p = A.sync.enter('car1'); await w.run(0.5); await p;
  A.car.input.throttle = 0.6; await w.run(2);
  A.car.input.throttle = 0;
  A.car.reset(A.car.body.pos.x + 5, A.car.body.pos.z, 0.3);
  let maxSpeedB = 0;
  for (let i = 0; i < 60; i++) { await w.frame(); maxSpeedB = Math.max(maxSpeedB, B.car.body.vel.length()); }
  assert.ok(dist(A.car, B.car) < 0.4, `B's car is ${dist(A.car, B.car).toFixed(2)} m from A's after the reset`);
  assert.ok(maxSpeedB < 25, `B's car must not fly across the map (apparent speed ${maxSpeedB.toFixed(0)} m/s)`);
  assert.equal(w.v().s[23], 1, 'server saw the reset');
});

await test('the car must be near, slow, and free to be entered; a knocked-out player cannot drive', async () => {
  const w = setup(['A', 'B']); await w.run(1);
  const [A, B] = [w.clients.get('A'), w.clients.get('B')];
  A.pos = { x: 40, z: 40 };                      // too far away
  await w.run(0.5);
  let r = A.sync.enter('car1'); await w.run(0.5); r = await r;
  assert.ok(!r.ok && /far/i.test(r.message), JSON.stringify(r));
  assert.equal(w.v().driver, null);
  A.pos = { x: 4, z: 16 }; await w.run(0.5);
  w.room().players.get('A').koUntil = simMs + 3000;
  r = A.sync.enter('car1'); await w.run(0.5); r = await r;
  assert.ok(!r.ok && /knocked/i.test(r.message));
  w.room().players.get('A').koUntil = 0; await w.run(1);
  // a car rolling fast: no
  const v = w.v(); v.s = [6, 0.6, 16, 0, 0, 0, 1, 0, 0, -12, 0, 0, 0, 0, 0, 0, 0, 0, 0.26, 0.26, 0.26, 0.26, 0, 0]; v.at = simMs;
  r = A.sync.enter('car1'); await w.run(0.5); r = await r;
  assert.ok(!r.ok && /fast/i.test(r.message), JSON.stringify(r));
});

await test('one driver per player: you cannot drive two cars or double-enter; exit frees the seat for somebody else immediately', async () => {
  const w = setup(['A', 'B']); await w.run(1);
  const [A, B] = [w.clients.get('A'), w.clients.get('B')];
  let p = A.sync.enter('car1'); await w.run(0.5); await p;
  p = A.sync.enter('car1'); await w.run(0.5); p = await p;
  assert.ok(!p.ok || A.sync.driverOf('car1') === 'me');
  A.car.input.throttle = 0; A.sync.exit('car1'); A.car.input.throttle = 0; await w.run(0.5);
  assert.equal(w.v().driver, null);
  assert.equal(B.sync.driverOf('car1'), null);
  p = B.sync.enter('car1'); await w.run(0.5); p = await p;
  assert.ok(p.ok, JSON.stringify(p));
  assert.equal(w.v().driver, 'B'); assert.equal(w.v().owner, 'B');
  assert.ok(A.car.body.kinematic && !B.car.body.kinematic, 'control moved cleanly from A to B');
});

await test('after getting out of a moving car the old driver keeps simulating it until it stops; then everybody agrees where it ended up', async () => {
  const w = setup(['A', 'B']); await w.run(1);
  const [A, B] = [w.clients.get('A'), w.clients.get('B')];
  let p = A.sync.enter('car1'); await w.run(0.5); await p;
  A.car.input.throttle = 1; await w.run(2.0);                                  // ~ 15 m/s
  A.car.input.throttle = 0; A.sync.exit('car1'); A.car.occupied = false;
  assert.ok(A.car.speed > 5);
  await w.run(0.5);
  assert.equal(w.v().driver, null); assert.equal(w.v().owner, 'A', 'A still simulates the coasting car');
  assert.ok(B.car.body.kinematic, 'B follows it');
  await w.run(12);
  assert.ok(A.car.speed < 0.1, `the abandoned car brakes itself to a halt (${A.car.speed})`);
  assert.equal(w.v().owner, null, 'and then the owner lets go of it');
  assert.ok(!A.car.body.kinematic && !B.car.body.kinematic);
  assert.ok(dist(A.car, B.car) < 0.05, `final positions differ by ${dist(A.car, B.car).toFixed(3)} m`);
  assert.ok(A.car.body.sleeping && B.car.body.sleeping, 'both sleep again');
});

await test('driver disconnects at speed: the seat is free at once, the host takes over the rolling car and brings it to a halt; a new driver can get in', async () => {
  const w = setup(['H', 'D']); await w.run(1);          // H (host) and D (driver)
  const [Hc, D] = [w.clients.get('H'), w.clients.get('D')];
  let p = D.sync.enter('car1'); await w.run(0.5); await p;
  D.car.input.throttle = 1; await w.run(3.5);
  assert.ok(D.car.speed > 10, `D speed ${D.car.speed}`);
  w.clients.delete('D');                                // the connection drops (same steps server.js takes on disconnect)
  const res = w.rooms.leave('D', 'disconnected');
  broadcastChanges(w.io, res.room, res.vehicleChanges);
  await w.run(0.6);
  assert.equal(w.v().driver, null, 'seat is free');
  assert.equal(w.v().owner, 'H', 'a moving car is handed to the host');
  assert.equal(Hc.sync.ownerOf('car1'), 'me'); assert.ok(!Hc.car.body.kinematic);
  assert.ok(Hc.car.speed > 3, 'it keeps rolling on the host\'s screen, not teleporting to a stop');
  await w.run(12);
  assert.ok(Hc.car.speed < 0.1, 'and it stops');
  assert.equal(w.v().owner, null);
  Hc.pos = { x: Hc.car.body.pos.x - 3, z: Hc.car.body.pos.z }; await w.run(0.5);      // walk over to it
  p = Hc.sync.enter('car1'); await w.run(0.5); p = await p;
  assert.ok(p.ok, `the car is available again: ${JSON.stringify(p)}`);
});

await test('a parked car whose driver disconnects while it is not moving is simply released; a late joiner gets the right picture', async () => {
  const w = setup(['A', 'B']); await w.run(1);
  const [A, B] = [w.clients.get('A'), w.clients.get('B')];
  let p = A.sync.enter('car1'); await w.run(0.5); await p;
  A.car.input.throttle = 0.7; await w.run(3); A.car.input.throttle = -1; await w.run(5); A.car.input.throttle = 0;
  A.car.input.steer = 0.5; await w.run(0.5);
  const res = w.rooms.leave('A', 'disconnected'); w.clients.delete('A');
  broadcastChanges(w.io, res.room, res.vehicleChanges);
  await w.run(1.5);
  assert.equal(w.v().driver, null);
  const C = w.add('C'); await w.run(1);
  assert.ok(dist(B.car, C.car) < 0.6, `late joiner sees the car ${dist(B.car, C.car).toFixed(2)} m from where B sees it`);
  assert.equal(C.sync.driverOf('car1'), null);
  const q = C.sync.enter('car1'); C.pos = { x: C.car.body.pos.x - 3, z: C.car.body.pos.z }; await w.run(1); const r = await q;
  assert.ok(r.ok || /far/i.test(r.message));
});

await test('a late joiner arriving while somebody drives sees them driving and follows the car', async () => {
  const w = setup(['A', 'B']); await w.run(1);
  const A = w.clients.get('A');
  let p = A.sync.enter('car1'); await w.run(0.5); await p;
  A.car.input.throttle = 1; await w.run(2.5);
  const C = w.add('C'); await w.run(1.5);
  assert.equal(C.sync.driverOf('car1'), 'A'); assert.ok(C.car.body.kinematic);
  const where = w.at(A, 180);
  assert.ok(Math.hypot(C.car.body.pos.x - where[1], C.car.body.pos.z - where[3]) < 0.6);
});

await test('a driver knocked out is ejected by the server; their client is told to get out', async () => {
  const w = setup(['A', 'B']); await w.run(1);
  const [A, B] = [w.clients.get('A'), w.clients.get('B')];
  let p = A.sync.enter('car1'); await w.run(0.5); await p;
  A.car.input.throttle = 1; await w.run(2);                    // rolling when the punch lands
  broadcastInfo(w.io, w.room(), V.eject(w.room(), 'A'));
  await w.run(0.5);
  assert.equal(w.v().driver, null);
  assert.equal(A.forced, 1, 'A is told to leave the seat');
  assert.equal(B.sync.driverOf('car1'), null);
  assert.equal(w.v().owner, 'A', 'A keeps simulating until the car has stopped');
});

await test('if the owner goes silent the other screens stop following and treat the car as free (no frozen ghost car)', async () => {
  const w = setup(['A', 'B']); await w.run(1);
  const [A, B] = [w.clients.get('A'), w.clients.get('B')];
  let p = A.sync.enter('car1'); await w.run(0.5); await p;
  A.car.input.throttle = 0.5; await w.run(1.5);
  A.net.sendVehicleState = () => {};                       // A's connection stalls
  await w.run(2.5);
  assert.ok(!B.car.body.kinematic && B.sync.ownerOf('car1') === null);
});

await test('the server-side constants match the client config (home position, name)', () => {
  assert.deepEqual(V.VEHICLES[0].home, [CONFIG.vehicle.spawn.x, CONFIG.vehicle.spawn.z]);
  assert.equal(V.VEHICLES[0].id, CONFIG.vehicle.id); assert.equal(V.VEHICLES[0].name, CONFIG.vehicle.name);
});

console.log(`${passed} passed`);
