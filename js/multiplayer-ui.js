// DOM for the multiplayer menu, in-game room HUD and join/leave toasts. No networking in here.
export class MultiplayerUI {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.$ = $;
    this.statusEl = $('mp-status'); this.pingEl = $('mp-ping');
    this.lobby = $('mp-lobby'); this.roomBox = $('mp-room');
    this.nameIn = $('mp-name'); this.codeIn = $('mp-code');
    this.createBtn = $('mp-create'); this.joinBtn = $('mp-join'); this.leaveBtn = $('mp-leave'); this.copyBtn = $('mp-copy');
    this.msg = $('mp-msg');
    this.hud = $('roomhud');
    this.connected = false;
    this.busy = false;
    this.onCreate = null; this.onJoin = null; this.onLeave = null;
    // host / admin callbacks (set by main)
    this.onSetLock = null; this.onSetCode = null; this.onKick = null;
    this.onAdminLogin = null; this.onAdminLogout = null; this.onAdminRefresh = null;
    this.onAdminJoin = null; this.onAdminKick = null; this.onAdminLock = null; this.onAdminNewCode = null;
    this.isAdmin = false; this.inRoom = false; this.lastRoster = null; this.adminRooms = [];

    try { this.nameIn.value = localStorage.getItem('dd_name') || ''; } catch (_) {}
    const q = new URLSearchParams(location.search).get('room');
    if (q) this.codeIn.value = q.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);

    this.nameIn.addEventListener('input', () => { try { localStorage.setItem('dd_name', this.nameIn.value); } catch (_) {} });
    this.codeIn.addEventListener('input', () => {
      this.codeIn.value = this.codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      this.refresh();
    });
    this.codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.joinBtn.click(); e.stopPropagation(); });
    this.nameIn.addEventListener('keydown', (e) => e.stopPropagation());

    this.createBtn.addEventListener('click', () => this._run(() => this.onCreate?.(this.name)));
    this.joinBtn.addEventListener('click', () => this._run(() => this.onJoin?.(this.codeIn.value, this.name)));
    this.leaveBtn.addEventListener('click', () => this._run(() => this.onLeave?.()));
    // host controls
    this.newCodeIn = $('mp-newcode');
    this.newCodeIn.addEventListener('input', () => { this.newCodeIn.value = this.newCodeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    this.newCodeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('mp-setcode').click(); e.stopPropagation(); });
    $('mp-lock').addEventListener('click', () => this._run(() => this.onSetLock?.(!this.locked)));
    $('mp-setcode').addEventListener('click', () => this._run(async () => { const ok = await this.onSetCode?.(this.newCodeIn.value); if (ok) this.newCodeIn.value = ''; }));
    $('mp-randcode').addEventListener('click', () => this._run(() => this.onSetCode?.('')));
    // admin
    this.adminCodeIn = $('mp-admincode');
    this.adminCodeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('mp-adminlogin').click(); e.stopPropagation(); });
    $('mp-adminlogin').addEventListener('click', () => this._run(async () => { const ok = await this.onAdminLogin?.(this.adminCodeIn.value); if (ok) this.adminCodeIn.value = ''; }));
    $('mp-adminlogout').addEventListener('click', () => this.onAdminLogout?.());
    $('mp-adminrefresh').addEventListener('click', () => this.onAdminRefresh?.());
    this.adminBox = $('mp-admin');
    setInterval(() => { if (this.isAdmin && this.adminBox.open && this.connected && !document.hidden) this.onAdminRefresh?.(); }, 3000);
    this.adminBox.addEventListener('toggle', () => { if (this.adminBox.open && this.isAdmin) this.onAdminRefresh?.(); });

    this.copyBtn.addEventListener('click', async () => {
      const code = this.$('mp-roomcode').textContent;
      const link = `${location.origin}${location.pathname}?room=${code}`;
      try { await navigator.clipboard.writeText(link); this.copyBtn.textContent = 'Copied!'; }
      catch (_) { this.copyBtn.textContent = code; }
      setTimeout(() => (this.copyBtn.textContent = 'Copy'), 1500);
    });
  }

  get name() { return this.nameIn.value.trim(); }

  async _run(fn) {
    if (this.busy) return;
    this.busy = true; this.refresh();
    try { await fn(); } finally { this.busy = false; this.refresh(); }
  }

  refresh() {
    const ok = this.connected && !this.busy;
    this.createBtn.disabled = !ok;
    this.joinBtn.disabled = !ok || this.codeIn.value.length !== 5;
    this.leaveBtn.disabled = this.busy;
  }

  setStatus(state, text) {
    this.statusEl.dataset.state = state;
    this.statusEl.querySelector('span').textContent = text;
    this.connected = state === 'connected';
    if (!this.connected) this.pingEl.textContent = '';
    this.refresh();
  }
  setPing(ms) { this.pingEl.textContent = ms == null ? '' : ms + ' ms'; }

  showMessage(text, kind = 'error') {
    this.msg.textContent = text; this.msg.className = kind === 'info' ? 'info' : ''; this.msg.hidden = !text;
  }

  setAdmin(on) {
    this.isAdmin = !!on;
    this.$('mp-admin-login').hidden = this.isAdmin; this.$('mp-admin-panel').hidden = !this.isAdmin;
    this.adminBox.classList.toggle('on', this.isAdmin);
    if (!this.isAdmin) { this.adminRooms = []; this.$('mp-admin-rooms').textContent = ''; }
    if (this.lastRoster) this.setRoster(...this.lastRoster);
    this._host();
    this.refresh();
  }

  // host controls are shown to the host and to admins
  _host() {
    const show = this.inRoom && (this.isHost || this.isAdmin);
    this.$('mp-host').hidden = !show;
    this.$('mp-lock').textContent = this.locked ? 'Unlock room (let anyone join)' : 'Lock room (admin only)';
    this.$('rh-code').textContent = (this.currentCode || '-----') + (this.locked ? ' \u{1F512}' : '');
  }

  renderAdminRooms(list) {
    this.adminRooms = list;
    const box = this.$('mp-admin-rooms'); box.textContent = '';
    if (!list.length) { const d = document.createElement('div'); d.className = 'ar-empty'; d.textContent = 'No rooms yet.'; box.appendChild(d); return; }
    const mini = (label, fn, cls = '') => { const b = document.createElement('button'); b.type = 'button'; b.className = 'mp-mini ' + cls; b.textContent = label; b.addEventListener('click', fn); return b; };
    for (const r of list) {
      const el = document.createElement('div'); el.className = 'ar-room';
      const head = document.createElement('div'); head.className = 'ar-head';
      const code = document.createElement('b'); code.textContent = r.code;
      const meta = document.createElement('small'); meta.textContent = `${r.players.length}/${r.max}${r.locked ? ' \u{1F512}' : ''}`;
      head.append(code, meta);
      const inThis = this.inRoom && this.currentCode === r.code;
      if (!inThis) head.appendChild(mini('Join', () => this.onAdminJoin?.(r.code)));
      head.appendChild(mini(r.locked ? 'Unlock' : 'Lock', () => this.onAdminLock?.(r.code, !r.locked)));
      head.appendChild(mini('New code', () => this.onAdminNewCode?.(r.code)));
      const ul = document.createElement('ul'); ul.className = 'ar-players';
      for (const p of r.players) {
        const li = document.createElement('li');
        const n = document.createElement('span'); n.textContent = p.name;
        li.appendChild(n);
        if (p.id === r.hostId) { const h = document.createElement('em'); h.textContent = 'host'; li.appendChild(h); }
        if (p.id !== this.myId) li.appendChild(mini('Kick', () => this.onAdminKick?.(p.id, p.name), 'mp-kick'));
        ul.appendChild(li);
      }
      el.append(head, ul); box.appendChild(el);
    }
  }

  setRoom(room) {
    const inRoom = !!room;
    this.inRoom = inRoom;
    this.currentCode = room ? room.code : null;
    this.locked = !!(room && room.locked);
    this.lobby.hidden = inRoom; this.roomBox.hidden = !inRoom; this.hud.hidden = !inRoom;
    if (room) {
      this.$('mp-roomcode').textContent = room.code; this.$('rh-code').textContent = room.code;
      this.$('mp-max').textContent = room.max; this.showMessage('');
    }
    this._host();
    this.refresh();
  }

  setRoster(players, myId, max, hostId, locked) {
    this.lastRoster = [players, myId, max, hostId, locked];
    this.myId = myId; this.isHost = hostId === myId;
    if (locked !== undefined) { this.locked = !!locked; }
    this._host();
    for (const [listId, hud] of [['mp-players', false], ['rh-players', true]]) {
      const ul = this.$(listId); ul.textContent = '';
      for (const p of players) {
        const li = document.createElement('li');
        li.textContent = p.name;
        if (p.id === myId) { li.className = 'you'; const s = document.createElement('small'); s.textContent = ' (you)'; li.appendChild(s); }
        if (p.id === hostId) { const s = document.createElement('small'); s.textContent = ' \u2605host'; li.appendChild(s); }
        if (!hud && this.isAdmin && p.id !== myId) {
          const b = document.createElement('button'); b.type = 'button'; b.className = 'mp-mini mp-kick'; b.textContent = 'Kick';
          b.addEventListener('click', () => this.onKick?.(p.id, p.name)); li.appendChild(b);
        }
        ul.appendChild(li);
      }
    }
    this.$('mp-count').textContent = players.length;
    if (max) this.$('mp-max').textContent = max;
  }

  toast(text, kind = 'info') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind; el.textContent = text;
    const box = this.$('toasts'); box.appendChild(el);
    while (box.children.length > 5) box.firstChild.remove();
    setTimeout(() => el.classList.add('out'), 3600);
    setTimeout(() => el.remove(), 4100);
  }
}
