// Syncs the pushable crates between players.
// Every client simulates crates locally (so pushing feels instant). Per-crate OWNERSHIP decides who is
// authoritative: whoever sets a crate moving owns it and streams its state; everybody else treats it as a
// kinematic (network-positioned) body and interpolates it. When it rests, the owner releases it.
// The server arbitrates conflicting claims, replays state to late joiners and frees crates on disconnect.
import { INTERP_DELAY } from './remote.js';

const SEND_INTERVAL = 50;      // ms
const REST_SPEED = 0.05;       // m/s
const MOVE_SPEED = 0.1;        // m/s: faster than this and a free crate gets claimed
const REST_TIME = 0.6;         // s at rest before the owner lets go
const STALE_OWNER = 1.5;       // s without updates -> treat the crate as free locally
const r3 = (v) => Math.round(v * 1000) / 1000;

export class CrateSync {
  constructor(crates, physics, net) {
    this.crates = crates;
    this.physics = physics;
    this.net = net;
    this.st = crates.map(() => ({ owner: null, buf: [], lastRecv: 0, rest: 0, lastSent: null, dirty: false }));
    this._index = new Map(crates.map((b, i) => [b, i]));
    this._lastSendAt = 0;
    this.active = false;                     // only while inside a room
  }

  indexOf(body) { return this._index.has(body) ? this._index.get(body) : -1; }
  isRemoteOwned(body) { const i = this.indexOf(body); return i >= 0 && !!this.st[i].owner && this.st[i].owner !== 'me'; }

  // Called when entering a room: everybody starts from the same layout.
  resetToHome() {
    this.crates.forEach((b, i) => {
      b.pos.set(...b.home); b.vel.set(0, 0, 0); b.kinematic = false; b.onGround = false; b.updateBounds();
      Object.assign(this.st[i], { owner: null, buf: [], rest: 0, lastSent: null, dirty: false });
    });
  }

  setActive(on) {
    this.active = on;
    if (!on) this.releaseAllLocal();
  }

  releaseAllLocal() {
    this.crates.forEach((b, i) => { const s = this.st[i]; s.owner = null; s.buf = []; b.kinematic = false; b.vel.set(0, 0, 0); });
  }

  // ---- incoming ----
  applyInit(list) {                          // [idx, x,y,z, vx,vy,vz, ownerId|null]
    const now = performance.now() / 1000;
    for (const e of list) {
      const b = this.crates[e[0]]; if (!b) continue;
      const s = this.st[e[0]];
      b.pos.set(e[1], e[2], e[3]); b.vel.set(0, 0, 0); b.updateBounds();
      s.buf = []; s.lastRecv = now;
      s.owner = e[7] && e[7] !== this.net.myId ? e[7] : null;
      b.kinematic = !!s.owner;
    }
  }

  onRemote(msg) {                            // { t, from, c: [[idx, x,y,z, vx,vy,vz, release]] }
    if (!this.active) return;
    const t = msg.t / 1000, now = performance.now() / 1000;
    for (const e of msg.c) {
      const b = this.crates[e[0]]; if (!b) continue;
      const s = this.st[e[0]];
      s.lastRecv = now;
      if (e[7] === 1) {                      // released: snap to the final resting place and become a normal crate
        s.owner = null; s.buf = []; b.kinematic = false;
        b.pos.set(e[1], e[2], e[3]); b.vel.set(0, 0, 0); b.updateBounds();
        continue;
      }
      if (s.owner === 'me') { s.owner = msg.from; s.buf = []; }          // somebody else won the claim: yield
      s.owner = msg.from;
      b.kinematic = true;
      if (!s.buf.length || t > s.buf[s.buf.length - 1].t) {
        s.buf.push({ t, x: e[1], y: e[2], z: e[3] });
        if (s.buf.length > 20) s.buf.shift();
      }
    }
  }

  onReleased(list) {                         // owner left / disconnected
    for (const i of list) {
      const b = this.crates[i]; if (!b) continue;
      const s = this.st[i]; s.owner = null; s.buf = []; b.kinematic = false; b.vel.set(0, 0, 0);
    }
  }

  onImpulse(d) {                             // somebody poked a crate that we own
    const b = this.crates[d.idx]; if (!b) return;
    this.physics.applyImpulse(b, { x: d.d[0], y: d.d[1], z: d.d[2] }, d.m);
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
  poke(body, dir, magnitude) {
    const i = this.indexOf(body);
    if (this.active && i >= 0 && this.st[i].owner && this.st[i].owner !== 'me') {
      this.net.sendCrateImpulse(i, [dir.x, dir.y, dir.z], magnitude);
      return;
    }
    this.physics.applyImpulse(body, dir, magnitude);
  }

  // ---- per frame, BEFORE physics: place crates other players own ----
  beforePhysics() {
    if (!this.active) return;
    const rt = this.net.renderTimeSec(), now = performance.now() / 1000;
    this.crates.forEach((b, i) => {
      const s = this.st[i];
      if (!s.owner || s.owner === 'me') return;
      if (now - s.lastRecv > STALE_OWNER) { s.owner = null; s.buf = []; b.kinematic = false; b.vel.set(0, 0, 0); return; }
      const buf = s.buf; if (!buf.length) return;
      let p = buf[0];
      if (rt >= buf[buf.length - 1].t) p = buf[buf.length - 1];
      else if (rt > buf[0].t) {
        let k = buf.length - 2; while (k > 0 && buf[k].t > rt) k--;
        const a = buf[k], c = buf[k + 1], f = (rt - a.t) / (c.t - a.t || 1);
        p = { x: a.x + (c.x - a.x) * f, y: a.y + (c.y - a.y) * f, z: a.z + (c.z - a.z) * f };
      }
      b.pos.set(p.x, p.y, p.z); b.vel.set(0, 0, 0); b.updateBounds();
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
      if (s.owner && s.owner !== 'me') return;
      const speed = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
      if (!s.owner) {
        if (speed > MOVE_SPEED || (!b.onGround && b.pos.y > 0.02 && speed > 0.02)) {   // started moving -> claim it
          s.owner = 'me'; s.rest = 0; s.dirty = true;
        } else return;
      }
      if (s.held) { s.rest = 0; s.dirty = true; }                                       // carried: never release, always stream
      else if (speed < REST_SPEED && b.onGround) s.rest += dt; else s.rest = 0;
      if (!s.held && s.rest > REST_TIME) {                                                         // settled: let go
        out.push([i, r3(b.pos.x), r3(b.pos.y), r3(b.pos.z), 0, 0, 0, 1]);
        s.owner = null; s.rest = 0; s.lastSent = null; s.dirty = false;
        return;
      }
      if (due || s.dirty) {
        const e = [i, r3(b.pos.x), r3(b.pos.y), r3(b.pos.z), r3(b.vel.x), r3(b.vel.y), r3(b.vel.z), 0];
        const l = s.lastSent;
        if (s.dirty || !l || Math.abs(e[1] - l[1]) > 0.002 || Math.abs(e[2] - l[2]) > 0.002 || Math.abs(e[3] - l[3]) > 0.002 || nowMs - this._lastSendAt > 400) {
          out.push(e); s.lastSent = e; s.dirty = false;
        }
      }
    });
    if (out.length) { this.net.sendCrates(out); this._lastSendAt = nowMs; }
    else if (due) this._lastSendAt = nowMs;
  }
}
