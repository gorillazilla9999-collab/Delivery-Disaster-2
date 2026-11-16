// Loads assets/person.glb, finds its six parts, scales it to game size and exposes every part.
// Character.load() builds the local player; Character.createRemote() builds more copies for other players.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CONFIG } from './config.js';

// GLTFLoader strips "." from node names ("Sphere.001" -> "Sphere001"), so names are normalised.
const norm = (s) => (s || '').toLowerCase().replace(/[\s._\-]/g, '');
const PART_NAMES = {
  torso: 'cube',
  head: 'sphere',
  handR: 'sphere001',
  handL: 'sphere002',
  footR: 'sphere003',
  footL: 'sphere004',
};

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function findParts(scene) {
  const byName = {};
  scene.traverse((o) => { if (o.isMesh) byName[norm(o.name)] = o; });
  const parts = {};
  for (const [key, name] of Object.entries(PART_NAMES)) parts[key] = byName[name] || null;
  if (Object.values(parts).every(Boolean)) return parts;

  // Fallback if the parts were renamed in Blender: guess by position/size.
  console.warn('[character] Part names not found, guessing by geometry.');
  scene.updateMatrixWorld(true);
  const meshes = [];
  scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  if (meshes.length < 6) throw new Error('person.glb needs 6 meshes (head, torso, 2 hands, 2 feet), found ' + meshes.length);
  const info = meshes.map((m) => {
    const b = new THREE.Box3().setFromObject(m);
    const s = b.getSize(new THREE.Vector3());
    return { m, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2, vol: s.x * s.y * s.z };
  });
  info.sort((a, b) => b.y - a.y);
  const head = info.shift();
  info.sort((a, b) => b.vol - a.vol);
  const torso = info.shift();
  info.sort((a, b) => b.y - a.y);
  const hands = info.slice(0, 2).sort((a, b) => b.z - a.z);
  const feet = info.slice(2, 4).sort((a, b) => b.z - a.z);
  return { head: head.m, torso: torso.m, handR: hands[0].m, handL: hands[1].m, footR: feet[0].m, footL: feet[1].m };
}

export class Character {
  constructor({ root, model, parts, scale, eyeHeight }) {
    this.root = root;          // Group: position = feet on ground, rotation.y = body facing
    this.model = model;        // the scaled glTF scene
    this.parts = parts;        // { head, torso, handR, handL, footR, footL }  (all THREE.Mesh)
    this.scale = scale;        // metres per model unit
    this.eyeHeight = eyeHeight;
    this.firstPerson = true;
    this._air = 0;
    this._reach = 0;
    this._poke = { left: 0, right: 0 };
    this._feetRest = [parts.footR.position.clone(), parts.footL.position.clone()];
    this._handsRest = [parts.handR.position.clone(), parts.handL.position.clone()];
    this.setFirstPerson(true);
  }

  static async load(url, onProgress) {
    const gltf = await new GLTFLoader().loadAsync(url, (e) => {
      if (e.total) onProgress?.(e.loaded / e.total);
    });
    // Keep an untouched copy so every other player gets the same complete model.
    Character._template = gltf.scene.clone(true);
    return Character.build(gltf.scene);
  }

  static build(scene) {
    scene.updateMatrixWorld(true);

    const parts = findParts(scene);
    const box = new THREE.Box3().setFromObject(scene);
    const scale = CONFIG.player.height / (box.max.y - box.min.y);

    const headBox = new THREE.Box3().setFromObject(parts.head);
    const headCenterY = (headBox.min.y + headBox.max.y) / 2;
    const headRadius = (headBox.max.y - headBox.min.y) / 2;
    const eyeHeight = (headCenterY + headRadius * CONFIG.eyeAboveHeadCenter - box.min.y) * scale;

    scene.scale.setScalar(scale);
    scene.position.y = -box.min.y * scale;      // feet rest on y = 0
    scene.rotation.y = CONFIG.modelYawOffset;
    scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

    const root = new THREE.Group();
    root.name = 'Character';
    root.add(scene);
    return new Character({ root, model: scene, parts, scale, eyeHeight });
  }

  // A complete third-person copy of the model (head, torso, floating hands and feet) for another player.
  static createRemote() {
    if (!Character._template) throw new Error('Character.load() must finish before createRemote()');
    const c = Character.build(Character._template.clone(true));
    c.setFirstPerson(false);
    return c;
  }

  // First person: hide the head and torso so they never block the camera.
  setFirstPerson(fp) {
    this.firstPerson = fp;
    this.parts.head.visible = !fp;
    this.parts.torso.visible = !fp;
  }

  // Body turns independently of where the camera looks; the head turns/tilts to follow the camera.
  setLook(bodyYaw, camYaw, pitch) {
    this.root.rotation.y = bodyYaw;
    this.parts.head.rotation.set(0, wrapAngle(camYaw - bodyYaw), pitch);
  }

  triggerPoke(side) { this._poke[side] = CONFIG.hands.pokeDuration; }

  // Floating feet step alternately; they tuck up in the air.
  animateFeet(phase, amount, airborne, dt) {
    this._air += ((airborne ? 1 : 0) - this._air) * (1 - Math.exp(-12 * dt));
    const k = 1 / this.scale;     // metres -> model units (feet live inside the scaled model)
    [this.parts.footR, this.parts.footL].forEach((foot, i) => {
      const rest = this._feetRest[i];
      const ph = phase + (i ? Math.PI : 0);
      const swing = Math.sin(ph) * 0.22 * amount + (i ? -0.1 : 0.12) * this._air;
      const lift = Math.max(0, Math.cos(ph)) * 0.12 * amount + 0.12 * this._air;
      foot.position.set(rest.x + swing * k, rest.y + lift * k, rest.z);
    });
  }

  // Hands ON THE BODY (only used when the hands are not attached to the camera: other players, third-person debug).
  animateHands(phase, amount, reaching, dt) {
    this._reach += ((reaching ? 1 : 0) - this._reach) * (1 - Math.exp(-12 * dt));
    const k = 1 / this.scale;
    const dur = CONFIG.hands.pokeDuration;
    [['right', this.parts.handR, 0, +1], ['left', this.parts.handL, 1, -1]].forEach(([side, hand, i, sgn]) => {
      const rest = this._handsRest[i];
      const ph = phase + (i ? 0 : Math.PI);          // each hand swings opposite to the foot on its side
      let a = 0;
      if (this._poke[side] > 0) {
        this._poke[side] = Math.max(0, this._poke[side] - dt);
        const p = 1 - this._poke[side] / dur;
        a = p < 0.35 ? easeOutCubic(p / 0.35) : 1 - easeInOutSine((p - 0.35) / 0.65);
      }
      const fwd = Math.sin(ph) * 0.18 * amount + a * 0.55 + this._reach * 0.45;
      const up = Math.sin(ph * 2) * 0.02 * amount + a * 0.08 + this._reach * 0.1;
      const inward = a * 0.15 + this._reach * 0.3;
      hand.position.set(rest.x + fwd * k, rest.y + up * k, rest.z - sgn * inward * k);
    });
  }
}
