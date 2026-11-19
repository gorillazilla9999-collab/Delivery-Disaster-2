// Vehicle HUD: speed (km/h), gear (R / N / D), handbrake light and the car's name, plus the "Press H" prompt.
// The markup lives in index.html (#vhud, #vprompt) and the look in css/style.css, in the same style as the rest of the game.
export class VehicleHUD {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.root = $('vhud'); this.name = $('vh-name'); this.kmh = $('vh-kmh'); this.gears = { R: $('vh-gR'), N: $('vh-gN'), D: $('vh-gD') };
    this.hb = $('vh-hb'); this.flip = $('vh-flip'); this.prompt = $('vprompt'); this.bar = $('vh-bar');
    this._last = {};
  }
  show(on) { if (this.root) this.root.hidden = !on; document.body.classList.toggle('driving', !!on); }
  setPrompt(text) {
    if (!this.prompt) return;
    if (text) { if (this._last.prompt !== text) this.prompt.innerHTML = text; this.prompt.hidden = false; } else this.prompt.hidden = true;
    this._last.prompt = text;
  }
  // v: { name, speedMs, gear, handbrake, flipped, maxSpeed }
  update(v) {
    if (!this.root) return;
    const kmh = Math.round(v.speedMs * 3.6);
    if (this._last.kmh !== kmh) { this.kmh.textContent = String(kmh); this._last.kmh = kmh; }
    if (this._last.gear !== v.gear) { for (const g of ['R', 'N', 'D']) this.gears[g].classList.toggle('on', g === v.gear); this._last.gear = v.gear; }
    if (this._last.hb !== v.handbrake) { this.hb.classList.toggle('on', v.handbrake); this._last.hb = v.handbrake; }
    if (this._last.name !== v.name) { this.name.textContent = v.name; this._last.name = v.name; }
    if (this._last.flipped !== v.flipped) { this.flip.hidden = !v.flipped; this._last.flipped = v.flipped; }
    const f = Math.min(1, v.speedMs / v.maxSpeed); const w = Math.round(f * 100);
    if (this._last.bar !== w) { this.bar.style.width = w + '%'; this._last.bar = w; }
  }
}
