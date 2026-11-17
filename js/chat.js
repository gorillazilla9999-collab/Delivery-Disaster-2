// In-room text chat. Enter (or T) opens the box while playing, Enter sends, Esc cancels.
// Messages come back from the server (validated + rate limited) and are drawn as plain text (never HTML).
const MAX_LINES = 60;       // kept in the log
const FADE_AFTER = 9000;    // ms a line stays visible when you are not typing

export class Chat {
  constructor({ net, input, toast }) {
    this.net = net; this.input = input; this.toast = toast;
    this.root = document.getElementById('chat');
    this.log = document.getElementById('chat-log');
    this.box = document.getElementById('chat-input');
    this.active = false;                       // only inside a room
    this.open = false;
    this.history = []; this.histIdx = -1;

    net.onChat = (m) => this.add(m);

    addEventListener('keydown', (e) => {
      if (this.open || !this.active || !input.locked || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Enter' || e.code === 'KeyT' || e.code === 'Slash') {
        e.preventDefault();
        this.show();
      }
    });
    this.box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); this.send(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.hide(); }
      else if (e.key === 'ArrowUp' && this.history.length) {
        e.preventDefault(); this.histIdx = Math.min(this.history.length - 1, this.histIdx + 1); this.box.value = this.history[this.history.length - 1 - this.histIdx];
      } else if (e.key === 'ArrowDown') {
        e.preventDefault(); this.histIdx = Math.max(-1, this.histIdx - 1); this.box.value = this.histIdx < 0 ? '' : this.history[this.history.length - 1 - this.histIdx];
      }
    });
    this.box.addEventListener('keyup', (e) => e.stopPropagation());
    // the mouse lock was released (Esc / menu): cancel typing so the menu is not left with a half-open chat
    document.addEventListener('pointerlockchange', () => { if (!input.locked && this.open) this.hide(); });
    setInterval(() => this._fade(), 1000);
  }

  setActive(on) {
    this.active = on;
    this.root.hidden = !on;
    if (!on) { this.hide(); this.log.textContent = ''; }
  }

  show() {
    this.open = true; this.input.typing = true; this.input.clearHeld();
    this.root.classList.add('typing');
    this.box.hidden = false; this.box.value = ''; this.histIdx = -1;
    this.box.focus();
    this._fade();
  }

  hide() {
    this.open = false; this.input.typing = false; this.input.clearHeld();
    this.root.classList.remove('typing');
    this.box.hidden = true; this.box.blur();
    this._fade();
  }

  async send() {
    const text = this.box.value.trim();
    this.hide();
    if (!text) return;
    if (this.history[this.history.length - 1] !== text) this.history.push(text);
    if (this.history.length > 30) this.history.shift();
    const res = await this.net.sendChat(text);
    if (!res.ok && res.message) this.toast(res.message, 'error');
  }

  add(m) {
    const li = document.createElement('li');
    li.dataset.at = String(Date.now());
    const name = document.createElement('b');
    name.textContent = m.name || '???';
    if (m.id === this.net.myId) name.className = 'me';
    if (m.admin) { const t = document.createElement('i'); t.textContent = 'ADMIN'; li.appendChild(t); }
    else if (m.host) { const t = document.createElement('i'); t.className = 'host'; t.textContent = '★'; li.appendChild(t); }
    const msg = document.createElement('span');
    msg.textContent = ' ' + m.text;                         // textContent: never interpreted as HTML
    li.append(name, msg);
    this.log.appendChild(li);
    while (this.log.children.length > MAX_LINES) this.log.firstChild.remove();
    this.log.scrollTop = this.log.scrollHeight;
    this._fade();
  }

  _fade() {
    const now = Date.now();
    for (const li of this.log.children) li.classList.toggle('old', !this.open && now - Number(li.dataset.at) > FADE_AFTER);
  }
}
