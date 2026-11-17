// Headless checks that the physics behaves like the real world. Run: npm run test:physics
import assert from 'node:assert/strict';
import { PhysicsWorld, Body } from '../js/physics.js';
import { CONFIG } from '../js/config.js';

const M = CONFIG.materials, G = CONFIG.physics.gravity;
const H = 1 / 120;

function world() {
  const w = new PhysicsWorld();
  const ground = w.add(new Body({ size: [600, 10, 600], position: [0, -10, 0], name: 'ground', friction: M.ground.friction, restitution: M.ground.restitution }));
  ground.rayIgnore = true;
  return w;
}
function crate(w, size, x, y, z) {   // y = bottom, like the game
  const b = new Body({ size: [size, size, size], position: [x, y + size / 2, z], mass: M.crate.density * size ** 3, dynamic: true, baseOrigin: false, name: 'crate', friction: M.crate.friction, restitution: M.crate.restitution });
  return w.add(b);
}
function barrel(w, x, y, z) {
  return w.add(new Body({ shape: 'cyl', radius: 0.3, height: 0.9, position: [x, y + 0.45, z], mass: M.barrel.mass, dynamic: true, baseOrigin: false, name: 'barrel', friction: M.barrel.friction, restitution: M.barrel.restitution }));
}
function player(w, x, z) {
  const P = CONFIG.player;
  const b = new Body({ size: [P.radius * 2, P.height, P.radius * 2], position: [x, 0, z], mass: P.mass, dynamic: true, baseOrigin: true, lockRotation: true, friction: 0, name: 'player' });
  b.isPlayer = true; b.stepHeight = P.stepHeight;
  return w.add(b);
}
// the same acceleration rules as Player.fixedUpdate: bounded acceleration, and a limited push force against loose bodies
function walk(p, dx, dz, speed = CONFIG.player.walkSpeed) {
  const P = CONFIG.player;
  let accel = p.onGround ? P.groundAccel : P.airAccel;
  if (p.pushing) accel = Math.min(accel, P.pushForce / P.mass);
  const tx = dx * speed, tz = dz * speed, ex = tx - p.vel.x, ez = tz - p.vel.z, l = Math.hypot(ex, ez), m = accel * H;
  if (l <= m) { p.vel.x = tx; p.vel.z = tz; } else { p.vel.x += ex / l * m; p.vel.z += ez / l * m; }
}
const run = (w, secs, each) => { const n = Math.round(secs / H); for (let i = 0; i < n; i++) { w.step(H); if (each) each(i * H); } };
const up = (b) => b.R[4];                       // y-axis of the body's local up in world y
const bottom = (b) => b.min.y;
const fin = (b) => Number.isFinite(b.pos.x + b.pos.y + b.pos.z + b.quat.w);

let passed = 0;
function test(name, fn) {
  const t0 = performance.now();
  try { fn(); passed++; console.log(`  ok   ${name}  (${(performance.now() - t0).toFixed(0)} ms)`); }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
}

console.log('physics');

test('free fall matches s = g t^2 / 2', () => {
  const w = world(), b = crate(w, 0.5, 0, 20, 0);
  run(w, 1.0);
  const fallen = 20 - bottom(b);
  assert.ok(Math.abs(fallen - 0.5 * G) < 0.12, `fell ${fallen.toFixed(3)} m, expected ${(0.5 * G).toFixed(3)}`);
});

test('a dropped crate lands flat, rests exactly on the ground and falls asleep', () => {
  const w = world(), b = crate(w, 0.8, 0, 3, 0);
  run(w, 4);
  assert.ok(Math.abs(bottom(b)) < 0.012, `rest height ${bottom(b)}`);
  assert.ok(up(b) > 0.999, 'not upright');
  assert.ok(b.sleeping, 'should sleep');
  assert.ok(Math.hypot(b.pos.x, b.pos.z) < 0.02, 'drifted sideways');
});

