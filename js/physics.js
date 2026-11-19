// Rigid-body physics (no dependencies, so it also runs headless in Node for the tests).
//
// What it does
//   * Boxes and cylinders (barrels) are real rigid bodies: they have mass (kg), a rotation, an inertia tensor, and
//     they tumble, tip, topple, roll, slide, bounce and stack.
//   * Contacts come from a convex-polyhedron SAT (box = 6 faces, cylinder = 24-sided prism) with face clipping, so a
//     crate lying across a thin barrier or a barrel standing on a crate's edge gets proper multi-point support.
//   * A sequential-impulse solver (warm-started, Coulomb friction, restitution, speculative contacts) resolves them.
//   * Resting bodies go to sleep; the player is a rotation-locked box that pushes things around with its real mass.
//
// Units: metres, seconds, kilograms, newton-seconds. A Body's `pos` is the centre of its BOTTOM face for static
// boxes and the player (originY 'base'), and the centre of mass for everything that can rotate (originY 'center').
import { CONFIG } from './config.js';

const MARGIN = 0.02;            // contacts are created up to this gap (speculative contacts)
const SLOP = 0.004;             // penetration we tolerate before pushing bodies apart
const REST_THRESHOLD = 1.2;     // m/s: slower impacts do not bounce
const SLEEP_V2 = 0.05 * 0.05, SLEEP_W2 = 0.12 * 0.12, SLEEP_TIME = 0.55;
const SOLVER_ITERATIONS = 12;
const PRISM_SIDES = 24;
export const PARK_Y = -49;       // where parked bodies live (the network treats y < -48 as "parked")

// ---------- tiny vector helpers (plain [x,y,z] arrays) ----------
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const addv = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const l = vlen(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vec3(this.x, this.y, this.z); }
  length() { return Math.hypot(this.x, this.y, this.z); }
}

export class Quat {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
  normalize() {
    const l = Math.hypot(this.x, this.y, this.z, this.w) || 1;
    this.x /= l; this.y /= l; this.z /= l; this.w /= l; return this;
  }
  setYaw(yaw) { this.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)); return this; }
}

// spherical interpolation (shortest arc), writes into `out`
export function quatSlerp(out, a, b, t) {
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let s0, s1;
  if (cos > 0.9995) { s0 = 1 - t; s1 = t; }
  else { const th = Math.acos(cos), s = Math.sin(th); s0 = Math.sin((1 - t) * th) / s; s1 = Math.sin(t * th) / s; }
  out.set(a.x * s0 + bx * s1, a.y * s0 + by * s1, a.z * s0 + bz * s1, a.w * s0 + bw * s1).normalize();
  return out;
}

// angular velocity (world frame) that takes q0 to q1 in dt seconds
export function quatAngularVelocity(out, q0, q1, dt) {
  // dq = q1 * conj(q0)
  const x = q1.w * -q0.x + q1.x * q0.w + q1.y * -q0.z - q1.z * -q0.y;
  const y = q1.w * -q0.y - q1.x * -q0.z + q1.y * q0.w + q1.z * -q0.x;
  const z = q1.w * -q0.z + q1.x * -q0.y - q1.y * -q0.x + q1.z * q0.w;
  let w = q1.w * q0.w + q1.x * q0.x + q1.y * q0.y + q1.z * q0.z;
  let sx = x, sy = y, sz = z;
  if (w < 0) { sx = -x; sy = -y; sz = -z; w = -w; }
  const s = Math.hypot(sx, sy, sz);
  if (s < 1e-9 || dt <= 0) return out.set(0, 0, 0);
  const angle = 2 * Math.atan2(s, w);
  const k = angle / s / dt;
  return out.set(sx * k, sy * k, sz * k);
}

function quatToMat(q, m) {
  const x = q.x, y = q.y, z = q.z, w = q.w;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  m[0] = 1 - 2 * (yy + zz); m[1] = 2 * (xy - wz);     m[2] = 2 * (xz + wy);
  m[3] = 2 * (xy + wz);     m[4] = 1 - 2 * (xx + zz); m[5] = 2 * (yz - wx);
  m[6] = 2 * (xz - wy);     m[7] = 2 * (yz + wx);     m[8] = 1 - 2 * (xx + yy);
}
const mulM = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

// ---------- convex shapes ----------
// A shape holds local-space vertices, faces (outward normal + CCW vertex ring), edges and the unique edge directions.
function makeFace(verts, idx) {
  let n = [0, 0, 0];                                       // Newell normal
  for (let i = 0; i < idx.length; i++) {
    const a = verts[idx[i]], b = verts[idx[(i + 1) % idx.length]];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  n = unit(n);
  let c = [0, 0, 0];
  for (const i of idx) c = addv(c, verts[i]);
  c = mul(c, 1 / idx.length);
  if (dot(n, c) < 0) { n = mul(n, -1); idx = idx.slice().reverse(); }     // shapes are centred on the origin
  return { n, idx };
}

function boxShape(hx, hy, hz) {
  const verts = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) verts.push([sx * hx, sy * hy, sz * hz]);
  const id = (sx, sy, sz) => (sx > 0 ? 4 : 0) + (sy > 0 ? 2 : 0) + (sz > 0 ? 1 : 0);
  const faces = [];
  for (const s of [-1, 1]) {
    faces.push(makeFace(verts, [id(s, -1, -1), id(s, 1, -1), id(s, 1, 1), id(s, -1, 1)]));
    faces.push(makeFace(verts, [id(-1, s, -1), id(1, s, -1), id(1, s, 1), id(-1, s, 1)]));
    faces.push(makeFace(verts, [id(-1, -1, s), id(1, -1, s), id(1, 1, s), id(-1, 1, s)]));
  }
  const edges = [];
  for (let a = 0; a < 8; a++) for (let bit = 0; bit < 3; bit++) {
    const b = a ^ (4 >> bit);
    if (b > a) edges.push({ a, b, di: bit });
  }
  return { verts, faces, edges, dirs: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], kind: 'box' };
}

