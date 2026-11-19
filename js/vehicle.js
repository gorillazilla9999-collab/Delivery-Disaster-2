// Drivable car physics. No rendering code in here, so it runs headless in Node for the tests.
//
// How it fits the existing physics (there is NO second physics system):
//   * The chassis is one dynamic box `Body` in the normal PhysicsWorld. It collides with the ground, walls, crates,
//     barrels and the player through the same solver as everything else.
//   * Each wheel is a ray cast down from the chassis against STATIC scenery only (crates and barrels are bumped by the
//     chassis box, never "driven over"). Where the ray lands, a spring + damper pushes the chassis up and a tyre model
//     pushes it sideways / forwards. Those forces are applied as impulses right before physics.step().
//   * Tyres: slip-angle curve for sideways grip (peak, then falls to ~70% when sliding), a friction ellipse (hard braking
//     or accelerating reduces cornering grip), a lower coefficient for locked or spinning wheels. That is where
//     understeer, oversteer, power slides and handbrake drifts come from; nothing is scripted.
//
// Axes in car space: forward = -Z, right = +X, up = +Y (so yaw 0 faces -Z, like the camera).
import { Body } from './physics.js';
import { CONFIG } from './config.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => Math.round(v * 1000) / 1000;
const r4 = (v) => Math.round(v * 10000) / 10000;

export const WHEELS = ['FL', 'FR', 'RL', 'RR'];
export const NET_LEN = 24;     // numbers in a network state packet (see getNetState)
const IDLE_INPUT = { throttle: 0, steer: 0, handbrake: false };
const staticOnly = (b) => !b.dynamic;          // wheels only "see" static scenery

// Height of the chassis centre above the ground when the car stands still on its springs.
export function restHeightOf(cfg = CONFIG.vehicle) {
  const S = cfg.suspension, C = cfg.chassis, W = cfg.wheels;
  const compression = (C.mass * CONFIG.physics.gravity / 4) / S.stiffness;
  return W.radius + (S.maxLength - compression) - W.attachY;
}

// impulse J applied at world point p (same maths as PhysicsWorld.applyImpulse, without the wake/allocation overhead)
function impulseAt(b, jx, jy, jz, px, py, pz) {
  b.vel.x += jx * b.invMass; b.vel.y += jy * b.invMass; b.vel.z += jz * b.invMass;
  const c = b.c, R = b.R, I = b.invI;
  const rx = px - c[0], ry = py - c[1], rz = pz - c[2];
  const tx = ry * jz - rz * jy, ty = rz * jx - rx * jz, tz = rx * jy - ry * jx;
  const lx = (R[0] * tx + R[3] * ty + R[6] * tz) * I[0];
  const ly = (R[1] * tx + R[4] * ty + R[7] * tz) * I[1];
  const lz = (R[2] * tx + R[5] * ty + R[8] * tz) * I[2];
  b.angVel.x += R[0] * lx + R[1] * ly + R[2] * lz;
  b.angVel.y += R[3] * lx + R[4] * ly + R[5] * lz;
  b.angVel.z += R[6] * lx + R[7] * ly + R[8] * lz;
}