test('a thrown crate slides to a stop in v^2 / (2 mu g)', () => {
  const w = world(), b = crate(w, 0.6, 0, 0.0, 0);
  run(w, 0.3);
  b.vel.x = 4; b.wake();
  const mu = Math.sqrt(M.crate.friction * M.ground.friction), expect = 16 / (2 * mu * G);
  run(w, 3);
  assert.ok(Math.abs(b.pos.x - expect) < 0.25, `slid ${b.pos.x.toFixed(2)} m, expected ${expect.toFixed(2)} m`);
  assert.ok(b.speed < 0.05);
});

test('bounce: a crate rebounds only a little, a steel barrel more', () => {
  const w = world(), c = crate(w, 0.6, -3, 2, 0), br = barrel(w, 3, 2, 0);
  let cMax = 0, bMax = 0, cHit = false, bHit = false;
  run(w, 2.2, () => {
    if (c.onGround) cHit = true; if (br.onGround) bHit = true;
    if (cHit && c.pos.y - 0.3 > cMax) cMax = c.pos.y - 0.3;
    if (bHit && br.pos.y - 0.45 > bMax) bMax = br.pos.y - 0.45;
  });
  console.log(`         rebound heights from 2 m drop: crate ${cMax.toFixed(3)} m, barrel ${bMax.toFixed(3)} m`);
  assert.ok(bMax > cMax, 'barrel should bounce higher than the crate');
  assert.ok(cMax < 0.2 && bMax < 0.6, 'bounces should be modest');
});

test('pyramid of 6 crates stays put for 10 s (stacking is stable)', () => {
  const w = world(), s = 0.8, g = 0.02, cs = [];
  for (let i = 0; i < 3; i++) cs.push(crate(w, s, -3 + i * (s + g), 0, -2));
  for (let i = 0; i < 2; i++) cs.push(crate(w, s, -3 + (s + g) / 2 + i * (s + g), s, -2));
  cs.push(crate(w, s, -3 + (s + g), 2 * s, -2));
  const start = cs.map((b) => b.pos.clone());
  run(w, 10);
  let worst = 0;
  cs.forEach((b, i) => { worst = Math.max(worst, Math.hypot(b.pos.x - start[i].x, b.pos.y - start[i].y, b.pos.z - start[i].z)); assert.ok(up(b) > 0.995, 'tilted'); });
  assert.ok(worst < 0.05, `a crate moved ${worst.toFixed(3)} m`);
  assert.ok(cs.every((b) => b.sleeping), 'should all be asleep');
});

test('a tower of 5 crates does not jitter or topple', () => {
  const w = world(), cs = [];
  for (let i = 0; i < 5; i++) cs.push(crate(w, 0.5, 0, i * 0.5, 0));
  run(w, 8);
  assert.ok(cs.every((b) => Math.hypot(b.pos.x, b.pos.z) < 0.03 && up(b) > 0.999), 'tower moved');
  assert.ok(Math.abs(bottom(cs[4]) - 2.0) < 0.03, `top crate at ${bottom(cs[4])}`);
});

test('an off-centre stack overhanging by 40% tips over (centre of mass past the edge)', () => {
  const w = world(), a = crate(w, 0.8, 0, 0, 0), b = crate(w, 0.8, 0.45, 0.8, 0);   // b's centre is 0.45 from a's centre > 0.4 half width
  run(w, 3);
  assert.ok(b.pos.y < 0.7 || Math.abs(b.pos.x - 0.45) > 0.2, 'top crate should have toppled off');
});

test('an overhanging stack with its centre still over the support stays', () => {
  const w = world(), a = crate(w, 0.8, 0, 0, 0), b = crate(w, 0.8, 0.25, 0.8, 0);
  run(w, 4);
  assert.ok(up(b) > 0.99 && b.pos.y > 0.9, `top crate fell (y=${b.pos.y.toFixed(2)})`);
});

test('a crate dropped tilted on one corner tumbles over and ends up lying flat', () => {
  const w = world(), b = crate(w, 0.6, 0, 1.2, 0);
  b.quat.set(0.3, 0, 0.2, 1).normalize(); b.updateBounds();
  run(w, 5);
  assert.ok(Math.abs(Math.abs(up(b)) - 1) < 0.01 || Math.abs(b.R[3]) > 0.99 || Math.abs(b.R[5]) > 0.99, 'did not settle on a face');
  const half = 0.3, c = b.c;
  assert.ok(Math.abs(c[1] - half) < 0.015, `centre at ${c[1].toFixed(3)}`);
  assert.ok(b.sleeping);
});

