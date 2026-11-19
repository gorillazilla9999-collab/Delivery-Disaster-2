// Multiplayer client: Socket.IO connection, rooms, state sending, snapshot receiving.
// The server URL is never hardcoded: it comes from /config.js (PUBLIC_SERVER_URL env var on the server),
// or ?server=https://... in the page URL, and otherwise defaults to the page's own origin.
import { INTERP_DELAY } from './remote.js';

const SEND_INTERVAL = 50;        // ms between state packets (20 Hz) when something changed
const HEARTBEAT = 1000;          // ms: resend even if idle, so late joiners / lost state converge
const r3 = (v) => Math.round(v * 1000) / 1000;

function loadScript(src, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    const timer = setTimeout(() => { el.remove(); reject(new Error('timeout')); }, timeoutMs);
    el.src = src;
    el.onload = () => { clearTimeout(timer); resolve(); };
    el.onerror = () => { clearTimeout(timer); el.remove(); reject(new Error('failed to load ' + src)); };
    document.head.appendChild(el);
  });
}

export class Net {
  constructor(remotes) {
    this.remotes = remotes;
    this.socket = null;
    this.available = false;
    this.myId = null;
    this.room = null;                 // { code, max } while inside a room
    this.roster = [];                 // [{ id, name }]
    this.maxPlayers = 12;
    this.session = null;              // { code, name } remembered for auto-rejoin after a dropped connection
    this.everConnected = false;
    this._offset = null;              // ms: local clock minus server clock (taken from the fastest recent packets)
    this._offsetSamples = [];         // recent (clock difference + latency) samples, ~5 s worth
    this._jitterMean = 0;             // ms: how much later than the fastest packets typical ones arrive
    this._jitterDev = 0;
    this._delay = INTERP_DELAY;       // s: how far in the past we draw remote things (grows with jitter, so a bad connection buffers more)
    this._lastSent = null;
    this._lastSendAt = 0;
    this._pendingPings = 0;
    this.pingMs = null;
    this.isAdmin = false;
    this._adminCode = null;           // kept in memory only, so a dropped connection can log in again automatically

    // callbacks (set by main/UI)
    this.onStatus = () => {};         // (state, text)   state: unavailable|connecting|connected|reconnecting|error
    this.onRoom = () => {};           // (room|null, info)
    this.onRoster = () => {};         // (roster, hostId)
    this.onNotice = () => {};         // (text, kind)  kind: join|leave|info|error
    this.onHit = () => {};            // ({ from, to, d, hp, ko, koMs, fromName, toName })
    this.onChat = () => {};           // ({ id, name, text, t, host, admin })
    this.onAdmin = () => {};          // (isAdmin)
    this.onRoomUpdate = () => {};     // () room code / lock changed
    this.crateSync = null;            // set by main (CrateSync)
    this.vehicleSync = null;          // set by main (VehicleSync)
  }

  get inRoom() { return !!this.room; }

