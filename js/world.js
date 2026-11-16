// Test environment: sky, lights, ground, static obstacles and pushable crates.
import * as THREE from 'three';
import { Body } from './physics.js';

const SUN_DIR = new THREE.Vector3(0.45, 0.8, 0.35).normalize();
const HORIZON = 0xcfe6fa;

function canvasTexture(size, draw, repeat, aniso) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  if (repeat) t.repeat.set(repeat, repeat);
  return t;
}

function makeSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x2f7fe0) },
      bottom: { value: new THREE.Color(HORIZON) },
      sunDir: { value: SUN_DIR.clone() },
    },
    vertexShader: `varying vec3 vP;
      void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 bottom; uniform vec3 sunDir; varying vec3 vP;
      void main(){
        float h = clamp(vP.y * 1.5 + 0.05, 0.0, 1.0);
        vec3 col = mix(bottom, top, pow(h, 0.65));
        float sd = max(dot(normalize(vP), sunDir), 0.0);
        col += vec3(1.0, 0.93, 0.75) * (pow(sd, 900.0) * 3.0 + pow(sd, 10.0) * 0.18);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(450, 32, 16), mat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  return sky;
}

function makeClouds() {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false, transparent: true, opacity: 0.92 });
  const geo = new THREE.SphereGeometry(1, 12, 8);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 16; i++) {
    const cloud = new THREE.Group();
    const puffs = 3 + Math.floor(rnd() * 3);
    for (let j = 0; j < puffs; j++) {
      const m = new THREE.Mesh(geo, mat);
      const r = 8 + rnd() * 9;
      m.scale.set(r * 1.5, r * 0.6, r);
      m.position.set((j - puffs / 2) * 13 + rnd() * 5, rnd() * 3, rnd() * 8);
      cloud.add(m);
    }
    const a = rnd() * Math.PI * 2, d = 140 + rnd() * 160;
    cloud.position.set(Math.cos(a) * d, 70 + rnd() * 40, Math.sin(a) * d);
    group.add(cloud);
  }
  return group;
}

export function buildWorld({ scene, physics, renderer }) {
  const aniso = renderer.capabilities.getMaxAnisotropy();
  scene.background = new THREE.Color(HORIZON);
  scene.fog = new THREE.Fog(HORIZON, 70, 320);

  const sky = makeSky();
  scene.add(sky);
  const clouds = makeClouds();
  scene.add(clouds);

  // --- lights ---
  scene.add(new THREE.HemisphereLight(0xbfdcff, 0x5f7f4c, 1.0));
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -32; sc.right = sc.top = 32; sc.near = 1; sc.far = 160;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  // --- ground ---
  const groundTex = canvasTexture(256, (g, s) => {
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
      g.fillStyle = (x + y) % 2 ? '#79b85f' : '#6aa852';
      g.fillRect(x * s / 2, y * s / 2, s / 2, s / 2);
    }
    for (let i = 0; i < 700; i++) {
      g.fillStyle = `rgba(${Math.random() < .5 ? '255,255,255' : '0,40,0'},.045)`;
      g.fillRect(Math.random() * s, Math.random() * s, 2, 2);
    }
    g.strokeStyle = 'rgba(255,255,255,.22)';
    g.lineWidth = 2;
    g.strokeRect(1, 1, s - 2, s - 2);
  }, 100, aniso);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // --- static obstacles ---
  const statics = [];
  function block(size, x, z, color, name) {
    const body = physics.add(new Body({ size, position: [x, 0, z], name }));
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(...size),
      new THREE.MeshStandardMaterial({ color, roughness: 0.85 }),
    );
    mesh.position.set(x, size[1] / 2, z);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    body.mesh = mesh;
    statics.push(body);
    return body;
  }

  block([14, 3, 0.6], 0, -16, 0xb9b2a5, 'back wall');
  for (const x of [-7, -3, 3, 7]) block([1, 4, 1], x, -10, 0x8f99c7, 'pillar');
  block([6, 0.8, 0.5], -9, -2, 0xf2a03d, 'low barrier');          // jump over it
  block([6, 2.6, 2.4], 15, 8, 0xd2503f, 'container');
  // jump tower (each block is jumpable from the last)
  block([2, 0.6, 2], -13, -6, 0x6fc3a0, 'tower 1');
  block([2, 1.2, 2], -13, -8.2, 0x58b08c, 'tower 2');
  block([2, 1.8, 2], -13, -10.4, 0x419c78, 'tower 3');
  // stairs + platform (walkable thanks to step-up)
  for (let i = 0; i < 5; i++) block([4, 0.3 * (i + 1), 1], 11, -2.5 - i, 0xe6c35c, 'stair ' + i);
  block([4, 1.5, 5], 11, -10, 0xd9b248, 'platform');

  // --- pushable crates ---
  const crateTex = canvasTexture(128, (g, s) => {
    g.fillStyle = '#c99a5b'; g.fillRect(0, 0, s, s);
    g.fillStyle = 'rgba(80,50,20,.25)';
    for (let i = 0; i < 40; i++) g.fillRect(Math.random() * s, Math.random() * s, 10, 1);
    g.fillStyle = '#e9d8a6'; g.fillRect(s / 2 - 12, 0, 24, s);          // tape
    g.strokeStyle = '#7b5427'; g.lineWidth = 6; g.strokeRect(3, 3, s - 6, s - 6);
    g.fillStyle = '#b0362a'; g.font = 'bold 15px sans-serif'; g.textAlign = 'center';
    g.fillText('FRAGILE', s / 2, s - 14);
  }, 0, aniso);
  const crateMat = new THREE.MeshStandardMaterial({ map: crateTex, roughness: 0.9 });

  const crates = [];
  function crate(size, x, y, z) {
    const mass = Math.max(0.3, 1.4 * size ** 3);
    const body = physics.add(new Body({ size: [size, size, size], position: [x, y, z], mass, dynamic: true, name: 'crate' }));
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), crateMat.clone());
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    body.mesh = mesh;
    body.flash = 0;
    body.home = [x, y, z];
    crates.push(body);
    return body;
  }
  // a small pyramid
  const s = 0.8, g = 0.02;
  for (let i = 0; i < 3; i++) crate(s, -3 + i * (s + g), 0, -2);
  for (let i = 0; i < 2; i++) crate(s, -3 + (s + g) / 2 + i * (s + g), s, -2);
  crate(s, -3 + (s + g), 2 * s, -2);
  // scattered
  crate(0.6, 3, 0, 4); crate(0.6, 4, 0, 5.5); crate(1.0, 6, 0, 2); crate(1.2, -6, 0, 6);
  crate(0.5, 0, 0, 0); crate(0.7, 2, 0, -5); crate(0.9, -2, 0, 7);

  let highlighted = null;
  const hlColor = new THREE.Color(0x3a2a00), flashColor = new THREE.Color(0x8a6414);

  return {
    crates,
    setHighlight(body) { highlighted = body; },
    flash(body) { if (body && body.mesh) body.flash = 0.22; },
    update(dt, playerPos, camera, time) {
      for (const b of crates) {
        b.mesh.position.set(b.pos.x, b.pos.y + b.h / 2, b.pos.z);
        b.flash = Math.max(0, b.flash - dt);
        const em = b.mesh.material.emissive;
        if (b.flash > 0) em.copy(flashColor); else if (b === highlighted) em.copy(hlColor); else em.setRGB(0, 0, 0);
      }
      sun.position.copy(playerPos).addScaledVector(SUN_DIR, 70);
      sun.target.position.copy(playerPos);
      sky.position.copy(camera.position);
      clouds.position.x = Math.sin(time * 0.01) * 20;
    },
  };
}