const _prismCache = new Map();
function prismShape(radius, halfHeight, n = PRISM_SIDES) {
  const key = radius + '/' + halfHeight + '/' + n;
  if (_prismCache.has(key)) return _prismCache.get(key);
  const R = radius / Math.cos(Math.PI / n);                // flats sit at `radius`, so a resting barrel is exactly as tall as it looks
  const verts = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; verts.push([Math.cos(a) * R, halfHeight, Math.sin(a) * R]); }
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; verts.push([Math.cos(a) * R, -halfHeight, Math.sin(a) * R]); }
  const ring = [...Array(n).keys()];
  const faces = [makeFace(verts, ring), makeFace(verts, ring.map((i) => n + i))];
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; faces.push(makeFace(verts, [i, j, n + j, n + i])); }
  const edges = [], dirs = [[0, 1, 0]];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    dirs.push(unit(sub(verts[j], verts[i])));
    edges.push({ a: i, b: j, di: 1 + i }, { a: n + i, b: n + j, di: 1 + i }, { a: i, b: n + i, di: 0 });
  }
  const sh = { verts, faces, edges, dirs, kind: 'cyl' };
  _prismCache.set(key, sh);
  return sh;
}

// ---------- bodies ----------
let _nextId = 1;

export class Body {
  // size: [x, y, z] full box extents.  For a cylinder pass shape: 'cyl', radius and height instead.
  constructor({ shape = 'box', size = [1, 1, 1], radius = 0.3, height = 1, position = [0, 0, 0], mass = 1,
                dynamic = false, name = '', baseOrigin = null, lockRotation = false,
                friction = 0.6, restitution = 0.15 }) {
    this.id = _nextId++;
    this.name = name;
    this.kind = shape;
    if (shape === 'cyl') { this.hx = radius; this.hz = radius; this.h = height; this.radius = radius; this.shape = prismShape(radius, height / 2); }
    else { this.hx = size[0] / 2; this.h = size[1]; this.hz = size[2] / 2; this.shape = boxShape(this.hx, this.h / 2, this.hz); }

    this.dynamic = dynamic;
    this.mass = dynamic ? mass : Infinity;
    this.invMass = dynamic ? 1 / mass : 0;
    this.lockRotation = lockRotation;
    // local inverse inertia (diagonal), solid-body formulas
    if (!dynamic || lockRotation) this.invI = [0, 0, 0];
    else if (shape === 'cyl') {
      const iy = 0.5 * mass * radius * radius, ix = mass * (3 * radius * radius + height * height) / 12;
      this.invI = [1 / ix, 1 / iy, 1 / ix];
    } else {
      const sx = this.hx * 2, sy = this.h, sz = this.hz * 2;
      this.invI = [12 / (mass * (sy * sy + sz * sz)), 12 / (mass * (sx * sx + sz * sz)), 12 / (mass * (sx * sx + sy * sy))];
    }

    this.baseOrigin = baseOrigin === null ? !dynamic : baseOrigin;     // pos is the bottom centre (true) or the centre of mass
    this.oy = this.baseOrigin ? this.h / 2 : 0;
    this.pos = new Vec3(...position);
    this.vel = new Vec3();
    this.quat = new Quat();
    this.angVel = new Vec3();
    this.min = new Vec3();
    this.max = new Vec3();
    this.c = [0, 0, 0];                                                 // world centre
    this.R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    this.wv = this.shape.verts.map(() => [0, 0, 0]);
    this.wn = this.shape.faces.map(() => [0, 0, 0]);
    this.wd = this.shape.dirs.map(() => [0, 0, 0]);
    this.Iw = [0, 0, 0, 0, 0, 0, 0, 0, 0];

    this.friction = friction;       // Coulomb coefficient (pairs use sqrt(a*b))
    this.restitution = restitution;
    this.linDamp = 0.04; this.angDamp = 0.25;
    this.isPlayer = false;
    this.isVehicle = false;   // the drivable car's chassis (set by Vehicle); the crosshair / pick-up code skips it
    this.kinematic = false;   // true = moved by the network (owned by another player): acts like a moving wall
    this.stepHeight = 0;      // > 0 lets the body walk up small ledges (player)
    this.stepOffset = 0;      // visual offset used to smooth step-ups (read by the camera)
    this.onGround = false;
    this.pushing = false;     // (player) touching a loose body from the side, set by the solver each step
    this.noGravity = false;   // true while carried: velocity is driven by the carrier
    this.ignore = null;       // a body this one passes through (the carrier)
    this.rayIgnore = false;   // raycasts skip this body (carried crate)
    this.sleeping = false; this.sleepT = 0;
    this.parked = false;      // out of play (hidden, no collisions): spawn-pool items and crushed crates
    this.noCollide = false;   // true = takes part in nothing (a player seated in a vehicle): no contacts, but not parked
    this.supported = false;   // set by a vehicle whose wheels hold it up: lets a car that never touches the ground fall asleep
    this.world = null;
    this.mesh = null;
    this.updateBounds();
  }

