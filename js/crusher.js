// A hydraulic press. The platen's height is a pure function of (synced) time, so every player sees it at the same
// place without any network traffic. Physically the platen is a kinematic body: it carries its real velocity, so it
// shoves whatever it touches. Anything still under it when it bottoms out gets crushed flat; the player gets flung out.
import * as THREE from 'three';
import { Body } from './physics.js';
import { CONFIG } from './config.js';

const C = CONFIG.crusher;

// platen bottom height as a function of the cycle time (seconds)
export function platenHeight(t) {
  const u = ((t % C.cycle) + C.cycle) % C.cycle;
  const { top, bottom, waitTop, slam, hold } = C;
  if (u < waitTop) return top;                                     // idle, siren on at the end
  if (u < waitTop + slam) { const k = (u - waitTop) / slam; return top + (bottom - top) * k * k; }   // gravity-like slam
  if (u < waitTop + slam + hold) return bottom;
  const k = (u - waitTop - slam - hold) / (C.cycle - waitTop - slam - hold);                       // slow hydraulic rise
  const e = k * k * (3 - 2 * k);
  return bottom + (top - bottom) * e;
}
// true from just before the slam until the platen starts to rise again: nobody should be under it
export const isDanger = (t) => { const u = ((t % C.cycle) + C.cycle) % C.cycle; return u > C.waitTop - 0.25 && u < C.waitTop + C.slam + C.hold + 0.3; };
const warning = (t) => { const u = ((t % C.cycle) + C.cycle) % C.cycle; return u > C.waitTop - C.warn && u < C.waitTop + C.slam + C.hold; };

function hazardTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#f2c230'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#1b1b1b';
  for (let i = -128; i < 256; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 16, 0); g.lineTo(i + 16 - 128, 128); g.lineTo(i - 128, 128); g.fill(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Crusher {
  constructor({ scene, physics, x, z }) {
    this.x = x; this.z = z;
    const half = C.size / 2;
    this.half = half;
    const steel = new THREE.MeshStandardMaterial({ color: 0x5b6169, roughness: 0.45, metalness: 0.7 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.6, metalness: 0.6 });
    const stripe = hazardTexture(); stripe.repeat.set(2, 0.5);
    const hazard = new THREE.MeshStandardMaterial({ map: stripe, roughness: 0.7 });
    const add = (geo, mat, px, py, pz) => { const m = new THREE.Mesh(geo, mat); m.position.set(px, py, pz); m.castShadow = m.receiveShadow = true; scene.add(m); return m; };
    const solid = (sx, sy, sz, px, pz, mat) => {            // a static block with collision, bottom on the ground
      physics.add(new Body({ size: [sx, sy, sz], position: [px, 0, pz], name: 'crusher frame', ...CONFIG.materials.wall }));
      add(new THREE.BoxGeometry(sx, sy, sz), mat, px, sy / 2, pz);
    };

    // floor plate (visual) + frame: four posts and a head beam
    const plate = add(new THREE.BoxGeometry(C.size + 1.2, 0.04, C.size + 1.2), hazard, x, 0.02, z);
    plate.castShadow = false;
    const off = half + 0.55;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) solid(0.5, C.headY, 0.5, x + sx * off, z + sz * off, dark);
    this.beamY = C.headY;
    add(new THREE.BoxGeometry(C.size + 1.6, 0.7, C.size + 1.6), steel, x, C.headY + 0.35, z);
    physics.add(new Body({ size: [C.size + 1.6, 0.7, C.size + 1.6], position: [x, C.headY, z], name: 'crusher head', ...CONFIG.materials.wall }));

    // the platen (kinematic physics body) + piston
    this.body = physics.add(new Body({
      size: [C.size, C.thick, C.size], position: [x, C.top, z], mass: 5000, dynamic: true, baseOrigin: true,
      name: 'crusher platen', friction: 0.8, restitution: 0,
    }));
    this.body.kinematic = true; this.body.rayIgnore = true;      // not a crate: never highlighted, picked up or punched
    this.platen = add(new THREE.BoxGeometry(C.size, C.thick, C.size), [hazard, hazard, steel, steel, hazard, hazard], x, C.top, z);
    this.rod = add(new THREE.CylinderGeometry(0.28, 0.28, 1, 16), steel, x, 0, z);
    this.lamp = add(new THREE.SphereGeometry(0.22, 16, 12), new THREE.MeshStandardMaterial({ color: 0x551111, emissive: 0x000000 }), x + off, C.headY + 0.95, z + off);
    this.light = new THREE.PointLight(0xff3020, 0, 9); this.light.position.copy(this.lamp.position); scene.add(this.light);
    this.y = C.top;
    this.crushedThisCycle = new Set();
    this._place(0);
  }

  _place(t, dt = 1 / 60) {
    const y = platenHeight(t), y0 = platenHeight(t - dt);
    const b = this.body;
    b.pos.set(this.x, y, this.z);
    b.vel.set(0, (y - y0) / dt, 0);
    b.updateBounds();
    this.y = y;
    this.platen.position.set(this.x, y + C.thick / 2, this.z);
    const top = y + C.thick, len = Math.max(0.01, this.beamY - top);
    this.rod.scale.set(1, len, 1); this.rod.position.set(this.x, top + len / 2, this.z);
  }

  // is a footprint point under the platen?
  covers(px, pz, margin = 0) { return Math.abs(px - this.x) < this.half + margin && Math.abs(pz - this.z) < this.half + margin; }

  // call once per frame, before physics, with the synced time in seconds
  update(t, dt, time) {
    this._place(t, Math.max(dt, 1 / 120));
    const on = warning(t) && Math.floor(time * 5) % 2 === 0;
    this.lamp.material.emissive.setHex(on ? 0xff2a10 : 0x000000);
    this.light.intensity = on ? 3 : 0;
  }

  // Bodies that the platen has pinned: still under it with it lower than 60% of their height. [{body}]
  crushed(bodies) {
    if (this.y > C.crushBelow) return [];
    const out = [];
    for (const b of bodies) {
      if (b.parked || !b.dynamic) continue;
      if (!this.covers(b.pos.x, b.pos.z, -0.05)) continue;
      const h = b.max.y - b.min.y;
      if (this.y < b.min.y + h * 0.6 && b.max.y > this.y) out.push(b);
    }
    return out;
  }
}
