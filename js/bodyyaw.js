// Body facing that is independent of the camera: the body only turns when you move,
// or when the camera twists further than `maxTwist` away from it (like a real neck).
// Used for the local player AND for remote players (derived from their camera yaw + speed),
// so everybody sees the same body orientation.
const TAU = Math.PI * 2;
export const wrapAngle = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };

export class BodyYaw {
  constructor(yaw = 0, maxTwist = 1.1) {
    this.yaw = yaw;
    this.maxTwist = maxTwist;
  }
  snap(yaw) { this.yaw = yaw; }
  update(camYaw, speed, dt) {
    let diff = wrapAngle(camYaw - this.yaw);
    if (speed > 0.4) {
      this.yaw += diff * (1 - Math.exp(-12 * dt));            // moving: face where you look
    } else {
      const lim = Math.max(-this.maxTwist, Math.min(this.maxTwist, diff));
      this.yaw += diff - lim;                                  // neck limit: body gets dragged along
      diff = wrapAngle(camYaw - this.yaw);
      this.yaw += diff * (1 - Math.exp(-1.4 * dt));            // idle: slowly square up
    }
    this.yaw = wrapAngle(this.yaw);
    return this.yaw;
  }
}