  async init() {
    const params = new URLSearchParams(location.search);
    let serverUrl = '';
    try { await loadScript('/config.js', 4000); serverUrl = (window.DD_ENV && window.DD_ENV.serverUrl) || ''; } catch (_) { /* no Node server: fine */ }
    const override = params.get('server');
    if (override && /^https?:\/\//i.test(override)) serverUrl = override.replace(/\/+$/, '');
    if (window.DD_ENV && window.DD_ENV.maxPlayers) this.maxPlayers = window.DD_ENV.maxPlayers;
    this.serverUrl = serverUrl;

    this.onStatus('connecting', 'Connecting to server…');
    try {
      if (typeof window.io !== 'function') await loadScript(`${serverUrl}/socket.io/socket.io.js`);
    } catch (e) {
      this.available = false;
      this.onStatus('unavailable', 'Multiplayer server not reachable (offline / single-player). Run "npm start" to enable it.');
      return false;
    }
    this.available = true;
    this._connect(serverUrl);
    return true;
  }

  _connect(url) {
    const socket = window.io(url || undefined, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });
    this.socket = socket;

    socket.on('connect', () => {
      const wasInRoom = !!this.session;
      this.myId = socket.id;
      this.everConnected = true;
      this.onStatus('connected', 'Connected');
      const go = () => { if (wasInRoom) this._rejoin(); };
      if (this._adminCode) {                         // admin rights belong to the socket: log in again before rejoining
        socket.timeout(5000).emit('admin-login', { code: this._adminCode }, (err, res) => {
          this.isAdmin = !err && !!(res && res.ok);
          if (!this.isAdmin) this._adminCode = null;
          this.onAdmin(this.isAdmin);
          go();
        });
      } else go();
    });

    socket.on('hello', (h) => {
      if (h.maxPlayers) this.maxPlayers = h.maxPlayers;
      this._noteServerTime(h.serverTime);
    });

    socket.on('connect_error', (err) => {
      this.onStatus(this.everConnected ? 'reconnecting' : 'error',
        this.everConnected ? 'Connection lost - reconnecting…' : `Cannot reach server (${err && err.message ? err.message : 'error'}) - retrying…`);
    });

    socket.on('disconnect', (reason) => {
      // Everyone we could see is now stale; wipe them until we rejoin.
      this.remotes.clear();
      this.roster = [];
      if (this.room) { this.onNotice('Connection lost - trying to reconnect…', 'error'); this.onRoom(null, { keepSession: true, lostConnection: true }); }
      this.room = null;
      this._lastSent = null;
      this.onRoster([], null);
      if (reason === 'io server disconnect') socket.connect();
      this.onStatus('reconnecting', 'Connection lost - reconnecting…');
    });

    socket.io.on('reconnect_attempt', () => this.onStatus('reconnecting', 'Reconnecting…'));
    socket.io.on('reconnect_failed', () => this.onStatus('error', 'Could not reconnect to the server.'));

    socket.on('roster', (r) => this._onRoster(r));
    socket.on('player-joined', (p) => this.onNotice(`${p.name} joined`, 'join'));
    socket.on('player-left', (p) => {
      this.remotes.remove(p.id);
      this.onNotice(`${p.name || 'A player'} ${p.reason === 'disconnected' ? 'disconnected' : p.reason === 'kicked' ? 'was kicked' : 'left'}`, 'leave');
    });
    socket.on('room-code', (m) => {
      if (!this.room) return;
      this.room.code = m.code;
      if (this.session) this.session.code = m.code;
      this.onNotice(`Room code changed to ${m.code}`, 'info');
      this.onRoomUpdate();
    });
    socket.on('room-lock', (m) => {
      if (!this.room) return;
      this.room.locked = !!m.locked;
      this.onNotice(m.locked ? 'Room locked' : 'Room unlocked', 'info');
      this.onRoomUpdate();
    });
    socket.on('kicked', () => {
      this.session = null;
      this.remotes.clear();
      this.roster = [];
      this.room = null;
      this._lastSent = null;
      this.onRoster([], null);
      this.onRoom(null, { kicked: true });
    });
    socket.on('snapshot', (snap) => this._onSnapshot(snap));
    socket.on('crate-init', (list) => this.crateSync?.applyInit(list));
    socket.on('crates', (m) => this.crateSync?.onRemote(m));
    socket.on('crates-released', (l) => this.crateSync?.onReleased(l));
    socket.on('crate-impulse', (d) => this.crateSync?.onImpulse(d));
    socket.on('vehicle-init', (l) => this.vehicleSync?.applyInit(l));
    socket.on('vehicle-driver', (m) => this.vehicleSync?.onDriver(m));
    socket.on('vehicle-state', (m) => this.vehicleSync?.onState(m));
    socket.on('vehicle-denied', (m) => this.vehicleSync?.onDenied(m));
    socket.on('hit', (h) => this.onHit(h));
    socket.on('chat', (m) => { if (this.room) this.onChat(m); });
    socket.on('action', (a) => { const p = this.remotes.players.get(a.id); if (p && a.type === 'poke') p.poke(a.side); });

    // latency probe
    setInterval(() => {
      if (!socket.connected || this._pendingPings > 0) return;
      const t0 = performance.now();
      this._pendingPings++;
      socket.timeout(4000).emit('ping-check', (err, serverMs) => {
        this._pendingPings = 0;
        if (!err) { this.pingMs = Math.round(performance.now() - t0); if (typeof serverMs === 'number') this._noteServerTime(serverMs, false); }
      });
    }, 3000);
  }