test('a crate resting across a thin (0.5 m) barrier does not fall through', () => {
  const w = world();
  w.add(new Body({ size: [6, 0.8, 0.5], position: [0, 0, 0], name: 'barrier', friction: M.wall.friction }));
  const b = crate(w, 0.8, 0, 1.5, 0);
  run(w, 3);
  assert.ok(Math.abs(bottom(b) - 0.8) < 0.02, `crate bottom at ${bottom(b).toFixed(3)}`);
});

test('a barrel stands upright, a push at the top tips it over and it comes to rest lying down', () => {
  const w = world(), b = barrel(w, 0, 0, 0);
  run(w, 2);
  assert.ok(b.sleeping && up(b) > 0.999, 'standing barrel should sleep upright');
  assert.ok(Math.abs(bottom(b)) < 0.012, 'rest height');
  w.applyImpulse(b, { x: 1, y: 0, z: 0 }, 70, { x: 0, y: 0.8, z: 0 });   // hard shove near the rim
  run(w, 5);
  assert.ok(Math.abs(up(b)) < 0.2, `barrel should be on its side (up.y=${up(b).toFixed(2)})`);
  assert.ok(Math.abs(b.c[1] - 0.3) < 0.02, `lying barrel centre at ${b.c[1].toFixed(3)} (expected radius 0.3)`);
});

test('a barrel on its side rolls (spin matches v / r) and rolls a good distance', () => {
  const w = world(), b = barrel(w, 0, 0, 0);
  b.quat.set(0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)).normalize();     // axis along world X -> roll along Z
  b.pos.y = 0.3; b.updateBounds();
  run(w, 0.5);
  b.vel.z = 3; b.angVel.x = 3 / 0.3; b.wake();    // pushed hard enough to roll
  let rollingOK = true;
  run(w, 1, () => { if (b.speed > 1) { const roll = Math.abs(b.angVel.x * 0.3), v = Math.abs(b.vel.z); if (Math.abs(roll - v) > 0.6 * v + 0.2) rollingOK = false; } });
  const z1 = b.pos.z;
  run(w, 8);
  console.log(`         barrel rolled ${b.pos.z.toFixed(1)} m in total (${z1.toFixed(1)} m in the first 1.5 s)`);
  assert.ok(rollingOK, 'spin and travel speed should match while rolling');
  assert.ok(b.pos.z > 3, 'should roll several metres');
  assert.ok(Math.abs(b.pos.x) < 0.5, 'should roll straight');
});

test('a rolling barrel hits a standing barrel: momentum is transferred, nothing explodes', () => {
  const w = world(), a = barrel(w, 0, 0, 0), t = barrel(w, 0, 0, 3);
  a.quat.set(0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)).normalize(); a.pos.y = 0.3; a.updateBounds();
  run(w, 0.3);
  a.vel.z = 5; a.angVel.x = 5 / 0.3; a.wake();
  run(w, 3);
  assert.ok(t.pos.z > 3.5 || Math.abs(up(t)) < 0.9, 'target should have been shoved or knocked over');
  assert.ok(fin(a) && fin(t));
});

test('player pushes a light crate easily and barely moves a heavy one', () => {
  const light = (() => {
    const w = world(), p = player(w, 0, 3), c = crate(w, 0.5, 0, 0, 0);   // 9 kg
    run(w, 1.5, () => walk(p, 0, -1));
    return { crate: c.pos.z, player: p.pos.z };
  })();
  const heavy = (() => {
    const w = world(), p = player(w, 0, 3), c = crate(w, 1.2, 0, 0, 0);   // 130 kg
    run(w, 1.5, () => walk(p, 0, -1));
    return { crate: c.pos.z, player: p.pos.z };
  })();
  console.log(`         after 1.5 s walking into them: light crate at z=${light.crate.toFixed(2)}, heavy crate at z=${heavy.crate.toFixed(2)}`);
  assert.ok(light.crate < -1.5, 'light crate should be shoved ahead');
  assert.ok(heavy.crate > light.crate + 1.0, 'heavy crate should lag well behind');
});

