// Delivery Disaster - first-person movement + online multiplayer (Prompt 2).
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Input } from './input.js';
import { PhysicsWorld, Quat } from './physics.js';
import { buildWorld } from './world.js';
import { Character } from './character.js';
import { FirstPersonHands } from './hands.js';
import { Player } from './player.js';
import { UI } from './ui.js';
import { RemotePlayers } from './remote.js';
import { Net } from './net.js';
import { MultiplayerUI } from './multiplayer-ui.js';
import { CrateSync } from './crates-sync.js';
import { Chat } from './chat.js';
import { Combat } from './combat.js';
import { isDanger } from './crusher.js';
import { VehicleSystem } from './vehicle-system.js';
import { buildCoursePhysics } from './course.js';
import { buildCourseView } from './course-view.js';

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
  buildCoursePhysics(physics); buildCourseView(scene);          // speed bumps + a ramp to drive over (static bodies, same world)

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

  // --- carrying (press E to pick up / put down, click while carrying to throw) ---
  let held = null;
  const dropCrate = (throwIt = false) => {
    if (!held) return;
    const b = held;
    held = null;
    player.carryMass = 0;
    b.noGravity = false; b.ignore = null; b.rayIgnore = false;
    crateSync.unhold(b);
    b.wake();
    b.angVel.set(0, 0, 0);
    if (throwIt) {
      // an arm delivers a roughly fixed amount of energy: light things fly fast, heavy things barely leave the hands
      const C = CONFIG.carry;
      const t = Math.min(C.maxThrow, C.throwPower / Math.sqrt(Math.max(1, b.mass)));
      b.vel.set(player.aimDir.x * t + player.body.vel.x, player.aimDir.y * t + 1.2 + player.body.vel.y, player.aimDir.z * t + player.body.vel.z);
      // released a little off-centre, so it tumbles: spin about the axis across the throw direction
      const sp = t / (b.h + 0.4) * 0.8;
      b.angVel.set(-player.aimDir.z * sp + (Math.random() - 0.5), (Math.random() - 0.5) * 2, player.aimDir.x * sp + (Math.random() - 0.5));
    } else {
      b.vel.x = player.body.vel.x * 0.5; b.vel.z = player.body.vel.z * 0.5;
      b.vel.y = 0;
    }
  };
  const pickUp = () => {
    const hit = physics.raycast(player.eyePos, player.aimDir, CONFIG.interaction.reach, player.body);
    const b = hit && hit.body;
    if (!b || !b.dynamic || b.isPlayer || crateSync.indexOf(b) < 0) return;
    if (crateSync.isRemoteOwned(b)) { mpUI.toast('Somebody else is moving that crate', 'info'); return; }
    held = b;
    player.carryMass = b.mass;
    b.wake();
    b.noGravity = true; b.ignore = player.body; b.rayIgnore = true; b.onGround = false;
    crateSync.hold(b);
  };
  // drive the carried crate toward a spot in front of the camera (runs every physics substep). Heavier loads lag more,
  // and the crate is turned upright and to face the way you look.
  const holdQuat = new Quat();
  const driveHeld = () => {
    const c = CONFIG.carry, b = held;
    const d = c.holdGap + b.hx;
    const tx = player.eyePos.x + player.aimDir.x * d;
    const ty = player.eyePos.y + player.aimDir.y * d - c.holdDrop;          // centre of the crate
    const tz = player.eyePos.z + player.aimDir.z * d;
    const k = c.gain / (1 + c.massLag * b.mass);
    let vx = (tx - b.pos.x) * k, vy = (ty - b.pos.y) * k, vz = (tz - b.pos.z) * k;
    const sp = Math.hypot(vx, vy, vz);
    if (sp > c.maxSpeed) { const f = c.maxSpeed / sp; vx *= f; vy *= f; vz *= f; }
    b.vel.set(vx, vy, vz);
    physics.driveOrientation(b, holdQuat.setYaw(player.yaw), 10, 12);
    return Math.hypot(tx - b.pos.x, ty - b.pos.y, tz - b.pos.z);
  };

  // --- spawn tool (Q cycle, F spawn, X remove) ---
  const spawnTypes = CONFIG.spawner.types;
  let spawnSel = 0;
  const spawnEl = document.getElementById('spawner-item');
  const showSpawnSel = () => { if (spawnEl) spawnEl.textContent = spawnTypes[spawnSel].label; };
  showSpawnSel();
  const respawns = [];                                           // crushed / removed map crates that come back at their home
  const spawnItem = () => {
    const t = spawnTypes[spawnSel];
    const free = world.pool[t.id].filter((b) => b.parked);
    if (!free.length) { mpUI.toast(`Out of ${t.label.toLowerCase()}s - remove (X) or crush some`, 'info'); return; }
    const b = free[Math.floor(Math.random() * free.length)];
    const a = player.aimDir, e = player.eyePos;
    const hit = physics.raycast(e, a, 4, player.body);
    const d = Math.max(1.5, Math.min(3.2, hit ? hit.dist - b.hx - 0.3 : 3.2));
    const x = e.x + a.x * d, z = e.z + a.z * d, y = Math.max(e.y + a.y * d, b.h / 2 + 0.05);
    const v = { x: player.body.vel.x + a.x * 2, y: player.body.vel.y + a.y * 2, z: player.body.vel.z + a.z * 2 };
    crateSync.spawn(b, x, y, z, v, holdQuat.setYaw(player.yaw));
    world.flash(b);
  };
  const removeItem = (b) => {
    if (crateSync.isRemoteOwned(b)) { mpUI.toast('Somebody else is moving that one', 'info'); return; }
    if (b === held) dropCrate();
    crateSync.park(b);
    if (!b.pool) respawns.push({ b, at: performance.now() + CONFIG.crusher.respawn * 1000 });
  };

  // --- hand interaction ---
  hands.onImpact = (side) => {
    if (combat.tryPunch()) return;                        // punched another player
    const hit = physics.raycast(player.eyePos, player.aimDir, CONFIG.interaction.reach, player.body);
    if (hit && hit.body && hit.body.dynamic) {
      const e = player.eyePos, a = player.aimDir;
      const point = { x: e.x + a.x * hit.dist, y: e.y + a.y * hit.dist, z: e.z + a.z * hit.dist };   // where the fist lands: off-centre hits spin the crate
      crateSync.poke(hit.body, a, CONFIG.interaction.pokeImpulse, point);
      world.flash(hit.body);
    }
  };

  // --- multiplayer ---
  const remotes = new RemotePlayers(scene);
  const net = new Net(remotes);
  const mpUI = new MultiplayerUI();
  const combat = new Combat({
    scene, player, net, remotes, physics,
    toast: (text, kind) => mpUI.toast(text, kind),
    onHurt: () => dropCrate(),
  });
  net.onHit = (h) => combat.onHit(h);
  let needSpawn = false;
  const crateSync = new CrateSync(world.crates, physics, net);
  const chat = new Chat({ net, input, toast: (t, k) => mpUI.toast(t, k) });
  net.crateSync = crateSync;
  const vehicles = new VehicleSystem({
    scene, camera, physics, player, character, hands, input, net, remotes,
    toast: (t, k) => mpUI.toast(t, k), dropCrate, getSensitivity: () => ui.sensitivity,
    isDown: () => combat.knockedOut || player.ko,
  });

  net.onStatus = (state, text) => mpUI.setStatus(state, text);
  net.onNotice = (text, kind) => mpUI.toast(text, kind);
  net.onRoom = (room, info = {}) => {
    mpUI.setRoom(room);
    if (!room || !info.rejoined) dropCrate();
    combat.setActive(!!room);
    chat.setActive(!!room);
    if (room) {
      if (!info.rejoined) { crateSync.resetToHome(); vehicles.resetToHome(); }     // everybody starts from the same crate + car layout
      crateSync.setActive(true); vehicles.setActive(true);
      needSpawn = !info.rejoined;
      if (info.created) mpUI.toast(`Room ${room.code} created - share the code!`, 'join');
      else if (!info.rejoined) mpUI.toast(`Joined room ${room.code}`, 'join');
    } else {
      crateSync.setActive(false); vehicles.setActive(false);
      if (info.left) mpUI.toast('You left the room', 'info');
      if (info.kicked) {
        mpUI.showMessage('You were kicked from the room by an admin.', 'error');
        mpUI.toast('You were kicked from the room', 'error');
        if (document.pointerLockElement) document.exitPointerLock();
      }
      if (info.lostConnection) mpUI.showMessage('Connection lost - trying to rejoin your room…', 'error');
      if (info.rejoinFailed) mpUI.showMessage('Could not rejoin your room (it may have closed or filled up).', 'error');
    }
  };
  net.onRoster = (players, hostId) => {
    mpUI.setRoster(players, net.myId, net.room && net.room.max, hostId, net.room ? net.room.locked : false);
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

  // --- host controls + admin ---
  net.onRoomUpdate = () => { if (net.room) { mpUI.setRoom(net.room); mpUI.setRoster(net.roster, net.myId, net.room.max, net.room.hostId, net.room.locked); } };
  net.onAdmin = (on) => { mpUI.setAdmin(on); if (on) refreshAdmin(); };
  const refreshAdmin = async () => {
    if (!net.isAdmin) return;
    const res = await net.adminRooms();
    if (res.ok) mpUI.renderAdminRooms(res.rooms);
    else if (res.message === 'Not an admin.') { net.isAdmin = false; mpUI.setAdmin(false); }
  };
  const report = (res, okText) => { if (res.ok) { if (okText) mpUI.toast(okText, 'info'); } else mpUI.showMessage(res.message || 'That did not work.'); };
  mpUI.onSetLock = async (locked) => { report(await net.setLock(locked)); };
  mpUI.onSetCode = async (code) => { const res = await net.setRoomCode(code); report(res); return res.ok; };
  mpUI.onAdminLogin = async (code) => {
    const res = await net.adminLogin(code);
    mpUI.showMessage(res.ok ? 'Admin unlocked.' : (res.message || 'Wrong admin code.'), res.ok ? 'info' : 'error');
    return res.ok;
  };
  mpUI.onAdminLogout = () => net.adminLogout();
  mpUI.onAdminRefresh = refreshAdmin;
  mpUI.onAdminJoin = async (code) => { const res = await net.joinRoom(code, mpUI.name); if (!res.ok) mpUI.showMessage(res.message || 'Could not join room.'); };
  const kick = async (id, name) => { report(await net.adminKick(id), `Kicked ${name || 'player'}`); refreshAdmin(); };
  mpUI.onKick = kick;
  mpUI.onAdminKick = kick;
  mpUI.onAdminLock = async (code, locked) => { report(await net.setLock(locked, code)); refreshAdmin(); };
  mpUI.onAdminNewCode = async (code) => { report(await net.setRoomCode('', code)); refreshAdmin(); };
  net.init().catch((e) => { console.error(e); mpUI.setStatus('unavailable', 'Multiplayer unavailable'); });
  setInterval(() => mpUI.setPing(net.socket && net.socket.connected ? net.pingMs : null), 2000);

  // --- pointer lock / menu ---
  ui.onRequestPlay(() => input.lock());
  input.onLockChange = (locked) => { if (locked) ui.hide(); else ui.showPaused(); };
  input.onLockError = () => { ui.status.textContent = 'Could not lock the mouse - click again.'; };
  ui.showReady();

  // debug handles for the console
  window.DD = { combat, get held() { return held; }, scene, camera, character, hands, player, physics, world, input, net, remotes, crateSync, vehicles };

  // --- main loop ---
  let last = performance.now();
  const clock0 = last;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (dt <= 0) return;

    // one-shot actions
    vehicles.frameStart();                                       // H get in / out, R reset, driving keys
    const driving = vehicles.driving;
    if (input.pressed('KeyV') && !driving) player.toggleThirdPerson();
    const down = combat.knockedOut || driving;                   // in the car: no pick-up / spawn / punching                              // knocked out: no actions at all
    if (down && held) dropCrate();
    if (down) { for (const k of ['KeyE', 'Mouse0', 'Mouse2']) input._pressed.delete(k); }
    if (input.pressed('KeyE')) { if (held) dropCrate(); else pickUp(); }
    if (!down) {
      if (input.pressed('KeyQ')) { spawnSel = (spawnSel + 1) % spawnTypes.length; showSpawnSel(); }
      if (input.pressed('KeyF')) spawnItem();
      if (input.pressed('KeyX')) {
        const r = physics.raycast(player.eyePos, player.aimDir, CONFIG.interaction.rayLength + 1, player.body);
        if (r && r.body && r.body.dynamic && world.crates.includes(r.body)) removeItem(r.body);
      }
    }
    if (held && crateSync.isRemoteOwned(held)) dropCrate();      // somebody else won the claim
    if (held && (input.pressed('Mouse0') || input.pressed('Mouse2'))) {
      dropCrate(true);                                           // click while carrying = throw
      hands.poke(input.pressed('Mouse0') ? 'left' : 'right') && net.sendAction('poke', input.pressed('Mouse0') ? 'left' : 'right');
    } else {
      if (input.pressed('Mouse0') && hands.poke('left')) net.sendAction('poke', 'left');
      if (input.pressed('Mouse2') && hands.poke('right')) net.sendAction('poke', 'right');
    }
    hands.setReaching(!!held || (!down && input.down('KeyE')));
    hands.setGrip('left', held ? 1 : 0); hands.setGrip('right', held ? 1 : 0);

    // the crusher runs on synced time, so every player sees the same press; anybody caught under it is flung clear
    const tSync = net.serverNowSec(), crusher = world.crusher, pb = player.body;
    crusher.update(tSync, dt, now / 1000);
    if (isDanger(tSync) && crusher.covers(pb.pos.x, pb.pos.z, 0.3) && crusher.y < pb.pos.y + CONFIG.player.height + 0.4) {
      const dx = pb.pos.x - crusher.x, dz = pb.pos.z - crusher.z, l = Math.hypot(dx, dz) || 1;
      player.knock(dx / l, dz / l, 13, 3.5);
      if (now - (crusher.lastWarn || 0) > 3000) { crusher.lastWarn = now; mpUI.toast('The crusher flung you out!', 'info'); }
    }

    vehicles.crusherPush(crusher, isDanger(tSync));

    // physics in small substeps for stable collisions
    crateSync.beforePhysics(dt);
    vehicles.beforePhysics(dt);
    if (!driving) player.beginFrame(dt);
    const n = Math.max(1, Math.ceil(dt / CONFIG.physics.maxSubstep));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      if (!vehicles.driving) player.fixedUpdate(h);
      vehicles.fixedUpdate(h);
      if (held) { const off = driveHeld(); if (off > CONFIG.carry.breakDist) { dropCrate(); } }
      physics.step(h);
      vehicles.afterStep();
      if (!vehicles.driving) player.afterStep();
    }
    crateSync.afterPhysics(dt);
    vehicles.afterPhysics(dt);
    for (const b of crusher.crushed(world.crates)) {                 // pinned under the press: flattened (the owner / host decides)
      if (!crateSync.isAuthority(b)) continue;
      if (b === held) dropCrate();
      crateSync.park(b);
      if (!b.pool) respawns.push({ b, at: now + CONFIG.crusher.respawn * 1000 });
    }
    for (let i = respawns.length - 1; i >= 0; i--) {
      if (now >= respawns[i].at) { const { b } = respawns.splice(i, 1)[0]; if (b.parked) crateSync.restore(b, b.home[0], b.home[1], b.home[2]); }
    }

    // view
    const view = vehicles.updateView(dt) || player.updateView(dt);       // in the car the vehicle camera drives the view
    vehicles.applyBlend(dt);                                             // smooth transition when getting in / out
    const hit = physics.raycast(player.eyePos, player.aimDir, CONFIG.interaction.rayLength, player.body);
    const reachDist = hit ? hit.dist : Infinity;
    hands.update(dt, { ...view, reachDist });

    const target = !held && !vehicles.driving && hit && hit.body && hit.body.dynamic && !hit.body.isVehicle && hit.dist <= CONFIG.interaction.reach ? hit.body : null;
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
    combat.update(dt);

    world.update(dt, player.body.pos, camera, (now - clock0) / 1000);
    renderer.render(scene, camera);
    input.endFrame();
  }
  requestAnimationFrame(frame);
}

main();
