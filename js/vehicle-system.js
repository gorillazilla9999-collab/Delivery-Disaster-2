// Ties the car into the game: H to get in / out, the controls, the seat, the third-person camera, the HUD, reset, and
// the network sync. main.js calls a handful of hooks (frameStart / fixedUpdate / afterStep / afterPhysics / updateView).
//
// While driving, the player's physics body is NOT part of the world (noCollide, no gravity): it is simply carried at the seat, so it
// can neither be hit by nor disturb the car, and every system that reads player.body.pos (network state, crusher, sun) keeps working.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Vehicle, findExitSpot, findResetSpot } from './vehicle.js';
import { VehicleModel } from './vehicle-model.js';
import { VehicleCamera } from './vehicle-camera.js';
import { VehicleSync } from './vehicle-sync.js';
import { VehicleHUD } from './vehicle-hud.js';

const VC = CONFIG.vehicle;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

export class VehicleSystem {
  constructor({ scene, camera, physics, player, character, hands, input, net, remotes, toast, dropCrate, isDown, getSensitivity }) {
    Object.assign(this, { scene, camera, physics, player, character, hands, input, net, remotes, toast, dropCrate, isDown, getSensitivity });
    this.vehicle = new Vehicle({ physics });
    this.model = new VehicleModel(this.vehicle);
    scene.add(this.model.group);
    this.sync = new VehicleSync([this.vehicle], net);
    net.vehicleSync = this.sync;
    this.sync.onForcedExit = () => { if (this.driving) this._leave({ forced: true }); };
    this.cam = new VehicleCamera();
    this.hud = new VehicleHUD();
    this.driving = false;
    this.busy = false;                                   // an enter request is in flight
    this.seatAmt = 0; this.enterFrom = new THREE.Vector3();
    this.blend = null;                                   // camera transition { t, dur, pos, quat, fov }
    this.roadkillAt = -1e9;
    this._v = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._look = new THREE.Vector3(); this._seatPos = { x: 0, y: 0, z: 0 };
    this.view = { move: 0, run: 0, phase: 0, vy: 0, grounded: true, dYaw: 0, dPitch: 0 };
  }

  get id() { return this.vehicle.id; }
  setActive(on) { this.sync.setActive(on); if (!on && this.driving) this._leave({ forced: true, silent: true }); }
  resetToHome() { this.sync.resetToHome(); }

  // ---- geometry helpers ----
  // world position of the character's feet when seated (car space -> world)
  seatWorld(out = this._seatPos) {
    const b = this.vehicle.body, R = b.R, S = VC.seat;
    out.x = b.c[0] + R[0] * S.x + R[1] * S.y + R[2] * S.z;
    out.y = b.c[1] + R[3] * S.x + R[4] * S.y + R[5] * S.z;
    out.z = b.c[2] + R[6] * S.x + R[7] * S.y + R[8] * S.z;
    return out;
  }
  // how far the player is from the car's body (metres, ground plane), 0 when touching / inside
  distanceToCar() {
    const b = this.vehicle.body, R = b.R, p = this.player.body.pos;
    const dx = p.x - b.pos.x, dz = p.z - b.pos.z;
    const rx = R[0], rz = R[6], fx = -R[2], fz = -R[8];
    const hr = Math.hypot(rx, rz) || 1, hf = Math.hypot(fx, fz) || 1;
    const lx = (dx * rx + dz * rz) / hr, lz = (dx * fx + dz * fz) / hf;
    const qx = Math.max(Math.abs(lx) - VC.chassis.size[0] / 2, 0), qz = Math.max(Math.abs(lz) - VC.chassis.size[2] / 2, 0);
    return Math.hypot(qx, qz);
  }
  _remotePoints() { const pts = []; for (const rp of this.remotes.players.values()) if (rp.hasState && !rp.seat) pts.push({ x: rp.pos.x, z: rp.pos.z }); return pts; }
  _state() {
    const v = this.vehicle, b = v.body;
    return { x: b.pos.x, y: b.pos.y, z: b.pos.z, yaw: v.yaw(), vx: b.vel.x, vz: b.vel.z, speed: v.speed, forwardSpeed: v.forwardSpeed };
  }

