// Socket.IO client wrapper: connection status, room requests (with timeouts), state/action sending.
import { io } from 'socket.io-client';
import { SERVER_URL } from './server-config.js';

export function resolveServerUrl() {
  try {
    const q = new URLSearchParams(location.search).get('server');
    if (q && /^https?:\/\//i.test(q)) return q.replace(/\/+$/, '');
  } catch (_) { /* ignore */ }
  return SERVER_URL ? SERVER_URL.replace(/\/+$/, '') : '';     // '' = same origin
}

export const ERROR_TEXT = {
  INVALID_CODE: 'That is not a valid room code (5 letters/numbers).',
  ROOM_NOT_FOUND: 'No room with that code. Check the code and try again.',
  ROOM_FULL: 'That room is full (12 players max).',
  ALREADY_IN_ROOM: 'You are already in a room.',
  RATE_LIMIT: 'Slow down a little and try again.',
  NOT_CONNECTED: 'Not connected to the server yet.',
  TIMEOUT: 'The server did not answer in time. Try again.',
};
export const errorText = (code) => ERROR_TEXT[code] || 'Something went wrong. Try again.';

export class Network {
  constructor() {
    this.url = resolveServerUrl();
    this.status = 'connecting';        // 'connecting' | 'connected' | 'disconnected' | 'error'
    this.ping = null;
    this.roomCode = null;
    this.selfId = null;
    this.socket = null;
    // callbacks (assigned by main.js)
    this.onStatus = null;              // (status, text)
    this.onPing = null;                // (ms)
    this.onRoomUpdate = null;          // (update)
    this.onRoomLost = null;            // (reason)  -> connection dropped while in a room
    this.onSnap = null;                // ({players})
    this.onAction = null;              // ({id,type,side})
    this._pingTimer = null;
    this._startedAt = Date.now();
  }

  get connected() { return !!this.socket && this.socket.connected; }
  get inRoom() { return this.connected && !!this.roomCode; }

  _setStatus(status, text) {
    this.status = status;
    this.onStatus?.(status, text);
  }

  connect() {
    const opts = {
      transports: ['websocket', 'polling'],   // websocket first, polling as fallback
      reconnectionDelayMax: 5000,
      timeout: 20000,
    };
    this.socket = this.url ? io(this.url, opts) : io(opts);
    const s = this.socket;
    this._setStatus('connecting', 'Connecting to server…');

    s.on('connect', () => {
      this._setStatus('connected', 'Connected');
      this._startPing();
    });

    s.on('connect_error', (err) => {
      const waited = (Date.now() - this._startedAt) / 1000;
      const hint = waited > 4 ? ' The server may be waking up (free hosting can take ~1 minute) – retrying…' : ' Retrying…';
      this._setStatus('error', 'Cannot reach server.' + hint);
      console.warn('[net] connect_error', err?.message);
    });

    s.on('disconnect', (reason) => {
      this._stopPing();
      this.ping = null;
      const wasInRoom = !!this.roomCode;
      this.roomCode = null;
      this.selfId = null;
      this._setStatus('disconnected', 'Disconnected – reconnecting…');
      if (wasInRoom) this.onRoomLost?.(reason);
    });

    s.io.on('reconnect_attempt', () => this._setStatus('connecting', 'Reconnecting…'));

    s.on('room:update', (u) => this.onRoomUpdate?.(u));
    s.on('snap', (m) => this.onSnap?.(m));
    s.on('player:action', (a) => this.onAction?.(a));
  }

  _startPing() {
    this._stopPing();
    const tick = () => {
      if (!this.connected) return;
      const t = performance.now();
      this.socket.timeout(3000).emit('net:ping', null, (err) => {
        if (err) return;
        this.ping = Math.round(performance.now() - t);
        this.onPing?.(this.ping);
      });
    };
    tick();
    this._pingTimer = setInterval(tick, 3000);
  }
  _stopPing() { if (this._pingTimer) clearInterval(this._pingTimer); this._pingTimer = null; }

  request(event, payload, timeoutMs = 8000) {
    return new Promise((resolve) => {
      if (!this.connected) return resolve({ ok: false, error: 'NOT_CONNECTED' });
      this.socket.timeout(timeoutMs).emit(event, payload, (err, res) => {
        resolve(err ? { ok: false, error: 'TIMEOUT' } : res || { ok: false, error: 'SERVER_ERROR' });
      });
    });
  }

  async createRoom(name) {
    const res = await this.request('room:create', { name });
    if (res.ok) { this.roomCode = res.code; this.selfId = res.you; }
    return res;
  }
  async joinRoom(code, name) {
    const res = await this.request('room:join', { code, name });
    if (res.ok) { this.roomCode = res.code; this.selfId = res.you; }
    return res;
  }
  async leaveRoom() {
    const wasIn = !!this.roomCode;
    this.roomCode = null;
    this.selfId = null;
    if (wasIn && this.connected) await this.request('room:leave', null, 3000);
  }

  sendState(state) { if (this.inRoom) this.socket.volatile.emit('player:state', state); }
  sendAction(type, side) { if (this.inRoom) this.socket.emit('player:action', { type, side }); }
}
