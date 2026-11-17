// First-person player: input -> physics body, camera, head bob, character sync.
import * as THREE from 'three';
import { CONFIG } from './config.js';
import { Body } from './physics.js';
import { BodyYaw } from './bodyyaw.js';

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
      baseOrigin: true, lockRotation: true, friction: 0, restitution: 0,   // legs set the ground speed, so no contact friction
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
    this.carryMass = 0;                    // kg held in the hands: slows walking and jumping
    this.ko = false; this.koAmt = 0;       // knocked out: no control, camera lies on the ground
    this.knockT = 0;                       // brief loss of control after being punched
    this.bodyYaw = new BodyYaw(0);          // camera-independent body facing

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

    // punched / knocked out: no steering, just slide and tumble with friction
    if (this.ko || this.knockT > 0) {
      this.knockT = Math.max(0, this.knockT - h);
      this.jumpBuffer = 0;
      if (b.onGround) {
        const sp = Math.hypot(b.vel.x, b.vel.z), ns = Math.max(0, sp - (this.ko ? 16 : 10) * h);
        const k = sp > 0 ? ns / sp : 0;
        b.vel.x *= k; b.vel.z *= k;
      }
      this.prevVy = b.vel.y;
      return;
    }

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
      speed /= 1 + P.carrySlow * this.carryMass;                       // a heavy load slows you down
      tvx = (wx / len) * speed;
      tvz = (wz / len) * speed;
    }

    let accel = b.onGround ? (hasInput ? P.groundAccel : P.groundDecel) : (hasInput ? P.airAccel : P.airDecel);
    if (b.pushing && hasInput) accel = Math.min(accel, P.pushForce / P.mass);     // shoving a crate: legs only push so hard
    const dx = tvx - b.vel.x, dz = tvz - b.vel.z;
    const dl = Math.hypot(dx, dz), maxD = accel * h;
    if (dl <= maxD) { b.vel.x = tvx; b.vel.z = tvz; }
    else { b.vel.x += (dx / dl) * maxD; b.vel.z += (dz / dl) * maxD; }

    // jump (with coyote time + input buffer)
    this.coyote = b.onGround ? P.coyoteTime : Math.max(0, this.coyote - h);
    if (this.jumpBuffer > 0 && this.coyote > 0) {
      b.vel.y = P.jumpSpeed / Math.sqrt(1 + P.carrySlow * this.carryMass);     // carrying something heavy: lower jump
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
    if (this.ko) { look.x = 0; look.y = 0; }               // can't look around while out cold
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

    this.koAmt += ((this.ko ? 1 : 0) - this.koAmt) * (1 - Math.exp(-6 * dt));
    const standEye = b.pos.y + this.character.eyeHeight + b.stepOffset + this.dip + bobY;
    const eyeY = standEye + (b.pos.y + 0.3 - standEye) * this.koAmt;
    this.eyePos.set(b.pos.x + cy * bobX, eyeY, b.pos.z - sy * bobX);

    // strafe tilt
    const strafe = (b.vel.x * cy - b.vel.z * sy) / P.runSpeed;
    this.roll += (-strafe * cam.tilt - this.roll) * (1 - Math.exp(-8 * dt));

    const camera = this.camera;
    camera.rotation.set(this.pitch, this.yaw, this.roll + this.koAmt * 1.35, 'YXZ');
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
    ch.root.rotation.y = this.bodyYaw.update(this.yaw, hs, dt);
    ch.animateFeet(this.phase, this.moveAmt, !grounded, dt);

    const v = this.viewState;
    v.move = this.moveAmt; v.run = this.runAmt; v.phase = this.phase;
    v.vy = b.vel.y; v.grounded = grounded; v.dYaw = dYaw; v.dPitch = dPitch;
    return v;
  }

  // Used by multiplayer to place the player at a spawn slot.
  teleport(x, z, yaw = this.targetYaw) {
    const b = this.body;
    b.pos.set(x, 0, z); b.vel.set(0, 0, 0); b.stepOffset = 0; b.wake();
    this.yaw = this.targetYaw = yaw;
    this.bodyYaw.snap(yaw);
    b.updateBounds();
  }

  // Punched: shoved away from the attacker, briefly out of control.
  knock(dx, dz, speed, lift) {
    const b = this.body;
    b.vel.x = dx * speed; b.vel.z = dz * speed;
    b.vel.y = Math.max(b.vel.y, lift);
    b.onGround = false;
    this.knockT = 0.4;
  }
  setKnockedOut(on) { this.ko = on; if (on) this.knockT = 0; }

  toggleThirdPerson() {
    this.thirdPerson = !this.thirdPerson;
    this.character.setFirstPerson(!this.thirdPerson);
    if (this.thirdPerson) this.hands.detach(); else this.hands.attach();
  }
}