  // ---- once per frame, first thing: H / R and the driving controls ----
  frameStart() {
    const inp = this.input, v = this.vehicle;
    if (inp.pressed('KeyH')) this.toggle();
    if (this.driving) {
      const k = (...c) => c.some((x) => inp.down(x));
      v.input.throttle = (k('KeyW', 'ArrowUp') ? 1 : 0) - (k('KeyS', 'ArrowDown') ? 1 : 0);
      v.input.steer = (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0);
      v.input.handbrake = inp.down('Space');
      if (inp.pressed(VC.reset.key)) this.reset();
    }
  }
  toggle() {
    if (this.busy) return;
    if (this.driving) this._leave({});
    else this._enter();
  }

  async _enter() {
    const s = this.sync.state(this.id);
    if (this.isDown()) return;
    if (this.distanceToCar() > VC.enterRange || Math.abs(this.player.body.pos.y - this.vehicle.body.pos.y) > 2.2) return;      // nothing to get into
    if (s.driver && s.driver !== 'me') { this.toast('Somebody is already driving that', 'info'); return; }
    this.busy = true;
    const res = await this.sync.enter(this.id);
    this.busy = false;
    if (!res.ok) { this.toast(res.message || 'Could not get in', 'info'); return; }
    if (this.isDown()) { this.sync.exit(this.id); return; }               // got knocked out while the server was answering
    this._begin();
  }

  _begin() {
    const p = this.player, b = p.body;
    this.dropCrate();
    this._startBlend(VC.camera.blendIn);
    this.enterFrom.set(b.pos.x, b.pos.y, b.pos.z); this.seatAmt = 0;
    this.driving = true;
    b.noCollide = true; b.noGravity = true; b.onGround = false; b.pushing = false;
    this.hands.detach(); this.character.setFirstPerson(false);
    this.vehicle.occupied = true; this.vehicle.body.wake();
    this.cam.snap(this._state());
    this.cam.yaw = this.vehicle.yaw();
    this._seatBody();
    this.hud.show(true); this.hud.setPrompt(null);
  }

  // Leave the car. forced = the server (or a lost connection) took us out: no speed / space checks. Returns true if we got out.
  _leave({ forced = false, silent = false } = {}) {
    const v = this.vehicle, p = this.player, b = p.body;
    let spot = null;
    if (!forced) {
      if (v.speed > VC.exitMaxSpeed) { this.toast('Slow down to get out', 'info'); return false; }
      spot = findExitSpot(v, { points: this._remotePoints() });
      if (!spot) { this.toast('No room to get out here', 'info'); return false; }
    } else {
      spot = findExitSpot(v, { points: this._remotePoints() });
      if (!spot) { const R = v.body.R, S = VC.chassis.size[0] / 2 + 1.0; spot = { x: v.body.pos.x - R[0] * S, y: 0, z: v.body.pos.z - R[6] * S }; }
    }
    this._startBlend(VC.camera.blendOut);
    this.sync.exit(this.id);
    v.input.throttle = 0; v.input.steer = 0; v.input.handbrake = false; v.occupied = false;
    this.driving = false;

    b.noCollide = false; b.noGravity = false;
    const yaw = v.yaw();
    p.teleport(spot.x, spot.z, yaw);
    b.pos.y = spot.y;
    const sp = Math.hypot(v.body.vel.x, v.body.vel.z), k = sp > 6 ? 6 / sp : 1;
    b.vel.set(v.body.vel.x * k, 0, v.body.vel.z * k);                 // you keep the car's motion for a moment instead of being left behind
    b.updateBounds(); b.wake();
    p.pitch = p.targetPitch = 0; p.fov = this.camera.fov;
    this.character.root.rotation.set(0, yaw, 0);
    this.character.poseSeated(0);
    this.character.setFirstPerson(!p.thirdPerson);
    if (!p.thirdPerson) this.hands.attach();
    this.hud.show(false);
    if (!silent && forced) this.toast('You were thrown out of the car', 'info');
    return true;
  }

