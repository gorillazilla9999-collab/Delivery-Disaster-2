// Overlay / crosshair / settings. No game logic in here.
export class UI {
  constructor() {
    this.$ = (id) => document.getElementById(id);
    this.overlay = this.$('overlay');
    this.status = this.$('status');
    this.fill = this.$('loadfill');
    this.bar = this.$('loadbar');
    this.play = this.$('play');
    this.error = this.$('error');
    this.crosshair = this.$('crosshair');
    this.sens = this.$('sens');
    this.sensVal = this.$('sensval');
    this.ready = false;

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
    this.$('panel').addEventListener('click', (e) => e.stopPropagation());
    document.body.classList.add('menu-open');
  }

  onRequestPlay(fn) {
    this.overlay.addEventListener('click', () => { if (this.ready) fn(); });
    this.play.addEventListener('click', (e) => { e.stopPropagation(); if (this.ready) fn(); });
  }
  setLoading(frac) { this.fill.style.width = Math.round(Math.min(1, frac) * 100) + '%'; }
  showReady() {
    this.ready = true;
    this.bar.hidden = true;
    this.play.hidden = false;
    this.play.textContent = 'Click to play';
    this.status.textContent = 'Your character is ready.';
    this.overlay.classList.remove('hidden');
    document.body.classList.add('menu-open');
  }
  showPaused() {
    this.status.textContent = 'Paused';
    this.play.textContent = 'Click to resume';
    this.overlay.classList.remove('hidden');
    document.body.classList.add('menu-open');
  }
  hide() { this.overlay.classList.add('hidden'); document.body.classList.remove('menu-open'); }
  showError(html) {
    this.status.textContent = 'Something went wrong';
    this.bar.hidden = true;
    this.error.hidden = false;
    this.error.innerHTML = html;
  }
  setReach(on) { this.crosshair.classList.toggle('reach', on); }
}