export class Vehicle {
  constructor({ physics, cfg = CONFIG.vehicle, spawn = cfg.spawn }) {
    this.cfg = cfg; this.physics = physics;
    this.id = cfg.id; this.name = cfg.name;
    const C = cfg.chassis, W = cfg.wheels;

    this.body = new Body({
      size: C.size, position: [spawn.x, restHeightOf(cfg), spawn.z], mass: C.mass, dynamic: true, baseOrigin: false,
      name: 'vehicle', friction: C.friction, restitution: C.restitution,
    });
    this.body.isVehicle = true;
    this.body.linDamp = C.linDamp; this.body.angDamp = C.angDamp;
    this.body.setQuat(0, Math.sin((spawn.yaw || 0) / 2), 0, Math.cos((spawn.yaw || 0) / 2));
    physics.add(this.body);

    const hx = W.track / 2;
    const mk = (name, front, side, z) => ({
      name, front, side, local: [side * hx, W.attachY, z],
      contact: false, length: cfg.suspension.maxLength, load: 0, normal: [0, 1, 0], point: [0, 0, 0],
      omega: 0, spin: 0, vl: 0, vs: 0, slipping: false, locked: false,
    });
    this.wheels = [mk('FL', true, -1, -W.frontZ), mk('FR', true, 1, -W.frontZ), mk('RL', false, -1, W.rearZ), mk('RR', false, 1, W.rearZ)];

    this.input = { throttle: 0, steer: 0, handbrake: false };      // set by the driver (-1..1, -1..1, bool)
    this.occupied = false;                                         // somebody is driving it (else the parking brake holds it)
    this.thr = 0; this.rev = 0; this.brk = 0; this.hand = 0; this.steerAngle = 0;
    this.time = 0; this.lastResetAt = -1e9; this.resetSeq = 0; this.lastYaw = spawn.yaw || 0;
    this.restTime = 0;                                             // seconds the car has been (nearly) motionless
    this._o = { x: 0, y: 0, z: 0 }; this._d = { x: 0, y: -1, z: 0 };

    // read-outs for the HUD, the model and the network
    this.speed = 0; this.forwardSpeed = 0; this.gear = 'N'; this.brakeLight = false; this.handbrakeOn = false;
    this.contacts = 0; this.flipped = false; this.upDot = 1; this.maxSlip = 0;
  }

  get kinematic() { return this.body.kinematic; }
  wake() { this.body.wake(); }

