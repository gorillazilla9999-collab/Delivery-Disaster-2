// Remote players: full 3D copies of person.glb (head, torso, floating hands, floating feet),
// driven by buffered + interpolated network snapshots.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Character } from './character.js';
import { BodyYaw, wrapAngle } from './bodyyaw.js';

const P = CONFIG.player;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;

export const INTERP_DELAY = 0.12;     // seconds: remote players are shown this far in the past
const MAX_EXTRAPOLATE = 0.15;         // seconds of dead-reckoning if snapshots stop arriving
const TELEPORT_DIST = 25;             // bigger jumps (respawn etc.) snap instead of gliding

function makeNameTag(text) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.font = 'bold 56px "Trebuchet MS", "Segoe UI", sans-serif';
  const w = Math.min(480, g.measureText(text).width + 56);
  g.fillStyle = '#fff6dc'; g.strokeStyle = '#1b1b1b'; g.lineWidth = 8;
  const x = (512 - w) / 2, y = 22, h = 84, r = 22;
  g.beginPath(); g.roundRect(x, y, w, h, r); g.fill(); g.stroke();
  g.fillStyle = '#1b1b1b'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 256, 66, 440);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.3, 0.325, 1);
  sprite.renderOrder = 5;
  return sprite;
}

export class RemotePlayer {
  constructor(id, name, scene) {
    this.id = id; this.name = name;
    this.scene = scene;
    this.character = Character.createRemote();
    this.root = this.character.root;
    this.root.visible = false;                         // until the first snapshot arrives
    scene.add(this.root);

    this.tag = makeNameTag(name);
    this.tag.position.y = P.height + 0.45;
    this.root.add(this.tag);

    this.buf = [];                                     // { t, x,y,z, yaw, pitch, speed, vy, flags }
    this.pos = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0; this.speed = 0; this.vy = 0;
    this.grounded = true; this.reaching = false;
    this.bodyYaw = new BodyYaw(0);
    this.moveAmt = 0; this.runAmt = 0; this.phase = 0; this.time = Math.random() * 10;
    this.air = 0; this.reach = 0;
    this.actions = { left: null, right: null };
    this.hasState = false;
  }

  pushSnapshot(t, s) {
    const n = { t, x: s[0], y: s[1], z: s[2], yaw: s[3], pitch: s[4], speed: s[5], vy: s[6], flags: s[7] };
    const b = this.buf;
    if (b.length && n.t <= b[b.length - 1].t) return;
    b.push(n);
    if (b.length > 40) b.shift();
  }

  poke(side) {
    if (!this.actions[side]) this.actions[side] = { t: 0, dur: CONFIG.hands.pokeDuration };
  }

  // Sample the buffer at (server) time rt.
  _sample(rt) {
    const b = this.buf;
    if (!b.length) return null;
    if (rt <= b[0].t) return b[0];
    const last = b[b.length - 1];
    if (rt >= last.t) {
      const dtp = Math.min(rt - last.t, MAX_EXTRAPOLATE);
      if (b.length > 1 && dtp > 0 && last.speed > 0.3) {
        const prev = b[b.length - 2];
        const span = last.t - prev.t;
        if (span > 0.001 && span < 0.5) {
          const k = dtp / span;
          return { ...last, x: last.x + (last.x - prev.x) * k, z: last.z + (last.z - prev.z) * k };
        }
      }
      return last;
    }
    let i = b.length - 2;
    while (i > 0 && b[i].t > rt) i--;
    const a = b[i], c = b[i + 1];
    const f = clamp((rt - a.t) / (c.t - a.t || 1), 0, 1);
    return {
      x: a.x + (c.x - a.x) * f, y: a.y + (c.y - a.y) * f, z: a.z + (c.z - a.z) * f,
      yaw: a.yaw + wrapAngle(c.yaw - a.yaw) * f,
      pitch: a.pitch + (c.pitch - a.pitch) * f,
      speed: a.speed + (c.speed - a.speed) * f,
      vy: a.vy + (c.vy - a.vy) * f,
      flags: f < 0.5 ? a.flags : c.flags,
    };
  }