  // recompute world transform + bounds after pos / quat changed
  updateBounds() {
    if (!this.lockRotation) quatToMat(this.quat, this.R);
    const c = this.c, R = this.R;
    c[0] = this.pos.x; c[1] = this.pos.y + this.oy; c[2] = this.pos.z;
    const sh = this.shape, wv = this.wv;
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = 0; i < wv.length; i++) {
      const v = sh.verts[i], w = wv[i];
      w[0] = R[0] * v[0] + R[1] * v[1] + R[2] * v[2] + c[0];
      w[1] = R[3] * v[0] + R[4] * v[1] + R[5] * v[2] + c[1];
      w[2] = R[6] * v[0] + R[7] * v[1] + R[8] * v[2] + c[2];
      if (w[0] < mnx) mnx = w[0]; if (w[0] > mxx) mxx = w[0];
      if (w[1] < mny) mny = w[1]; if (w[1] > mxy) mxy = w[1];
      if (w[2] < mnz) mnz = w[2]; if (w[2] > mxz) mxz = w[2];
    }
    for (let i = 0; i < this.wn.length; i++) { const n = sh.faces[i].n, o = this.wn[i]; o[0] = R[0] * n[0] + R[1] * n[1] + R[2] * n[2]; o[1] = R[3] * n[0] + R[4] * n[1] + R[5] * n[2]; o[2] = R[6] * n[0] + R[7] * n[1] + R[8] * n[2]; }
    for (let i = 0; i < this.wd.length; i++) { const n = sh.dirs[i], o = this.wd[i]; o[0] = R[0] * n[0] + R[1] * n[1] + R[2] * n[2]; o[1] = R[3] * n[0] + R[4] * n[1] + R[5] * n[2]; o[2] = R[6] * n[0] + R[7] * n[1] + R[8] * n[2]; }
    this.min.set(mnx, mny, mnz);
    this.max.set(mxx, mxy, mxz);
  }

  // true when it is a flat-topped, upright block (safe to walk up onto)
  get flatTop() { return this.kind === 'box' && this.R[4] > 0.9995; }

  // take out of play / put back. A parked body sits far below the world and is ignored by everything.
  park() {
    this.parked = true; this.sleeping = true; this.kinematic = false; this.noGravity = false; this.ignore = null; this.rayIgnore = true;
    this.vel.set(0, 0, 0); this.angVel.set(0, 0, 0); this.pos.set(0, PARK_Y, 0); this.quat.set(0, 0, 0, 1);
    this.updateBounds();
  }
  unpark() { if (!this.parked) return; this.parked = false; this.sleeping = false; this.sleepT = 0; this.rayIgnore = false; }
  wake() { if (this.parked) return; if (this.world) this.world.wakeBody(this); else { this.sleeping = false; this.sleepT = 0; } }
  setQuat(x, y, z, w) { this.quat.set(x, y, z, w).normalize(); this.updateBounds(); }
  get speed() { return Math.hypot(this.vel.x, this.vel.y, this.vel.z); }
  get spin() { return Math.hypot(this.angVel.x, this.angVel.y, this.angVel.z); }
}

function passes(a, b) { return a.ignore === b || b.ignore === a; }

// ---------- narrow phase: convex SAT + clipping ----------
function faceQuery(A, B) {
  let best = -Infinity, bf = -1;
  const faces = A.shape.faces, bv = B.wv;
  for (let f = 0; f < faces.length; f++) {
    const n = A.wn[f], p = A.wv[faces[f].idx[0]];
    let m = Infinity;
    for (let i = 0; i < bv.length; i++) { const d = n[0] * bv[i][0] + n[1] * bv[i][1] + n[2] * bv[i][2]; if (d < m) m = d; }
    const sep = m - dot(n, p);
    if (sep > best) { best = sep; bf = f; if (sep > MARGIN) break; }
  }
  return { sep: best, face: bf };
}

function projectRange(wv, n) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < wv.length; i++) { const d = n[0] * wv[i][0] + n[1] * wv[i][1] + n[2] * wv[i][2]; if (d < mn) mn = d; if (d > mx) mx = d; }
  return [mn, mx];
}

function edgeQuery(A, B) {
  let best = -Infinity, bn = null, bi = -1, bj = -1;
  for (let i = 0; i < A.wd.length; i++) {
    for (let j = 0; j < B.wd.length; j++) {
      let n = cross(A.wd[i], B.wd[j]);
      const l = vlen(n);
      if (l < 0.02) continue;                                  // (nearly) parallel edges: covered by the face axes
      n = mul(n, 1 / l);
      const [amn, amx] = projectRange(A.wv, n), [bmn, bmx] = projectRange(B.wv, n);
      const s1 = bmn - amx, s2 = amn - bmx;                    // B beyond A / A beyond B
      let sep = s1, nn = n;
      if (s2 > s1) { sep = s2; nn = mul(n, -1); }
      if (sep > best) { best = sep; bn = nn; bi = i; bj = j; if (sep > MARGIN) return { sep, n: bn, i: bi, j: bj }; }
    }
  }
  return { sep: best, n: bn, i: bi, j: bj };
}

function clipPoly(poly, pn, pp) {            // keep points with dot(pn, p - pp) <= 0
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = dot(pn, sub(a, pp)), db = dot(pn, sub(b, pp));
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) { const t = da / (da - db); out.push(addv(a, mul(sub(b, a), t))); }
  }
  return out;
}

function closestSegments(p1, q1, p2, q2) {   // Ericson, Real-Time Collision Detection 5.1.9
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s, t;
  if (a <= 1e-12 && e <= 1e-12) { s = t = 0; }
  else if (a <= 1e-12) { s = 0; t = Math.max(0, Math.min(1, f / e)); }
  else {
    const c = dot(d1, r);
    if (e <= 1e-12) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den > 1e-12 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
      else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
    }
  }
  return [addv(p1, mul(d1, s)), addv(p2, mul(d2, t))];
}