  // ---- placing ----
  // Put the car upright at (x, z) facing `yaw`, standing still. Used by reset, by "everybody starts from the same layout"
  // and when the server tells us where it is.
  place(x, z, yaw, lift = 0) {
    const b = this.body;
    b.pos.set(x, restHeightOf(this.cfg) + lift, z);
    b.vel.set(0, 0, 0); b.angVel.set(0, 0, 0);
    b.quat.set(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
    b.sleeping = false; b.sleepT = 0;
    b.updateBounds();
    this.steerAngle = 0; this.thr = this.rev = this.brk = this.hand = 0;
    for (const w of this.wheels) { w.omega = 0; w.length = this.cfg.suspension.maxLength; w.contact = false; w.slipping = false; }
    this.lastYaw = yaw; this.restTime = 0;
  }

  // Heading of the car (rotation about Y) in the same convention as the camera: yaw 0 faces -Z.
  yaw() {
    const R = this.body.R, fx = -R[2], fz = -R[8];
    if (fx * fx + fz * fz > 0.04) return Math.atan2(-fx, -fz);
    return this.lastYaw;                      // nose straight up/down: keep the last known heading
  }

  // ---- the physics, once per substep (call right before physics.step(h)) ----
  fixedUpdate(h) {
    const b = this.body, cfg = this.cfg;
    if (b.parked || b.kinematic) return;       // a car somebody else drives is moved by the network instead
    this.time += h;
    if (b.sleeping) {
      if (!this.occupied) return;              // asleep and untouched: nothing to do
      b.wake();
    }
    const S = cfg.suspension, T = cfg.tires, E = cfg.engine, B = cfg.brakes, St = cfg.steering, P = cfg.pedals, Rs = cfg.resistance, Wc = cfg.wheels;
    const R = b.R, c = b.c, m = b.mass, g = CONFIG.physics.gravity;
    const rx = R[0], ry = R[3], rz = R[6];                 // right
    const ux = R[1], uy = R[4], uz = R[7];                 // up
    const fx = -R[2], fy = -R[5], fz = -R[8];              // forward
    const vx = b.vel.x, vy = b.vel.y, vz = b.vel.z, wv = b.angVel;
    const vf = vx * fx + vy * fy + vz * fz;                // along the car
    const vsd = vx * rx + vy * ry + vz * rz;               // sideways

    // ---------- pedals ----------
    const inp = this.occupied ? this.input : IDLE_INPUT;
    let thr = 0, rev = 0, brk = 0;
    if (inp.throttle > 0.02) { if (vf < -P.reverseSwitchSpeed) brk = inp.throttle; else thr = inp.throttle; }      // W while rolling backwards = brake
    else if (inp.throttle < -0.02) { if (vf > P.reverseSwitchSpeed) brk = -inp.throttle; else rev = -inp.throttle; } // S while rolling forwards = brake
    const pedal = thr > 0 || rev > 0 || brk > 0;
    if (!this.occupied) brk = Math.max(brk, B.idleBrake);                       // nobody inside: the car brakes itself to a stop
    else if (!pedal && !inp.handbrake && Math.abs(vf) < B.holdSpeed) brk = Math.max(brk, B.holdBrake);   // hill hold
    const up = (cur, target, a, d) => (target > cur ? Math.min(target, cur + a) : Math.max(target, cur - d));
    this.thr = up(this.thr, thr, P.throttleUp * h, P.throttleDown * h);
    this.rev = up(this.rev, rev, P.throttleUp * h, P.throttleDown * h);
    this.brk = up(this.brk, brk, B.ramp * h, B.ramp * 1.5 * h);
    this.hand = up(this.hand, inp.handbrake ? 1 : 0, 14 * h, 14 * h);
    const handLock = this.hand > 0.6;

    // ---------- steering: less lock at speed, counter-steer assist when the car slides ----------
    const lockLim = St.maxLock + (St.minLock - St.maxLock) * smooth(St.lockSpeedLow, St.lockSpeedHigh, Math.abs(vf));
    let target = inp.steer * lockLim;
    let sliding = 0;
    if (St.counterSteer > 0 && vf > -1 && Math.hypot(vf, vsd) > 4) {
      const beta = Math.atan2(vsd, Math.max(vf, 0));       // > 0: the car travels towards its right side
      sliding = smooth(0.1, 0.35, Math.abs(beta));
      target += St.counterSteer * beta * sliding;
    }
    const lim = Math.max(lockLim, 0.4 + 0.15 * sliding);
    target = clamp(target, -lim, lim);
    const rate = St.rate + (St.rateHigh - St.rate) * smooth(4, 30, Math.abs(vf));
    const step = (Math.abs(target) < Math.abs(this.steerAngle) ? St.returnRate : rate) * h;
    this.steerAngle += clamp(target - this.steerAngle, -step, step);

    // ---------- engine ----------
    let Fe = 0;
    if (this.thr > 0) Fe = this.thr * Math.min(E.launchForce, E.power / Math.max(vf, 2.5)) * (1 - smooth(0.88 * E.maxSpeed, E.maxSpeed, vf));
    else if (this.rev > 0) Fe = -this.rev * Math.min(E.reverseForce, E.reversePower / Math.max(-vf, 2)) * (1 - smooth(0.8 * E.reverseMaxSpeed, E.reverseMaxSpeed, -vf));
    const coasting = this.thr < 0.02 && this.rev < 0.02;
    const brakeTotal = this.brk * B.force;

    // ---------- wheels ----------
    const maxLen = S.maxLength + Wc.radius;
    const dirD = this._d; dirD.x = -ux; dirD.y = -uy; dirD.z = -uz;
    const Bshape = Math.tan(Math.PI / (2 * T.shapeC)) / T.slipPeak;           // makes the slip-angle curve peak at slipPeak
    const mc = m * 0.25;                                                       // mass each wheel "carries" for the no-overshoot clamps
    const maxSusp = S.maxForceG * m * g;
    let contacts = 0, maxSlip = 0;

    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i], L = w.local;
      const ax = c[0] + R[0] * L[0] + R[1] * L[1] + R[2] * L[2];
      const ay = c[1] + R[3] * L[0] + R[4] * L[1] + R[5] * L[2];
      const az = c[2] + R[6] * L[0] + R[7] * L[1] + R[8] * L[2];
      const o = this._o; o.x = ax; o.y = ay; o.z = az;
      const hit = this.physics.raycast(o, dirD, maxLen, b, staticOnly);
      let grounded = false, n = null, cosA = 1;
      if (hit) { n = hit.normal; cosA = n[0] * ux + n[1] * uy + n[2] * uz; grounded = cosA > 0.25; }   // a wall is not a road
      w.contact = grounded; w.slipping = false; w.locked = false;

      if (!grounded) {                                                           // in the air: the wheel droops and free-spins
        w.length = Math.min(S.maxLength, w.length + 1.5 * h);
        w.load = 0;
        w.omega *= Math.exp(-0.3 * h);
        if (!w.front || E.driveFront > 0) w.omega += (Fe > 0 ? 1 : Fe < 0 ? -1 : 0) * 40 * Math.min(1, Math.abs(Fe) / E.launchForce) * h;
        continue;
      }
      contacts++;

      // contact point + its velocity
      const dist = hit.dist;
      const px = ax - ux * dist, py = ay - uy * dist, pz = az - uz * dist;
      const rpx = px - c[0], rpy = py - c[1], rpz = pz - c[2];
      const vpx = vx + wv.y * rpz - wv.z * rpy, vpy = vy + wv.z * rpx - wv.x * rpz, vpz = vz + wv.x * rpy - wv.y * rpx;

      // suspension: spring + damper (+ bump stop) along the surface normal
      const len = dist - Wc.radius;
      w.length = clamp(len, S.minLength, S.maxLength);
      const compRate = -(vpx * n[0] + vpy * n[1] + vpz * n[2]) / cosA;           // m/s, positive while compressing
      let F = S.stiffness * Math.max(0, S.maxLength - len) / cosA + (compRate > 0 ? S.damperCompress : S.damperRebound) * compRate;
      const over = S.minLength + S.bumpMargin - len;
      if (over > 0) F += S.bumpStop * over;
      F = clamp(F, 0, maxSusp);
      w.load = F; w.normal = n; w.point[0] = px; w.point[1] = py; w.point[2] = pz;
      impulseAt(b, n[0] * F * h, n[1] * F * h, n[2] * F * h, px, py, pz);
      const N = F;
      if (N < 1) { w.omega += ((vpx * fx + vpy * fy + vpz * fz) / Wc.radius - w.omega) * 0.2; continue; }

      // wheel frame on the ground plane: forward (steered for the front wheels) and right
      const sd = w.front ? this.steerAngle : 0, cs = Math.cos(sd), sn = Math.sin(sd);
      let tx = fx * cs + rx * sn, ty = fy * cs + ry * sn, tz = fz * cs + rz * sn;
      const dn = tx * n[0] + ty * n[1] + tz * n[2];
      tx -= n[0] * dn; ty -= n[1] * dn; tz -= n[2] * dn;
      const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      const sx = ty * n[2] - tz * n[1], sy = tz * n[0] - tx * n[2], sz = tx * n[1] - ty * n[0];
      const vl = vpx * tx + vpy * ty + vpz * tz, vs = vpx * sx + vpy * sy + vpz * sz;
      w.vl = vl; w.vs = vs;

      // longitudinal demand: engine - brakes - resistance (the brake/resistance can never reverse the wheel in one step)
      const handWheel = !w.front && handLock;
      let Fd = handWheel ? 0 : Fe * (w.front ? E.driveFront : 1 - E.driveFront) * 0.5;
      const Fb = brakeTotal * (w.front ? B.frontBias : 1 - B.frontBias) * 0.5;
      let Fres = Fb + Rs.rolling * N + (coasting ? Rs.engineBrake * 0.25 : 0);
      Fres = Math.min(Fres, mc * Math.abs(vl) / h);
      let Fx = Fd - (vl >= 0 ? 1 : -1) * Fres;
      const FxMax = T.muLong * N, FyMax = T.mu * N;
      let Fy = 0, slip = false;

      if (handWheel) {
        // handbrake: the rear tyres are asked for (almost) all the grip they have lengthways, so the friction ellipse leaves
        // them only about half of their sideways grip. The tail steps out, but the tyres keep pulling it back: a drift, not a spin.
        const vp = Math.hypot(vl, vs);
        Fx = -Math.sign(vl) * Math.min(B.handbrake * FxMax, mc * Math.abs(vl) / h);
        slip = vp > 3;
        w.locked = true;
        const alpha = Math.atan2(Math.abs(vs), Math.abs(vl) + T.lowSpeed);
        Fy = -Math.sign(vs) * FyMax * Math.sin(T.shapeC * Math.atan(Bshape * alpha));
        const cap = mc * Math.abs(vs) / h;
        if (Math.abs(Fy) > cap) Fy = Math.sign(Fy) * cap;
        const ex = Fx / FxMax, ey = Fy / FyMax, e2 = ex * ex + ey * ey;
        if (e2 > 1) { const k = 1 / Math.sqrt(e2); Fx *= k; Fy *= k; }
      } else {
        if (Math.abs(Fx) > FxMax) {                                              // brakes have ABS; a spinning wheel loses a little grip
          const spinning = Math.abs(Fd) > FxMax;
          slip = spinning;
          Fx = Math.sign(Fx) * FxMax * (spinning ? 0.9 : 1);
        }
        const alpha = Math.atan2(Math.abs(vs), Math.abs(vl) + T.lowSpeed);       // slip angle (softened at walking pace)
        Fy = -Math.sign(vs) * FyMax * Math.sin(T.shapeC * Math.atan(Bshape * alpha));
        const cap = mc * Math.abs(vs) / h;                                       // tyres can stop sideways motion, not reverse it
        if (Math.abs(Fy) > cap) Fy = Math.sign(Fy) * cap;
        const ex = Fx / FxMax, ey = Fy / FyMax, e2 = ex * ex + ey * ey;          // friction ellipse: grip is shared
        if (e2 > 1) { const k = 1 / Math.sqrt(e2); Fx *= k; Fy *= k; slip = slip || e2 > 1.15; }
        if (alpha > T.slipPeak * 1.3) slip = true;
      }
      w.slipping = slip;
      if (slip) maxSlip = Math.max(maxSlip, Math.abs(vs));

      // apply: drive/brake at the contact patch, cornering force at a height near the centre of mass (limits body roll)
      impulseAt(b, tx * Fx * h, ty * Fx * h, tz * Fx * h, px, py, pz);
      impulseAt(b, sx * Fy * h, sy * Fy * h, sz * Fy * h, px, c[1] + (py - c[1]) * T.rollInfluence, pz);

      // visual wheel speed: rolls with the ground, locks with the handbrake, spins up when the engine overpowers the tyre
      let wt = handWheel ? 0 : vl / Wc.radius;
      if (!handWheel && Math.abs(Fd) > FxMax) wt += Math.sign(Fd) * 25;
      w.omega += (wt - w.omega) * (1 - Math.exp(-30 * h));
    }