  // rt: render time in server-clock seconds.  dt: frame delta (seconds).
  update(rt, dt) {
    const s = this._sample(rt);
    if (!s) return;
    if (!this.hasState) {
      this.hasState = true;
      this.pos.set(s.x, s.y, s.z);
      this.yaw = s.yaw;
      this.bodyYaw.snap(s.yaw);
      this.root.visible = true;
    }
    const target = new THREE.Vector3(s.x, s.y, s.z);
    if (target.distanceTo(this.pos) > TELEPORT_DIST) this.pos.copy(target);
    else this.pos.lerp(target, 1 - Math.exp(-30 * dt));          // light smoothing on top of the buffer
    this.yaw = s.yaw; this.pitch = s.pitch; this.speed = s.speed; this.vy = s.vy;
    this.grounded = !!(s.flags & 1);
    this.reaching = !!(s.flags & 2);

    const ch = this.character, root = this.root;
    root.position.copy(this.pos);
    root.rotation.y = this.bodyYaw.update(this.yaw, this.speed, dt);   // body turns independently of the camera

    // same animation maths as the local player
    const moveTarget = this.grounded ? Math.min(1, this.speed / P.runSpeed) : 0;
    this.moveAmt += (moveTarget - this.moveAmt) * (1 - Math.exp(-10 * dt));
    this.runAmt = clamp((this.speed - P.walkSpeed) / (P.runSpeed - P.walkSpeed), 0, 1);
    if (this.grounded) this.phase += this.speed * dt * CONFIG.camera.bobFrequency;
    ch.animateFeet(this.phase, this.moveAmt, !this.grounded, dt);
    this._animateHands(dt);
  }

  _animateHands(dt) {
    const ch = this.character;
    const k = 1 / ch.scale;                       // metres -> model units; model forward = +X, up = +Y
    this.time += dt;
    this.air += ((this.grounded ? 0 : 1) - this.air) * (1 - Math.exp(-12 * dt));
    this.reach += ((this.reaching ? 1 : 0) - this.reach) * (1 - Math.exp(-12 * dt));
    const sp = Math.sin(this.pitch);
    const move = this.moveAmt * (1 + this.runAmt * 0.7);

    [ch.parts.handR, ch.parts.handL].forEach((hand, i) => {
      const side = i === 0 ? 'right' : 'left';
      const rest = ch._handRest[i];
      const ph = this.phase + (i === 0 ? Math.PI : 0);         // arms swing opposite to the legs
      let fwd = Math.sin(ph) * 0.14 * move;
      let up = (Math.sin(ph * 2) * 0.02) * move + Math.sin(this.time * 1.6 + i * 1.7) * 0.008;
      up += this.air * (this.vy > 0 ? 0.14 : 0.08);

      const a = this.actions[side];
      if (a) {
        a.t += dt;
        const p = a.t / a.dur;
        if (p >= 1) this.actions[side] = null;
        else {
          const peak = 0.35;
          const st = p < peak ? easeOutCubic(p / peak) : 1 - easeInOutSine((p - peak) / (1 - peak));
          fwd += 0.6 * st; up += 0.6 * st * sp;
        }
      }
      if (this.reach > 0.001) { fwd += 0.42 * this.reach; up += (0.42 * sp + 0.12) * this.reach; }

      hand.position.set(rest.x + fwd * k, rest.y + up * k, rest.z);
    });
  }

  dispose() {
    this.scene.remove(this.root);
    this.tag.material.map.dispose();
    this.tag.material.dispose();
    // geometry/materials are shared with the template, so they are NOT disposed here.
  }
}

export class RemotePlayers {
  constructor(scene) {
    this.scene = scene;
    this.players = new Map();
  }
  has(id) { return this.players.has(id); }
  add(id, name) {
    if (this.players.has(id)) return this.players.get(id);
    const p = new RemotePlayer(id, name, this.scene);
    this.players.set(id, p);
    return p;
  }
  remove(id) {
    const p = this.players.get(id);
    if (!p) return;
    p.dispose();
    this.players.delete(id);
  }
  clear() { for (const id of [...this.players.keys()]) this.remove(id); }
  update(rt, dt) { for (const p of this.players.values()) p.update(rt, dt); }
}