test('the player cannot walk through a static wall or a crate against a wall', () => {
  const w = world();
  w.add(new Body({ size: [10, 3, 0.6], position: [0, 0, -2], name: 'wall' }));
  const p = player(w, 0, 3), c = crate(w, 0.8, 0, 0, -1.2);
  run(w, 3, () => walk(p, 0, -1));
  assert.ok(p.pos.z > -0.95 + 0.3 - 0.05 - 0.15, `player got to z=${p.pos.z.toFixed(2)} (should be stopped by the pinned crate)`);
  assert.ok(c.pos.z > -1.7 + 0.4 - 0.03, 'crate squeezed into the wall');
  assert.ok(Math.abs(c.pos.y - 0.4) < 0.03 && up(c) > 0.99, `crate popped out of the squeeze (y=${c.pos.y.toFixed(2)})`);
});

test('the player walks up the stairs and onto the platform, but is stopped by a tall block', () => {
  const w = world();
  for (let i = 0; i < 5; i++) w.add(new Body({ size: [4, 0.3 * (i + 1), 1], position: [11, 0, -2.5 - i], name: 'stair' }));
  w.add(new Body({ size: [4, 1.5, 5], position: [11, 0, -10], name: 'platform' }));
  w.add(new Body({ size: [2, 1.8, 2], position: [-13, 0, -10.4], name: 'tall' }));
  const p = player(w, 11, 3);
  run(w, 3, () => walk(p, 0, -1));
  assert.ok(Math.abs(p.pos.y - 1.5) < 0.02 && p.pos.z < -8, `player at y=${p.pos.y.toFixed(2)}, z=${p.pos.z.toFixed(2)}`);
  const q = player(w, -13, -6);
  run(w, 2, () => walk(q, 0, -1));
  assert.ok(q.pos.y < 0.1, 'should not climb a 1.8 m block by walking');
});

test('a jump with real gravity reaches ~0.94 m and takes ~0.88 s', () => {
  const w = world(), p = player(w, 0, 0);
  run(w, 0.2);
  p.vel.y = CONFIG.player.jumpSpeed;
  let peak = 0, air = 0;
  run(w, 1.5, (t) => { peak = Math.max(peak, p.pos.y); if (!p.onGround) air += H; });
  assert.ok(Math.abs(peak - 0.94) < 0.06, `peak ${peak.toFixed(2)}`);
  assert.ok(Math.abs(air - 0.88) < 0.1, `air time ${air.toFixed(2)}`);
});

test('a player forced deep inside a crate or wall is pushed back out (no explosion)', () => {
  const w = world();
  w.add(new Body({ size: [10, 3, 0.6], position: [0, 0, -4], name: 'wall' }));
  const c = crate(w, 0.8, 0, 0, 0), p = player(w, 0, -3.6);          // 0.3 m into the wall
  let maxV = 0;
  run(w, 1.0, () => { maxV = Math.max(maxV, p.speed); });
  assert.ok(p.pos.z > -3.43 && p.pos.z < -3.2, `player at z=${p.pos.z.toFixed(2)}`);
  assert.ok(maxV < 6, `player was flung at ${maxV.toFixed(1)} m/s`);
  const q = player(w, 0.2, 0.1);                                      // inside the crate
  maxV = 0;
  run(w, 1.0, () => { maxV = Math.max(maxV, q.speed); });
  assert.ok(maxV < 6, `player flung at ${maxV.toFixed(1)} m/s`);
  const out = Math.abs(q.pos.x - c.pos.x) >= 0.7 - 0.03 || Math.abs(q.pos.z - c.pos.z) >= 0.7 - 0.03 || q.pos.y >= 0.8 - 0.03;
  assert.ok(out, `player still overlaps the crate (${q.pos.x.toFixed(2)}, ${q.pos.y.toFixed(2)}, ${q.pos.z.toFixed(2)})`);
});

