// Third-person follow camera for the car. Pure maths (no THREE): it produces a position, a look-at point and a field of view,
// and the vehicle system applies them to the real camera. That keeps it testable headless.
//   * swings in behind the car with a little lag (and follows the direction of TRAVEL a bit, so a drift looks like a drift)
//   * pulls back, rises and widens the field of view with speed
//   * mouse looks around the car and eases back behind it
//   * never goes through walls: a ray from the car to the camera shortens the camera arm (in fast, out slowly)
import { CONFIG } from './config.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };
const staticOnly = (b) => !b.dynamic;

export class VehicleCamera {
  constructor(cfg = CONFIG.vehicle.camera) {
    this.cfg = cfg;
    this.yaw = 0; this.orbitYaw = 0; this.orbitPitch = 0; this.idle = 99;
    this.arm = cfg.distance;                          // current length of the camera arm (shortened near walls)
    this.pos = { x: 0, y: 2, z: 0 }; this.look = { x: 0, y: 1, z: 0 }; this.fov = cfg.fov;
    this.collided = false;
  }

  // st: { x, y, z, yaw, vx, vz, speed, forwardSpeed }
  snap(st) {
    this.yaw = st.yaw; this.orbitYaw = 0; this.orbitPitch = 0; this.idle = 99; this.arm = this.cfg.distance; this.fov = this.cfg.fov;
    this.update(0.0001, st, null, null);
  }

  // mouse movement in radians (positive x = look right)
  orbit(dx, dy) {
    if (!this.cfg.mouseOrbit || (!dx && !dy)) return;
    this.orbitYaw = clamp(this.orbitYaw + dx, -Math.PI, Math.PI);
    this.orbitPitch = clamp(this.orbitPitch + dy, -0.35, 0.9);
    this.idle = 0;
  }

  update(dt, st, physics, ignoreBody) {
    const c = this.cfg, E = CONFIG.vehicle.engine;
    // where the camera "thinks behind" is: the car's heading, nudged toward its direction of travel at speed
    let target = st.yaw;
    if (st.forwardSpeed > 3) {
      const vyaw = Math.atan2(-st.vx, -st.vz);
      target = st.yaw + wrap(vyaw - st.yaw) * c.velocityFollow * smooth(5, 15, st.speed);
    }
    this.yaw += wrap(target - this.yaw) * (1 - Math.exp(-c.yawFollow * dt));

    this.idle += dt;
    if (this.idle > c.orbitReturnDelay) {
      const k = Math.exp(-c.orbitReturnRate * dt);
      this.orbitYaw *= k; this.orbitPitch *= k;
    }

    const sp = clamp(st.speed / E.maxSpeed, 0, 1);
    const dist = c.distance + c.distanceSpeed * sp, height = c.height + c.heightSpeed * sp;
    const elev = Math.atan2(height, dist) + this.orbitPitch, arm = Math.hypot(dist, height);
    const yaw = this.yaw + this.orbitYaw;
    const tx = st.x + st.vx * c.lookAhead * 0.2, ty = st.y + c.lookHeight, tz = st.z + st.vz * c.lookAhead * 0.2;   // look at the car, a touch ahead of it
    const dx = Math.sin(yaw) * Math.cos(elev), dy = Math.sin(elev), dz = Math.cos(yaw) * Math.cos(elev);          // unit vector from the car to the camera

    // walls: shorten the arm so the camera stays in front of them
    let want = arm; this.collided = false;
    if (physics) {
      const hit = physics.raycast({ x: tx, y: ty, z: tz }, { x: dx, y: dy, z: dz }, arm + c.collisionPad, ignoreBody, staticOnly);
      if (hit && hit.body) { want = Math.max(c.minDistance, Math.min(arm, hit.dist - c.collisionPad)); this.collided = want < arm; }
    }
    const k = 1 - Math.exp(-(want < this.arm ? c.distIn : c.distOut) * dt);
    this.arm += (want - this.arm) * k;
    if (want < this.arm) this.arm = want;                    // never let a wall be between us and the car for even a frame

    this.pos.x = tx + dx * this.arm; this.pos.y = Math.max(0.35, ty + dy * this.arm); this.pos.z = tz + dz * this.arm;
    this.look.x = tx; this.look.y = ty; this.look.z = tz;
    this.fov += (c.fov + c.fovSpeed * sp - this.fov) * (1 - Math.exp(-3 * dt));
  }
}
