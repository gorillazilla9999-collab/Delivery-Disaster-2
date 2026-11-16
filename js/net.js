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
    this._offset = null;              // ms: local clock minus server clock (min-latency estimate)
    this._lastSent = null;
    this._lastSendAt = 0;
    this._pendingPings = 0;
    this.pingMs = null;

    // callbacks (set by main/UI)
    this.onStatus = () => {};         // (state, text)   state: unavailable|connecting|connected|reconnecting|error
    this.onRoom = () => {};           // (room|null, info)
    this.onRoster = () => {};         // (roster, hostId)
    this.onNotice = () => {};         // (text, kind)  kind: join|leave|info|error
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
      if (wasInRoom) this._rejoin();
    });

    socket.on('hello', (h) => {
      if (h.maxPlayers) this.maxPlayers = h.maxPlayers;
      this._noteServerTime(h.serverTime, true);
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
      this.onNotice(`${p.name || 'A player'} ${p.reason === 'disconnected' ? 'disconnected' : 'left'}`, 'leave');
    });
    socket.on('snapshot', (snap) => this._onSnapshot(snap));
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
  _noteServerTime(serverMs, force) {
    const sample = Date.now() - serverMs;                 // = clock difference + latency
    if (this._offset === null || force && sample < this._offset) this._offset = sample;
    else if (sample < this._offset) this._offset = sample;
    else this._offset += (sample - this._offset) * 0.01;  // creeps up slowly to follow clock drift
  }
  serverNowSec() { return (Date.now() - (this._offset ?? 0)) / 1000; }
  renderTimeSec() { return this.serverNowSec() - INTERP_DELAY; }

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
        this.room = { code: res.code, max: res.max };
        this.session = { code: res.code, name: res.name };
        this.myId = res.you;
        this._lastSent = null;
        this.onRoom(this.room, { name: res.name, created: event === 'create-room' });
        resolve(res);
      });
    });
  }

  _rejoin() {
    const { code, name } = this.session;
    this.socket.timeout(8000).emit('join-room', { code, name }, (err, res) => {
      if (!err && res && res.ok) {
        this.room = { code: res.code, max: res.max };
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
      if (rp) rp.pushSnapshot(t, snap.p[id]);
    }
  }

  // ---- sending ----
  // st: { x,y,z,yaw,pitch,speed,vy,grounded,reaching }
  sendState(st) {
    if (!this.room || !this.socket || !this.socket.connected) return;
    const now = performance.now();
    if (now - this._lastSendAt < SEND_INTERVAL) return;
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

  sendAction(type, side) {
    if (this.room && this.socket && this.socket.connected) this.socket.emit('action', { type, side });
  }

  // Remote avatars are advanced by main's loop; this is its time source.
  updateRemotes(dt) { this.remotes.update(this.renderTimeSec(), dt); }
}
