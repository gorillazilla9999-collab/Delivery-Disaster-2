// Overlay / lobby / HUD. DOM only - no game logic. main.js assigns the on* callbacks.
import { PLAYER_COLORS } from './config.js';

const $ = (id) => document.getElementById(id);

export class UI {
  constructor() {
    this.overlay = $('overlay');
    this.status = $('status');
    this.bar = $('loadbar');
    this.fill = $('loadfill');
    this.error = $('error');
    this.crosshair = $('crosshair');

    this.netBox = $('netstatus');
    this.netDot = $('netdot');
    this.netText = $('nettext');

    this.viewMenu = $('view-menu');
    this.viewRoom = $('view-room');
    this.nameInput = $('name');
    this.codeInput = $('code');
    this.btnCreate = $('btn-create');
    this.btnJoin = $('btn-join');
    this.btnSolo = $('btn-solo');
    this.menuMsg = $('menu-msg');
    this.play = $('play');
    this.btnLeave = $('btn-leave');
    this.btnCopy = $('btn-copy');

    this.hud = $('roomhud');

    // callbacks
    this.onCreate = null; this.onJoin = null; this.onSolo = null; this.onLeave = null; this.onPlay = null;

    this.ready = false;           // overlay click may start/resume the game
    this.netOk = false;
    this.mpAvailable = true;
    this.busy = false;
    this.ping = null;
    this._room = null;

    // sensitivity
    this.sens = $('sens');
    this.sensVal = $('sensval');
    let saved = 1;
    try { saved = parseFloat(localStorage.getItem('dd_sens')) || 1; } catch (_) {}
    this.sensitivity = saved;
    this.sens.value = saved;
    this.sensVal.textContent = saved.toFixed(2);
    this.sens.addEventListener('input', () => {
      this.sensitivity = parseFloat(this.sens.value);
      this.sensVal.textContent = this.sensitivity.toFixed(2);
      try { localStorage.setItem('dd_sens', String(this.sensitivity)); } catch (_) {}
    });

    // name
    let name = '';
    try { name = localStorage.getItem('dd_name') || ''; } catch (_) {}
    this.nameInput.value = name || 'Courier ' + Math.floor(100 + Math.random() * 900);
    this.nameInput.addEventListener('change', () => this._saveName());

    this.codeInput.addEventListener('input', () => {
      this.codeInput.value = this.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      this._refreshButtons();
    });

    this.btnCreate.addEventListener('click', () => this.onCreate?.(this.name));
    this.btnJoin.addEventListener('click', () => this.onJoin?.(this.codeInput.value, this.name));
    this.codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !this.btnJoin.disabled) this.btnJoin.click(); });
    this.nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !this.btnCreate.disabled) this.btnCreate.click(); });
    this.btnSolo.addEventListener('click', () => this.onSolo?.());
    this.btnLeave.addEventListener('click', () => this.onLeave?.());
    this.play.addEventListener('click', (e) => { e.stopPropagation(); if (this.ready) this.onPlay?.(); });
    this.overlay.addEventListener('click', () => { if (this.ready) this.onPlay?.(); });
    $('panel').addEventListener('click', (e) => e.stopPropagation());
    this.btnCopy.addEventListener('click', () => this._copyCode());

    document.body.classList.add('menu-open');
  }

  get name() { this._saveName(); return this.nameInput.value.trim(); }
  _saveName() { try { localStorage.setItem('dd_name', this.nameInput.value.trim()); } catch (_) {} }

  // ----- loading / fatal -----
  setLoading(frac) { this.fill.style.width = Math.round(Math.min(1, frac) * 100) + '%'; }
  fatal(html) {
    this.status.textContent = 'Something went wrong';
    this.bar.hidden = true;
    this.error.hidden = false;
    this.error.innerHTML = html;
  }

  // ----- views -----
  _showOverlay() { this.overlay.classList.remove('hidden'); document.body.classList.add('menu-open'); }
  hide() { this.overlay.classList.add('hidden'); document.body.classList.remove('menu-open'); }

  showMenu(message, kind = 'error') {
    this.ready = false;
    this.hud.hidden = true;
    this.bar.hidden = true;
    this.status.textContent = 'Create a room, join a friend, or play solo.';
    this.netBox.hidden = false;
    this.viewMenu.hidden = false;
    this.viewRoom.hidden = true;
    this.setMenuMessage(message || '', kind);
    this.setBusy(false);
    this._showOverlay();
  }

  // room: { code, players, hostId, maxPlayers } or null for solo. paused = shown after pressing Esc.
  showRoom(room, selfId, paused = false) {
    this._room = room ? { room, selfId } : null;
    this.ready = true;
    this.bar.hidden = true;
    this.viewMenu.hidden = true;
    this.viewRoom.hidden = false;
    this.status.textContent = paused ? 'Paused' : (room ? 'You are in the room.' : 'Solo mode.');
    this.play.textContent = paused ? 'Click to resume' : 'Click to play';
    this.btnLeave.textContent = room ? 'Leave Room' : 'Back to Menu';
    $('roomcode-wrap').hidden = !room;
    $('players-wrap').hidden = !room;
    this.netBox.hidden = !room;
    if (room) this.updateRoom(room, selfId);
    this.hud.hidden = !room;
    this._showOverlay();
  }

  updateRoom(room, selfId) {
    this._room = { room, selfId };
    const max = room.maxPlayers || 12;
    $('roomcode').textContent = room.code;
    $('playercount').textContent = `${room.players.length}/${max}`;
    $('hud-code').textContent = room.code;
    $('hud-count').textContent = `${room.players.length}/${max}`;

    const full = $('playerlist'), mini = $('hud-list');
    full.innerHTML = ''; mini.innerHTML = '';
    for (const p of room.players) {
      const color = PLAYER_COLORS[p.slot % PLAYER_COLORS.length];
      const li = document.createElement('li');
      const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = color;
      const nm = document.createElement('span'); nm.textContent = p.name + (p.id === selfId ? ' (you)' : '');
      if (p.id === selfId) nm.className = 'you';
      li.append(sw, nm);
      if (p.host) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = 'HOST'; li.append(t); }
      full.append(li);
      mini.append(li.cloneNode(true));
    }
    mini.querySelectorAll('.tag').forEach((t) => (t.textContent = '★'));
  }

  // ----- connection status -----
  setNet(status, text) {
    this.netOk = status === 'connected';
    const cls = status === 'connected' ? 'ok' : status === 'connecting' ? '' : 'bad';
    for (const dot of [this.netDot, $('hud-dot')]) dot.className = 'dot ' + cls;
    this.netText.textContent = text + (this.netOk && this.ping != null ? ` · ${this.ping} ms` : '');
    this._refreshButtons();
  }
  setPing(ms) {
    this.ping = ms;
    if (this.netOk) this.netText.textContent = `Connected · ${ms} ms`;
    $('hud-ping').textContent = ms + ' ms';
  }
  setMultiplayerUnavailable(text) {
    this.mpAvailable = false;
    this.netDot.className = 'dot bad';
    this.netText.textContent = text;
    this._refreshButtons();
  }

  setBusy(b) { this.busy = b; this._refreshButtons(); }
  _refreshButtons() {
    const can = this.netOk && this.mpAvailable && !this.busy;
    this.btnCreate.disabled = !can;
    this.btnJoin.disabled = !can || this.codeInput.value.length !== 5;
    this.btnSolo.disabled = this.busy;
  }
  setMenuMessage(text, kind = 'error') {
    this.menuMsg.hidden = !text;
    this.menuMsg.textContent = text || '';
    this.menuMsg.className = kind === 'info' ? 'info' : '';
  }

  async _copyCode() {
    const code = this._room?.room.code;
    if (!code) return;
    try { await navigator.clipboard.writeText(code); this.btnCopy.textContent = 'Copied!'; }
    catch (_) { this.btnCopy.textContent = code; }
    setTimeout(() => { this.btnCopy.textContent = 'Copy'; }, 1500);
  }

  toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = text;
    $('toasts').append(el);
    setTimeout(() => el.classList.add('fade'), 3200);
    setTimeout(() => el.remove(), 3700);
    while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
  }

  setReach(on) { this.crosshair.classList.toggle('reach', on); }
}
