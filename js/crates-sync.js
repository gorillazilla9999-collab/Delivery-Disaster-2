// Syncs the pushable crates + barrels between players.
// Every client simulates crates locally (so pushing feels instant). Per-crate OWNERSHIP decides who is
// authoritative: whoever sets a crate moving owns it and streams its full rigid-body state (position, velocity,
// ORIENTATION and spin); everybody else treats it as a kinematic (network-positioned) body and interpolates it,
// including a spherical interpolation of its rotation. When it rests, the owner releases it.
// The server arbitrates conflicting claims, replays state to late joiners and frees crates on disconnect.
import { quatSlerp, quatAngularVelocity, Quat, PARK_Y } from './physics.js';

const SEND_INTERVAL = 50;      // ms
const REST_SPEED = 0.05;       // m/s
const REST_SPIN = 0.15;        // rad/s
const MOVE_SPEED = 0.1;        // m/s: faster than this and a free crate gets claimed
const MOVE_SPIN = 0.4;         // rad/s: ... or spinning faster than this (tipping over)
const REST_TIME = 0.6;         // s at rest before the owner lets go
const STALE_OWNER = 1.5;       // s without updates -> treat the crate as free locally
const r3 = (v) => Math.round(v * 1000) / 1000;
const r4 = (v) => Math.round(v * 10000) / 10000;

// entry layout: [idx, x, y, z, vx, vy, vz, release|ownerId, qx, qy, qz, qw, wx, wy, wz]
const entryOf = (i, b, release) => [
  i, r3(b.pos.x), r3(b.pos.y), r3(b.pos.z), r3(b.vel.x), r3(b.vel.y), r3(b.vel.z), release,
  r4(b.quat.x), r4(b.quat.y), r4(b.quat.z), r4(b.quat.w), r3(b.angVel.x), r3(b.angVel.y), r3(b.angVel.z),
];

export class CrateSync {
  constructor(crates, physics, net) {
    this.crates = crates;
    this.physics = physics;
    this.net = net;
    this.st = crates.map(() => ({ owner: null, buf: [], lastRecv: 0, rest: 0, lastSent: null, dirty: false }));
    this._index = new Map(crates.map((b, i) => [b, i]));
    this._lastSendAt = 0;
    this.active = false;                     // only while inside a room
    this._q = new Quat(); this._p = { x: 0, y: 0, z: 0 }; this._w = { x: 0, y: 0, z: 0 };
  }

  indexOf(body) { return this._index.has(body) ? this._index.get(body) : -1; }
  isRemoteOwned(body) { const i = this.indexOf(body); return i >= 0 && !!this.st[i].owner && this.st[i].owner !== 'me'; }

  _place(b, x, y, z, q) {                    // snap a crate to a pose and let it settle as a normal local body
    if (y < -48) { b.park(); return; }       // the network's way of saying "out of play"
    b.unpark();
    b.pos.set(x, y, z); b.vel.set(0, 0, 0); b.angVel.set(0, 0, 0);
    if (q) b.quat.set(q[0], q[1], q[2], q[3]).normalize(); else b.quat.set(0, 0, 0, 1);
    b.updateBounds();
    b.wake();
  }

  // Called when entering a room: everybody starts from the same layout.
  resetToHome() {
    this.crates.forEach((b, i) => {
      b.kinematic = false; b.onGround = false;
      this._place(b, b.home[0], b.home[1], b.home[2], null);    // spawn-pool items have a parked home
      Object.assign(this.st[i], { owner: null, buf: [], rest: 0, lastSent: null, dirty: false });
    });
  }

  setActive(on) {
    this.active = on;
    if (!on) this.releaseAllLocal();
  }

  releaseAllLocal() {
    this.crates.forEach((b, i) => { const s = this.st[i]; s.owner = null; s.buf = []; b.kinematic = false; b.vel.set(0, 0, 0); b.angVel.set(0, 0, 0); b.wake(); });
  }

