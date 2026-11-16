// Delivery Disaster - first-person movement + online multiplayer.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Input } from './input.js';
import { PhysicsWorld } from './physics.js';
import { buildWorld } from './world.js';
import { Character } from './character.js';
import { FirstPersonHands } from './hands.js';
import { Player } from './player.js';
import { RemotePlayers } from './remote-players.js';
import { UI } from './ui.js';

async function main() {
  const ui = new UI();

  if (location.protocol === 'file:') {
    ui.fatal('Browsers block loading models from <code>file://</code>. Run <code>npm start</code> and open <code>http://localhost:3000</code>.');
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
    ui.fatal(`Could not load <code>${CONFIG.modelUrl}</code>.<br>${err.message || err}<br>Make sure the file exists and you are running from a server.`);
    return;
  }
  scene.add(character.root);

  const input = new Input(canvas);
  const hands = new FirstPersonHands(camera, character);
  const player = new Player({ camera, physics, character, hands, input, getSensitivity: () => ui.sensitivity });
  const remotes = new RemotePlayers(scene);

  // --- multiplayer (optional: if the socket.io client can't load, the game still works solo) ---
  let net = null;
  let errorText = (c) => String(c);
  try {
    const mod = await import('./network.js');
    errorText = mod.errorText;
    net = new mod.Network();
  } catch (err) {
    console.warn('[net] multiplayer unavailable:', err);
    ui.setMultiplayerUnavailable('Multiplayer unavailable (could not load socket.io). Solo play still works.');
  }

  let mode = 'menu';            // 'menu' | 'solo' | 'room'
  let room = null;              // latest room info from the server
  let selfId = null;

  const solo = CONFIG.player.spawn;
  function spawnForSlot(slot) {
    const a = (slot / 12) * Math.PI * 2;
    player.respawn(solo[0] + Math.cos(a) * CONFIG.network.spawnRadius, solo[2] + Math.sin(a) * CONFIG.network.spawnRadius, 0);
  }

  function enterRoom(res) {
    mode = 'room';
    room = res;
    selfId = res.you;
    remotes.setPlayers(res.players, selfId);
    const me = res.players.find((p) => p.id === selfId);
    spawnForSlot(me ? me.slot : 0);
    ui.showRoom(room, selfId, false);
    ui.toast(`Joined room ${res.code}`);
  }

  function backToMenu(message, kind = 'error') {
    mode = 'menu';
    room = null;
    selfId = null;
    remotes.clear();
    if (document.pointerLockElement) document.exitPointerLock();
    player.respawn(solo[0], solo[2], 0);
    ui.showMenu(message, kind);
  }

  ui.onPlay = () => input.lock();
  ui.onSolo = () => { mode = 'solo'; ui.showRoom(null, null, false); input.lock(); };

  ui.onCreate = async (name) => {
    ui.setBusy(true); ui.setMenuMessage('');
    const res = await net.createRoom(name);
    ui.setBusy(false);
    if (!res.ok) return ui.setMenuMessage(errorText(res.error));
    enterRoom(res);
  };
  ui.onJoin = async (code, name) => {
    ui.setBusy(true); ui.setMenuMessage('');
    const res = await net.joinRoom(code, name);
    ui.setBusy(false);
    if (!res.ok) return ui.setMenuMessage(errorText(res.error));
    enterRoom(res);
  };
  ui.onLeave = async () => {
    if (mode === 'room' && net) await net.leaveRoom();
    backToMenu('', 'info');
  };

  if (net) {
    net.onStatus = (status, text) => ui.setNet(status, text);
    net.onPing = (ms) => ui.setPing(ms);
    net.onRoomLost = () => backToMenu('Connection to the server was lost, so you were removed from the room.');

    net.onRoomUpdate = (u) => {
      if (mode !== 'room') return;
      room = u;
      remotes.setPlayers(u.players, selfId);
      ui.updateRoom(u, selfId);
      const ev = u.event;
      if (ev && ev.id !== selfId) {
        if (ev.type === 'join') ui.toast(`${ev.name} joined`);
        else if (ev.type === 'leave') ui.toast(ev.reason === 'left' ? `${ev.name} left` : `${ev.name} lost connection`, 'bad');
      }
      if (ev && ev.newHostId === selfId) ui.toast('You are now the host');
    };
    net.onSnap = (m) => { if (mode === 'room') remotes.applySnapshot(m.players, selfId); };
    net.onAction = (a) => { if (mode === 'room' && a.type === 'poke') remotes.applyAction(a.id, a.side); };
    net.connect();
  }

  // --- hand interaction ---
  hands.onImpact = () => {
    const hit = physics.raycast(player.eyePos, player.aimDir, CONFIG.interaction.reach, player.body);
    if (hit && hit.body && hit.body.dynamic) {
      physics.applyImpulse(hit.body, player.aimDir, CONFIG.interaction.pokeImpulse);
      world.flash(hit.body);
    }
  };
  function poke(side) {
    if (!hands.poke(side)) return;
    character.triggerPoke(side);
    if (mode === 'room') net.sendAction('poke', side);
  }

  // --- pointer lock / menu ---
  input.onLockChange = (locked) => {
    if (locked) ui.hide();
    else if (mode === 'room') ui.showRoom(room, selfId, true);
    else if (mode === 'solo') ui.showRoom(null, null, true);
  };
  input.onLockError = () => { ui.status.textContent = 'Could not lock the mouse - click again.'; };
  ui.showMenu();

  // debug handles for the console
  window.DD = { scene, camera, character, hands, player, physics, world, input, net, remotes };

  // --- main loop ---
  let last = performance.now();
  const clock0 = last;
  let sendAcc = 0;
  let lastSent = null;

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (dt <= 0) return;

    // one-shot actions
    if (input.pressed('KeyV')) player.toggleThirdPerson();
    if (input.pressed('Mouse0')) poke('left');
    if (input.pressed('Mouse2')) poke('right');
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

    // network: send our state (fast when active, slow when idle), draw everyone else
    if (mode === 'room' && net && net.inRoom) {
      sendAcc += dt;
      const s = player.getNetState();
      const changed = !lastSent
        || Math.hypot(s.x - lastSent.x, s.y - lastSent.y, s.z - lastSent.z) > 0.002
        || Math.abs(s.yaw - lastSent.yaw) > 0.005 || Math.abs(s.pitch - lastSent.pitch) > 0.005
        || s.g !== lastSent.g || s.r !== lastSent.r || s.e !== lastSent.e;
      const interval = 1 / (changed ? CONFIG.network.sendRate : CONFIG.network.idleSendRate);
      if (sendAcc >= interval) {
        sendAcc = 0;
        net.sendState(s);
        lastSent = s;
      }
    } else {
      lastSent = null;
    }
    remotes.update(dt);

    world.update(dt, player.body.pos, camera, (now - clock0) / 1000);
    renderer.render(scene, camera);
    input.endFrame();
  }
  requestAnimationFrame(frame);
}

main();