  // Stand an overturned (or stuck) car back up: right where it is if there is room, otherwise the nearest free spot, otherwise home.
  reset() {
    const v = this.vehicle;
    if (!v.canReset()) { this.toast('Wait a moment before resetting again', 'info'); return; }
    const spot = findResetSpot(v, { points: this._remotePoints(), home: VC.spawn });
    if (!spot) { this.toast('No clear space to reset the car here', 'info'); return; }
    v.reset(spot.x, spot.z, spot.yaw);
    this.cam.snap(this._state());
    this.toast(spot.moved > 0.5 ? 'Car reset to a clear spot' : 'Car back on its wheels', 'info');
  }

  // carry the (non-colliding) player body at the seat
  _seatBody() {
    const b = this.player.body, s = this.seatWorld(), vb = this.vehicle.body;
    b.pos.set(s.x, s.y, s.z); b.vel.copy(vb.vel); b.angVel.set(0, 0, 0);
    b.updateBounds();
  }

  // ---- physics hooks ----
  fixedUpdate(h) { this.vehicle.fixedUpdate(h); if (this.driving) this._seatBody(); }
  afterStep() { this.vehicle.afterStep(); if (this.driving) this._seatBody(); }
  afterPhysics(dt) {
    this.sync.afterPhysics(dt);
    this.vehicle.tickWheels(dt);
    this._roadkill();
  }
  beforePhysics(dt) { this.sync.beforePhysics(dt); }

  // being hit by a moving car (ours or anybody's) knocks you off your feet; every client checks this for its own player only
  _roadkill() {
    const v = this.vehicle, p = this.player;
    if (this.driving) return;
    const sp = v.speed;
    if (sp < 4 || performance.now() - this.roadkillAt < 900) return;
    const b = v.body, R = b.R, pp = p.body.pos;
    const dx = pp.x - b.pos.x, dz = pp.z - b.pos.z;
    const hr = Math.hypot(R[0], R[6]) || 1, hf = Math.hypot(R[2], R[8]) || 1;
    const lx = (dx * R[0] + dz * R[6]) / hr, lz = (dx * -R[2] + dz * -R[8]) / hf;
    if (Math.abs(lx) > VC.chassis.size[0] / 2 + 0.55 || Math.abs(lz) > VC.chassis.size[2] / 2 + 0.55 || pp.y > b.pos.y + 1.0) return;
    const vl = Math.hypot(b.vel.x, b.vel.z) || 1;
    const ux = b.vel.x / vl, uz = b.vel.z / vl;
    if ((dx * ux + dz * uz) < -0.5 && sp < 8) return;                 // we walked into the side of a slow car: just a bump
    this.roadkillAt = performance.now();
    p.knock(ux, uz, clamp(sp * 0.8, 5, 14), 4);
    this.toast('Hit by a car!', 'info');
  }

  // the press can squash a car too: anything driving into it is flung clear, like players are
  crusherPush(crusher, danger) {
    const b = this.vehicle.body;
    if (!danger || b.kinematic) return;
    if (crusher.covers(b.pos.x, b.pos.z, 1.3) && crusher.y < b.pos.y + 1.2) {
      const dx = b.pos.x - crusher.x, dz = b.pos.z - crusher.z, l = Math.hypot(dx, dz) || 1;
      b.vel.x = (dx / l) * 11; b.vel.z = (dz / l) * 11; b.vel.y = Math.max(b.vel.y, 2.5); b.wake();
    }
  }

