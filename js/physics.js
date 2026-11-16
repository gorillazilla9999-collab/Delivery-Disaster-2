// Tiny AABB physics: gravity, ground, static boxes, stair step-up, and pushable dynamic boxes.
// A Body's `pos` is the centre of its BOTTOM face. The player is just a dynamic Body.
import * as THREE from 'three';
import { CONFIG } from './config.js';

const EPS = 1e-5;

export class Body {
  constructor({ size = [1, 1, 1], position = [0, 0, 0], mass = 1, dynamic = false, name = '' }) {
    this.name = name;
    this.hx = size[0] / 2;
    this.h = size[1];
    this.hz = size[2] / 2;
    this.pos = new THREE.Vector3(...position);
    this.vel = new THREE.Vector3();
    this.min = new THREE.Vector3();
    this.max = new THREE.Vector3();
    this.mass = mass;
    this.dynamic = dynamic;
    this.isPlayer = false;
    this.kinematic = false;   // true = moved by the network (owned by another player), acts like a moving wall
    this.friction = 5;        // ground deceleration for non-player dynamic bodies (m/s^2)
    this.stepHeight = 0;      // > 0 lets the body walk up small ledges
    this.stepOffset = 0;      // visual offset used to smooth step-ups (read by the camera)
    this.onGround = false;
    this.noGravity = false;   // true while carried: velocity is driven by the carrier, no gravity/friction
    this.ignore = null;       // a body this one passes through (the carrier)
    this.rayIgnore = false;   // raycasts skip this body (carried crate)
    this.mesh = null;
    this.updateBounds();
  }
  updateBounds() {
    this.min.set(this.pos.x - this.hx, this.pos.y, this.pos.z - this.hz);
    this.max.set(this.pos.x + this.hx, this.pos.y + this.h, this.pos.z + this.hz);
  }
}

function passes(a, b) { return a.ignore === b || b.ignore === a; }

function overlaps(a, b) {
  return a.min.x < b.max.x - EPS && a.max.x > b.min.x + EPS &&
         a.min.y < b.max.y - EPS && a.max.y > b.min.y + EPS &&
         a.min.z < b.max.z - EPS && a.max.z > b.min.z + EPS;
}

