// First-person player: input -> physics body, camera, head bob, character sync.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Body } from './physics.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const P = CONFIG.player;

export class Player {
  constructor({ camera, physics, character, hands, input, getSensitivity }) {
    this.camera = camera;
    this.physics = physics;
    this.character = character;
    this.hands = hands;
    this.input = input;
    this.getSensitivity = getSensitivity;

    this.body = new Body({
      size: [P.radius * 2, P.height, P.radius * 2],
      position: P.spawn, mass: P.mass, dynamic: true, name: 'player',
    });
    this.body.isPlayer = true;
    this.body.stepHeight = P.stepHeight;
    physics.add(this.body);

    this.yaw = 0; this.pitch = 0;
    this.targetYaw = 0; this.targetPitch = 0;
    this.moveAmt = 0; this.runAmt = 0; this.phase = 0;
    this.jumpBuffer = 0; this.coyote = 0;
    this.prevVy = 0; this.wasGround = true;
    this.dip = 0; this.dipVel = 0; this.roll = 0;
    this.fov = CONFIG.camera.fov;
    this.thirdPerson = false;

    this.eyePos = new THREE.Vector3();     // first-person eye position (used for aiming)
    this.aimDir = new THREE.Vector3(0, 0, -1);
    this.viewState = { move: 0, run: 0, phase: 0, vy: 0, grounded: true, dYaw: 0, dPitch: 0 };
  }

  // ---- once per frame, before physics substeps ----
  beginFrame(dt) {
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    if (this.input.pressed('Space')) this.jumpBuffer = P.jumpBuffer;
  }

  // ---- every physics substep ----
  fixedUpdate(h) {
    const b = this.body, inp = this.input;
    const f = (inp.down('KeyW') || inp.down('ArrowUp') ? 1 : 0) - (inp.down('KeyS') || inp.down('ArrowDown') ? 1 : 0);
    const r = (inp.down('KeyD') || inp.down('ArrowRight') ? 1 : 0) - (inp.down('KeyA') || inp.down('ArrowLeft') ? 1 : 0);

    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    let wx = cy * r - sy * f;
    let wz = -sy * r - cy * f;
    const len = Math.hypot(wx, wz);
    const hasInput = len > 0;
    let tvx = 0, tvz = 0;
    if (hasInput) {
      const run = inp.down('ShiftLeft') || inp.down('ShiftRight');
      let speed = run ? P.runSpeed : P.walkSpeed;
      if (f < 0) speed *= P.backwardFactor;
      tvx = (wx / len) * speed;
      tvz = (wz / len) * speed;
    }

    const accel = b.onGround ? (hasInput ? P.groundAccel : P.groundDecel) : (hasInput ? P.airAccel : P.airDecel);
    const dx = tvx - b.vel.x, dz = tvz - b.vel.z;
    const dl = Math.hypot(dx, dz), maxD = accel * h;
    if (dl <= maxD) { b.vel.x = tvx; b.vel.z = tvz; }
    else { b.vel.x += (dx / dl) * maxD; b.vel.z += (dz / dl) * maxD; }

    // jump (with coyote time + input buffer)
    this.coyote = b.onGround ? P.coyoteTime : Math.max(0, this.coyote - h);
    if (this.jumpBuffer > 0 && this.coyote > 0) {
      b.vel.y = P.jumpSpeed;
      this.jumpBuffer = 0;
      this.coyote = 0;
      b.onGround = false;
    }
    this.prevVy = b.vel.y;
  }

  // call right after physics.step() each substep
  afterStep() {
    const b = this.body;
    if (!this.wasGround && b.onGround) {
      const impact = clamp(-this.prevVy, 0, 12);
      if (impact > 2) this.dipVel = -impact * 0.12;     // camera dips on landing
    }
    this.wasGround = b.onGround;
  }

  // ---- once per frame: camera / hands / character ----
  updateView(dt) {
    const b = this.body, cam = CONFIG.camera, inp = this.input;

    // look
    const look = inp.consumeLook();
    const sens = CONFIG.look.baseSensitivity * this.getSensitivity();
    this.targetYaw -= look.x * sens;
    this.targetPitch = clamp(this.targetPitch - look.y * sens, -CONFIG.look.maxPitch, CONFIG.look.maxPitch);
    const k = 1 - Math.exp(-CONFIG.look.smoothing * dt);
    const py = this.yaw, pp = this.pitch;
    this.yaw += (this.targetYaw - this.yaw) * k;
    this.pitch += (this.targetPitch - this.pitch) * k;
    const dYaw = this.yaw - py, dPitch = this.pitch - pp;

    // movement-derived animation values
    const hs = Math.hypot(b.vel.x, b.vel.z);
    const grounded = b.onGround;
    const moveTarget = grounded ? Math.min(1, hs / P.runSpeed) : 0;
    this.moveAmt += (moveTarget - this.moveAmt) * (1 - Math.exp(-10 * dt));
    this.runAmt = clamp((hs - P.walkSpeed) / (P.runSpeed - P.walkSpeed), 0, 1);
    if (grounded) this.phase += hs * dt * cam.bobFrequency;

    // landing spring
    this.dipVel += (-180 * this.dip - 22 * this.dipVel) * dt;
    this.dip += this.dipVel * dt;
    b.stepOffset += (0 - b.stepOffset) * (1 - Math.exp(-14 * dt));   // smooth stair steps

    const bobAmt = this.moveAmt * (1 + this.runAmt * 0.6);
    const bobY = Math.sin(this.phase * 2) * cam.bobAmount * bobAmt;
    const bobX = Math.cos(this.phase) * cam.swayAmount * bobAmt;

    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
    this.aimDir.set(-sy * cp, sp, -cy * cp);

    const eyeY = b.pos.y + this.character.eyeHeight + b.stepOffset + this.dip + bobY;
    this.eyePos.set(b.pos.x + cy * bobX, eyeY, b.pos.z - sy * bobX);

    // strafe tilt
    const strafe = (b.vel.x * cy - b.vel.z * sy) / P.runSpeed;
    this.roll += (-strafe * cam.tilt - this.roll) * (1 - Math.exp(-8 * dt));

    const camera = this.camera;
    camera.rotation.set(this.pitch, this.yaw, this.roll, 'YXZ');
    if (this.thirdPerson) {
      camera.position.copy(this.eyePos).addScaledVector(this.aimDir, -3);
      camera.position.y = Math.max(0.2, camera.position.y);
    } else {
      camera.position.copy(this.eyePos);
    }

    const fov = cam.fov + cam.runFovBoost * this.runAmt * (grounded ? 1 : 0.6);
    this.fov += (fov - this.fov) * (1 - Math.exp(-6 * dt));
    if (Math.abs(camera.fov - this.fov) > 0.01) { camera.fov = this.fov; camera.updateProjectionMatrix(); }

    // character body follows the physics body
    const ch = this.character;
    ch.root.position.set(b.pos.x, b.pos.y, b.pos.z);
    ch.root.rotation.y = this.yaw;
    ch.animateFeet(this.phase, this.moveAmt, !grounded, dt);

    const v = this.viewState;
    v.move = this.moveAmt; v.run = this.runAmt; v.phase = this.phase;
    v.vy = b.vel.y; v.grounded = grounded; v.dYaw = dYaw; v.dPitch = dPitch;
    return v;
  }

  toggleThirdPerson() {
    this.thirdPerson = !this.thirdPerson;
    this.character.setFirstPerson(!this.thirdPerson);
    if (this.thirdPerson) this.hands.detach(); else this.hands.attach();
  }
}
