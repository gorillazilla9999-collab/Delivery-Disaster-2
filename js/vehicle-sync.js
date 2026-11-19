// Vehicle network sync. Same idea as crates-sync.js (the owner simulates and streams full rigid-body state, everybody else
// follows it as a kinematic body behind a short interpolation buffer), with one big difference: WHO owns the car is not
// decided by whoever moves it first. The SERVER hands out the driver's seat (one player at a time) and ownership; this
// class only follows what the server says, and the server drops state from anybody who is not the owner.
//
//   driver: 'me' | <playerId> | null      owner: 'me' | <playerId> | null
//   owner 'me'      -> we simulate it and stream it (20 Hz)
//   owner other     -> we do not simulate it: it is a kinematic body placed from the interpolated stream
//   owner null      -> nobody; a parked car every client simulates locally (it sits asleep, held by its parking brake)
import { CONFIG } from './config.js';
import { quatSlerp, quatAngularVelocity, Quat } from './physics.js';
import { NET_LEN } from './vehicle.js';

const BUF_MAX = 20;
const SNAP_DIST = 2.5;            // m: a bigger gap between two samples is a teleport (reset), not movement

const lerp = (a, b, f) => a + (b - a) * f;

export class VehicleSync {
  constructor(vehicles, net, cfg = CONFIG.vehicle.net) {
    this.vehicles = vehicles;                         // Vehicle[]
    this.byId = new Map(vehicles.map((v) => [v.id, v]));
    this.net = net;
    this.cfg = cfg;
    this.active = false;                              // only inside a room
    this.st = new Map(vehicles.map((v) => [v.id, { driver: null, driverName: null, owner: null, buf: [], lastRecv: 0, lastSent: 0, lastState: null, releasing: false, claiming: false }]));
    this.onForcedExit = null;                         // (id) the server took us out of the driver's seat (knocked out...)
    this.onYield = null;                              // (id) we lost control of a car we were simulating
    this._q = new Quat(); this._qa = new Quat(); this._qb = new Quat();
    this._lastSendAt = 0;
  }

  // ---- queries ----
  state(id) { return this.st.get(id); }
  driverOf(id) { return this.st.get(id).driver; }
  ownerOf(id) { return this.st.get(id).owner; }
  isDriving(id) { return this.st.get(id).driver === 'me'; }
  isRemoteOwned(id) { const o = this.st.get(id).owner; return !!o && o !== 'me'; }
  // do we simulate this car? (we own it, or we are playing alone, or nobody owns it)
  simulates(id) { return !this.isRemoteOwned(id); }
  _me() { return this.net.myId; }
  _norm(id) { return id && id === this._me() ? 'me' : id || null; }

  // ---- lifecycle ----
  setActive(on) {
    this.active = on;
    if (!on) for (const v of this.vehicles) this._free(v, this.st.get(v.id));
  }
  _free(v, s) { s.owner = null; s.driver = null; s.buf = []; s.releasing = s.claiming = false; v.body.kinematic = false; v.occupied = false; v.body.vel.set(0, 0, 0); v.body.angVel.set(0, 0, 0); v.body.wake(); }

  // entering a room: everybody starts with the car at its home
  resetToHome() {
    for (const v of this.vehicles) {
      const s = this.st.get(v.id);
      this._free(v, s);
      v.place(CONFIG.vehicle.spawn.x, CONFIG.vehicle.spawn.z, CONFIG.vehicle.spawn.yaw);
      v.resetSeq = 0;
    }
  }

  // ---- messages from the server ----
  applyInit(list) {
    for (const info of list || []) {
      const v = this.byId.get(info.id); if (!v) continue;
      const s = this.st.get(info.id);
      s.buf = []; s.lastRecv = performance.now() / 1000;
      s.driver = this._norm(info.driver); s.driverName = info.driverName || null;
      s.owner = this._norm(info.owner);
      if (info.s && info.s.length >= NET_LEN) this._snap(v, info.s, s.owner !== null && s.owner !== 'me');
      if (this.isRemoteOwned(info.id)) { v.body.kinematic = true; v.body.sleeping = false; v.occupied = true; }
      else { v.body.kinematic = false; v.occupied = s.driver === 'me'; }
    }
  }