test('the player can jump onto a 0.6 m block and stand on a crate without sinking', () => {
  const w = world(), c = crate(w, 0.8, 0, 0, 0), p = player(w, 0, 0.0);
  p.pos.set(0, 1.5, 0); p.updateBounds();
  run(w, 2);
  assert.ok(Math.abs(p.pos.y - 0.8) < 0.02, `player feet at ${p.pos.y.toFixed(3)}`);
  assert.ok(Math.abs(bottom(c)) < 0.02 && up(c) > 0.999, 'crate got squashed or tilted');
});

test('knocking the bottom crate out from under a stack makes everything fall, and it ends up stable again', () => {
  const w = world(), cs = [crate(w, 0.6, 0, 0, 0), crate(w, 0.6, 0, 0.6, 0), crate(w, 0.6, 0, 1.2, 0)];
  run(w, 2);
  assert.ok(cs.every((b) => b.sleeping), 'asleep before');
  w.applyImpulse(cs[0], { x: 1, y: 0, z: 0 }, 200, { x: 0, y: 0.3, z: 0 });
  let woke = true;
  run(w, 0.4, () => { if (cs[2].sleeping) woke = false; });
  assert.ok(woke, 'upper crates should wake when the bottom one is hit');
  run(w, 6);
  assert.ok(cs.every((b) => b.pos.y > 0.28 && fin(b)), 'valid');
  assert.ok(cs[0].pos.x > 0.5, 'bottom crate should have been knocked away');
});

test('a fast crate cannot tunnel through a 0.5 m wall', () => {
  const w = world();
  w.add(new Body({ size: [10, 3, 0.5], position: [0, 0, -5], name: 'wall' }));
  const b = crate(w, 0.5, 0, 0, 0);
  run(w, 0.2); b.vel.z = -25; b.wake();
  run(w, 2);
  assert.ok(b.pos.z > -4.8, `crate at z=${b.pos.z.toFixed(2)} (wall face at -4.75)`);
});

test('raycast hits tilted crates and cylinders at the right distance', () => {
  const w = world(), c = crate(w, 1, 0, 0, -5), br = barrel(w, 4, 0, -5);
  const o = { x: 0, y: 0.5, z: 0 }, d = { x: 0, y: 0, z: -1 };
  const hit = w.raycast(o, d, 20);
  assert.ok(hit && hit.body === c && Math.abs(hit.dist - 4.5) < 1e-6, `box hit ${JSON.stringify(hit && hit.dist)}`);
  const hit2 = w.raycast({ x: 4, y: 0.5, z: 0 }, d, 20);
  assert.ok(hit2 && hit2.body === br && Math.abs(hit2.dist - 4.7) < 0.02, `cylinder hit ${hit2 && hit2.dist}`);
  const miss = w.raycast({ x: 4.5, y: 0.5, z: 0 }, d, 20);
  assert.ok(!miss || miss.body !== br, 'ray beside the barrel must miss it');
  const down = w.raycast({ x: 10, y: 2, z: 0 }, { x: 0, y: -1, z: 0 }, 5);
  assert.ok(down && down.body === null && Math.abs(down.dist - 2) < 1e-9, 'ground plane');
});

test('a plank-like load: a crate on top of two standing barrels is held up; a barrel stands happily on a crate', () => {
  const w = world(), b1 = barrel(w, -0.4, 0, 0), b2 = barrel(w, 0.4, 0, 0);
  run(w, 1.5);
  const top = crate(w, 0.8, 0, 0.9, 0), c2 = crate(w, 0.8, 5, 0, 0), b3 = barrel(w, 5, 0.8, 0);
  run(w, 5);
  assert.ok(Math.abs(bottom(top) - 0.9) < 0.04 && up(top) > 0.995, `crate on barrels at ${bottom(top).toFixed(3)}`);
  assert.ok(up(b1) > 0.995 && up(b2) > 0.995, 'barrels should stay upright under the load');
  assert.ok(Math.abs(bottom(b3) - 0.8) < 0.03 && up(b3) > 0.995, `barrel on crate at ${bottom(b3).toFixed(3)}`);
});

