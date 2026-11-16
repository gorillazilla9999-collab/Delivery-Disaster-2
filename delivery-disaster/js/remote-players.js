// Other players: complete 3D characters (your person.glb), smoothed with snapshot interpolation.
import * as THREE from 'three';
import { Character } from './character.js';
import { CONFIG, PLAYER_COLORS } from './config.js';
import { SnapshotBuffer, ClockSync } from './interp.js';

function makeLabel(name, color) {
  const w = 256, h = 64;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const r = 14;
  g.beginPath();
  g.moveTo(r, 4); g.arcTo(w - 4, 4, w - 4, h - 4, r); g.arcTo(w - 4, h - 4, 4, h - 4, r);
  g.arcTo(4, h - 4, 4, 4, r); g.arcTo(4, 4, w - 4, 4, r); g.closePath();
  g.fillStyle = 'rgba(0,0,0,0.6)'; g.fill();
  g.lineWidth = 5; g.strokeStyle = color; g.stroke();
  g.fillStyle = '#fff';
  g.font = 'bold 30px "Trebuchet MS", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(name, w / 2, h / 2 + 2, w - 24);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, fog: false }));
  sprite.scale.set(1.5, 0.375, 1);
  sprite.position.set(0, CONFIG.player.height + 0.4, 0);
  return sprite;
}

export class RemotePlayers {
  constructor(scene) {
    this.scene = scene;
    this.avatars = new Map();
    this.clock = new ClockSync();
  }

  _create(info) {
    const char = Character.createRemote();
    char.root.visible = false;               // hidden until the first snapshot arrives
    const label = makeLabel(info.name, PLAYER_COLORS[info.slot % PLAYER_COLORS.length]);
    char.root.add(label);
    this.scene.add(char.root);
    return {
      id: info.id, name: info.name, slot: info.slot, char, label,
      buf: new SnapshotBuffer(), phase: 0, moveAmt: 0,
    };
  }

  _dispose(a) {
    this.scene.remove(a.char.root);
    a.label.material.map.dispose();
    a.label.material.dispose();             // geometry/materials of the model itself are shared - not disposed
  }

  // Reconcile with the server's player list (adds new players, removes the ones who left).
  setPlayers(list, selfId) {
    const ids = new Set();
    for (const p of list) {
      if (p.id === selfId) continue;
      ids.add(p.id);
      if (!this.avatars.has(p.id)) this.avatars.set(p.id, this._create(p));
    }
    for (const [id, a] of this.avatars) {
      if (!ids.has(id)) { this._dispose(a); this.avatars.delete(id); }
    }
  }

  applySnapshot(players, selfId) {
    const now = Date.now();
    for (const [id, st] of Object.entries(players)) {
      if (id === selfId) continue;
      const a = this.avatars.get(id);
      if (!a) continue;                      // snapshot for someone we have not been told about yet
      a.buf.push(st);
      this.clock.update(st.ts, now);
    }
  }

  applyAction(id, side) {
    this.avatars.get(id)?.char.triggerPoke(side);
  }

  update(dt) {
    if (!this.avatars.size) return;
    const rt = this.clock.renderTime(Date.now(), CONFIG.network.interpDelayMs);
    if (rt === null) return;
    for (const a of this.avatars.values()) {
      const s = a.buf.sample(rt);
      if (!s) continue;
      const ch = a.char;
      ch.root.visible = true;
      ch.root.position.set(s.x, s.y, s.z);
      ch.setLook(s.byaw, s.yaw, s.pitch);

      const speed = Math.hypot(s.vx, s.vz);
      const grounded = !!s.g;
      const target = grounded ? Math.min(1, speed / CONFIG.player.runSpeed) : 0;
      a.moveAmt += (target - a.moveAmt) * (1 - Math.exp(-10 * dt));
      if (grounded) a.phase += speed * dt * CONFIG.camera.bobFrequency;
      ch.animateFeet(a.phase, a.moveAmt, !grounded, dt);
      ch.animateHands(a.phase, a.moveAmt, !!s.e, dt);
    }
  }

  clear() {
    for (const a of this.avatars.values()) this._dispose(a);
    this.avatars.clear();
    this.clock = new ClockSync();
  }
}
