// Punching + knockouts.
// The puncher aims at the (interpolated) remote player they see, and tells the server. The server checks range,
// cooldowns and health, then broadcasts a `hit` to the whole room: the victim is shoved back, 3 hits knock them out
// for a few seconds (they lie on the ground), and everybody sees the POW.
import * as THREE from 'three';
import { CONFIG } from './config.js';

// Ray vs vertical box (slab method). Returns distance or null.
function rayBox(o, d, min, max) {
  let tmin = -Infinity, tmax = Infinity;
  for (const ax of ['x', 'y', 'z']) {
    const dir = Math.abs(d[ax]) < 1e-9 ? 1e-9 : d[ax];
    const inv = 1 / dir;
    let t1 = (min[ax] - o[ax]) * inv, t2 = (max[ax] - o[ax]) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  return Math.max(tmin, 0);
}

function wordSprite(text, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.font = '900 78px "Trebuchet MS", "Segoe UI", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineJoin = 'round'; g.lineWidth = 16; g.strokeStyle = '#1b1b1b';
  g.strokeText(text, 128, 66); g.fillStyle = color; g.fillText(text, 128, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  sp.renderOrder = 10;
  return sp;
}

export class Combat {
  constructor({ scene, player, net, remotes, physics, toast, onHurt }) {
    this.scene = scene; this.player = player; this.net = net; this.remotes = remotes; this.physics = physics;
    this.toast = toast || (() => {});
    this.onHurt = onHurt || (() => {});
    this.hp = 100; this.ko = false; this.koUntil = 0; this.active = false;
    this.effects = [];
    this._o = new THREE.Vector3();

    const $ = (id) => document.getElementById(id);
    this.hud = $('hp'); this.hpFill = $('hp-fill');
    this.flash = $('hitflash'); this.koScreen = $('koscreen'); this.koCount = $('ko-count');
    this.crosshair = $('crosshair');
    this._flashT = 0; this._hitmarkT = 0;
  }

  get knockedOut() { return this.ko; }

  setActive(on) {
    this.active = on;
    this.hud.hidden = !on;
    if (!on) this.reset();
  }

  reset() {
    this.hp = 100;
    if (this.ko) this._wake();
    this._setHp();
  }

  // Called at the moment one of our punches connects (hands.onImpact). Returns true if it hit a player.
  tryPunch() {
    if (!this.active || this.ko || !this.net.inRoom) return false;
    const eye = this.player.eyePos, dir = this.player.aimDir, C = CONFIG.combat;
    let best = null;
    const hw = C.hitboxHalf;
    for (const rp of this.remotes.players.values()) {
      if (!rp.hasState || rp.isKO) continue;
      const min = { x: rp.pos.x - hw, y: rp.pos.y, z: rp.pos.z - hw };
      const max = { x: rp.pos.x + hw, y: rp.pos.y + CONFIG.player.height + 0.1, z: rp.pos.z + hw };
      const t = rayBox(eye, dir, min, max);
      if (t !== null && t <= C.reach && (!best || t < best.t)) best = { id: rp.id, t };
    }
    if (!best) return false;
    const wall = this.physics.raycast(eye, dir, best.t, this.player.body);     // a crate or wall in the way blocks the punch
    if (wall && wall.dist < best.t - 0.05) return false;
    this.net.sendPunch(best.id);
    return true;
  }

  // Server says somebody got hit (we get this for every hit in the room, including our own punches).
  onHit(h) {
    const myId = this.net.myId;
    if (h.to === myId) {
      this.hp = h.hp; this._setHp();
      this._flashT = 0.35;
      this.onHurt();
      this.player.knock(h.d[0], h.d[1], CONFIG.combat.knockback, CONFIG.combat.knockLift);
      this._popAt(this.player.eyePos, h.ko ? 'KO!' : 'OW!', h.ko ? '#ff5a4a' : '#ffd23f', true);
      if (h.ko) this._sleep(h.koMs || 5000);
    } else {
      const rp = this.remotes.players.get(h.to);
      if (rp) {
        this._popAt(this._o.set(rp.pos.x, rp.pos.y + 1.7, rp.pos.z), h.ko ? 'KO!' : 'POW!', h.ko ? '#ff5a4a' : '#ffd23f', false);
        if (h.ko) rp.knockOut(h.koMs || 5000);
      }
    }
    if (h.from === myId) this._hitmarkT = 0.18;
    if (h.ko) {
      const text = h.to === myId ? `You were knocked out by ${h.fromName}!`
        : h.from === myId ? `You knocked out ${h.toName}!` : `${h.toName} was knocked out by ${h.fromName}`;
      this.toast(text, h.to === myId ? 'error' : 'info');
    }
  }

  _sleep(ms) {
    this.ko = true; this.koUntil = performance.now() + ms;
    this.player.setKnockedOut(true);
    this.koScreen.hidden = false;
  }
  _wake() {
    this.ko = false;
    this.player.setKnockedOut(false);
    this.koScreen.hidden = true;
    this.hp = 100; this._setHp();
  }
  _setHp() { this.hpFill.style.width = Math.max(0, Math.min(100, this.hp)) + '%'; this.hpFill.dataset.low = this.hp <= 34 ? '1' : '0'; }

  _popAt(pos, text, color, local) {
    const sp = wordSprite(text, color);
    sp.position.copy(pos);
    if (local) sp.position.addScaledVector(this.player.aimDir, 1.2);       // in front of our own face
    sp.scale.set(0.01, 0.005, 1);
    this.scene.add(sp);
    this.effects.push({ sp, t: 0, base: local ? 0.7 : 1.3 });
  }

  update(dt) {
    if (this.ko) {
      const left = this.koUntil - performance.now();
      if (left <= 0) this._wake();
      else this.koCount.textContent = String(Math.ceil(left / 1000));
    }
    this._flashT = Math.max(0, this._flashT - dt);
    this.flash.style.opacity = String(Math.min(0.55, this._flashT * 1.6));
    this._hitmarkT = Math.max(0, this._hitmarkT - dt);
    this.crosshair.classList.toggle('hitmark', this._hitmarkT > 0);

    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.t += dt;
      const k = e.t / 0.7;
      if (k >= 1) {
        this.scene.remove(e.sp); e.sp.material.map.dispose(); e.sp.material.dispose();
        this.effects.splice(i, 1); continue;
      }
      const pop = k < 0.2 ? k / 0.2 : 1;
      const s = e.base * (0.4 + 0.6 * pop);
      e.sp.scale.set(s, s / 2, 1);
      e.sp.position.y += dt * 0.6;
      e.sp.material.opacity = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
    }
  }
}