  // ---- clock ----
  _noteServerTime(serverMs) {
    const sample = Date.now() - serverMs;                 // = clock difference + latency
    const w = this._offsetSamples;
    w.push(sample); if (w.length > 100) w.shift();
    let min = Infinity; for (let i = 0; i < w.length; i++) if (w[i] < min) min = w[i];
    // follow the fastest recent packets, but never jump: a smooth clock means smooth motion
    if (this._offset === null) this._offset = min;
    else this._offset += Math.max(-2, Math.min(2, min - this._offset));
    // jitter = how late the typical packet is compared with the best one; the buffer has to cover it
    const late = Math.max(0, sample - min);
    this._jitterMean += (late - this._jitterMean) * 0.05;
    this._jitterDev += (Math.abs(late - this._jitterMean) - this._jitterDev) * 0.05;
    const target = Math.min(0.4, Math.max(INTERP_DELAY, 0.05 + (this._jitterMean + 2.5 * this._jitterDev) / 1000));
    // grow quickly (avoid running dry), shrink slowly (avoid visible speed-ups)
    this._delay += target > this._delay ? Math.min(target - this._delay, 0.004) : Math.max(target - this._delay, -0.0005);
  }
  serverNowSec() { return (Date.now() - (this._offset ?? 0)) / 1000; }
  renderTimeSec() { return this.serverNowSec() - this._delay; }

  // ---- rooms ----
  createRoom(name) { return this._enter('create-room', { name }); }
  joinRoom(code, name) { return this._enter('join-room', { code, name }); }

  _enter(event, payload) {
    return new Promise((resolve) => {
      if (!this.socket || !this.socket.connected) return resolve({ ok: false, message: 'Not connected to the server yet.' });
      if (this.room) return resolve({ ok: false, message: 'You are already in a room.' });
      this.socket.timeout(8000).emit(event, payload, (err, res) => {
        if (err) return resolve({ ok: false, message: 'Server did not respond. Try again.' });
        if (!res.ok) return resolve(res);
        this.room = { code: res.code, max: res.max, locked: !!res.locked };
        this.session = { code: res.code, name: res.name, token: res.token };
        this.myId = res.you;
        this._lastSent = null;
        this.onRoom(this.room, { name: res.name, created: event === 'create-room' });
        resolve(res);
      });
    });
  }

  // ---- host / admin ----
  _call(event, payload, timeoutMs = 6000) {
    return new Promise((resolve) => {
      if (!this.socket || !this.socket.connected) return resolve({ ok: false, message: 'Not connected to the server.' });
      this.socket.timeout(timeoutMs).emit(event, payload, (err, res) => resolve(err ? { ok: false, message: 'Server did not respond.' } : (res || { ok: false })));
    });
  }
  get isHost() { return !!this.room && this.room.hostId === this.myId; }
  setLock(locked, target) { return this._call('room-set-lock', { locked: !!locked, target }); }
  setRoomCode(newCode, target) { return this._call('room-set-code', { newCode: newCode || '', target }); }
  async adminLogin(code) {
    const res = await this._call('admin-login', { code });
    this.isAdmin = !!res.ok;
    this._adminCode = res.ok ? code : null;
    this.onAdmin(this.isAdmin);
    return res;
  }
  async adminLogout() {
    await this._call('admin-logout', {});
    this.isAdmin = false; this._adminCode = null;
    this.onAdmin(false);
  }
  sendChat(text) { return this._call('chat', { text }, 4000); }
  adminRooms() { return this._call('admin-rooms', {}); }
  adminKick(id) { return this._call('admin-kick', { id }); }

  _rejoin() {
    const { code, name, token } = this.session;
    this.socket.timeout(8000).emit('join-room', { code, name, token }, (err, res) => {
      if (!err && res && res.ok) {
        this.room = { code: res.code, max: res.max, locked: !!res.locked };
        this.session.token = res.token;
        this.myId = res.you;
        this._lastSent = null;
        this.onRoom(this.room, { name: res.name, rejoined: true });
        this.onNotice('Reconnected to room ' + res.code, 'info');
      } else {
        this.session = null;
        this.onNotice(`Could not rejoin room ${code}: ${(res && res.message) || 'no response'}`, 'error');
        this.onRoom(null, { rejoinFailed: true });
      }
    });
  }

  leaveRoom() {
    return new Promise((resolve) => {
      this.session = null;
      const done = () => {
        this.remotes.clear();
        this.roster = [];
        this.room = null;
        this._lastSent = null;
        this.onRoster([], null);
        this.onRoom(null, { left: true });
        resolve();
      };
      if (this.socket && this.socket.connected) this.socket.timeout(3000).emit('leave-room', {}, done);
      else done();
    });
  }

