import test from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotBuffer, ClockSync, lerpAngle } from '../js/interp.js';

const S = (ts, x, extra = {}) => ({ ts, x, y: 0, z: 0, yaw: 0, byaw: 0, pitch: 0, vx: 0, vz: 0, g: 1, r: 0, e: 0, ...extra });
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('interpolates smoothly between snapshots', () => {
  const b = new SnapshotBuffer();
  b.push(S(1000, 0)); b.push(S(1050, 1)); b.push(S(1100, 2));
  close(b.sample(1025).x, 0.5);
  close(b.sample(1075).x, 1.5);
  close(b.sample(1100).x, 2);
});

test('ignores out-of-order packets', () => {
  const b = new SnapshotBuffer();
  b.push(S(1000, 0)); b.push(S(1100, 10)); b.push(S(1050, 99));
  assert.equal(b.list.length, 2);
});

test('extrapolates briefly with velocity, then holds', () => {
  const b = new SnapshotBuffer({ extrapolateMs: 150 });
  b.push(S(1000, 0, { vx: 10 }));
  close(b.sample(1100).x, 1);          // 100 ms * 10 m/s
  close(b.sample(5000).x, 1.5);        // capped at 150 ms
});

test('before the first snapshot returns the first; empty returns null', () => {
  const b = new SnapshotBuffer();
  assert.equal(b.sample(1), null);
  b.push(S(1000, 5));
  assert.equal(b.sample(0).x, 5);
});

test('angles take the short way around +-PI', () => {
  close(lerpAngle(3.0, -3.0, 0.5), 3.0 + ((-3.0 - 3.0 + 2 * Math.PI) / 2));
  const b = new SnapshotBuffer();
  b.push(S(0, 0, { yaw: 3.0 })); b.push(S(100, 0, { yaw: -3.0 }));
  const y = b.sample(50).yaw;
  assert.ok(Math.abs(Math.abs(y) - Math.PI) < 0.2, 'passes through ~PI, not through 0: ' + y);
});

test('teleports are not smeared across the map', () => {
  const b = new SnapshotBuffer({ teleportDist: 8 });
  b.push(S(0, 0)); b.push(S(100, 50));
  assert.equal(b.sample(30).x, 0);
  assert.equal(b.sample(70).x, 50);
});

test('flags come from the older snapshot while interpolating', () => {
  const b = new SnapshotBuffer();
  b.push(S(0, 0, { g: 1 })); b.push(S(100, 1, { g: 0 }));
  assert.equal(b.sample(50).g, 1);
});

test('ClockSync tracks the fastest packets and renders in the past', () => {
  const c = new ClockSync();
  assert.equal(c.renderTime(1000, 100), null);
  c.update(500, 1000);              // offset 500
  c.update(520, 1100);              // sample 580 -> drifts up slowly
  assert.ok(c.offset >= 500 && c.offset < 510);
  c.update(1000, 1400);             // sample 400 -> jump down
  assert.equal(c.offset, 400);
  assert.equal(c.renderTime(2000, 100), 2000 - 400 - 100);
});
