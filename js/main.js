// Delivery Disaster - Prompt 1: player & first-person movement.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Input } from './input.js';
import { PhysicsWorld } from './physics.js';
import { buildWorld } from './world.js';
import { Character } from './character.js';
import { FirstPersonHands } from './hands.js';
import { Player } from './player.js';
import { UI } from './ui.js';

async function main() {
  const ui = new UI();

  if (location.protocol === 'file:') {
    ui.showError('Browsers block loading models from <code>file://</code>. Start a local server in this folder, e.g. <code>python3 -m http.server 8000</code>, then open <code>http://localhost:8000</code>.');
    return;
  }

  // --- renderer / scene / camera ---
  const canvas = document.getElementById('game');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, innerWidth / innerHeight, CONFIG.camera.near, CONFIG.camera.far);
  camera.rotation.order = 'YXZ';
  scene.add(camera);                       // camera must be in the scene so its child hands render

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });

  // --- world + character ---
  const physics = new PhysicsWorld();
  const world = buildWorld({ scene, physics, renderer });

  let character;
  try {
    character = await Character.load(CONFIG.modelUrl, (f) => ui.setLoading(f));
  } catch (err) {
    console.error(err);
    ui.showError(`Could not load <code>${CONFIG.modelUrl}</code>.<br>${err.message || err}<br>Make sure the file exists and you are running from a local server.`);
    return;
  }
  scene.add(character.root);

  const input = new Input(canvas);
  const hands = new FirstPersonHands(camera, character);
  const player = new Player({ camera, physics, character, hands, input, getSensitivity: () => ui.sensitivity });

  // --- hand interaction ---
  hands.onImpact = (side) => {
    const hit = physics.raycast(player.eyePos, player.aimDir, CONFIG.interaction.reach, player.body);
    if (hit && hit.body && hit.body.dynamic) {
      physics.applyImpulse(hit.body, player.aimDir, CONFIG.interaction.pokeImpulse);
      world.flash(hit.body);
    }
  };

  // --- pointer lock / menu ---
  ui.onRequestPlay(() => input.lock());
  input.onLockChange = (locked) => { if (locked) ui.hide(); else ui.showPaused(); };
  input.onLockError = () => { ui.status.textContent = 'Could not lock the mouse - click again.'; };
  ui.showReady();

  // debug handles for the console
  window.DD = { scene, camera, character, hands, player, physics, world, input };

  // --- main loop ---
  let last = performance.now();
  const clock0 = last;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (dt <= 0) return;

    // one-shot actions
    if (input.pressed('KeyV')) player.toggleThirdPerson();
    if (input.pressed('Mouse0')) hands.poke('left');
    if (input.pressed('Mouse2')) hands.poke('right');
    hands.setReaching(input.down('KeyE'));

    // physics in small substeps for stable collisions
    player.beginFrame(dt);
    const n = Math.max(1, Math.ceil(dt / CONFIG.physics.maxSubstep));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      player.fixedUpdate(h);
      physics.step(h);
      player.afterStep();
    }

    // view
    const view = player.updateView(dt);
    const hit = physics.raycast(player.eyePos, player.aimDir, CONFIG.interaction.rayLength, player.body);
    const reachDist = hit ? hit.dist : Infinity;
    hands.update(dt, { ...view, reachDist });

    const target = hit && hit.body && hit.body.dynamic && hit.dist <= CONFIG.interaction.reach ? hit.body : null;
    world.setHighlight(target);
    ui.setReach(!!target);

    world.update(dt, player.body.pos, camera, (now - clock0) / 1000);
    renderer.render(scene, camera);
    input.endFrame();
  }
  requestAnimationFrame(frame);
}

main();