    // drag on the whole car
    const spd = Math.hypot(vx, vy, vz);
    if (spd > 0.01) { const k = Rs.cdA * spd / m * h; b.vel.x -= vx * k; b.vel.y -= vy * k; b.vel.z -= vz * k; }

    this.contacts = contacts; this.maxSlip = maxSlip;
    b.supported = contacts >= 3;                // lets a parked car fall asleep even though its box never touches the ground
  }

  // ---- after physics.step(): read-outs ----
  afterStep() {
    const b = this.body, R = b.R;
    this.forwardSpeed = b.vel.x * -R[2] + b.vel.y * -R[5] + b.vel.z * -R[8];
    this.speed = Math.hypot(b.vel.x, b.vel.z);
    this.upDot = R[4];
    this.flipped = this.upDot < this.cfg.flipUpDot;
    if (this.upDot > 0.7) this.lastYaw = this.yaw();
    this.brakeLight = this.brk > 0.12 || this.hand > 0.5;
    this.handbrakeOn = this.hand > 0.5;
    const reversing = this.rev > 0.05 || this.forwardSpeed < -0.5;
    if (Math.abs(this.forwardSpeed) < 0.4 && this.thr < 0.05 && this.rev < 0.05) this.gear = 'N';
    else this.gear = reversing ? 'R' : 'D';
  }
  // call once per FRAME (any car, local or network-driven): advances the visual wheel rotation
  tickWheels(dt) { for (const w of this.wheels) w.spin = (w.spin + w.omega * dt) % TAU; }
  // call once per frame for the car this client simulates: counts how long it has been at rest
  tickRest(dt) {
    const b = this.body;
    if (b.kinematic || b.parked) { this.restTime = 0; return; }
    if (b.sleeping || (b.vel.length() < 0.12 && b.angVel.length() < 0.2 && this.contacts >= 3)) this.restTime += dt; else this.restTime = 0;
  }

  // ---- overturned cars ----
  canReset() { return this.time - this.lastResetAt >= this.cfg.reset.cooldown; }
  // Stand the car back up at (x, z) heading `yaw`. The caller has checked the spot is free (see findSafeSpot); the car is put
  // down gently with zero velocity, so nothing it touches gets shoved.
  reset(x, z, yaw) {
    this.place(x, z, yaw, this.cfg.reset.lift);
    this.resetSeq++;
    this.lastResetAt = this.time;
  }

  // ---- network ----
  // [x,y,z, qx,qy,qz,qw, vx,vy,vz, wx,wy,wz, steer, wheelRate x4, suspensionLength x4, flags, resetSeq]
  // flags: bit0 handbrake, bit1 brake lights, bit2 reversing, bits4-7 wheel i is skidding
  getNetState() {
    const b = this.body, q = b.quat, W = this.wheels;
    let flags = (this.handbrakeOn ? 1 : 0) | (this.brakeLight ? 2 : 0) | (this.gear === 'R' ? 4 : 0);
    for (let i = 0; i < 4; i++) if (W[i].slipping) flags |= 16 << i;
    return [
      r3(b.pos.x), r3(b.pos.y), r3(b.pos.z), r4(q.x), r4(q.y), r4(q.z), r4(q.w),
      r3(b.vel.x), r3(b.vel.y), r3(b.vel.z), r3(b.angVel.x), r3(b.angVel.y), r3(b.angVel.z), r3(this.steerAngle),
      r1(W[0].omega), r1(W[1].omega), r1(W[2].omega), r1(W[3].omega),
      r3(W[0].length), r3(W[1].length), r3(W[2].length), r3(W[3].length), flags, this.resetSeq,
    ];
  }
  // wheel/lights part of a received state (the pose itself is applied by VehicleSync)
  applyNetLook(s) {
    this.steerAngle = s[13];
    for (let i = 0; i < 4; i++) { this.wheels[i].omega = s[14 + i]; this.wheels[i].length = s[18 + i]; this.wheels[i].slipping = !!(s[22] & (16 << i)); }
    this.handbrakeOn = !!(s[22] & 1); this.brakeLight = !!(s[22] & 2);
    this.gear = (s[22] & 4) ? 'R' : (Math.hypot(s[7], s[9]) < 0.4 ? 'N' : 'D');
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Finding somewhere safe to put the car (reset) or the player (leaving the car).
// ---------------------------------------------------------------------------------------------------------------------

// Is a footprint (an oriented rectangle, half sizes hx/hz, heading yaw) free of everything solid between heights y0..y1?
// `ignore` = bodies to skip (the car itself). `points` = extra things to keep clear of, e.g. other players [{x,z}].
export function footprintFree(physics, x, z, yaw, hx, hz, { ignore = [], points = [], pointRadius = 0.7, y0 = 0.05, y1 = 1.9, margin = 0.15 } = {}) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const ex = Math.abs(c) * hx + Math.abs(s) * hz + margin, ez = Math.abs(s) * hx + Math.abs(c) * hz + margin;   // AABB of the rotated rectangle
  for (const b of physics.all) {
    if (b.parked || b.noCollide || ignore.includes(b)) continue;
    if (b.max.y <= 0.03) continue;                                  // the ground slab
    if (b.max.x < x - ex || b.min.x > x + ex || b.max.z < z - ez || b.min.z > z + ez) continue;
    if (b.max.y < y0 || b.min.y > y1) continue;
    return false;
  }
  for (const p of points) {                                         // people: distance to the rectangle
    const dx = p.x - x, dz = p.z - z;
    const lx = dx * c - dz * s, lz = dx * s + dz * c;               // into car space (yaw about +Y)
    const qx = Math.max(Math.abs(lx) - hx, 0), qz = Math.max(Math.abs(lz) - hz, 0);
    if (Math.hypot(qx, qz) < pointRadius) return false;
  }
  return true;
}