function reduceContacts(list, n) {           // keep <= 4 well-spread points
  if (list.length <= 4) return list;
  let i0 = 0;
  for (let i = 1; i < list.length; i++) if (list[i].sep < list[i0].sep) i0 = i;
  const p0 = list[i0].p;
  let i1 = -1, bd = -1;
  for (let i = 0; i < list.length; i++) { const d = vlen(sub(list[i].p, p0)); if (d > bd) { bd = d; i1 = i; } }
  const p1 = list[i1].p, ax = sub(p1, p0);
  let i2 = -1, i3 = -1, mx = 1e-9, mn = -1e-9;
  for (let i = 0; i < list.length; i++) {
    if (i === i0 || i === i1) continue;
    const a = dot(cross(ax, sub(list[i].p, p0)), n);
    if (a > mx) { mx = a; i2 = i; } else if (a < mn) { mn = a; i3 = i; }
  }
  return [i0, i1, i2, i3].filter((i) => i >= 0).map((i) => list[i]);
}

// Appends {n (A -> B), p, sep} to `out`. sep < 0 means penetration.
function collide(A, B, out) {
  const qa = faceQuery(A, B);
  if (qa.sep > MARGIN) return;
  const qb = faceQuery(B, A);
  if (qb.sep > MARGIN) return;
  const qe = edgeQuery(A, B);
  if (qe.sep > MARGIN) return;
  const faceSep = Math.max(qa.sep, qb.sep);

  if (qe.n && qe.sep > faceSep + 0.004) {                      // edge-edge contact: a single point
    const n = qe.n;
    let ea = null, eb = null, da = -Infinity, db = Infinity;
    for (const e of A.shape.edges) if (e.di === qe.i) { const m = dot(n, addv(A.wv[e.a], A.wv[e.b])); if (m > da) { da = m; ea = e; } }
    for (const e of B.shape.edges) if (e.di === qe.j) { const m = dot(n, addv(B.wv[e.a], B.wv[e.b])); if (m < db) { db = m; eb = e; } }
    if (ea && eb) {
      const [pa, pb] = closestSegments(A.wv[ea.a], A.wv[ea.b], B.wv[eb.a], B.wv[eb.b]);
      out.push({ n, p: mul(addv(pa, pb), 0.5), sep: qe.sep });
      return;
    }
  }

  const refA = qa.sep + 0.0005 >= qb.sep;
  const R = refA ? A : B, I = refA ? B : A, rf = refA ? qa.face : qb.face;
  const nR = R.wn[rf];
  const refIdx = R.shape.faces[rf].idx;
  const refPoly = refIdx.map((i) => R.wv[i]);
  let fi = 0, bd = Infinity;
  for (let f = 0; f < I.wn.length; f++) { const d = dot(I.wn[f], nR); if (d < bd) { bd = d; fi = f; } }
  let poly = I.shape.faces[fi].idx.map((i) => I.wv[i].slice());
  for (let i = 0; i < refPoly.length && poly.length; i++) {
    const a = refPoly[i], b = refPoly[(i + 1) % refPoly.length];
    poly = clipPoly(poly, unit(cross(sub(b, a), nR)), a);
  }
  const nAB = refA ? nR : mul(nR, -1);
  const found = [];
  for (const p of poly) {
    const dist = dot(nR, sub(p, refPoly[0]));
    if (dist > MARGIN) continue;
    found.push({ n: nAB, p: sub(p, mul(nR, dist * 0.5)), sep: dist });
  }
  if (!found.length) {                                         // fallback: deepest vertex of the incident body
    let bi = 0, bv = Infinity;
    for (let i = 0; i < I.wv.length; i++) { const d = dot(nR, I.wv[i]); if (d < bv) { bv = d; bi = i; } }
    found.push({ n: nAB, p: I.wv[bi].slice(), sep: faceSep });
  }
  for (const c of reduceContacts(found, nAB)) out.push(c);
}

// ---------- ray casts ----------
// Returns the hit distance (or null). If `nOut` ([x,y,z]) is given it receives the world-space surface normal at the hit.
function rayBody(b, o, d, maxDist, nOut = null) {
  const R = b.R;
  const rx = o.x - b.c[0], ry = o.y - b.c[1], rz = o.z - b.c[2];
  // into local space: R^T * v
  const lo = [R[0] * rx + R[3] * ry + R[6] * rz, R[1] * rx + R[4] * ry + R[7] * rz, R[2] * rx + R[5] * ry + R[8] * rz];
  const ld = [R[0] * d.x + R[3] * d.y + R[6] * d.z, R[1] * d.x + R[4] * d.y + R[7] * d.z, R[2] * d.x + R[5] * d.y + R[8] * d.z];
  const hy = b.h / 2;
  const setN = (nx, ny, nz) => {                                   // local normal -> world
    if (!nOut) return;
    nOut[0] = R[0] * nx + R[1] * ny + R[2] * nz; nOut[1] = R[3] * nx + R[4] * ny + R[5] * nz; nOut[2] = R[6] * nx + R[7] * ny + R[8] * nz;
  };
  if (b.kind === 'cyl') {
    let best = Infinity, ln = null;
    const A = ld[0] * ld[0] + ld[2] * ld[2], B = lo[0] * ld[0] + lo[2] * ld[2], C = lo[0] * lo[0] + lo[2] * lo[2] - b.radius * b.radius;
    if (A > 1e-12) {
      const disc = B * B - A * C;
      if (disc >= 0) {
        const t = (-B - Math.sqrt(disc)) / A;
        const y = lo[1] + ld[1] * t;
        if (t >= 0 && Math.abs(y) <= hy) { best = t; ln = [(lo[0] + ld[0] * t) / b.radius, 0, (lo[2] + ld[2] * t) / b.radius]; }
        else if (C < 0) { best = Math.min(best, 0); ln = [0, 1, 0]; }                 // starting inside
      }
    }
    if (Math.abs(ld[1]) > 1e-9) {
      for (const cy of [-hy, hy]) {
        const t = (cy - lo[1]) / ld[1];
        if (t < 0) continue;
        const x = lo[0] + ld[0] * t, z = lo[2] + ld[2] * t;
        if (x * x + z * z <= b.radius * b.radius && t < best) { best = t; ln = [0, cy > 0 ? 1 : -1, 0]; }
      }
    }
    if (best <= maxDist) { if (ln) setN(ln[0], ln[1], ln[2]); return best; }
    return null;
  }
  const half = [b.hx, hy, b.hz];
  let tmin = -Infinity, tmax = Infinity, ax = 1, sg = 1;
  for (let k = 0; k < 3; k++) {
    const dir = Math.abs(ld[k]) < 1e-9 ? 1e-9 : ld[k], inv = 1 / dir;
    let t1 = (-half[k] - lo[k]) * inv, t2 = (half[k] - lo[k]) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) { tmin = t1; ax = k; sg = dir > 0 ? -1 : 1; }          // the face we entered through
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  const t = Math.max(tmin, 0);
  if (t > maxDist) return null;
  if (nOut) { if (tmin < 0) setN(0, 1, 0); else setN(ax === 0 ? sg : 0, ax === 1 ? sg : 0, ax === 2 ? sg : 0); }
  return t;
}