  onDriver(m) {
    const v = this.byId.get(m.id); if (!v) return;
    const s = this.st.get(m.id);
    const prevDriver = s.driver, prevOwner = s.owner;
    s.driver = this._norm(m.driver); s.driverName = m.driverName || null;
    const owner = this._norm(m.owner);
    s.owner = owner;
    if (prevDriver === 'me' && s.driver !== 'me') this.onForcedExit?.(m.id);       // the server took us out (or confirms our exit)
    v.occupied = s.driver !== null;

    if (owner === 'me') {
      if (prevOwner !== 'me') this._takeOver(v, s);
    } else if (owner) {                                                          // somebody else simulates it now
      if (prevOwner === 'me') { s.releasing = false; this.onYield?.(m.id); }
      s.buf = [];
      v.body.kinematic = true; v.body.sleeping = false; s.lastRecv = performance.now() / 1000;
    } else {                                                                     // released: nobody owns it
      if (prevOwner !== 'me' && m.s && m.s.length >= NET_LEN) this._snap(v, m.s, false);   // everybody ends up at exactly the same spot
      v.body.kinematic = false; s.buf = [];
      if (prevOwner !== 'me') { v.body.vel.set(0, 0, 0); v.body.angVel.set(0, 0, 0); }
      v.body.wake();
    }
  }

  onState(m) {                                                                   // { t, id, from, s }
    if (!this.active) return;
    const v = this.byId.get(m.id); if (!v || !m.s || m.s.length < NET_LEN) return;
    const s = this.st.get(m.id);
    if (s.owner === 'me') return;                                                // we are the owner: ignore echoes
    const t = m.t / 1000, last = s.buf[s.buf.length - 1];
    s.lastRecv = performance.now() / 1000;
    if (s.owner !== m.from) { s.owner = m.from; s.buf = []; }
    v.body.kinematic = true; v.body.sleeping = false;
    if (last && m.s[23] !== last.s[23]) { s.buf = []; this._snap(v, m.s, true); }   // the owner reset the car: jump, do not glide
    if (!s.buf.length || t > s.buf[s.buf.length - 1].t) {
      s.buf.push({ t, s: m.s });
      if (s.buf.length > BUF_MAX) s.buf.shift();
    }
    v.resetSeq = m.s[23];
  }

  onDenied(m) {                                                                  // we sent state for a car we do not control
    const v = this.byId.get(m.id); if (!v) return;
    const s = this.st.get(m.id);
    const owner = this._norm(m.owner);
    if (owner && owner !== 'me') {
      if (s.owner === 'me') this.onYield?.(m.id);
      s.owner = owner; s.buf = []; v.body.kinematic = true; v.body.sleeping = false;
    } else if (m.resync) this._snap(v, m.resync, false);                         // teleport refused: go back to where the server has it
  }

  // ---- entering / leaving the seat (server decides) ----
  async enter(id) {
    const v = this.byId.get(id), s = this.st.get(id);
    if (!v) return { ok: false, message: 'No such vehicle.' };
    if (s.driver && s.driver !== 'me') return { ok: false, message: 'Somebody is already driving that.' };
    if (this.active) {
      const res = await this.net.vehicleEnter(id);
      if (!res.ok) return res;
    }
    s.driver = 'me'; s.driverName = null; v.occupied = true;
    if (s.owner !== 'me') { s.owner = 'me'; this._takeOver(v, s); }
    return { ok: true };
  }
  exit(id) {
    const v = this.byId.get(id), s = this.st.get(id);
    if (!v || s.driver !== 'me') return;
    s.driver = null; v.occupied = false;                                          // the car keeps its owner (us) until it has stopped
    if (this.active) this.net.vehicleExit(id);
  }

  _takeOver(v, s) {                                                              // from kinematic follower to simulating it ourselves
    v.body.kinematic = false; v.body.sleeping = false; v.body.sleepT = 0;
    const last = s.buf[s.buf.length - 1]; if (last) v.resetSeq = last.s[23];
    s.buf = []; s.lastSent = 0; s.releasing = false;
    v.body.wake();
  }

  // put the car at the pose in a state packet (used for init / released / reset); `moving` keeps the velocity
  _snap(v, st, moving) {
    const b = v.body;
    b.pos.set(st[0], st[1], st[2]); b.quat.set(st[3], st[4], st[5], st[6]).normalize();
    if (moving) { b.vel.set(st[7], st[8], st[9]); b.angVel.set(st[10], st[11], st[12]); } else { b.vel.set(0, 0, 0); b.angVel.set(0, 0, 0); }
    b.updateBounds(); b.sleeping = false; b.sleepT = 0;
    v.applyNetLook(st);
    v.resetSeq = st[23];
  }