// A spot to stand the car back up: right where it is if that is free, otherwise the nearest free spot (rings of
// candidates), otherwise its home. Returns { x, z, yaw, moved } or null if nothing within reach is free.
export function findResetSpot(vehicle, { points = [], home = null } = {}) {
  const cfg = vehicle.cfg, [sx, , sz] = cfg.chassis.size, hx = sx / 2 + 0.05, hz = sz / 2 + 0.05;
  const b = vehicle.body, yaw = vehicle.yaw(), ignore = [b];
  const px = b.pos.x, pz = b.pos.z, LIM = CONFIG.world.limit - 3;
  const ok = (x, z, a) => Math.abs(x) < LIM && Math.abs(z) < LIM && footprintFree(vehicle.physics, x, z, a, hx, hz, { ignore, points, pointRadius: 1.0, y0: 0.05, y1: 1.6 });
  if (ok(px, pz, yaw)) return { x: px, z: pz, yaw, moved: 0 };
  const R = cfg.reset;
  for (let ring = 1; ring <= 6; ring++) {
    const r = 1.5 + ring * ((R.searchRadius - 1.5) / 6);
    const n = 8 + ring * 2;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * TAU + ring * 0.4;
      const x = px + Math.cos(a) * r, z = pz + Math.sin(a) * r;
      if (Math.hypot(x - px, z - pz) <= R.maxDistance && ok(x, z, yaw)) return { x, z, yaw, moved: r };
    }
  }
  if (home && ok(home.x, home.z, home.yaw || 0)) return { x: home.x, z: home.z, yaw: home.yaw || 0, moved: Math.hypot(home.x - px, home.z - pz) };
  return null;
}