// ---------- the world ----------
export class PhysicsWorld {
  constructor() {
    this.all = [];
    this.dynamics = [];
    this.statics = [];
    this.cache = new Map();          // pair key -> previous contacts (warm starting)
    this.contacts = [];
    this.gravity = CONFIG.physics.gravity;
  }

  add(body) {
    body.world = this;
    this.all.push(body);
    (body.dynamic ? this.dynamics : this.statics).push(body);
    return body;
  }

  wakeBody(b) {
    if (!b.sleeping) { b.sleepT = 0; return; }
    const stack = [b];
    while (stack.length) {
      const x = stack.pop();
      x.sleeping = false; x.sleepT = 0;
      for (const o of this.dynamics) {              // anything resting on / next to it wakes too
        if (!o.sleeping || o === x || o.parked) continue;
        if (o.min.x < x.max.x + 0.05 && o.max.x > x.min.x - 0.05 && o.min.y < x.max.y + 0.05 && o.max.y > x.min.y - 0.05 &&
            o.min.z < x.max.z + 0.05 && o.max.z > x.min.z - 0.05) stack.push(o);
      }
    }
  }

  // advance the simulation by h seconds (call with small steps, e.g. 1/120)
  step(h) {
    const g = this.gravity, tv = CONFIG.physics.terminalVelocity;
    const dyn = this.dynamics;

    // 1. forces: gravity + drag on every moving body; walking bodies climb small ledges
    for (const b of dyn) {
      if (b.kinematic || b.sleeping || b.parked) continue;
      if (!b.noGravity) b.vel.y = Math.max(b.vel.y - g * h, -tv);
      if (!b.isPlayer && !b.noGravity) {
        const kl = 1 / (1 + b.linDamp * h), ka = 1 / (1 + b.angDamp * h);
        b.vel.x *= kl; b.vel.y *= kl; b.vel.z *= kl;
        b.angVel.x *= ka; b.angVel.y *= ka; b.angVel.z *= ka;
      }
      if (b.stepHeight > 0) this._tryStep(b, h);
    }

    // 2. contacts
    const contacts = this._collect(h);

    // 3. solve velocities
    this._solve(contacts, h);

    // 4. integrate
    const L = CONFIG.world.limit;
    for (const b of dyn) {
      if (b.kinematic || b.sleeping) continue;
      b._dx = b.vel.x * h; b._dy = b.vel.y * h; b._dz = b.vel.z * h;
      const sp = b.vel.length();
      if (sp > 80) { const k = 80 / sp; b.vel.x *= k; b.vel.y *= k; b.vel.z *= k; }
      const w = b.angVel, ws = w.length();
      if (ws > 40) { const k = 40 / ws; w.x *= k; w.y *= k; w.z *= k; }
      b.pos.x += b._dx; b.pos.y += b._dy; b.pos.z += b._dz;
      if (!b.lockRotation && ws > 1e-6) {
        const q = b.quat, hh = 0.5 * h;
        const x = q.x, y = q.y, z = q.z, ww = q.w;
        q.x = x + hh * (w.x * ww + w.y * z - w.z * y);
        q.y = y + hh * (w.y * ww + w.z * x - w.x * z);
        q.z = z + hh * (w.z * ww + w.x * y - w.y * x);
        q.w = ww + hh * (-w.x * x - w.y * y - w.z * z);
        q.normalize();
      }
    }

    // 5. push out of penetrations
    this._correct(contacts);

    // 6. world limits, bounds, sleeping
    for (const b of dyn) {
      if (b.kinematic) continue;
      if (!b.sleeping) {
        if (b.pos.x > L) { b.pos.x = L; if (b.vel.x > 0) b.vel.x = 0; } else if (b.pos.x < -L) { b.pos.x = -L; if (b.vel.x < 0) b.vel.x = 0; }
        if (b.pos.z > L) { b.pos.z = L; if (b.vel.z > 0) b.vel.z = 0; } else if (b.pos.z < -L) { b.pos.z = -L; if (b.vel.z < 0) b.vel.z = 0; }
        b.updateBounds();
        this._sleepCheck(b, h);
      }
    }
    this.contacts = contacts;
  }