  // ---- spawning / despawning ----
  // Put a (parked) crate into the world and stream it as ours. Everybody else unparks it when the first update arrives.
  spawn(body, x, y, z, vel = null, quat = null) {
    const i = this.indexOf(body); if (i < 0) return false;
    this._place(body, x, y, z, quat ? [quat.x, quat.y, quat.z, quat.w] : null);
    if (vel) body.vel.set(vel.x, vel.y, vel.z);
    const s = this.st[i]; s.owner = 'me'; s.rest = 0; s.dirty = true; s.held = false; s.buf = [];
    return true;
  }
  // Take a crate out of play for everybody (crushed, deleted).
  park(body) {
    const i = this.indexOf(body); if (i < 0) return;
    const s = this.st[i];
    body.park(); s.owner = null; s.buf = []; s.held = false; s.rest = 0; s.dirty = false; s.lastSent = null;
    if (this.active) this.net.sendCrates([entryOf(i, body, 1)]);
  }
  // Bring a parked crate back at a pose (respawn at its home).
  restore(body, x, y, z) {
    const i = this.indexOf(body); if (i < 0) return;
    this._place(body, x, y, z, null);
    const s = this.st[i]; s.owner = null; s.buf = []; s.rest = 0;
    if (this.active) this.net.sendCrates([entryOf(i, body, 1)]);
  }
  // Who gets to decide that a crate was crushed / removed: its owner, or (if free) the room host, or us when playing solo.
  isAuthority(body) {
    const i = this.indexOf(body); if (i < 0) return false;
    if (!this.active) return true;
    const o = this.st[i].owner;
    return o === 'me' || (!o && this.net.isHost);
  }

  // ---- incoming ----
  applyInit(list) {                          // [idx, x,y,z, vx,vy,vz, ownerId|null, qx,qy,qz,qw, wx,wy,wz]
    const now = performance.now() / 1000;
    for (const e of list) {
      const b = this.crates[e[0]]; if (!b) continue;
      const s = this.st[e[0]];
      this._place(b, e[1], e[2], e[3], e.length >= 12 ? [e[8], e[9], e[10], e[11]] : null);
      s.buf = []; s.lastRecv = now;
      s.owner = e[7] && e[7] !== this.net.myId ? e[7] : null;
      b.kinematic = !!s.owner;
    }
  }

  onRemote(msg) {                            // { t, from, c: [[idx, x,y,z, vx,vy,vz, release, qx,qy,qz,qw, wx,wy,wz]] }
    if (!this.active) return;
    const t = msg.t / 1000, now = performance.now() / 1000;
    for (const e of msg.c) {
      const b = this.crates[e[0]]; if (!b) continue;
      const s = this.st[e[0]];
      s.lastRecv = now;
      const hasQ = e.length >= 12;
      if (e[7] === 1) {                      // released: snap to the final resting place and become a normal crate
        s.owner = null; s.buf = []; b.kinematic = false;
        this._place(b, e[1], e[2], e[3], hasQ ? [e[8], e[9], e[10], e[11]] : null);
        continue;
      }
      if (e[2] < -48) { s.owner = null; s.buf = []; b.park(); continue; }   // despawned / crushed
      if (b.parked) b.unpark();                                            // freshly spawned by somebody
      if (s.owner === 'me') { s.owner = msg.from; s.buf = []; }          // somebody else won the claim: yield
      s.owner = msg.from;
      b.kinematic = true;
      if (!s.buf.length || t > s.buf[s.buf.length - 1].t) {
        s.buf.push({ t, x: e[1], y: e[2], z: e[3], q: hasQ ? [e[8], e[9], e[10], e[11]] : null });
        if (s.buf.length > 20) s.buf.shift();
      }
    }
  }

  onReleased(list) {                         // owner left / disconnected
    for (const i of list) {
      const b = this.crates[i]; if (!b) continue;
      const s = this.st[i]; s.owner = null; s.buf = []; b.kinematic = false; b.vel.set(0, 0, 0); b.angVel.set(0, 0, 0); b.wake();
    }
  }

  onImpulse(d) {                             // somebody poked a crate that we own
    const b = this.crates[d.idx]; if (!b) return;
    const p = Array.isArray(d.p) && d.p.length >= 3 ? { x: d.p[0], y: d.p[1], z: d.p[2] } : null;
    this.physics.applyImpulse(b, { x: d.d[0], y: d.d[1], z: d.d[2] }, d.m, p);
  }

  // Carrying: the carrier claims the crate immediately and keeps streaming it until it is dropped.
  hold(body) {
    const i = this.indexOf(body); if (i < 0) return;
    const s = this.st[i];
    s.owner = 'me'; s.rest = 0; s.dirty = true; s.held = true;
  }
  unhold(body) {
    const i = this.indexOf(body); if (i < 0) return;
    this.st[i].held = false; this.st[i].rest = 0;
  }