  _onRoster(r) {
    if (!this.room || r.code !== this.room.code) return;
    this.roster = r.players;
    this.room.max = r.max;
    this.room.locked = !!r.locked;
    this.room.hostId = r.hostId;
    const ids = new Set(r.players.map((p) => p.id));
    for (const id of [...this.remotes.players.keys()]) if (!ids.has(id)) this.remotes.remove(id);
    for (const p of r.players) {
      if (p.id === this.myId) continue;
      const fresh = !this.remotes.has(p.id);
      const rp = this.remotes.add(p.id, p.name);
      if (fresh && p.state) rp.pushSnapshot(this.serverNowSec() - 0.5, p.state);   // idle players still appear
    }
    this.onRoster(r.players, r.hostId);
  }

  _onSnapshot(snap) {
    if (!this.room) return;
    const t = snap.t / 1000;
    this._noteServerTime(snap.t, false);
    for (const id in snap.p) {
      if (id === this.myId) continue;
      const rp = this.remotes.players.get(id);
      const s = snap.p[id];
      if (rp) rp.pushSnapshot(typeof s[8] === 'number' && s[8] > 0 ? s[8] / 1000 : t, s);   // s[8] = when the server received this sample
    }
  }

  // ---- sending ----
  // st: { x,y,z,yaw,pitch,speed,vy,grounded,reaching }
  sendState(st) {
    if (!this.room || !this.socket || !this.socket.connected) return;
    const now = performance.now();
    if (now - this._lastSendAt < SEND_INTERVAL - 8) return;     // frames are 16.7 ms apart: without the slack 50 ms rounds up to 67 ms (15 Hz, uneven)
    const yaw = Math.atan2(Math.sin(st.yaw), Math.cos(st.yaw));
    const pkt = [r3(st.x), r3(st.y), r3(st.z), r3(yaw), r3(st.pitch), r3(st.speed), r3(st.vy), (st.grounded ? 1 : 0) | (st.reaching ? 2 : 0)];
    const l = this._lastSent;
    const changed = !l ||
      Math.abs(pkt[0] - l[0]) > 0.005 || Math.abs(pkt[1] - l[1]) > 0.005 || Math.abs(pkt[2] - l[2]) > 0.005 ||
      Math.abs(pkt[3] - l[3]) > 0.004 || Math.abs(pkt[4] - l[4]) > 0.004 ||
      Math.abs(pkt[5] - l[5]) > 0.05 || Math.abs(pkt[6] - l[6]) > 0.1 || pkt[7] !== l[7];
    if (!changed && now - this._lastSendAt < HEARTBEAT) return;
    this._lastSent = pkt;
    this._lastSendAt = now;
    this.socket.volatile.emit('state', pkt);
  }

  sendCrates(entries) {
    if (!this.room || !this.socket || !this.socket.connected) return;
    // releases / spawns / parks (entry[7] === 1) must arrive; a plain moving-crate update may be dropped
    if (entries.some((e) => e[7] === 1)) this.socket.emit('crates', entries); else this.socket.volatile.emit('crates', entries);
  }
  sendCrateImpulse(idx, d, m, p) { if (this.room && this.socket && this.socket.connected) this.socket.emit('crate-impulse', { idx, d, m, p }); }

  // ---- vehicles (the server decides who may drive / control a car) ----
  vehicleEnter(id) { return this._call('vehicle-enter', { id }, 4000); }
  vehicleExit(id) { return this._call('vehicle-exit', { id }, 4000); }
  vehicleClaim(id) { return this._call('vehicle-claim', { id }, 4000); }
  vehicleRelease(id, s) { return this._call('vehicle-release', { id, s }, 4000); }
  sendVehicleState(id, s) { if (this.room && this.socket && this.socket.connected) this.socket.volatile.emit('vehicle-state', { id, s }); }

  sendPunch(targetId) {
    if (this.room && this.socket && this.socket.connected) this.socket.emit('punch', { to: targetId });
  }

  sendAction(type, side) {
    if (this.room && this.socket && this.socket.connected) this.socket.emit('action', { type, side });
  }

  // Remote avatars are advanced by main's loop; this is its time source.
  updateRemotes(dt) { this.remotes.update(this.renderTimeSec(), dt); }
}
