// Snapshot interpolation helpers. Pure functions/classes (no Three.js) so they can be unit-tested.

export function lerpAngle(a, b, t) {
  const TAU = Math.PI * 2;
  const d = ((((b - a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  return a + d * t;
}

// Estimates "server time" on the client. offset = localNow - serverTime.
// Jumps down immediately to faster packets, drifts up slowly (handles clock drift/jitter).
export class ClockSync {
  constructor() { this.offset = null; }
  update(serverTs, localNow) {
    const sample = localNow - serverTs;
    if (this.offset === null || sample < this.offset) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.02;
  }
  renderTime(localNow, delayMs) {
    return this.offset === null ? null : localNow - this.offset - delayMs;
  }
}

const LERP_FIELDS = ['x', 'y', 'z', 'pitch', 'vx', 'vz'];
const ANGLE_FIELDS = ['yaw', 'byaw'];

// Per-remote-player buffer of timestamped states. sample(t) returns the smoothly interpolated state.
export class SnapshotBuffer {
  constructor({ extrapolateMs = 150, teleportDist = 8, maxLength = 60 } = {}) {
    this.list = [];
    this.extrapolateMs = extrapolateMs;
    this.teleportDist = teleportDist;
    this.maxLength = maxLength;
  }

  push(state) {
    const last = this.list[this.list.length - 1];
    if (last && state.ts <= last.ts) return;       // ignore out-of-order / duplicate packets
    this.list.push(state);
    if (this.list.length > this.maxLength) this.list.shift();
  }

  get latest() { return this.list[this.list.length - 1] || null; }

  sample(t) {
    const L = this.list;
    if (!L.length) return null;
    if (t <= L[0].ts) return { ...L[0] };
    const last = L[L.length - 1];
    if (t >= last.ts) {
      // No newer data yet: coast along the last known velocity for a short time, then hold.
      const dt = Math.min(t - last.ts, this.extrapolateMs) / 1000;
      return { ...last, x: last.x + last.vx * dt, z: last.z + last.vz * dt };
    }
    let i = L.length - 1;
    while (i > 0 && L[i - 1].ts > t) i--;
    const a = L[i - 1], b = L[i];
    const span = b.ts - a.ts || 1;
    const k = (t - a.ts) / span;
    if (Math.hypot(b.x - a.x, b.z - a.z) > this.teleportDist) return { ...(k < 0.5 ? a : b) };
    const out = { ...a };
    for (const f of LERP_FIELDS) out[f] = a[f] + (b[f] - a[f]) * k;
    for (const f of ANGLE_FIELDS) out[f] = lerpAngle(a[f], b[f], k);
    out.ts = t;
    return out;
  }
}