  // Poke on a crate: if somebody else owns it, ask the owner to apply it; otherwise apply locally.
  // `point` is where the fist lands (world coordinates): hits away from the centre make the crate spin.
  poke(body, dir, magnitude, point = null) {
    const i = this.indexOf(body);
    if (this.active && i >= 0 && this.st[i].owner && this.st[i].owner !== 'me') {
      this.net.sendCrateImpulse(i, [dir.x, dir.y, dir.z], magnitude, point ? [point.x, point.y, point.z] : undefined);
      return;
    }
    this.physics.applyImpulse(body, dir, magnitude, point);
  }

  // ---- per frame, BEFORE physics: place crates other players own ----
  beforePhysics(dt = 1 / 60) {
    if (!this.active) return;
    const rt = this.net.renderTimeSec(), now = performance.now() / 1000;
    this.crates.forEach((b, i) => {
      const s = this.st[i];
      if (b.parked || !s.owner || s.owner === 'me') return;
      if (now - s.lastRecv > STALE_OWNER) { s.owner = null; s.buf = []; b.kinematic = false; b.vel.set(0, 0, 0); b.angVel.set(0, 0, 0); b.wake(); return; }
      const buf = s.buf; if (!buf.length) return;
      const q = this._q, p = this._p;
      let last = buf[0], a = last, c = last, f = 0;
      if (rt >= buf[buf.length - 1].t) { a = c = buf[buf.length - 1]; }
      else if (rt > buf[0].t) {
        let k = buf.length - 2; while (k > 0 && buf[k].t > rt) k--;
        a = buf[k]; c = buf[k + 1]; f = (rt - a.t) / (c.t - a.t || 1);
      }
      p.x = a.x + (c.x - a.x) * f; p.y = a.y + (c.y - a.y) * f; p.z = a.z + (c.z - a.z) * f;
      if (a.q && c.q) quatSlerp(q, { x: a.q[0], y: a.q[1], z: a.q[2], w: a.q[3] }, { x: c.q[0], y: c.q[1], z: c.q[2], w: c.q[3] }, f);
      else q.copy(b.quat);

      // it moves like a wall: give it the velocity it actually has, so it shoves (and carries) whatever it touches
      const dx = p.x - b.pos.x, dy = p.y - b.pos.y, dz = p.z - b.pos.z;
      if (dx * dx + dy * dy + dz * dz > 4 || dt <= 0) { b.vel.set(0, 0, 0); b.angVel.set(0, 0, 0); }
      else { b.vel.set(dx / dt, dy / dt, dz / dt); quatAngularVelocity(b.angVel, b.quat, q, dt); }
      b.pos.set(p.x, p.y, p.z); b.quat.copy(q); b.updateBounds();
    });
  }

  // ---- per frame, AFTER physics: claim crates that started moving, release resting ones, send state ----
  afterPhysics(dt) {
    if (!this.active) return;
    const out = [];
    const nowMs = performance.now();
    const due = nowMs - this._lastSendAt >= SEND_INTERVAL;
    this.crates.forEach((b, i) => {
      const s = this.st[i];
      if (b.parked || (s.owner && s.owner !== 'me')) return;
      const speed = b.speed, spin = b.spin;
      if (!s.owner) {
        if (speed > MOVE_SPEED || spin > MOVE_SPIN || (!b.onGround && !b.sleeping && speed > 0.02)) {   // started moving -> claim it
          s.owner = 'me'; s.rest = 0; s.dirty = true;
        } else return;
      }
      if (s.held) { s.rest = 0; s.dirty = true; }                                       // carried: never release, always stream
      else if (b.sleeping || (speed < REST_SPEED && spin < REST_SPIN && b.onGround)) s.rest += dt; else s.rest = 0;
      if (!s.held && s.rest > REST_TIME) {                                              // settled: let go
        out.push(entryOf(i, b, 1));
        s.owner = null; s.rest = 0; s.lastSent = null; s.dirty = false;
        return;
      }
      if (due || s.dirty) {
        const e = entryOf(i, b, 0);
        const l = s.lastSent;
        const moved = !l || Math.abs(e[1] - l[1]) > 0.002 || Math.abs(e[2] - l[2]) > 0.002 || Math.abs(e[3] - l[3]) > 0.002 ||
          Math.abs(e[8] - l[8]) + Math.abs(e[9] - l[9]) + Math.abs(e[10] - l[10]) + Math.abs(e[11] - l[11]) > 0.004;
        if (s.dirty || moved || nowMs - this._lastSendAt > 400) {
          out.push(e); s.lastSent = e; s.dirty = false;
        }
      }
    });
    if (out.length) { this.net.sendCrates(out); this._lastSendAt = nowMs; }
    else if (due) this._lastSendAt = nowMs;
  }
}