  _sleepCheck(b, h) {
    if (b.isPlayer || b.noGravity) { b.sleepT = 0; return; }
    const v2 = b.vel.x * b.vel.x + b.vel.y * b.vel.y + b.vel.z * b.vel.z;
    const w2 = b.angVel.x * b.angVel.x + b.angVel.y * b.angVel.y + b.angVel.z * b.angVel.z;
    if (v2 < SLEEP_V2 && w2 < SLEEP_W2 && (b.onGround || b.supported)) {
      b.sleepT += h;
      if (b.sleepT > SLEEP_TIME) { b.sleeping = true; b.vel.set(0, 0, 0); b.angVel.set(0, 0, 0); }
    } else b.sleepT = 0;
  }

  // Walk up kerbs / stairs / low blocks (player only). Looks one step ahead and lifts the body onto the ledge.
  _tryStep(b, h) {
    if (!b.onGround) return;
    const sp = Math.hypot(b.vel.x, b.vel.z);
    if (sp < 0.05) return;
    const look = sp * h + 0.04, dx = (b.vel.x / sp) * look, dz = (b.vel.z / sp) * look;
    const nminx = b.min.x + dx, nmaxx = b.max.x + dx, nminz = b.min.z + dz, nmaxz = b.max.z + dz;
    let best = 0, top = null;
    for (const c of this.all) {
      if (c === b || c.parked || passes(b, c) || !c.flatTop && !(c.kind === 'box' && !c.dynamic)) continue;
      const rise = c.max.y - b.min.y;
      const limit = c.dynamic ? 0.3 : b.stepHeight;                 // loose crates are shoved, not climbed (unless small)
      if (rise <= 0.01 || rise > limit || rise <= best) continue;
      if (nminx < c.max.x && nmaxx > c.min.x && nminz < c.max.z && nmaxz > c.min.z) { best = rise; top = c; }
    }
    if (!top) return;
    // headroom check at the new height
    const ny = b.min.y + best;
    for (const c of this.all) {
      if (c === b || c === top || passes(b, c)) continue;
      if (b.min.x < c.max.x - 1e-3 && b.max.x > c.min.x + 1e-3 && ny + 1e-3 < c.max.y && ny + b.h > c.min.y + 1e-3 &&
          b.min.z < c.max.z - 1e-3 && b.max.z > c.min.z + 1e-3 && c.max.y > ny + 1e-3) return;
    }
    b.pos.y += best;
    b.pos.x += dx; b.pos.z += dz;                                  // and onto the ledge, so the feet really overlap it
    b.stepOffset -= best;
    if (b.vel.y < 0) b.vel.y = 0;
    b.updateBounds();
  }

  _collect(h) {
    const all = this.all, out = [];
    const flags = new Map();
    for (const b of this.dynamics) { if (!b.sleeping) b.onGround = false; b.pushing = false; b._dx = b._dy = b._dz = 0; }
    for (let i = 0; i < all.length; i++) {
      const A = all[i];
      for (let j = i + 1; j < all.length; j++) {
        const B = all[j];
        if (!A.dynamic && !B.dynamic) continue;
        if (A.parked || B.parked || A.noCollide || B.noCollide) continue;
        const aAct = A.dynamic && !A.kinematic && !A.sleeping, bAct = B.dynamic && !B.kinematic && !B.sleeping;
        const aMov = A.kinematic && A.vel.length() > 0.02, bMov = B.kinematic && B.vel.length() > 0.02;
        if (!aAct && !bAct && !(aMov && B.sleeping) && !(bMov && A.sleeping)) continue;
        if (passes(A, B)) continue;
        if (A.min.x > B.max.x + MARGIN || A.max.x < B.min.x - MARGIN || A.min.y > B.max.y + MARGIN || A.max.y < B.min.y - MARGIN ||
            A.min.z > B.max.z + MARGIN || A.max.z < B.min.z - MARGIN) continue;

        // a moving body wakes whatever sleeps against it
        if (A.sleeping && (bAct || bMov) && this._disturbs(B)) A.wake();
        if (B.sleeping && (aAct || aMov) && this._disturbs(A)) B.wake();

        const list = [];
        collide(A, B, list);
        if (!list.length) continue;
        const key = A.id * 65536 + B.id, prev = this.cache.get(key);
        const mu = Math.sqrt(A.friction * B.friction), e = Math.max(A.restitution, B.restitution);
        const used = [];
        for (const c of list) {
          c.a = A; c.b = B; c.mu = mu; c.e = e; c.key = key;
          c.jn = 0; c.jt1 = 0; c.jt2 = 0; c.old = null;
          if (prev) {                                                // match with last step's contact for warm starting
            let bestD = 0.0025, bp = null;
            for (const p of prev) { const d = (p.p[0] - c.p[0]) ** 2 + (p.p[1] - c.p[1]) ** 2 + (p.p[2] - c.p[2]) ** 2; if (d < bestD && !used.includes(p)) { bestD = d; bp = p; } }
            if (bp) { used.push(bp); c.old = bp; }
          }
          out.push(c);
        }
        flags.set(key, list);
      }
    }
    // refresh the cache with this step's contacts
    this.cache = flags;
    return out;
  }

  _disturbs(b) {
    if (b.isPlayer) return b.vel.x * b.vel.x + b.vel.z * b.vel.z > 0.01 || Math.abs(b.vel.y) > 0.3;
    if (b.kinematic) return true;
    return b.vel.x * b.vel.x + b.vel.y * b.vel.y + b.vel.z * b.vel.z > 0.04 || b.angVel.x * b.angVel.x + b.angVel.y * b.angVel.y + b.angVel.z * b.angVel.z > 0.25;
  }

