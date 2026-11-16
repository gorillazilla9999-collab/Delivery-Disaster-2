// First-person "viewmodel" hands.
// The two hand spheres from person.glb are re-parented onto the camera (still the same
// separate Object3Ds, accessible as hands.left.object / hands.right.object) and animated here.
//
// Future grabbing hooks:
//   hands.setReaching(true/false)    both hands reach toward the crosshair target
//   hands.setGrip(side, 0..1)        squeeze a hand
//   hands.getHandWorldPosition(side, out)
//   hands.onImpact(side)             fired at the moment a poke "connects"
import * as THREE from 'three';
import { CONFIG } from './config.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;

class Hand {
  constructor(object, side, viewScale) {
    this.object = object;
    this.side = side;                         // +1 right, -1 left
    this.home = {                             // original transform inside the character model
      parent: object.parent,
      position: object.position.clone(),
      quaternion: object.quaternion.clone(),
      scale: object.scale.clone(),
    };
    this.viewScale = viewScale;
    const h = CONFIG.hands;
    this.rest = new THREE.Vector3(side * h.restX, h.restY, h.restZ);
    this.action = null;
    this.reach = 0;
    this.grip = 0;
    this.gripTarget = 0;
    this.air = 0;
  }
}

export class FirstPersonHands {
  constructor(camera, character) {
    this.root = new THREE.Group();
    this.root.name = 'ViewmodelHands';
    camera.add(this.root);

    const vs = character.scale * CONFIG.hands.viewScale;
    this.right = new Hand(character.parts.handR, +1, character.parts.handR.scale.x * vs);
    this.left = new Hand(character.parts.handL, -1, character.parts.handL.scale.x * vs);
    this.hands = [this.right, this.left];

    this.active = false;
    this.time = 0;
    this.reaching = false;
    this.lastReachDist = Infinity;
    this.lag = new THREE.Vector2();
    this.onImpact = null;
    this._o = new THREE.Vector3();
    this._t = new THREE.Vector3();
    this.attach();
  }

  get(side) { return side === 'left' ? this.left : this.right; }

  attach() {
    for (const h of this.hands) {
      this.root.add(h.object);
      h.object.position.copy(h.rest);
      h.object.quaternion.identity();
      h.object.scale.setScalar(h.viewScale);
      h.object.castShadow = false;
      h.object.frustumCulled = false;
    }
    this.active = true;
  }

  detach() {                                  // put the hands back on the body (third-person debug)
    for (const h of this.hands) {
      h.home.parent.add(h.object);
      h.object.position.copy(h.home.position);
      h.object.quaternion.copy(h.home.quaternion);
      h.object.scale.copy(h.home.scale);
      h.object.castShadow = true;
      h.object.frustumCulled = true;
    }
    this.active = false;
  }

  poke(side) {
    const h = this.get(side);
    if (!this.active || h.action) return false;
    const free = this.lastReachDist;
    const dist = isFinite(free) ? clamp(free - 0.1, 0.65, 1.5) : 1.2;
    h.action = { t: 0, dur: CONFIG.hands.pokeDuration, targetZ: -dist, hit: false };
    return true;
  }

  setReaching(on) {
    this.reaching = on;
    for (const h of this.hands) h.gripTarget = on ? 0.8 : 0;
  }
  setGrip(side, amount) { this.get(side).gripTarget = clamp(amount, 0, 1); }
  getHandWorldPosition(side, out) { return this.get(side).object.getWorldPosition(out); }

  // ctx: { move, run, phase, vy, grounded, dYaw, dPitch, reachDist }
  update(dt, ctx) {
    if (!this.active) return;
    const hc = CONFIG.hands;
    this.time += dt;
    this.lastReachDist = ctx.reachDist;

    // Hands trail behind camera rotation, then spring back.
    this.lag.x = clamp(this.lag.x + ctx.dYaw * hc.lagGain, -hc.lagMax, hc.lagMax);
    this.lag.y = clamp(this.lag.y - ctx.dPitch * hc.lagGain, -hc.lagMax, hc.lagMax);
    const decay = Math.exp(-9 * dt);
    this.lag.multiplyScalar(decay);

    // Pull hands back when a wall is right in front of the face.
    const retract = isFinite(ctx.reachDist) ? clamp((0.85 - ctx.reachDist) / 0.5, 0, 1) : 0;

    for (const h of this.hands) {
      const s = h.side;
      const o = this._o.copy(h.rest);

      // idle breathing
      const idle = this.time * 1.6 + (s > 0 ? 0 : 1.7);
      o.y += Math.sin(idle) * 0.006;
      o.x += Math.cos(idle * 0.7) * 0.004;

      // walking: opposite swing for each hand, bigger when running
      const ph = ctx.phase + (s > 0 ? 0 : Math.PI);
      const k = ctx.move * (1 + ctx.run * 0.7);
      o.z += Math.sin(ph) * 0.05 * k;
      o.y += (Math.sin(ph * 2) * 0.018 + Math.max(0, Math.cos(ph)) * 0.01) * k;
      o.x += Math.cos(ph) * 0.012 * k * s;

      // jumping/falling: hands lag behind vertical motion
      const airTarget = ctx.grounded ? 0 : clamp(-ctx.vy * 0.01, -0.07, 0.08);
      h.air += (airTarget - h.air) * (1 - Math.exp(-12 * dt));
      o.y += h.air;

      o.x += this.lag.x;
      o.y += this.lag.y;

      // wall retract
      o.y -= retract * 0.18;
      o.z += retract * 0.25;
      o.x += s * retract * 0.05;

      // poke animation
      let stretch = 0;
      const a = h.action;
      if (a) {
        a.t += dt;
        const p = a.t / a.dur;
        if (p >= 1) {
          h.action = null;
        } else {
          const peak = 0.35;
          stretch = p < peak ? easeOutCubic(p / peak) : 1 - easeInOutSine((p - peak) / (1 - peak));
          if (!a.hit && p >= peak) { a.hit = true; this.onImpact?.(h.side > 0 ? 'right' : 'left'); }
          o.z += (a.targetZ - h.rest.z) * stretch;
          o.y += 0.05 * stretch;
          o.x -= s * 0.07 * stretch;
        }
      }

      // sustained reach (future grab pose)
      h.reach += ((this.reaching ? 1 : 0) - h.reach) * (1 - Math.exp(-hc.reachRate * dt));
      if (h.reach > 0.001) {
        const d = isFinite(ctx.reachDist) ? clamp(ctx.reachDist - 0.1, 0.5, 1.3) : 0.9;
        this._t.set(s * 0.14, -0.06, -d);
        o.lerp(this._t, h.reach);
      }
      h.grip += (h.gripTarget - h.grip) * (1 - Math.exp(-16 * dt));

      h.object.position.copy(o);
      const sq = 1 - 0.06 * stretch - 0.12 * h.grip;
      h.object.scale.set(h.viewScale * sq, h.viewScale * sq, h.viewScale * (1 + 0.18 * stretch));
    }
  }
}