  // ---- per frame, after physics ----
  // Returns the "view" object when it drove the camera (we are in the car); null otherwise (main then runs the player's own view).
  updateView(dt) {
    const v = this.vehicle, cam = this.camera;
    this.model.update(v);
    this._updateRemoteSeats();
    this._prompts();
    if (!this.driving) return null;

    // look: the mouse orbits the camera around the car, then eases back
    const look = this.input.consumeLook(), sens = CONFIG.look.baseSensitivity * this.getSensitivity();
    this.cam.orbit(-look.x * sens, look.y * sens);
    this.cam.update(dt, this._state(), this.physics, v.body);
    cam.position.set(this.cam.pos.x, this.cam.pos.y, this.cam.pos.z);
    cam.lookAt(this._look.set(this.cam.look.x, this.cam.look.y, this.cam.look.z));
    if (Math.abs(cam.fov - this.cam.fov) > 0.01) { cam.fov = this.cam.fov; cam.updateProjectionMatrix(); }

    // the driver (our own character) sits in the seat
    const p = this.player, ch = this.character, s = this.seatWorld();
    this.seatAmt = Math.min(1, this.seatAmt + dt / 0.35);
    const e = ease(this.seatAmt), b = v.body;
    ch.root.position.set(this.enterFrom.x + (s.x - this.enterFrom.x) * e, this.enterFrom.y + (s.y - this.enterFrom.y) * e, this.enterFrom.z + (s.z - this.enterFrom.z) * e);
    ch.root.quaternion.set(b.quat.x, b.quat.y, b.quat.z, b.quat.w);
    ch.animateFeet(0, 0, false, dt); ch.poseSeated(e, v.steerAngle);
    p.yaw = p.targetYaw = v.yaw(); p.pitch = 0;
    p.bodyYaw.snap(p.yaw);
    p.eyePos.set(s.x, s.y + ch.eyeHeight * 0.7, s.z);
    p.aimDir.set(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
    return this.view;
  }

  _prompts() {
    const v = this.vehicle;
    if (this.driving) {
      this.hud.update({ name: v.name, speedMs: v.speed, gear: v.gear, handbrake: v.handbrakeOn, flipped: v.flipped, maxSpeed: VC.engine.maxSpeed });
      return;
    }
    const near = !this.isDown() && this.distanceToCar() <= VC.enterRange + 0.4 && Math.abs(this.player.body.pos.y - v.body.pos.y) < 2.2;
    const d = this.sync.driverOf(this.id);
    if (near && !d) this.hud.setPrompt(`Press <b>H</b> to drive the ${v.name}`);
    else if (near && d && d !== 'me') this.hud.setPrompt(`${this.sync.state(this.id).driverName || 'Somebody'} is driving`);
    else this.hud.setPrompt(null);
  }

  // other players who are driving sit in the car, drawn with the car's own rendered pose
  _updateRemoteSeats() {
    const v = this.vehicle, d = this.sync.driverOf(this.id);
    let seat = null;
    if (d && d !== 'me') {
      const s = this.seatWorld(), q = v.body.quat;
      seat = { x: s.x, y: s.y, z: s.z, q: [q.x, q.y, q.z, q.w], steer: v.steerAngle };
    }
    for (const rp of this.remotes.players.values()) rp.seat = seat && rp.id === d ? seat : null;
  }

  // ---- camera transitions (entering / leaving) ----
  _startBlend(dur) {
    const c = this.camera;
    this.blend = { t: 0, dur, pos: c.position.clone(), quat: c.quaternion.clone(), fov: c.fov };
  }
  // call after the camera has been set for the frame (by us or by the player's own view)
  applyBlend(dt) {
    const bl = this.blend; if (!bl) return;
    bl.t += dt;
    const k = ease(bl.t / bl.dur), c = this.camera;
    c.position.lerpVectors(bl.pos, c.position, k);
    c.quaternion.slerpQuaternions(bl.quat, c.quaternion.clone(), k);
    const fov = bl.fov + (c.fov - bl.fov) * k;
    if (Math.abs(c.fov - fov) > 0.01) { c.fov = fov; c.updateProjectionMatrix(); }
    if (bl.t >= bl.dur) this.blend = null;
  }
}
