// Delivery Disaster - first-person movement + online multiplayer (Prompt 2).
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Input } from './input.js';
import { PhysicsWorld } from './physics.js';
import { buildWorld } from './world.js';
import { Character } from './character.js';
import { FirstPersonHands } from './hands.js';
import { Player } from './player.js';
import { UI } from './ui.js';
import { RemotePlayers } from './remote.js';
import { Net } from './net.js';
import { MultiplayerUI } from './multiplayer-ui.js';
import { CrateSync } from './crates-sync.js';

async function main() {
  const ui = new UI();

  if (location.protocol === 'file:') {
    ui.showError('Browsers block loading models from <code>file://</code>. Start the game server in this folder with <code>npm install</code> then <code>npm start</code> and open <code>http://localhost:3000</code> (or use <code>python3 -m http.server 8000</code> for single-player only).');
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
      crateSync.poke(hit.body, player.aimDir, CONFIG.interaction.pokeImpulse);
      world.flash(hit.body);
    }
  };

  // --- multiplayer ---
  const remotes = new RemotePlayers(scene);
  const net = new Net(remotes);
  const mpUI = new MultiplayerUI();
  let needSpawn = false;
  const crateSync = new CrateSync(world.crates, physics, net);
  net.crateSync = crateSync;

  net.onStatus = (state, text) => mpUI.setStatus(state, text);
  net.onNotice = (text, kind) => mpUI.toast(text, kind);
  net.onRoom = (room, info = {}) => {
    mpUI.setRoom(room);
    if (room) {
      if (!info.rejoined) crateSync.resetToHome();     // everybody starts from the same crate layout
      crateSync.setActive(true);
      needSpawn = !info.rejoined;
      if (info.created) mpUI.toast(`Room ${room.code} created - share the code!`, 'join');
      else if (!info.rejoined) mpUI.toast(`Joined room ${room.code}`, 'join');
    } else {
      crateSync.setActive(false);
      if (info.left) mpUI.toast('You left the room', 'info');
      if (info.lostConnection) mpUI.showMessage('Connection lost - trying to rejoin your room…', 'error');
      if (info.rejoinFailed) mpUI.showMessage('Could not rejoin your room (it may have closed or filled up).', 'error');
    }
  };
  net.onRoster = (players, hostId) => {
    mpUI.setRoster(players, net.myId, net.room && net.room.max);
    if (needSpawn && net.room) {                // spread players around the spawn so nobody stacks
      needSpawn = false;
      const i = Math.max(0, players.findIndex((p) => p.id === net.myId));
      const a = (i / Math.max(1, net.maxPlayers)) * Math.PI * 2;
      const r = i === 0 ? 0 : 2.6;
      player.teleport(CONFIG.player.spawn[0] + Math.cos(a) * r, CONFIG.player.spawn[2] + Math.sin(a) * r, 0);
    }
  };
  mpUI.onCreate = async (name) => {
    const res = await net.createRoom(name);
    if (!res.ok) mpUI.showMessage(res.message || 'Could not create room.');
  };
  mpUI.onJoin = async (code, name) => {
    const res = await net.joinRoom(code, name);
    if (!res.ok) mpUI.showMessage(res.message || 'Could not join room.');
  };
  mpUI.onLeave = () => net.leaveRoom();
  net.init().catch((e) => { console.error(e); mpUI.setStatus('unavailable', 'Multiplayer unavailable'); });
  setInterval(() => mpUI.setPing(net.socket && net.socket.connected ? net.pingMs : null), 2000);

  // --- pointer lock / menu ---
  ui.onRequestPlay(() => input.lock());
  input.onLockChange = (locked) => { if (locked) ui.hide(); else ui.showPaused(); };
  input.onLockError = () => { ui.status.textContent = 'Could not lock the mouse - click again.'; };
  ui.showReady();

  // debug handles for the console
  window.DD = { scene, camera, character, hands, player, physics, world, input, net, remotes, crateSync };

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
    if (input.pressed('Mouse0') && hands.poke('left')) net.sendAction('poke', 'left');
    if (input.pressed('Mouse2') && hands.poke('right')) net.sendAction('poke', 'right');
    hands.setReaching(input.down('KeyE'));

    // physics in small substeps for stable collisions
    crateSync.beforePhysics();
    player.beginFrame(dt);
    const n = Math.max(1, Math.ceil(dt / CONFIG.physics.maxSubstep));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      player.fixedUpdate(h);
      physics.step(h);
      player.afterStep();
    }
    crateSync.afterPhysics(dt);

    // view
    const view = player.updateView(dt);
    const hit = physics.raycast(player.eyePos, player.aimDir, CONFIG.interaction.rayLength, player.body);
    const reachDist = hit ? hit.dist : Infinity;
    hands.update(dt, { ...view, reachDist });

    const target = hit && hit.body && hit.body.dynamic && hit.dist <= CONFIG.interaction.reach ? hit.body : null;
    world.setHighlight(target);
    ui.setReach(!!target);

    // multiplayer: publish our state, advance the interpolated remote players
    if (net.inRoom) {
      const b = player.body;
      net.sendState({
        x: b.pos.x, y: b.pos.y, z: b.pos.z, yaw: player.yaw, pitch: player.pitch,
        speed: Math.hypot(b.vel.x, b.vel.z), vy: b.vel.y, grounded: b.onGround, reaching: hands.reaching,
      });
    }
    net.updateRemotes(dt);

    world.update(dt, player.body.pos, camera, (now - clock0) / 1000);
    renderer.render(scene, camera);
    input.endFrame();
  }
  requestAnimationFrame(frame);
}

main();
