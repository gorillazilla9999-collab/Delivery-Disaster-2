// Keyboard / mouse / pointer-lock handling. Input is ignored unless the pointer is locked.
const BLOCKED_KEYS = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.locked = false;
    this.lookX = 0;
    this.lookY = 0;
    this.onLockChange = null;
    this.onLockError = null;
    this._down = new Set();
    this._pressed = new Set();
    this.typing = false;           // true while the chat box has the keyboard: the game ignores keys and mouse

    addEventListener('keydown', (e) => {
      if (this.typing) return;
      if (this.locked && BLOCKED_KEYS.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this._down.add(e.code);
      this._pressed.add(e.code);
    });
    addEventListener('keyup', (e) => this._down.delete(e.code));
    addEventListener('blur', () => this._down.clear());

    addEventListener('mousedown', (e) => {
      if (!this.locked || this.typing) return;
      this._down.add('Mouse' + e.button);
      this._pressed.add('Mouse' + e.button);
    });
    addEventListener('mouseup', (e) => this._down.delete('Mouse' + e.button));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    addEventListener('mousemove', (e) => {
      if (!this.locked || this.typing) return;
      // Some browsers emit huge bogus deltas when the lock engages; drop them.
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.lookX += e.movementX;
      this.lookY += e.movementY;
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) { this._down.clear(); this.lookX = this.lookY = 0; }
      this.onLockChange?.(this.locked);
    });
    document.addEventListener('pointerlockerror', () => this.onLockError?.());
  }

  lock() {
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true }); // raw mouse where supported
      if (p && p.catch) p.catch(() => { try { this.canvas.requestPointerLock(); } catch (_) {} });
    } catch (_) {
      try { this.canvas.requestPointerLock(); } catch (_) {}
    }
  }

  clearHeld() { this._down.clear(); this._pressed.clear(); this.lookX = this.lookY = 0; }

  down(code) { return this.locked && this._down.has(code); }
  pressed(code) { return this.locked && this._pressed.has(code); }

  consumeLook() {
    const r = { x: this.lookX, y: this.lookY };
    this.lookX = this.lookY = 0;
    return r;
  }
  endFrame() { this._pressed.clear(); }
}