// Where can the player get out? Tries the driver's door, the other side, then the back and front. Returns {x, y, z} or null.
// The spot must be clear of solid things, other people, and have static ground under it (not a ravine / not the roof of something tall).
export function findExitSpot(vehicle, { points = [] } = {}) {
  const cfg = vehicle.cfg, b = vehicle.body, R = b.R;
  const E = cfg.exitClearance, hw = cfg.chassis.size[0] / 2, hl = cfg.chassis.size[2] / 2;
  const rx = R[0], rz = R[6], fx = -R[2], fz = -R[8];
  const hr = Math.hypot(rx, rz) || 1, hf = Math.hypot(fx, fz) || 1;
  const rgt = [rx / hr, rz / hr], fwd = [fx / hf, fz / hf];
  const cand = [];
  for (const d of [0.9, 1.4]) { cand.push([-(hw + d), 0]); cand.push([hw + d, 0]); }          // driver's side (left) first
  cand.push([-(hw + 0.9), 1.4], [hw + 0.9, 1.4], [-(hw + 0.9), -1.4], [hw + 0.9, -1.4]);
  cand.push([0, hl + 1.0], [0, -(hl + 1.0)], [-(hw + 2.0), 0], [hw + 2.0, 0]);                  // behind, in front, further out
  const ignore = [b];
  for (const [sx, sf] of cand) {
    const x = b.pos.x + rgt[0] * sx + fwd[0] * sf, z = b.pos.z + rgt[1] * sx + fwd[1] * sf;
    if (Math.abs(x) > CONFIG.world.limit - 1 || Math.abs(z) > CONFIG.world.limit - 1) continue;
    // ground below: a static surface within a step of the car's floor
    const hit = vehicle.physics.raycast({ x, y: 1.2, z }, { x: 0, y: -1, z: 0 }, 2.6, b, staticOnly);
    if (!hit) continue;
    const y = 1.2 - hit.dist;
    if (hit.normal[1] < 0.8 || y < -0.05 || y > 0.9) continue;
    if (!footprintFree(vehicle.physics, x, z, 0, E.radius, E.radius, { ignore, points, pointRadius: 0.8, y0: y + 0.35, y1: y + E.height, margin: 0.05 })) continue;
    return { x, y: Math.max(0, y), z };
  }
  return null;
}
