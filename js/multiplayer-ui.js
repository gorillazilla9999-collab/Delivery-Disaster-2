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

  setRoom(room) {
    const inRoom = !!room;
    this.lobby.hidden = inRoom; this.roomBox.hidden = !inRoom; this.hud.hidden = !inRoom;
    if (room) {
      this.$('mp-roomcode').textContent = room.code; this.$('rh-code').textContent = room.code;
      this.$('mp-max').textContent = room.max; this.showMessage('');
    }
    this.refresh();
  }

  setRoster(players, myId, max) {
    for (const [listId, hud] of [['mp-players', false], ['rh-players', true]]) {
      const ul = this.$(listId); ul.textContent = '';
      for (const p of players) {
        const li = document.createElement('li');
        li.textContent = p.name;
        if (p.id === myId) { li.className = 'you'; const s = document.createElement('small'); s.textContent = ' (you)'; li.appendChild(s); }
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
