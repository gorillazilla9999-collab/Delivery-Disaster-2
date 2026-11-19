// Runs the client-side glue (VehicleSystem + the real Player, Vehicle, sync, camera, HUD, model) in Node with three.js and the DOM
// stubbed out, through a whole enter -> drive -> exit cycle. It does not render anything: it proves the wiring does what it should.
// Run: npm run test:vehicle-client   (uses  node --import ./test/stubs/register.mjs)
import assert from 'node:assert/strict';
import { installDom } from './stubs/dom.mjs';
const dom = installDom();
const THREE = await import('three');
const { PhysicsWorld, Body } = await import('../js/physics.js');
const { CONFIG } = await import('../js/config.js');
const { Player } = await import('../js/player.js');
const { VehicleSystem } = await import('../js/vehicle-system.js');
const { RemotePlayer } = await import('../js/remote.js');
const { buildCoursePhysics } = await import('../js/course.js');
CONFIG.world.limit = 5000;
const M = CONFIG.materials, VC = CONFIG.vehicle;

let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { console.log(`  FAIL ${name}\n       ${e.stack.split('\n').slice(0, 4).join('\n       ')}`); process.exitCode = 1; } }

function rig() {
  const physics = new PhysicsWorld();
  physics.add(new Body({ size: [9000, 10, 9000], position: [0, -10, 0], name: 'ground', ...M.ground })).rayIgnore = true;
  const camera = new THREE.PerspectiveCamera(70); camera.rotation.order = 'YXZ';
  const keys = new Set(), pressed = new Set(); let look = { x: 0, y: 0 };
  const input = { down: (c) => keys.has(c), pressed: (c) => pressed.has(c), consumeLook: () => { const l = look; look = { x: 0, y: 0 }; return l; } };
  const character = { eyeHeight: 1.67, scale: 1, root: new THREE.Object3D(), fp: true, seated: 0, setFirstPerson(f) { this.fp = f; }, animateFeet() {}, poseSeated(a) { this.seated = a; } };
  const hands = { attached: true, detach() { this.attached = false; }, attach() { this.attached = true; } };
  const player = new Player({ camera, physics, character, hands, input, getSensitivity: () => 1 });
  player.teleport(3.4, 16, 0);
  const toasts = []; let dropped = 0, down = false;
  const net = { myId: null, inRoom: false, renderTimeSec: () => 0 };
  const remotes = { players: new Map() };
  const sys = new VehicleSystem({ scene: new THREE.Scene(), camera, physics, player, character, hands, input, net, remotes, toast: (t) => toasts.push(t), dropCrate: () => { dropped++; }, isDown: () => down, getSensitivity: () => 1 });
  const r = { physics, camera, keys, pressed, input, character, hands, player, sys, toasts, remotes, look: (x, y) => { look = { x, y }; }, setDown: (v) => { down = v; }, get dropped() { return dropped; } };
  // one frame, in the same order as main.js
  r.frame = (dt = 1 / 60) => {
    sys.frameStart();
    const driving = sys.driving;
    sys.beforePhysics(dt);
    if (!driving) player.beginFrame(dt);
    const n = Math.max(1, Math.ceil(dt / CONFIG.physics.maxSubstep)), h = dt / n;
    for (let i = 0; i < n; i++) { if (!sys.driving) player.fixedUpdate(h); sys.fixedUpdate(h); physics.step(h); sys.afterStep(); if (!sys.driving) player.afterStep(); }
    sys.afterPhysics(dt);
    const view = sys.updateView(dt) || player.updateView(dt);
    sys.applyBlend(dt);
    pressed.clear();
    return view;
  };
  r.run = (secs) => { for (let t = 0; t < secs; t += 1 / 60) r.frame(); };
  r.press = (code) => { pressed.add(code); r.frame(); };
  r.tap = async (code) => { pressed.add(code); r.frame(); for (let i = 0; i < 4; i++) await Promise.resolve(); r.frame(); };
  return r;
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

console.log('vehicle client glue');

await test('walking up and pressing H seats you: body carried at the seat, walking disabled, hands put away, HUD on', async () => {
  const r = rig(); r.run(1);
  assert.equal(r.sys.driving, false);
  assert.ok(!document.getElementById('vprompt').hidden && /Press/.test(document.getElementById('vprompt').innerHTML), 'the enter prompt shows when you are next to the car');
  await r.tap('KeyH');
  assert.equal(r.sys.driving, true);
  const b = r.player.body;
  assert.ok(b.noCollide && b.noGravity, 'player body no longer takes part in the physics');
  assert.equal(r.hands.attached, false); assert.equal(r.character.fp, false, 'third person body shown');
  assert.equal(r.sys.vehicle.occupied, true);
  assert.equal(document.getElementById('vhud').hidden, false);
  assert.ok(document.body.classList.contains('driving'));
  assert.ok(r.dropped >= 1, 'a carried crate is put down first');
  r.run(0.6);
  const seat = r.sys.seatWorld();
  assert.ok(dist(b.pos, seat) < 0.02, `body is ${dist(b.pos, seat).toFixed(3)} m from the seat`);
});

await test('driving keys: W accelerates, S brakes then reverses, A/D steer the right way, Space is the handbrake; HUD follows', async () => {
  const r = rig(); await r.tap('KeyH'); r.run(0.5);
  const v = r.sys.vehicle;
  r.keys.add('KeyW'); r.run(3);
  assert.ok(v.speed > 8 && v.forwardSpeed > 8, `speed ${v.speed}`);
  assert.equal(document.getElementById('vh-kmh').textContent, String(Math.round(v.speed * 3.6)));
  assert.ok(document.getElementById('vh-gD').classList.contains('on'));
  r.keys.add('KeyD'); r.run(0.6);
  assert.ok(v.steerAngle > 0.05, `D steers right (${v.steerAngle})`); assert.ok(v.body.angVel.y < -0.05, 'and the car turns clockwise seen from above');
  r.keys.delete('KeyD'); r.keys.add('KeyA'); r.run(1.2);
  assert.ok(v.steerAngle < -0.02 || v.body.angVel.y > 0, 'A steers left');
  r.keys.delete('KeyA'); r.keys.delete('KeyW');
  r.keys.add('Space'); r.run(0.3);
  assert.ok(v.handbrakeOn && document.getElementById('vh-hb').classList.contains('on'), 'handbrake indicator lights');
  r.keys.delete('Space'); r.keys.add('KeyS'); r.run(5);
  assert.ok(v.forwardSpeed < -2, 'S: brake, then reverse');
  assert.ok(document.getElementById('vh-gR').classList.contains('on'), 'R is lit in reverse');
});

await test('the third-person camera sits behind and above the car, looks at it, and widens with speed', async () => {
  const r = rig(); await r.tap('KeyH'); r.run(1.2);
  const v = r.sys.vehicle, c = r.camera;
  assert.ok(c.position.z > v.body.pos.z + 3 && c.position.y > 1.3, `camera ${c.position.x.toFixed(1)}, ${c.position.y.toFixed(1)}, ${c.position.z.toFixed(1)}`);
  assert.ok(c.lookedAt && Math.abs(c.lookedAt.x - v.body.pos.x) < 0.3 && Math.abs(c.lookedAt.z - v.body.pos.z) < 0.5);
  const fov0 = c.fov; r.keys.add('KeyW'); r.run(6);
  assert.ok(c.fov > fov0 + 2, `fov ${fov0.toFixed(1)} -> ${c.fov.toFixed(1)}`);
});

await test('entering blends the camera smoothly (no single-frame jump) from the walking view to the car view', async () => {
  const r = rig(); r.run(0.5);
  const before = r.camera.position.clone();
  await r.tap('KeyH');
  let maxStep = 0, prev = r.camera.position.clone();
  for (let i = 0; i < 40; i++) { r.frame(); maxStep = Math.max(maxStep, prev.distanceTo(r.camera.position)); prev = r.camera.position.clone(); }
  assert.ok(maxStep < 1.0, `largest single-frame camera move ${maxStep.toFixed(2)} m`);
  assert.ok(r.sys.blend === null, 'transition finished');
  assert.ok(prev.distanceTo(before) > 2, 'and the camera did end up somewhere else');
});

await test('getting out: refused while fast ("slow down"), allowed once slow; you land beside the car, clear of it, with walking restored', async () => {
  const r = rig(); await r.tap('KeyH'); r.run(0.4);
  const v = r.sys.vehicle, b = r.player.body;
  r.keys.add('KeyW'); r.run(3); r.keys.delete('KeyW');
  assert.ok(v.speed > VC.exitMaxSpeed);
  await r.tap('KeyH');
  assert.equal(r.sys.driving, true, 'cannot jump out at speed');
  assert.ok(r.toasts.some((t) => /slow down/i.test(t)));
  r.keys.add('KeyS'); r.run(2.5); r.keys.delete('KeyS'); r.run(1.5);
  assert.ok(v.speed < 2, `stopped (${v.speed})`);
  await r.tap('KeyH');
  assert.equal(r.sys.driving, false);
  assert.ok(!b.noCollide && !b.noGravity, 'back in the physics world');
  assert.ok(r.hands.attached && r.character.fp, 'first person restored');
  assert.equal(v.occupied, false); assert.equal(document.getElementById('vhud').hidden, true);
  assert.ok(!document.body.classList.contains('driving'));
  const lx = b.pos.x - v.body.pos.x, lz = b.pos.z - v.body.pos.z;
  const R = v.body.R, side = lx * R[0] + lz * R[6];
  assert.ok(Math.abs(side) > VC.chassis.size[0] / 2 + 0.3, `lateral offset ${side.toFixed(2)}`);
  assert.ok(Math.abs(b.pos.y) < 0.1, `feet on the ground (y ${b.pos.y})`);
  // overlap test with the car box
  const hz = VC.chassis.size[2] / 2, along = lx * -R[2] + lz * -R[8];
  assert.ok(Math.abs(side) > 0.92 + 0.3 || Math.abs(along) > hz + 0.3, 'not inside the car');
  r.run(2);                                                         // walking works again and nothing explodes
  assert.ok(Number.isFinite(b.pos.x) && Math.hypot(b.vel.x, b.vel.z) < 1);
  r.keys.add('KeyW'); r.run(1); assert.ok(Math.hypot(b.vel.x, b.vel.z) > 2, 'WASD walks again');
});

await test('no safe space nearby: you cannot get out', async () => {
  const r = rig(); await r.tap('KeyH'); r.run(0.5);
  const v = r.sys.vehicle, p = v.body.pos;
  // a solid pen around the car, 0.4 m off its sides, so nowhere to stand within reach
  for (const [x, z, w, d] of [[-2.2, 0, 1, 14], [2.2, 0, 1, 14], [0, -3.6, 8, 1], [0, 3.6, 8, 1]]) r.physics.add(new Body({ size: [w, 3, d], position: [p.x + x, 0, p.z + z], name: 'pen', ...M.wall }));
  r.run(0.3);
  await r.tap('KeyH');
  assert.equal(r.sys.driving, true, 'still in the car');
  assert.ok(r.toasts.some((t) => /no room/i.test(t)));
});

await test('exit spot avoids another player standing there', async () => {
  const r = rig(); await r.tap('KeyH'); r.run(0.5);
  const v = r.sys.vehicle, R = v.body.R;
  const rp = { id: 'X', hasState: true, pos: { x: v.body.pos.x - R[0] * 1.9, z: v.body.pos.z - R[6] * 1.9 }, seat: null };
  r.remotes.players.set('X', rp);
  await r.tap('KeyH');
  assert.equal(r.sys.driving, false);
  assert.ok(Math.hypot(r.player.body.pos.x - rp.pos.x, r.player.body.pos.z - rp.pos.z) > 0.8, 'not on top of them');
});

await test('overturned car: R stands it up, still, in a clear spot, with a cooldown and a hint on the HUD', async () => {
  const r = rig(); await r.tap('KeyH'); r.run(0.5);
  const v = r.sys.vehicle, b = v.body;
  b.quat.set(Math.sin(0.35), 0, Math.cos(0.35), 0); b.pos.y = 1.2; b.updateBounds(); b.wake();
  r.run(2.5);
  assert.ok(v.flipped, 'is flipped');
  assert.equal(document.getElementById('vh-flip').hidden, false, 'the HUD offers the reset');
  r.keys.add('KeyW'); r.run(0.2); r.keys.delete('KeyW');
  await r.tap('KeyR');
  r.run(0.3);
  assert.ok(v.upDot > 0.99 && !v.flipped, 'upright');
  assert.ok(v.speed < 0.5, 'not launched');
  assert.equal(v.resetSeq, 1);
  assert.equal(document.getElementById('vh-flip').hidden, true);
  const n = r.toasts.length; await r.tap('KeyR');
  assert.ok(r.toasts.length > n && /wait/i.test(r.toasts[r.toasts.length - 1]), 'resets are rate limited');
  assert.equal(v.resetSeq, 1);
  assert.ok(dist(r.player.body.pos, r.sys.seatWorld()) < 0.05, 'the driver went with the car');
});

await test('reset next to a crate or a person picks a clear spot instead of stacking things', async () => {
  const r = rig(); await r.tap('KeyH'); r.run(0.5);
  const v = r.sys.vehicle, b = v.body, x0 = b.pos.x, z0 = b.pos.z;
  const crate = r.physics.add(new Body({ size: [0.8, 0.8, 0.8], position: [x0 + 1.3, 0.4, z0], mass: 40, dynamic: true, baseOrigin: false, name: 'crate', ...M.crate }));
  r.remotes.players.set('Y', { id: 'Y', hasState: true, pos: { x: x0, z: z0 - 1.5 }, seat: null });
  b.quat.set(1, 0, 0, 0); b.pos.y = 1.0; b.updateBounds(); b.wake(); r.run(2);
  await r.tap('KeyR'); r.run(1);
  assert.ok(v.upDot > 0.99);
  assert.ok(Math.hypot(b.pos.x - x0, b.pos.z - z0) > 0.5, 'it moved off the spot that was occupied');
  assert.ok(crate.vel.length() < 0.1, `crate untouched (${crate.vel.length().toFixed(2)} m/s)`);
  assert.ok(Math.hypot(b.pos.x - 0, b.pos.z - (z0 - 1.5)) > 0 );
});

await test('knocked out / entering while knocked out: you do not get in; being knocked out by the server throws you out safely', async () => {
  const r = rig(); r.setDown(true); await r.tap('KeyH');
  assert.equal(r.sys.driving, false);
  r.setDown(false); await r.tap('KeyH'); assert.equal(r.sys.driving, true);
  r.run(0.3);
  r.sys.sync.onDriver({ id: r.sys.id, driver: 'someoneElse', owner: 'someoneElse', t: 0 });      // the server took the seat away
  assert.equal(r.sys.driving, false);
  assert.ok(!r.player.body.noCollide && r.toasts.some((t) => /thrown out/i.test(t)));
  assert.ok(Number.isFinite(r.player.body.pos.x));
});

await test('a car somebody else drives cannot be entered here; the prompt says who is driving', async () => {
  const r = rig(); r.run(0.3);
  r.sys.sync.st.get(r.sys.id).driver = 'P2'; r.sys.sync.st.get(r.sys.id).driverName = 'Pat';
  r.run(0.2);
  assert.ok(/Pat is driving/.test(document.getElementById('vprompt').innerHTML));
  await r.tap('KeyH');
  assert.equal(r.sys.driving, false); assert.ok(r.toasts.some((t) => /already driving/i.test(t)));
});

await test('other players who drive are drawn sitting in the car, using the car\'s own rendered pose', async () => {
  const r = rig(); r.run(0.3);
  const rp = { id: 'P2', seat: null }; r.remotes.players.set('P2', rp);
  const rp3 = { id: 'P3', seat: null }; r.remotes.players.set('P3', rp3);
  r.sys.sync.st.get(r.sys.id).driver = 'P2';
  r.run(0.1);
  assert.ok(rp.seat && dist(rp.seat, r.sys.seatWorld()) < 0.01 && rp.seat.q.length === 4);
  assert.equal(rp3.seat, null, 'only the driver sits');
  r.sys.sync.st.get(r.sys.id).driver = null; r.run(0.1);
  assert.equal(rp.seat, null);
  // the RemotePlayer side: it eases into the seat and out again
  const proto = Object.create(RemotePlayer.prototype);
  const posed = [];
  Object.assign(proto, { seat: { x: 5, y: 1, z: 7, q: [0, 0, 0, 1], steer: 0.2 }, _seatLast: null, seatAmt: 0, _seatQ: new THREE.Quaternion(), root: new THREE.Object3D(), tag: new THREE.Object3D(), character: { poseSeated: (a, s) => posed.push([a, s]) } });
  for (let i = 0; i < 60; i++) proto._applySeat(1 / 60);
  assert.ok(proto.seatAmt > 0.9 && Math.abs(proto.root.position.x - 5) < 1.2 && posed.length > 40, 'sits down smoothly');
  proto.seat = null; for (let i = 0; i < 120; i++) proto._applySeat(1 / 60);
  assert.equal(proto.seatAmt, 0);
});

await test('walking into a moving car knocks you down; a parked car does not', async () => {
  const r = rig(); r.run(0.3);
  const v = r.sys.vehicle; let knocks = 0; r.player.knock = () => { knocks++; };
  r.player.teleport(v.body.pos.x + 0.5, v.body.pos.z + 2.4, 0);     // standing right behind the car
  v.body.vel.set(0, 0, 9); v.body.wake(); v.occupied = false; v.afterStep();
  r.sys._roadkill(); assert.equal(knocks, 1, 'a car backing into you at 9 m/s');
  knocks = 0; r.sys.roadkillAt = -1e9; v.body.vel.set(0, 0, 0); v.afterStep();
  r.sys._roadkill(); assert.equal(knocks, 0, 'standing still: nothing');
});

await test('the crusher press flings a car out from under it', async () => {
  const r = rig(); r.run(0.3);
  const b = r.sys.vehicle.body;
  r.sys.crusherPush({ covers: () => true, x: b.pos.x - 1, z: b.pos.z, y: 0.5 }, false);
  assert.equal(b.vel.length() < 0.5, true, 'no danger: untouched');
  r.sys.crusherPush({ covers: () => true, x: b.pos.x - 1, z: b.pos.z, y: 0.5 }, true);
  assert.ok(b.vel.x > 8, `flung away (${b.vel.x.toFixed(1)})`);
});

await test('the model\'s wheels steer and spin, and the brake lights come on', async () => {
  const r = rig(); await r.tap('KeyH'); r.run(0.3);
  r.keys.add('KeyW'); r.keys.add('KeyD'); r.run(2.5);
  const nodes = r.sys.model.wheelNodes;
  assert.ok(nodes[0].pivot.rotation.y < -0.02 && nodes[1].pivot.rotation.y < -0.02, 'front wheels turned (negative y = right in three.js)');
  assert.equal(nodes[2].pivot.rotation.y, 0, 'rear wheels do not steer');
  const s0 = nodes[0].spinner.rotation.x; r.run(0.3);
  assert.notEqual(nodes[0].spinner.rotation.x, s0, 'wheels visibly rotate');
  const g = r.sys.model.group;
  assert.ok(Math.abs(g.position.x - r.sys.vehicle.body.pos.x) < 1e-9);
  r.keys.delete('KeyW'); r.keys.add('KeyS'); r.run(0.4);
  assert.ok(r.sys.model.tailMat.emissiveIntensity > 1, 'brake lights');
  // suspension: wheel hangs `length` below its mount in car space
  assert.ok(Math.abs(nodes[0].pivot.position.y - (nodes[0].w.local[1] - nodes[0].w.length)) < 1e-9);
});

await test('the ramp and bumps exist as static bodies in the same world, and the car drives over them without the camera or seat misbehaving', async () => {
  const r = rig(); buildCoursePhysics(r.physics);
  r.sys.vehicle.place(34, 30, 0); r.player.teleport(34 - 3, 30, 0); r.run(0.5);
  await r.tap('KeyH'); r.run(0.3);
  r.keys.add('KeyW'); r.run(6);
  const b = r.sys.vehicle.body;
  assert.ok(b.pos.z < 10, `drove over the bumps (z ${b.pos.z.toFixed(1)})`);
  assert.ok(dist(r.player.body.pos, r.sys.seatWorld()) < 0.02);
  assert.ok(Number.isFinite(r.camera.position.y) && r.camera.position.y > 0.3);
});

console.log(`${passed} passed`);