  // ---- per frame, BEFORE physics: place the cars other players own ----
  beforePhysics(dt = 1 / 60) {
    if (!this.active) return;
    const rt = this.net.renderTimeSec(), now = performance.now() / 1000;
    for (const v of this.vehicles) {
      const s = this.st.get(v.id);
      if (!s.owner || s.owner === 'me') continue;
      if (now - s.lastRecv > this.cfg.staleOwner) {                              // owner went silent: treat as free
        s.owner = null; s.buf = []; v.body.kinematic = false; v.body.vel.set(0, 0, 0); v.body.angVel.set(0, 0, 0); v.body.wake(); continue;
      }
      const buf = s.buf; if (!buf.length) continue;
      let a = buf[0], c = buf[0], f = 0;
      if (rt >= buf[buf.length - 1].t) a = c = buf[buf.length - 1];
      else if (rt > buf[0].t) { let k = buf.length - 2; while (k > 0 && buf[k].t > rt) k--; a = buf[k]; c = buf[k + 1]; f = (rt - a.t) / (c.t - a.t || 1); }
      const A = a.s, C = c.s, b = v.body;
      const x = lerp(A[0], C[0], f), y = lerp(A[1], C[1], f), z = lerp(A[2], C[2], f);
      quatSlerp(this._q, this._qa.set(A[3], A[4], A[5], A[6]), this._qb.set(C[3], C[4], C[5], C[6]), f);
      const dx = x - b.pos.x, dy = y - b.pos.y, dz = z - b.pos.z;
      if (dx * dx + dy * dy + dz * dz > SNAP_DIST * SNAP_DIST || dt <= 0) { b.vel.set(0, 0, 0); b.angVel.set(0, 0, 0); }
      else { b.vel.set(dx / dt, dy / dt, dz / dt); quatAngularVelocity(b.angVel, b.quat, this._q, dt); }   // it carries its real velocity: it shoves what it touches
      b.pos.set(x, y, z); b.quat.copy(this._q); b.updateBounds();
      b.kinematic = true;
      // wheels / lights from the nearer sample, wheel numbers interpolated
      const look = A.slice();
      for (let i = 13; i < 22; i++) look[i] = lerp(A[i], C[i], f);
      look[22] = f < 0.5 ? A[22] : C[22];
      v.applyNetLook(look);
    }
  }

  // ---- per frame, AFTER physics: stream what we own, let go of resting cars, claim ones that start rolling ----
  afterPhysics(dt) {
    if (!this.active) return;
    const nowMs = performance.now();
    for (const v of this.vehicles) {
      const s = this.st.get(v.id), b = v.body;
      if (b.kinematic || s.owner && s.owner !== 'me') continue;
      v.tickRest(dt);
      if (!s.owner) {
        // a free car that something has set rolling (slope, shoved by a crate...): ask the server for ownership
        if (!s.claiming && !b.sleeping && b.speed > 0.4 && !s.driver) {
          s.claiming = true; s.owner = 'me';
          this.net.vehicleClaim(v.id).then((res) => { s.claiming = false; if (!res.ok && s.owner === 'me' && !s.driver) { s.owner = this._norm(res.owner); if (s.owner) { b.kinematic = true; s.buf = []; } } });
        }
        continue;
      }
      // owner: stream
      const due = nowMs - s.lastSent >= this.cfg.sendInterval;
      if (due) {
        const st = v.getNetState(), l = s.lastState;
        const moved = !l || Math.abs(st[0] - l[0]) > 0.002 || Math.abs(st[1] - l[1]) > 0.002 || Math.abs(st[2] - l[2]) > 0.002 ||
          Math.abs(st[3] - l[3]) + Math.abs(st[4] - l[4]) + Math.abs(st[5] - l[5]) + Math.abs(st[6] - l[6]) > 0.003 || Math.abs(st[13] - l[13]) > 0.003 || st[22] !== l[22] || st[23] !== l[23];
        if (moved || nowMs - s.lastSent > 400) { this.net.sendVehicleState(v.id, st); s.lastSent = nowMs; s.lastState = st; }
      }
      // no driver and at rest for a while: hand the car back (everyone then agrees on exactly where it stands)
      if (!s.driver && !s.releasing && v.restTime >= this.cfg.releaseAfterRest) {
        s.releasing = true;
        const st = v.getNetState();
        this.net.vehicleRelease(v.id, st).then((res) => { s.releasing = false; if (res.ok && !s.driver) { s.owner = null; s.lastState = null; } });
      }
    }
  }
}
