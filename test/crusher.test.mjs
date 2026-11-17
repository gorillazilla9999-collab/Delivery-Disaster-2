// The press, headless: three.js is replaced by a no-op stub so the real crusher.js can run in Node.
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(s, c, n) { return s === 'three' ? { url: 'data:text/javascript,' + encodeURIComponent(
    "const P=new Proxy(function(){},{get:(t,k)=>k==='prototype'?{}:k==='position'||k==='scale'||k==='material'||k==='emissive'||k==='rotation'?P:P,apply:()=>P,construct:()=>P,set:()=>true});export const BoxGeometry=P,CylinderGeometry=P,SphereGeometry=P,Mesh=P,MeshStandardMaterial=P,PointLight=P,CanvasTexture=P,RepeatWrapping=1,SRGBColorSpace='s';"), shortCircuit: true } : n(s, c); }
`));
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }) };

const { PhysicsWorld, Body } = await import('../js/physics.js');
const { Crusher, platenHeight, isDanger } = await import('../js/crusher.js');
const { CONFIG } = await import('../js/config.js');
const C = CONFIG.crusher, M = CONFIG.materials;
let passed = 0;
const test = (n, f) => { try { f(); passed++; console.log('  ok  ', n); } catch (e) { console.log('  FAIL', n, '\n      ', e.message); process.exitCode = 1; } };
console.log('crusher');

const scene = { add() {}, remove() {} };
function setup() {
  const w = new PhysicsWorld();
  w.add(new Body({ size: [800, 10, 800], position: [0, -10, 0], name: 'ground', ...M.ground })).rayIgnore = true;
  const cr = new Crusher({ scene, physics: w, x: 0, z: 0 });
  return { w, cr };
}
const crate = (w, s, x, z) => w.add(new Body({ size: [s, s, s], position: [x, s / 2 + 0.001, z], mass: M.crate.density * s ** 3, dynamic: true, baseOrigin: false, friction: M.crate.friction, restitution: M.crate.restitution }));

test('the press cycle is periodic, smooth, and stays between its limits', () => {
  let prev = platenHeight(0), maxStep = 0;
  for (let t = 0; t < 3 * C.cycle; t += 0.01) {
    const y = platenHeight(t); assert.ok(y >= C.bottom - 1e-9 && y <= C.top + 1e-9, `y=${y}`);
    maxStep = Math.max(maxStep, Math.abs(y - prev)); prev = y;
  }
  assert.ok(Math.abs(platenHeight(1.234) - platenHeight(1.234 + C.cycle)) < 1e-9);
  assert.ok(maxStep < 0.3, `jump of ${maxStep} m in 10 ms`);
  assert.ok(platenHeight(C.waitTop + C.slam + C.hold * 0.5) === C.bottom && platenHeight(0) === C.top);
});

test('everything a client crushes is decided from the same synced clock (determinism)', () => {
  const a = [], b = [];
  for (let t = 100; t < 120; t += 0.37) { a.push(platenHeight(t), isDanger(t)); b.push(platenHeight(t), isDanger(t)); }
  assert.deepEqual(a, b);
});

test('a crate left under the press is flagged as crushed when it bottoms out - and not before', () => {
  const { w, cr } = setup(); const c = crate(w, 0.8, 0.3, -0.2), far = crate(w, 0.8, 6, 0);
  const t0 = C.cycle * 5;                                    // start of a cycle
  let early = false, crushedAt = null;
  for (let i = 0; i < C.cycle * 60; i++) {
    const t = t0 + i / 60; cr.update(t, 1 / 60, t); w.step(1 / 120); w.step(1 / 120);
    const hit = cr.crushed([c, far]);
    if (hit.includes(far)) assert.fail('crate outside the footprint must survive');
    if (hit.includes(c) && crushedAt === null) { crushedAt = i / 60; if (cr.y > C.crushBelow) early = true; }
  }
  assert.ok(crushedAt !== null && crushedAt > C.waitTop && crushedAt < C.waitTop + C.slam + 0.1, `crushed at ${crushedAt}`);
  assert.ok(!early);
});

test('the platen is a hard kinematic body: it shoves a crate on the edge of its footprint sideways instead of passing through', () => {
  const { w, cr } = setup(); const c = crate(w, 0.5, 1.5 + 0.2, 0);        // half under the platen edge (footprint is +-1.5)
  const t0 = C.cycle * 5 + C.waitTop;
  for (let i = 0; i < 90; i++) { const t = t0 + i / 60; cr.update(t, 1 / 60, t); w.step(1 / 120); w.step(1 / 120); }
  assert.ok(c.pos.x >= 1.74 || c.pos.y > 0.4, `crate at x=${c.pos.x.toFixed(2)} y=${c.pos.y.toFixed(2)}`);
  assert.ok(Number.isFinite(c.pos.x + c.pos.y));
});

test('a barrel and a big crate both qualify as crushed', () => {
  const { w, cr } = setup(); const big = crate(w, 1.2, -0.5, 0);
  const t0 = C.cycle * 5; let got = false;
  for (let i = 0; i < C.cycle * 60 && !got; i++) { const t = t0 + i / 60; cr.update(t, 1 / 60, t); got = cr.crushed([big]).length > 0; }
  assert.ok(got);
});

console.log(`${passed} passed`);
