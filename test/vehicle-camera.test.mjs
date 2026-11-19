// The follow camera is pure maths, so it can be checked headless. Run: npm run test:vehicle-camera
import assert from 'node:assert/strict';
import { PhysicsWorld, Body } from '../js/physics.js';
import { CONFIG } from '../js/config.js';
import { VehicleCamera } from '../js/vehicle-camera.js';

const M = CONFIG.materials;
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}
const world = () => { const w = new PhysicsWorld(); w.add(new Body({ size: [900, 10, 900], position: [0, -10, 0], name: 'ground', ...M.ground })).rayIgnore = true; return w; };
const st = (o = {}) => ({ x: 0, y: 0.6, z: 0, yaw: 0, vx: 0, vz: 0, speed: 0, forwardSpeed: 0, ...o });
const run = (cam, s, secs, w = null, step = 1 / 60) => { for (let t = 0; t < secs; t += step) cam.update(step, s, w, null); };

console.log('vehicle camera');

test('sits behind and above the car and looks at it', () => {
  const cam = new VehicleCamera(); cam.snap(st());
  assert.ok(cam.pos.z > 4 && Math.abs(cam.pos.x) < 0.01, `camera at ${cam.pos.x.toFixed(2)}, ${cam.pos.z.toFixed(2)} (the car faces -Z, so "behind" is +Z)`);
  assert.ok(cam.pos.y > 1.5);
  assert.ok(Math.abs(cam.look.x) < 0.01 && Math.abs(cam.look.z) < 0.01 && cam.look.y > 0.6, 'looks at the car');
  const cam2 = new VehicleCamera(); cam2.snap(st({ yaw: Math.PI / 2 }));       // facing -X: behind is +X
  assert.ok(cam2.pos.x > 4 && Math.abs(cam2.pos.z) < 0.01, `rotated car: ${cam2.pos.x.toFixed(2)}, ${cam2.pos.z.toFixed(2)}`);
});

test('speed pulls the camera back, lifts it and widens the field of view', () => {
  const slow = new VehicleCamera(); slow.snap(st()); run(slow, st(), 3);
  const fast = new VehicleCamera(); const f = st({ vz: -40, speed: 40, forwardSpeed: 40 }); fast.snap(f); run(fast, f, 3);
  const d = (c, s) => Math.hypot(c.pos.x - s.x, c.pos.z - s.z);
  assert.ok(d(fast, f) > d(slow, st()) + 1, `distance ${d(slow, st()).toFixed(2)} -> ${d(fast, f).toFixed(2)}`);
  assert.ok(fast.pos.y > slow.pos.y, 'higher');
  assert.ok(fast.fov > slow.fov + 5, `fov ${slow.fov.toFixed(1)} -> ${fast.fov.toFixed(1)}`);
});

test('follows a turn smoothly: it lags behind a sudden 90 degree turn, then catches up', () => {
  const cam = new VehicleCamera(); cam.snap(st());
  const s = st({ yaw: Math.PI / 2 });
  cam.update(1 / 60, s, null, null);
  assert.ok(cam.yaw < 0.2, `must not snap (yaw ${cam.yaw.toFixed(2)})`);
  run(cam, s, 2.5);
  assert.ok(Math.abs(cam.yaw - Math.PI / 2) < 0.03, `converges (yaw ${cam.yaw.toFixed(2)})`);
});

test('a drift: the camera leans toward the direction of travel instead of the car\'s nose', () => {
  const cam = new VehicleCamera(); cam.snap(st());
  const s = st({ yaw: 0.6, vx: 0, vz: -20, speed: 20, forwardSpeed: 19 });   // nose turned left (+yaw), still travelling straight ahead
  run(cam, s, 3);
  assert.ok(cam.yaw > 0.05 && cam.yaw < 0.6, `camera yaw ${cam.yaw.toFixed(2)} is between travel direction (0) and nose (0.6)`);
});

test('reversing does not flip the camera round to the front', () => {
  const cam = new VehicleCamera(); cam.snap(st());
  const s = st({ vz: 8, speed: 8, forwardSpeed: -8 }); run(cam, s, 3);
  assert.ok(cam.pos.z > 4, 'still behind the car');
});

test('the mouse orbits the camera and it eases back behind the car afterwards', () => {
  const cam = new VehicleCamera(); cam.snap(st()); run(cam, st(), 1);
  cam.orbit(1.2, 0.2); run(cam, st(), 0.3);
  assert.ok(Math.abs(cam.pos.x) > 3, `swung round the car (x ${cam.pos.x.toFixed(2)})`);
  run(cam, st(), 6);
  assert.ok(Math.abs(cam.pos.x) < 0.3 && cam.pos.z > 4, 'back behind it');
});

test('walls: the camera never ends up behind a wall - the arm shortens (quickly), and recovers slowly', () => {
  const w = world();
  w.add(new Body({ size: [30, 6, 0.5], position: [0, 0, 3.2], name: 'wall', ...M.wall }));       // 3.2 m behind the car
  const cam = new VehicleCamera(); cam.snap(st()); cam.update(1 / 60, st(), w, null);
  run(cam, st(), 0.5, w);
  assert.ok(cam.pos.z < 3.2 - 0.25 + 0.001, `camera z ${cam.pos.z.toFixed(2)} is through the wall at z=2.95`);
  assert.ok(cam.collided);
  assert.ok(Math.hypot(cam.pos.x, cam.pos.z) >= CONFIG.vehicle.camera.minDistance - 0.01, 'but never inside the car');
  // the wall is removed: the camera drifts back out over a second or so, it does not teleport
  w.all.splice(w.all.findIndex((b) => b.name === 'wall'), 1); w.statics = w.statics.filter((b) => b.name !== 'wall');
  const armBefore = cam.arm; cam.update(1 / 60, st(), w, null);
  assert.ok(cam.arm - armBefore < 0.2, 'eases out');
  run(cam, st(), 3, w);
  assert.ok(cam.pos.z > 5, 'and fully recovers');
});

test('a fast car in a narrow gap: the camera is clamped every frame, never behind the wall even for one frame', () => {
  const w = world();
  const cam = new VehicleCamera(); const s0 = st({ vz: -30, speed: 30, forwardSpeed: 30 }); cam.snap(s0);
  let worst = -Infinity;
  for (let i = 0; i < 300; i++) {
    const z = 40 - i * 0.5;                                        // car drives toward -Z; a wall appears 3 m behind it each frame
    const s = { ...s0, z };
    const wall = w.add(new Body({ size: [30, 6, 0.5], position: [0, 0, z + 3.0], name: 'wall', ...M.wall }));
    cam.update(1 / 60, s, w, null);
    worst = Math.max(worst, cam.pos.z - (z + 3.0 - 0.25));
    w.all.splice(w.all.indexOf(wall), 1); w.statics.splice(w.statics.indexOf(wall), 1);
  }
  assert.ok(worst < 0.01, `camera poked ${worst.toFixed(3)} m past the wall`);
});

test('never dips below the ground', () => {
  const cam = new VehicleCamera(); cam.snap(st({ y: 0.2 })); cam.orbit(0, -0.4); run(cam, st({ y: 0.2 }), 0.2);
  assert.ok(cam.pos.y >= 0.35);
});

console.log(`${passed} passed`);