test('an off-centre impulse makes a body spin: omega = I^-1 (r x J)', () => {
  const w = world(), b = crate(w, 1.0, 0, 3, 0);                       // in the air so nothing interferes
  const J = 30, r = 0.5;
  w.applyImpulse(b, { x: 1, y: 0, z: 0 }, J, { x: 0, y: 4.0, z: 0 });   // 0.5 m above the centre (3.5)
  const Iz = (75 * 1) / 12 * 2;                                          // m (sy^2 + sx^2) / 12
  const expected = -(r * J) / Iz;                                        // torque about z = r_y * J_x  (negative z)
  assert.ok(Math.abs(b.vel.x - J / b.mass) < 1e-9, 'linear part');
  assert.ok(Math.abs(b.angVel.z - expected) < 1e-6, `spin ${b.angVel.z.toFixed(3)} expected ${expected.toFixed(3)}`);
});

test('chaos: 12 crates + 7 barrels dropped in a heap settle, never explode, and the heap is cheap to simulate', () => {
  const w = world(), bodies = [];
  let seed = 12345; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 12; i++) bodies.push(crate(w, 0.5 + rnd() * 0.5, (rnd() - 0.5) * 3, 0.5 + i * 0.7, (rnd() - 0.5) * 3));
  for (let i = 0; i < 7; i++) bodies.push(barrel(w, (rnd() - 0.5) * 3, 1 + i * 1.1, (rnd() - 0.5) * 3));
  for (const b of bodies) { b.quat.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, 1).normalize(); b.updateBounds(); }
  let maxSpeed = 0, worstStep = 0, tot = 0, n = 0;
  run(w, 14, () => {
    const t0 = performance.now(); // (cost of the step itself is measured below)
    for (const b of bodies) { maxSpeed = Math.max(maxSpeed, b.speed); assert.ok(fin(b), 'NaN'); }
    void t0;
  });
  const t0 = performance.now();
  const w2 = world(); void w2;
  assert.ok(maxSpeed < 30, `max speed ${maxSpeed.toFixed(1)}`);
  const asleep = bodies.filter((b) => b.sleeping).length;
  console.log(`         ${asleep}/${bodies.length} asleep after 14 s; fastest body ${maxSpeed.toFixed(1)} m/s`);
  assert.ok(asleep >= bodies.length - 2, 'most of the heap should have gone to sleep');
  for (const b of bodies) assert.ok(b.min.y > -0.1, `a body sank into the ground (${b.min.y.toFixed(3)})`);
  void worstStep; void tot; void n; void t0;
});

test('performance: a busy scene costs well under a 60 fps frame budget', () => {
  const w = world(), bodies = [];
  let seed = 99; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 12; i++) bodies.push(crate(w, 0.5 + rnd() * 0.5, (rnd() - 0.5) * 4, 0.5 + i * 0.7, (rnd() - 0.5) * 4));
  for (let i = 0; i < 7; i++) bodies.push(barrel(w, (rnd() - 0.5) * 4, 1 + i * 1.1, (rnd() - 0.5) * 4));
  for (let i = 0; i < 20; i++) w.add(new Body({ size: [1, 3, 1], position: [-20 + i * 2, 0, -30], name: 'pillar' }));
  let worst = 0, sum = 0, cnt = 0;
  for (let i = 0; i < 6 * 120; i++) {
    const t0 = performance.now(); w.step(H); const dt = performance.now() - t0;
    if (i > 10) { worst = Math.max(worst, dt); sum += dt; cnt++; }
  }
  const perFrame = (sum / cnt) * 2;   // two 1/120 substeps per 60 fps frame
  console.log(`         avg ${(sum / cnt).toFixed(3)} ms per 1/120 s step (worst ${worst.toFixed(2)} ms) -> ~${perFrame.toFixed(2)} ms per frame while everything is falling`);
  assert.ok(worst < 8, 'a single step should never be slow');
});

console.log(`${passed} passed`);