  _prep(b) {
    if (b._prepared === this._stamp) return;
    b._prepared = this._stamp;
    const live = b.dynamic && !b.kinematic && !b.sleeping;
    b.im = live ? b.invMass : 0;
    const m = b.Iw, R = b.R, ii = live ? b.invI : [0, 0, 0];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      m[r * 3 + c] = R[r * 3] * ii[0] * R[c * 3] + R[r * 3 + 1] * ii[1] * R[c * 3 + 1] + R[r * 3 + 2] * ii[2] * R[c * 3 + 2];
    }
  }

  _solve(contacts, h) {
    this._stamp = (this._stamp || 0) + 1;
    const inv = 1 / h;
    for (const c of contacts) {
      const A = c.a, B = c.b;
      this._prep(A); this._prep(B);
      const n = c.n, p = c.p;
      c.rA = [p[0] - A.c[0], p[1] - A.c[1], p[2] - A.c[2]];
      c.rB = [p[0] - B.c[0], p[1] - B.c[1], p[2] - B.c[2]];
      // tangent basis
      const ax = Math.abs(n[0]) < 0.7 ? [1, 0, 0] : [0, 1, 0];
      c.t1 = unit(cross(n, ax)); c.t2 = cross(n, c.t1);
      c.kN = this._k(c, n); c.kT1 = this._k(c, c.t1); c.kT2 = this._k(c, c.t2);
      const rv = this._relVel(c);
      const vn = dot(rv, n);
      c.vn0 = vn;
      const gap = Math.max(c.sep, 0);
      if (vn < -REST_THRESHOLD && -vn * h > gap - 1e-6 && c.e > 0) c.target = -c.e * vn;      // will impact this step: bounce
      else c.target = gap > 0 ? -gap * inv : 0;                                                    // speculative / resting
      if (c.old) {                                                                                  // warm start
        c.jn = c.old.jn * 0.85;
        c.jt1 = c.old.ft ? dot(c.old.ft, c.t1) * 0.85 : 0; c.jt2 = c.old.ft ? dot(c.old.ft, c.t2) * 0.85 : 0;
        this._apply(c, c.jn * n[0] + c.jt1 * c.t1[0] + c.jt2 * c.t2[0], c.jn * n[1] + c.jt1 * c.t1[1] + c.jt2 * c.t2[1], c.jn * n[2] + c.jt1 * c.t1[2] + c.jt2 * c.t2[2]);
      }
    }
    for (let it = 0; it < SOLVER_ITERATIONS; it++) {
      for (const c of contacts) {
        // friction (clamped to a circular cone)
        let rv = this._relVel(c);
        const l1 = -dot(rv, c.t1) / c.kT1, l2 = -dot(rv, c.t2) / c.kT2;
        let n1 = c.jt1 + l1, n2 = c.jt2 + l2;
        const maxF = c.mu * c.jn, mag = Math.hypot(n1, n2);
        if (mag > maxF) { const k = mag > 0 ? maxF / mag : 0; n1 *= k; n2 *= k; }
        const d1 = n1 - c.jt1, d2 = n2 - c.jt2;
        c.jt1 = n1; c.jt2 = n2;
        this._apply(c, d1 * c.t1[0] + d2 * c.t2[0], d1 * c.t1[1] + d2 * c.t2[1], d1 * c.t1[2] + d2 * c.t2[2]);
        // normal
        rv = this._relVel(c);
        const vn = dot(rv, c.n);
        let jn = c.jn + (c.target - vn) / c.kN;
        if (jn < 0) jn = 0;
        const dj = jn - c.jn;
        c.jn = jn;
        this._apply(c, dj * c.n[0], dj * c.n[1], dj * c.n[2]);
      }
    }
    // remember impulses for the next step
    for (const c of contacts) {
      c.ft = [c.jt1 * c.t1[0] + c.jt2 * c.t2[0], c.jt1 * c.t1[1] + c.jt2 * c.t2[1], c.jt1 * c.t1[2] + c.jt2 * c.t2[2]];
      // `old` entries are matched by position; keep jn/ft/p on the contact itself (the cache stores these objects)
    }
    // ground flags
    for (const c of contacts) {
      if (c.sep > 0.03) continue;
      if (c.n[1] > 0.6 && c.b.dynamic) c.b.onGround = true;      // B rests on A
      if (c.n[1] < -0.6 && c.a.dynamic) c.a.onGround = true;     // A rests on B
      // a walker shoving a loose body: the controller limits its push force while this is set
      if (Math.abs(c.n[1]) < 0.6) {
        if (c.a.isPlayer && c.b.dynamic && !c.b.isPlayer) c.a.pushing = true;
        if (c.b.isPlayer && c.a.dynamic && !c.a.isPlayer) c.b.pushing = true;
      }
    }
  }

  _k(c, d) {
    const A = c.a, B = c.b, rA = c.rA, rB = c.rB;
    const ca = cross(rA, d), cb = cross(rB, d);
    const ia = mulM(A.Iw, ca), ib = mulM(B.Iw, cb);
    const k = A.im + B.im + dot(cross(ia, rA), d) + dot(cross(ib, rB), d);
    return k > 1e-12 ? k : 1e-12;
  }

  _relVel(c) {
    const A = c.a, B = c.b, rA = c.rA, rB = c.rB;
    const wa = A.angVel, wb = B.angVel;
    return [
      B.vel.x + wb.y * rB[2] - wb.z * rB[1] - A.vel.x - wa.y * rA[2] + wa.z * rA[1],
      B.vel.y + wb.z * rB[0] - wb.x * rB[2] - A.vel.y - wa.z * rA[0] + wa.x * rA[2],
      B.vel.z + wb.x * rB[1] - wb.y * rB[0] - A.vel.z - wa.x * rA[1] + wa.y * rA[0],
    ];
  }

  _apply(c, px, py, pz) {
    const A = c.a, B = c.b;
    if (A.im > 0) {
      A.vel.x -= px * A.im; A.vel.y -= py * A.im; A.vel.z -= pz * A.im;
      const t = cross(c.rA, [px, py, pz]), w = mulM(A.Iw, t);
      A.angVel.x -= w[0]; A.angVel.y -= w[1]; A.angVel.z -= w[2];
    }
    if (B.im > 0) {
      B.vel.x += px * B.im; B.vel.y += py * B.im; B.vel.z += pz * B.im;
      const t = cross(c.rB, [px, py, pz]), w = mulM(B.Iw, t);
      B.angVel.x += w[0]; B.angVel.y += w[1]; B.angVel.z += w[2];
    }
  }

  // positional correction: re-estimates every penetration from the displacement so far (Gauss-Seidel, no overshoot)
  _correct(contacts) {
    if (!contacts.length) return;
    const moved = new Set();
    for (let it = 0; it < 4; it++) {
      for (const c of contacts) {
        const A = c.a, B = c.b, n = c.n;
        const w = A.im + B.im;
        if (w <= 0) continue;
        const sep = c.sep + (n[0] * ((B._dx || 0) - (A._dx || 0)) + n[1] * ((B._dy || 0) - (A._dy || 0)) + n[2] * ((B._dz || 0) - (A._dz || 0)));
        const pen = -sep - SLOP;
        if (pen <= 0) continue;
        const corr = Math.min(pen * 0.5, 0.08) / w;
        if (A.im > 0) { const k = corr * A.im; A.pos.x -= n[0] * k; A.pos.y -= n[1] * k; A.pos.z -= n[2] * k; A._dx -= n[0] * k; A._dy -= n[1] * k; A._dz -= n[2] * k; moved.add(A); }
        if (B.im > 0) { const k = corr * B.im; B.pos.x += n[0] * k; B.pos.y += n[1] * k; B.pos.z += n[2] * k; B._dx += n[0] * k; B._dy += n[1] * k; B._dz += n[2] * k; moved.add(B); }
      }
    }
    for (const b of moved) b.updateBounds();
  }

  // Nearest hit among all bodies and the ground plane. Returns {body|null, dist, normal:[x,y,z]} or null.
  // `filter(body)` (optional) lets a caller skip bodies, e.g. a vehicle's wheels only look at static scenery.
  raycast(origin, dir, maxDist, ignore = null, filter = null) {
    let best = null;
    const n = [0, 1, 0];
    for (const c of this.all) {
      if (c === ignore || c.rayIgnore || c.parked || (filter && !filter(c))) continue;
      const t = rayBody(c, origin, dir, maxDist, n);
      if (t !== null && (!best || t < best.dist)) best = { body: c, dist: t, normal: [n[0], n[1], n[2]] };
    }
    if (dir.y < -1e-6) {
      const t = -origin.y / dir.y;
      if (t >= 0 && t <= maxDist && (!best || t < best.dist)) best = { body: null, dist: t, normal: [0, 1, 0] };
    }
    return best;
  }

  // Apply an impulse (N*s) along `dir` (unit) at a world point (defaults to the centre of mass).
  applyImpulse(body, dir, magnitude, point = null) {
    if (!body || !body.dynamic || body.kinematic || body.parked) return;
    body.wake();
    const jx = dir.x * magnitude, jy = dir.y * magnitude, jz = dir.z * magnitude;
    body.vel.x += jx * body.invMass; body.vel.y += jy * body.invMass; body.vel.z += jz * body.invMass;
    if (point && !body.lockRotation) {
      const live = body.invI;
      const R = body.R;
      const r = [point.x - body.c[0], point.y - body.c[1], point.z - body.c[2]];
      const t = cross(r, [jx, jy, jz]);
      const l = [R[0] * t[0] + R[3] * t[1] + R[6] * t[2], R[1] * t[0] + R[4] * t[1] + R[7] * t[2], R[2] * t[0] + R[5] * t[1] + R[8] * t[2]];
      const w = mulM(R, [l[0] * live[0], l[1] * live[1], l[2] * live[2]]);
      body.angVel.x += w[0]; body.angVel.y += w[1]; body.angVel.z += w[2];
    }
  }

  // Spin a body toward a target orientation (used for carried crates). Sets angVel directly.
  driveOrientation(body, target, gain = 12, maxW = 14) {
    const q = body.quat;
    // error = target * conj(q)
    let ex = target.w * -q.x + target.x * q.w + target.y * -q.z - target.z * -q.y;
    let ey = target.w * -q.y - target.x * -q.z + target.y * q.w + target.z * -q.x;
    let ez = target.w * -q.z + target.x * -q.y - target.y * -q.x + target.z * q.w;
    const ew = target.w * q.w + target.x * q.x + target.y * q.y + target.z * q.z;
    if (ew < 0) { ex = -ex; ey = -ey; ez = -ez; }
    let wx = ex * 2 * gain, wy = ey * 2 * gain, wz = ez * 2 * gain;
    const m = Math.hypot(wx, wy, wz);
    if (m > maxW) { const k = maxW / m; wx *= k; wy *= k; wz *= k; }
    body.angVel.set(wx, wy, wz);
  }
}
