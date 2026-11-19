// Headless checks for the drivable car: it runs in the SAME physics world as the crates and the player. Run: npm run test:vehicle
import assert from 'node:assert/strict';
import { PhysicsWorld, Body } from '../js/physics.js';
import { CONFIG } from '../js/config.js';
import { Vehicle, restHeightOf, findResetSpot, findExitSpot, footprintFree, NET_LEN } from '../js/vehicle.js';
import { buildCoursePhysics, COURSE, rampPose } from '../js/course.js';

const M = CONFIG.materials, H = 1 / 120, deg = (r) => (r * 180) / Math.PI;
CONFIG.world.limit = 5000;                    // long straight runs: don't let the arena edge stop the car mid-test

let passed = 0;
function test(name, fn) {
  const t0 = performance.now();
  try { fn(); passed++; console.log(`  ok   ${name}  (${(performance.now() - t0).toFixed(0)} ms)`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

function world() {
  const w = new PhysicsWorld();
  w.add(new Body({ size: [9000, 10, 9000], position: [0, -10, 0], name: 'ground', ...M.ground })).rayIgnore = true;
  return w;
}
function car(w, x = 0, z = 0, yaw = 0, driver = true) {
  const v = new Vehicle({ physics: w, spawn: { x, z, yaw } });
  v.occupied = driver;
  return v;
}
function crate(w, size, x, y, z) {
  return w.add(new Body({ size: [size, size, size], position: [x, y + size / 2, z], mass: M.crate.density * size ** 3, dynamic: true, baseOrigin: false, name: 'crate', friction: M.crate.friction, restitution: M.crate.restitution }));
}
function barrel(w, x, y, z) {
  return w.add(new Body({ shape: 'cyl', radius: 0.3, height: 0.9, position: [x, y + 0.45, z], mass: M.barrel.mass, dynamic: true, baseOrigin: false, name: 'barrel', friction: M.barrel.friction, restitution: M.barrel.restitution }));
}
function sim(w, v, secs, ctl, each) {
  const n = Math.round(secs / H);
  for (let i = 0; i < n; i++) { const t = i * H; if (ctl) ctl(t, v); v.fixedUpdate(H); w.step(H); v.afterStep(H); if (each) each(t, v); }
}
// a car already rolling at `kmh` (km/h) toward -Z on its springs
function rolling(kmh, opts = {}) {
  const w = opts.world || world(), v = car(w, opts.x ?? 0, opts.z ?? 0, opts.yaw ?? 0);
  sim(w, v, 1.0);
  v.body.vel.z = -kmh / 3.6; for (const x of v.wheels) x.omega = v.body.vel.length() / CONFIG.vehicle.wheels.radius;
  return { w, v };
}
const kmh = (v) => v.speed * 3.6;
const fin = (v) => [v.body.pos.x, v.body.pos.y, v.body.pos.z, v.body.vel.x, v.body.vel.y, v.body.vel.z, v.body.quat.w].every(Number.isFinite);
const sideslip = (v) => { const b = v.body, R = b.R; return Math.atan2(b.vel.x * R[0] + b.vel.y * R[3] + b.vel.z * R[6], Math.max(v.forwardSpeed, 0.1)); };

console.log('vehicle');

test('raycasts report the surface normal (ground plane, tilted ramp, lying cylinder)', () => {
  const w = world(), { ramp, bumps } = buildCoursePhysics(w);
  const p = rampPose();
  const down = { x: 0, y: -1, z: 0 };
  const g = w.raycast({ x: 0, y: 2, z: 0 }, down, 5);
  assert.deepEqual(g.normal, [0, 1, 0]);
  const hit = w.raycast({ x: COURSE.ramp.x, y: 3, z: COURSE.ramp.lowZ - 4 }, down, 6, null, (b) => !b.dynamic);
  assert.equal(hit.body, ramp);
  assert.ok(Math.abs(Math.acos(hit.normal[1]) - p.phi) < 0.01, `ramp normal tilt ${deg(Math.acos(hit.normal[1])).toFixed(2)} deg, expected ${deg(p.phi).toFixed(2)}`);
  assert.ok(hit.normal[2] > 0, 'the ramp surface should face back toward +Z (it rises toward -Z)');
  const top = w.raycast({ x: COURSE.bumps.x, y: 2, z: COURSE.bumps.zs[0] }, down, 5, null, (b) => !b.dynamic);
  assert.equal(top.body, bumps[0]);
  assert.ok(Math.abs(2 - top.dist - COURSE.bumps.radius) < 0.01, 'top of the bump is one radius high');
  assert.ok(top.normal[1] > 0.99);
  const none = w.raycast({ x: 0, y: 0.5, z: 0 }, down, 5, null, () => false);
  assert.ok(Math.abs(none.dist - 0.5) < 1e-6, 'a filter that rejects every body leaves only the ground plane');
});

test('the car settles on its springs at the designed ride height, evenly loaded, and stays still', () => {
  const w = world(), v = car(w);
  let maxVy = 0;
  sim(w, v, 3, null, (t) => { if (t > 1.5) maxVy = Math.max(maxVy, Math.abs(v.body.vel.y)); });
  const rest = restHeightOf(v.cfg);
  assert.ok(Math.abs(v.body.pos.y - rest) < 0.01, `rest height ${v.body.pos.y.toFixed(3)}, designed ${rest.toFixed(3)}`);
  assert.equal(v.contacts, 4);
  const weight = (v.body.mass * CONFIG.physics.gravity) / 4;
  for (const wh of v.wheels) assert.ok(Math.abs(wh.load - weight) < 0.06 * weight, `wheel load ${wh.load.toFixed(0)} N vs ${weight.toFixed(0)} N`);
  assert.ok(maxVy < 0.005, `still bouncing: ${maxVy}`);
  assert.ok(v.body.pos.y - v.cfg.chassis.size[1] / 2 > 0.15, 'the chassis box must clear the ground');
});

test('an empty car sleeps (cheap); a driver getting in wakes it', () => {
  const w = world(), v = car(w, 0, 0, 0, false);
  sim(w, v, 4);
  assert.ok(v.body.sleeping, 'a parked car should fall asleep');
  const z = v.body.pos.z;
  v.occupied = true; v.input.throttle = 1;
  sim(w, v, 1);
  assert.ok(!v.body.sleeping && v.body.pos.z < z - 1, 'it should drive away once someone gets in');
});

test('acceleration: 0-100 km/h in a believable 6-11 s, top speed near the configured limit', () => {
  const w = world(), v = car(w);
  sim(w, v, 1);
  v.input.throttle = 1;
  let t100 = null, t = 0;
  sim(w, v, 25, null, (tt) => { t = tt; if (t100 === null && kmh(v) >= 100) t100 = tt; });
  assert.ok(t100 !== null && t100 > 6 && t100 < 11, `0-100 km/h in ${t100} s`);
  const top = CONFIG.vehicle.engine.maxSpeed * 3.6;
  assert.ok(kmh(v) > top * 0.9 && kmh(v) < top * 1.03, `top speed ${kmh(v).toFixed(0)} km/h (limit ${top.toFixed(0)})`);
  assert.ok(v.upDot > 0.99, 'stays level');
  assert.ok(fin(v));
});

test('braking: 100 -> 0 km/h in 30-50 m (about 1 g), and the car does not nose-dive over', () => {
  const { w, v } = rolling(100);
  v.input.throttle = -1;
  let d = 0, minUp = 1;
  sim(w, v, 8, null, () => { if (v.forwardSpeed > 0.3) d += v.speed * H; minUp = Math.min(minUp, v.upDot); });
  assert.ok(d > 30 && d < 50, `braking distance ${d.toFixed(1)} m`);
  assert.ok(minUp > 0.97, `pitched too far: ${minUp}`);
});

test('holding S after stopping reverses, with a lower top speed; W while rolling backwards brakes first', () => {
  const w = world(), v = car(w);
  sim(w, v, 1);
  v.input.throttle = -1;
  sim(w, v, 8);
  assert.ok(v.forwardSpeed < -5, `reversing at ${v.forwardSpeed.toFixed(1)} m/s`);
  assert.ok(-v.forwardSpeed < CONFIG.vehicle.engine.reverseMaxSpeed + 1.5, `reverse too fast: ${v.forwardSpeed}`);
  assert.equal(v.gear, 'R');
  v.input.throttle = 1;
  sim(w, v, 0.4);
  assert.ok(v.brk > 0.5 && v.thr < 0.2, 'W while moving backwards should be a brake, not full drive');
  sim(w, v, 6);
  assert.ok(v.forwardSpeed > 5, 'then it drives forward');
});

test('steering gets less sensitive with speed (lock angle shrinks), and returns to centre', () => {
  const lock = (kph) => { const { w, v } = rolling(kph); v.input.steer = 1; sim(w, v, 1.5); return v.steerAngle; };
  const slow = lock(20), mid = lock(70), fast = lock(130);
  assert.ok(slow > 0.5, `parking-speed lock ${slow.toFixed(2)} rad`);
  assert.ok(mid < slow * 0.7 && fast < mid * 0.7, `lock should fall with speed: ${slow.toFixed(2)} > ${mid.toFixed(2)} > ${fast.toFixed(2)}`);
  assert.ok(fast < 0.15, `highway lock ${fast.toFixed(2)} rad is small`);
  const { w, v } = rolling(50); v.input.steer = 1; sim(w, v, 1); v.input.steer = 0; sim(w, v, 1.5);
  assert.ok(Math.abs(v.steerAngle) < 0.02, 'wheels re-centre');
});

test('grip, not ice: it turns promptly, corners at about 1 g, follows the wheels (small sideslip), barely rolls', () => {
  for (const [kph, st] of [[30, 0.5], [50, 0.5], [90, 1]]) {
    const { w, v } = rolling(kph);
    v.input.steer = st; v.input.throttle = 0.35;
    let yaw02 = null, maxRoll = 0, slipSum = 0, n = 0;
    sim(w, v, 5, null, (t) => {
      if (yaw02 === null && Math.abs(v.body.angVel.y) > 0.2) yaw02 = t;
      maxRoll = Math.max(maxRoll, Math.acos(Math.min(1, v.upDot)));
      if (t > 3) { slipSum += Math.abs(sideslip(v)); n++; }
    });
    const ay = Math.abs(v.body.angVel.y) * v.speed / CONFIG.physics.gravity;
    assert.ok(yaw02 !== null && yaw02 < 0.4, `${kph} km/h: first response after ${yaw02} s`);
    assert.ok(ay > 0.8 && ay < 1.25, `${kph} km/h: lateral acceleration ${ay.toFixed(2)} g`);
    assert.ok(slipSum / n < 0.12, `${kph} km/h: mean sideslip ${deg(slipSum / n).toFixed(1)} deg - sliding like on ice`);
    assert.ok(deg(maxRoll) < 6, `${kph} km/h: body roll ${deg(maxRoll).toFixed(1)} deg`);
    assert.ok(v.upDot > 0.98);
  }
});

test('letting go of the wheel at speed straightens the car out (no endless sliding)', () => {
  const { w, v } = rolling(80);
  v.input.steer = 1; sim(w, v, 1.5);
  assert.ok(Math.abs(v.body.angVel.y) > 0.2);
  v.input.steer = 0; sim(w, v, 2.5);
  assert.ok(Math.abs(v.body.angVel.y) < 0.1, `still rotating at ${v.body.angVel.y.toFixed(2)} rad/s`);
  assert.ok(Math.abs(sideslip(v)) < 0.05, 'and no longer sliding sideways');
});

test('handbrake: the tail steps out into a drift (a clearly larger slip angle than without), nothing flips, and it recovers', () => {
  const run = (hb) => {
    const { w, v } = rolling(70);
    let maxSlip = 0, minUp = 1;
    v.input.steer = 0.5;
    sim(w, v, 4.5, (t) => { v.input.handbrake = hb && t > 0.2 && t < 0.55; if (t > 0.55) v.input.steer = 0; }, () => { maxSlip = Math.max(maxSlip, Math.abs(sideslip(v))); minUp = Math.min(minUp, v.upDot); });
    return { v, maxSlip: deg(maxSlip), minUp };
  };
  const without = run(false), withHb = run(true);
  assert.ok(withHb.maxSlip > 10, `handbrake drift slip ${withHb.maxSlip.toFixed(0)} deg`);
  assert.ok(withHb.maxSlip > without.maxSlip * 1.8, `no difference: ${withHb.maxSlip.toFixed(0)} vs ${without.maxSlip.toFixed(0)} deg`);
  assert.ok(withHb.maxSlip < 80, 'a short pull must not spin the car around');
  assert.ok(withHb.minUp > 0.95, 'never rolls');
  assert.ok(Math.abs(withHb.v.body.angVel.y) < 0.15, 'rotation settles after the pull');
  assert.ok(withHb.v.speed < without.v.speed, 'the handbrake scrubs speed');
});

test('handbrake held at a standstill holds the car; held while driving, the rear wheels visibly lock', () => {
  const { w, v } = rolling(50);
  v.input.handbrake = true;
  sim(w, v, 0.6);
  assert.ok(v.handbrakeOn && v.wheels[2].locked && v.wheels[3].locked && !v.wheels[0].locked);
  assert.ok(Math.abs(v.wheels[2].omega) < Math.abs(v.wheels[0].omega) * 0.5 + 1, 'rear wheel rotation stops');
});

test('power slide: full throttle with full lock out of a slow corner kicks the tail out a little but stays controllable', () => {
  const { w, v } = rolling(20);
  v.input.throttle = 1; v.input.steer = 0.8;
  let mx = 0; sim(w, v, 3, null, () => { mx = Math.max(mx, Math.abs(sideslip(v))); });
  assert.ok(deg(mx) > 3 && deg(mx) < 45, `slip ${deg(mx).toFixed(1)} deg`);
  assert.ok(v.upDot > 0.98);
});

test('collision: a crate and a barrel in the way are shoved ahead, the car keeps most of its speed and stays upright', () => {
  for (const [name, make] of [['crate', (w) => crate(w, 0.8, 0, 0, -22)], ['barrel', (w) => barrel(w, 0, 0, -22)]]) {
    const w = world(), item = make(w);
    const v = car(w); sim(w, v, 1);
    v.body.vel.z = -15; v.input.throttle = 0.3;
    let hitAt = null;
    sim(w, v, 3, null, (t) => { if (hitAt === null && item.speed > 1) hitAt = t; });
    assert.ok(hitAt !== null, `${name} was never hit`);
    assert.ok(-item.vel.z > 8 || item.pos.z < -30, `${name} should be flung ahead (vz ${item.vel.z.toFixed(1)}, z ${item.pos.z.toFixed(1)})`);
    assert.ok(v.speed > 9, `the car lost too much speed: ${v.speed.toFixed(1)} m/s`);
    assert.ok(v.upDot > 0.97 && fin(v) && fin({ body: item }), 'car upright, nothing exploded');
  }
});

test('collision: hitting a wall at 70 km/h stops the car against it - no tunnelling, no explosion', () => {
  const w = world();
  w.add(new Body({ size: [14, 3, 0.6], position: [0, 0, -40], name: 'wall', ...M.wall }));
  const v = car(w, 0, 0); sim(w, v, 1);
  v.body.vel.z = -70 / 3.6; v.input.throttle = 1;
  let minZ = 0, maxVy = 0;
  sim(w, v, 4, null, () => { minZ = Math.min(minZ, v.body.pos.z); maxVy = Math.max(maxVy, Math.abs(v.body.vel.y)); });
  assert.ok(minZ > -40 + 0.3 - 2.1 - 0.5, `went through the wall: front reached z=${(minZ - 2.1).toFixed(2)}`);
  assert.ok(v.body.pos.z - 2.1 > -40 + 0.3 - 0.1, `ended inside the wall (${(v.body.pos.z - 2.1).toFixed(2)})`);
  assert.ok(v.speed < 6, `should have been stopped, speed ${v.speed.toFixed(1)}`);
  assert.ok(maxVy < 8 && fin(v), `launched upward at ${maxVy.toFixed(1)} m/s`);
});

test('collision: an off-centre wall strike (front corner) turns the car rather than stopping it dead', () => {
  const w = world();
  w.add(new Body({ size: [10, 3, 0.6], position: [4.5, 0, -30], name: 'wall', ...M.wall }));      // covers x in [-0.5, 9.5]; the car (x -2.1..-0.3) only clips it with its right front corner
  const v = car(w, -1.2, 0); sim(w, v, 1);
  v.body.vel.z = -15; let maxYaw = 0;
  sim(w, v, 2.5, null, () => { maxYaw = Math.max(maxYaw, Math.abs(v.body.angVel.y)); });
  assert.ok(maxYaw > 0.4, `a glancing hit should spin the car, peak yaw rate ${maxYaw.toFixed(2)}`);
  assert.ok(fin(v));
});

test('the same box shoves the player like any other body (and a seated player is not a body in the way)', () => {
  const w = world();
  const P = CONFIG.player;
  const p = w.add(new Body({ size: [P.radius * 2, P.height, P.radius * 2], position: [0, 0, -15], mass: P.mass, dynamic: true, baseOrigin: true, lockRotation: true, friction: 0, name: 'player' }));
  p.isPlayer = true;
  const v = car(w); sim(w, v, 1); v.body.vel.z = -8; v.input.throttle = 0.2;
  sim(w, v, 3);
  assert.ok(p.vel.z < -3 || p.pos.z < -17, `player should be pushed ahead (z ${p.pos.z.toFixed(2)})`);
  // a seated player sits inside the car box: with noCollide nothing happens to either of them
  const w2 = world(), v2 = car(w2); sim(w2, v2, 1);
  const q = w2.add(new Body({ size: [0.6, 1.8, 0.6], position: [0, 0, 0], mass: 75, dynamic: true, baseOrigin: true, lockRotation: true, friction: 0, name: 'player' }));
  q.isPlayer = true; q.noCollide = true; q.noGravity = true;
  const zBefore = v2.body.pos.z;
  for (let i = 0; i < 240; i++) { q.pos.set(v2.body.pos.x - 0.4, v2.body.pos.y - 0.5, v2.body.pos.z); q.vel.copy(v2.body.vel); v2.fixedUpdate(H); w2.step(H); v2.afterStep(H); }
  assert.ok(Math.abs(v2.body.pos.z - zBefore) < 0.05 && w2.contacts.length === 0, 'the car must not be disturbed by its own driver');
});

test('suspension reacts to uneven ground: speed bumps move the wheels and body, and it is not violent', () => {
  const w = world(); buildCoursePhysics(w);
  const v = car(w, COURSE.bumps.x, 30); sim(w, v, 1);
  v.body.vel.z = -30 / 3.6; v.input.throttle = 0.2;
  const lens = [Infinity, -Infinity]; let maxPitch = 0, maxVy = 0, airFrames = 0, frames = 0, minContacts = 4;
  sim(w, v, 4.5, null, () => {
    frames++; const L = v.wheels[0].length; lens[0] = Math.min(lens[0], L); lens[1] = Math.max(lens[1], L);
    maxPitch = Math.max(maxPitch, Math.abs(Math.asin(v.body.R[7])));
    if (v.body.pos.z < COURSE.bumps.zs[0] + 3) { maxVy = Math.max(maxVy, Math.abs(v.body.vel.y)); minContacts = Math.min(minContacts, v.contacts); }
  });
  assert.ok(v.body.pos.z < COURSE.bumps.zs[0] - 3, 'did not drive over the bumps');
  assert.ok(lens[1] - lens[0] > 0.04, `wheel travel across the bumps only ${(lens[1] - lens[0]).toFixed(3)} m`);
  assert.ok(deg(maxPitch) < 8, `pitched ${deg(maxPitch).toFixed(1)} deg`);
  assert.ok(maxVy > 0.1 && maxVy < 2.5, `vertical speed over the bumps ${maxVy.toFixed(2)} m/s`);
  assert.ok(v.upDot > 0.98 && fin(v));
  sim(w, v, 3);
  assert.equal(v.contacts, 4, 'all four wheels back on the ground afterwards');
});

test('each wheel has its own suspension: driving one side over a bump tilts the body (roll), not just heave', () => {
  const w = world(); buildCoursePhysics(w);
  const v = car(w, COURSE.bumps.x + 3.0, 30); sim(w, v, 1);       // bumps span x 30.5..37.5: at x=37 the left wheels (36.2) are on them, the right wheels (37.8) are past the end
  v.body.vel.z = -25 / 3.6; v.input.throttle = 0.4;
  let maxRoll = 0, diff = 0;
  sim(w, v, 5, null, () => { maxRoll = Math.max(maxRoll, Math.abs(Math.asin(v.body.R[1]))); diff = Math.max(diff, Math.abs(v.wheels[0].length - v.wheels[1].length)); });
  assert.ok(v.body.pos.z < COURSE.bumps.zs[0] - 3, `stuck at z=${v.body.pos.z.toFixed(2)} x=${v.body.pos.x.toFixed(2)} speed ${v.speed.toFixed(2)} contacts ${v.contacts}`);
  assert.ok(diff > 0.04, `left and right wheels should move independently (max difference ${diff.toFixed(3)} m)`);
  assert.ok(deg(maxRoll) > 0.4 && deg(maxRoll) < 8, `roll ${deg(maxRoll).toFixed(2)} deg`);
  assert.ok(fin(v) && v.upDot > 0.97);
});

test('a ramp: the car drives up it, goes airborne, lands on all four wheels, upright and still drivable', () => {
  const w = world(), { ramp } = buildCoursePhysics(w);
  const v = car(w, COURSE.ramp.x, COURSE.ramp.lowZ + 25); sim(w, v, 1);
  v.body.vel.z = -60 / 3.6; v.input.throttle = 0.4;
  let air = 0, maxY = 0, maxPitchUp = 0, onRamp = false, maxVy = 0;
  sim(w, v, 6, null, (t) => {
    if (v.contacts === 0) air += H;
    maxY = Math.max(maxY, v.body.pos.y); maxVy = Math.max(maxVy, Math.abs(v.body.vel.y));
    if (v.wheels.every((x) => x.contact && x.normal[2] > 0.1)) { onRamp = true; maxPitchUp = Math.max(maxPitchUp, Math.asin(-v.body.R[5])); }
  });
  const p = rampPose();
  assert.ok(onRamp, 'never had all wheels on the ramp');
  assert.ok(Math.abs(maxPitchUp - p.phi) < 0.08, `body pitch on the ramp ${deg(maxPitchUp).toFixed(1)} deg vs ramp ${deg(p.phi).toFixed(1)} deg - it should follow the surface`);
  assert.ok(air > 0.2, `only ${air.toFixed(2)} s in the air`);
  assert.ok(maxY > COURSE.ramp.rise + 0.2, 'it should fly');
  assert.equal(v.contacts, 4); assert.ok(v.upDot > 0.95, `upDot ${v.upDot}`); assert.ok(fin(v));
  v.input.throttle = 0.5; const z0 = v.body.pos.z; sim(w, v, 2);
  assert.ok(v.body.pos.z < z0 - 3, 'can drive on after landing');
});

test('a parked car stays put on the ramp (parking brake + tyre grip), and the same with a driver who lets go of everything', () => {
  for (const driver of [false, true]) {
    const w = world(), { ramp } = buildCoursePhysics(w);
    const p = rampPose(), midZ = COURSE.ramp.lowZ - 4.5 * Math.cos(p.phi);
    const v = car(w, COURSE.ramp.x, midZ, 0, driver);
    // lift onto the surface: sample the slab height under the middle
    const h = w.raycast({ x: COURSE.ramp.x, y: 5, z: midZ }, { x: 0, y: -1, z: 0 }, 8, null, (b) => !b.dynamic);
    v.body.pos.y = 5 - h.dist + restHeightOf(v.cfg) + 0.05;
    v.body.setQuat(Math.sin(p.phi / 2), 0, 0, Math.cos(p.phi / 2));            // nose up the slope, like a car parked on it
    sim(w, v, 2); const z0 = v.body.pos.z, y0 = v.body.pos.y;
    sim(w, v, 10);
    const slid = Math.hypot(v.body.pos.z - z0, v.body.pos.y - y0);
    assert.ok(slid < 0.35, `${driver ? 'idle driver' : 'parked'}: rolled ${slid.toFixed(2)} m down a ${deg(p.phi).toFixed(0)} deg ramp in 10 s`);
    assert.ok(v.contacts >= 3 && v.upDot > 0.9);
  }
});

test('knocked on its roof, the car is detected as flipped; reset stands it upright, motionless, without launching anything', () => {
  const w = world(), v = car(w, 0, 0, 0.7, false);
  sim(w, v, 1.5);
  v.body.quat.set(Math.sin(0.35), 0, Math.cos(0.35), 0); v.body.pos.y = 1.0; v.body.vel.set(0, 0, 0); v.body.wake(); v.body.updateBounds();   // roll over completely
  sim(w, v, 3);
  assert.ok(v.flipped, `should be flipped (upDot ${v.upDot.toFixed(2)})`);
  const bystander = crate(w, 0.8, v.body.pos.x + 1.6, 0, v.body.pos.z);      // a crate right where the car would stand up
  const P = CONFIG.player, person = { x: v.body.pos.x - 2.2, z: v.body.pos.z };
  sim(w, v, 0.5);
  const spot = findResetSpot(v, { points: [person] });
  assert.ok(spot, 'a free spot must exist on open ground');
  assert.ok(footprintFree(w, spot.x, spot.z, spot.yaw, 0.97, 2.15, { ignore: [v.body], points: [person], pointRadius: 1.0, y0: 0.05, y1: 1.6 }));
  v.reset(spot.x, spot.z, spot.yaw);
  assert.equal(v.resetSeq, 1);
  assert.ok(!v.canReset(), 'reset has a cooldown (no spamming it)');
  assert.ok(v.body.vel.length() === 0 && v.body.angVel.length() === 0);
  sim(w, v, 3);
  assert.ok(v.upDot > 0.999 && !v.flipped, 'upright');
  assert.ok(v.speed < 0.05, `still moving after reset: ${v.speed}`);
  assert.ok(bystander.speed < 0.05 && bystander.vel.length() < 0.05, `the crate was disturbed by the reset (${bystander.vel.length().toFixed(2)} m/s)`);
  assert.ok(Math.abs(v.yaw() - 0.7) < 0.35, `keeps its heading (${v.yaw().toFixed(2)} vs 0.7)`);
});

test('reset spot search: boxed in by walls on all sides within reach it falls back to a clear ring or home; a person on the spot moves it', () => {
  const w = world(), v = car(w, 0, 0, 0, false); sim(w, v, 1.5);
  // someone standing right next to / on the car's own spot
  const s1 = findResetSpot(v, { points: [{ x: 0.2, z: 0 }] });
  assert.ok(s1 && s1.moved > 0, 'it must not be stood up on top of a person');
  // a crate resting on the spot
  const cr = crate(w, 1.0, 0, 3, 0); cr.pos.y = 0.5; cr.updateBounds();
  const s2 = findResetSpot(v, {});
  assert.ok(s2 && Math.hypot(s2.x, s2.z) > 0.5, 'not on top of a crate');
  // enclosed in a big pen: nothing free anywhere within 9 m -> null unless home is free
  const pen = new PhysicsWorld(); pen.add(new Body({ size: [9000, 10, 9000], position: [0, -10, 0], name: 'ground', ...M.ground })).rayIgnore = true;
  for (let x = -14; x <= 14; x += 2) for (let z = -14; z <= 14; z += 2) if (Math.hypot(x, z) > 1.5) pen.add(new Body({ size: [2, 2, 2], position: [x, 0, z], name: 'block', ...M.wall }));
  const v3 = new Vehicle({ physics: pen, spawn: { x: 0, z: 0, yaw: 0 } }); v3.occupied = false; sim(pen, v3, 1);
  const s3 = findResetSpot(v3, { home: { x: 80, z: 80, yaw: 0 } });
  assert.ok(s3 && s3.x === 80, 'with nothing free nearby, it goes home');
});

test('exiting: the player is put beside the car on the driver side, or the other side if blocked, and nowhere if there is no room', () => {
  const w = world(), v = car(w, 0, 0, 0); sim(w, v, 1.5);
  const a = findExitSpot(v, {});
  assert.ok(a && a.x < -1.5, `driver side expected, got x=${a && a.x}`);
  assert.ok(Math.abs(a.y) < 0.05);
  w.add(new Body({ size: [3, 2, 9], position: [-2.9, 0, 0], name: 'left wall', ...M.wall }));
  const b = findExitSpot(v, {});
  assert.ok(b && b.x > 1.5, `should use the passenger side, got x=${b && b.x}`);
  const c = findExitSpot(v, { points: [{ x: b.x, z: b.z }] });
  assert.ok(!c || Math.hypot(c.x - b.x, c.z - b.z) > 0.8, 'not on top of another player');
  // totally enclosed
  const w2 = world(), v2 = car(w2, 0, 0, 0); sim(w2, v2, 1.5);
  w2.add(new Body({ size: [40, 3, 40], position: [0, 0, 0], name: 'roof slab', ...M.wall })).pos.y = 1.0;
  const slab = w2.all[w2.all.length - 1]; slab.updateBounds();
  assert.equal(findExitSpot(v2, {}), null, 'no safe space -> null (the game then refuses to let you out)');
});

test('network state: a fixed-size packet of finite numbers that carries pose, steering, wheel speed and suspension', () => {
  const { w, v } = rolling(60);
  v.input.steer = 0.5; v.input.handbrake = false; sim(w, v, 0.8);
  const s = v.getNetState();
  assert.equal(s.length, NET_LEN);
  assert.ok(s.every(Number.isFinite));
  assert.ok(Math.abs(s[13] - v.steerAngle) < 1e-3 && s[13] > 0.05, 'steer angle in the packet');
  assert.ok(s[14] > 10 && Math.abs(s[14] - v.wheels[0].omega) < 0.1, 'wheel rate in the packet');
  assert.ok(Math.abs(s[18] - v.wheels[0].length) < 1e-3, 'suspension length in the packet');
  const w2 = world(), v2 = car(w2, 50, 50, 0, false);
  v2.applyNetLook(s);
  assert.ok(Math.abs(v2.steerAngle - s[13]) < 1e-9 && Math.abs(v2.wheels[1].omega - s[15]) < 1e-9);
});

test('performance: a driven car in a busy scene costs a small slice of a 60 fps frame', () => {
  const w = world(); buildCoursePhysics(w);
  for (let i = 0; i < 12; i++) crate(w, 0.6 + (i % 3) * 0.2, -10 + i * 1.3, 0, -20 - (i % 4) * 1.5);
  for (let i = 0; i < 6; i++) barrel(w, -8 + i * 1.2, 0, -26);
  for (let i = 0; i < 20; i++) w.add(new Body({ size: [1, 3, 1], position: [-40 + i * 4, 0, -50], name: 'pillar', ...M.wall }));
  const v = car(w, 0, 10); sim(w, v, 1);
  v.input.throttle = 0.5; v.input.steer = 0.3;
  let worst = 0, sum = 0, n = 0;
  for (let i = 0; i < 6 * 120; i++) {
    const t0 = performance.now(); v.fixedUpdate(H); w.step(H); v.afterStep(H); const dt = performance.now() - t0;
    if (i > 10) { worst = Math.max(worst, dt); sum += dt; n++; }
    if (i % 90 === 0) v.input.steer = -v.input.steer;
  }
  const perFrame = (sum / n) * 2;
  console.log(`         avg ${(sum / n).toFixed(3)} ms per 1/120 s step incl. 4 wheel rays (worst ${worst.toFixed(2)} ms) -> ~${perFrame.toFixed(2)} ms per 60 fps frame`);
  assert.ok(perFrame < 3, `too slow: ${perFrame.toFixed(2)} ms per frame`);
  assert.ok(worst < 10);
});

console.log(`${passed} passed`);
