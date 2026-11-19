// Loads assets/person.glb, finds its six parts, scales it to game size and exposes every part.
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
    this.root = root;          // Group: position = feet on ground, rotation.y = facing (yaw)
    this.model = model;        // the scaled glTF scene
    this.parts = parts;        // { head, torso, handR, handL, footR, footL }  (all THREE.Mesh)
    this.scale = scale;        // metres per model unit
    this.eyeHeight = eyeHeight;
    this.firstPerson = true;
    this._air = 0;
    this._feetRest = [parts.footR.position.clone(), parts.footL.position.clone()];
    this._handRest = [parts.handR.position.clone(), parts.handL.position.clone()];   // model units
    this.setFirstPerson(true);
  }

  // Loads the GLB once. A pristine copy is kept so remote players can be cloned later,
  // even after the local player's hands have been re-parented onto the camera.
  static async load(url, onProgress) {
    const gltf = await new GLTFLoader().loadAsync(url, (e) => {
      if (e.total) onProgress?.(e.loaded / e.total);
    });
    Character._template = gltf.scene.clone(true);
    return Character._fromScene(gltf.scene);
  }

  // A complete, independent character for another player (same model, shared geometry/materials).
  static createRemote() {
    if (!Character._template) throw new Error('Character.load() must finish before createRemote()');
    const c = Character._fromScene(Character._template.clone(true));
    c.setFirstPerson(false);                 // others see the whole body: head + torso + hands + feet
    return c;
  }

  static _fromScene(scene) {
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

  // First person: hide the head and torso so they never block the camera.
  setFirstPerson(fp) {
    this.firstPerson = fp;
    this.parts.head.visible = !fp;
    this.parts.torso.visible = !fp;
  }

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

  // Sitting in a car: hands reach forward to the wheel (and turn it with `steer`), feet go to the pedals.
  // `amount` 0..1 blends from the normal standing pose (0 leaves the hands and feet exactly where animateFeet / the hand
  // animation put them, so it is safe to call every frame).
  poseSeated(amount, steer = 0) {
    if (amount <= 0.001) return;
    const k = 1 / this.scale;
    [this.parts.handR, this.parts.handL].forEach((hand, i) => {
      const rest = this._handRest[i];
      hand.position.set(rest.x + 0.34 * k * amount, rest.y + (0.1 + (i ? 1 : -1) * steer * 0.12) * k * amount, rest.z);
    });
    [this.parts.footR, this.parts.footL].forEach((foot, i) => {
      const rest = this._feetRest[i];
      foot.position.set(rest.x + 0.3 * k * amount, rest.y + 0.12 * k * amount, rest.z);
    });
  }
}