// Ray vs AABB (slab method). Returns distance or null.
function rayBox(o, d, min, max) {
  let tmin = -Infinity, tmax = Infinity;
  for (const ax of ['x', 'y', 'z']) {
    const dir = Math.abs(d[ax]) < 1e-9 ? 1e-9 : d[ax];
    const inv = 1 / dir;
    let t1 = (min[ax] - o[ax]) * inv;
    let t2 = (max[ax] - o[ax]) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  return Math.max(tmin, 0);
}

export class PhysicsWorld {
  constructor() {
    this.all = [];
    this.dynamics = [];
    this.statics = [];
  }

  add(body) {
    this.all.push(body);
    (body.dynamic ? this.dynamics : this.statics).push(body);
    return body;
  }

  step(dt) {
    const g = CONFIG.physics.gravity;
    for (const b of this.dynamics) {
      if (b.kinematic) continue;
      if (!b.noGravity) b.vel.y = Math.max(b.vel.y - g * dt, -CONFIG.physics.terminalVelocity);
      if (!b.isPlayer && b.onGround && !b.noGravity) {
        const sp = Math.hypot(b.vel.x, b.vel.z);
        if (sp > 0) {
          const ns = Math.max(0, sp - b.friction * dt);
          const k = ns < 0.05 ? 0 : ns / sp;
          b.vel.x *= k;
          b.vel.z *= k;
        }
      }
      this._move(b, dt);
    }
  }

  _move(b, dt) {
    const wasGround = b.onGround;
    b.onGround = false;
    this._axis(b, 'x', dt, wasGround);
    this._axis(b, 'z', dt, wasGround);
    this._vertical(b, dt);
    const L = CONFIG.world.limit;
    b.pos.x = Math.max(-L, Math.min(L, b.pos.x));
    b.pos.z = Math.max(-L, Math.min(L, b.pos.z));
    b.updateBounds();
  }

  _blocked(b) {
    for (const c of this.all) if (c !== b && !passes(b, c) && overlaps(b, c)) return true;
    return false;
  }

  _axis(b, ax, dt, canStep) {
    const half = ax === 'x' ? b.hx : b.hz;
    const d = b.vel[ax] * dt;
    b.pos[ax] += d;
    b.updateBounds();

    for (const c of this.all) {
      if (c === b || passes(b, c) || !overlaps(b, c)) continue;

      // Walk up small ledges / stairs.
      const rise = c.max.y - b.pos.y;
      if (canStep && b.stepHeight > 0 && rise > EPS && rise <= b.stepHeight) {
        const oldY = b.pos.y;
        b.pos.y = c.max.y;
        b.updateBounds();
        if (!this._blocked(b)) { b.stepOffset -= c.max.y - oldY; continue; }
        b.pos.y = oldY;
        b.updateBounds();
      }

      const dir = d > 0 ? 1 : d < 0 ? -1 : (b.pos[ax] < (c.min[ax] + c.max[ax]) / 2 ? 1 : -1);
      b.pos[ax] = dir > 0 ? c.min[ax] - half : c.max[ax] + half;
      b.updateBounds();

      const vb = b.vel[ax];
      if (c.dynamic && !c.kinematic && b.dynamic) {
        // Perfectly inelastic exchange: heavier things are harder to shove.
        const vc = c.vel[ax];
        if (dir * (vb - vc) > 0) {
          const v = (b.mass * vb + c.mass * vc) / (b.mass + c.mass);
          b.vel[ax] = v;
          c.vel[ax] = v;
        }
      } else if (dir * vb > 0) {
        b.vel[ax] = 0;
      }
    }
  }

  _vertical(b, dt) {
    const prevY = b.pos.y;
    b.pos.y += b.vel.y * dt;
    b.updateBounds();

    for (const c of this.all) {
      if (c === b || passes(b, c) || !overlaps(b, c)) continue;
      if (prevY >= c.max.y - 0.02) {                    // landed on top
        b.pos.y = c.max.y;
        if (b.vel.y < 0) b.vel.y = 0;
        b.onGround = true;
      } else if (prevY + b.h <= c.min.y + 0.02) {       // bumped head
        b.pos.y = c.min.y - b.h;
        if (b.vel.y > 0) b.vel.y = 0;
      } else {                                          // embedded: pop out the top
        b.pos.y = c.max.y;
        if (b.vel.y < 0) b.vel.y = 0;
        b.onGround = true;
      }
      b.updateBounds();
    }

    if (b.pos.y <= 0) {                                 // flat ground at y = 0
      b.pos.y = 0;
      if (b.vel.y < 0) b.vel.y = 0;
      b.onGround = true;
    }
  }

  // Nearest hit among all bodies and the ground plane. Returns {body|null, dist} or null.
  raycast(origin, dir, maxDist, ignore = null) {
    let best = null;
    for (const c of this.all) {
      if (c === ignore || c.rayIgnore) continue;
      const t = rayBox(origin, dir, c.min, c.max);
      if (t !== null && t <= maxDist && (!best || t < best.dist)) best = { body: c, dist: t };
    }
    if (dir.y < -1e-6) {
      const t = -origin.y / dir.y;
      if (t >= 0 && t <= maxDist && (!best || t < best.dist)) best = { body: null, dist: t };
    }
    return best;
  }

  applyImpulse(body, dir, magnitude) {
    if (!body || !body.dynamic) return;
    body.vel.x += (dir.x * magnitude) / body.mass;
    body.vel.z += (dir.z * magnitude) / body.mass;
    body.vel.y += (Math.max(dir.y, 0) * magnitude + 0.6) / body.mass;
  }
}
