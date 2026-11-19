// Server-side vehicle logic (pure: no sockets in here, so it can be unit-tested).
//
// The server never simulates a car. What it DOES own is the answer to "who may control it":
//   driver  = the one player seated at the wheel (at most one; only the server can change it)
//   owner   = the one client whose physics is authoritative for the car and who may stream its state. While somebody is
//             driving, the owner is the driver. After they get out, the car may still be rolling, so they stay its owner
//             until it has stopped (then they release it). If the owner leaves, the host takes over a moving car.
// Everything a client sends is checked: it must come from the owner, be well-formed, clamped, and physically plausible
// (no teleporting) - nobody can overwrite a car they do not own.
'use strict';

// Keep `home` in sync with CONFIG.vehicle.spawn in js/config.js (npm test checks it).
const VEHICLES = [{ id: 'car1', name: 'Courier Hatch', home: [6, 16] }];

const LIMITS = {
  worldLimit: 100,
  enterRange: 6,            // m between the player's last known position and the car (client range is ~2.3 m from the body; lag slack)
  enterMaxSpeed: 5,         // m/s: you cannot hop into a car that is flying past
  enterCooldownMs: 300,     // per player, against enter/exit spam
  minUpdateMs: 15,          // per player (~66/s max)
  maxSpeed: 70,             // m/s the car may plausibly travel at
  jumpSlack: 2.5,           // m of extra distance allowed between two updates (on top of speed * time)
  resetCooldownMs: 1500,
  resetMaxDist: 16,         // m a reset may move the car...
  resetHomeDist: 4,         // ...or it may put it back at its home
  handoverSpeed: 1,         // m/s: a car faster than this is handed to the host when its owner leaves
};

// state packet: [x,y,z, qx,qy,qz,qw, vx,vy,vz, wx,wy,wz, steer, wheelRate x4, suspensionLength x4, flags, resetSeq]
const STATE_LEN = 24;

const num = (v, lo, hi, fb = 0) => { v = Number(v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb; };

function createVehicles() {
  const m = new Map();
  for (const d of VEHICLES) m.set(d.id, { id: d.id, name: d.name, home: d.home.slice(), driver: null, owner: null, s: null, at: 0, lastResetAt: 0 });
  return m;
}

const posOf = (v) => (v.s ? [v.s[0], v.s[2]] : v.home);
const speedOf = (v) => (v.s ? Math.hypot(v.s[7], v.s[9]) : 0);

// what clients are told about a vehicle
function describe(room, v) {
  const d = v.driver && room.players.get(v.driver);
  return { id: v.id, name: v.name, driver: v.driver, driverName: d ? d.name : null, owner: v.owner, s: v.s };
}
const init = (room) => [...room.vehicles.values()].map((v) => describe(room, v));
const drivenBy = (room, playerId) => { for (const v of room.vehicles.values()) if (v.driver === playerId) return v; return null; };

// ---- entering / leaving the driver's seat ----
function enter(room, playerId, vehicleId, now = Date.now()) {
  const v = room.vehicles.get(String(vehicleId));
  const p = room.players.get(playerId);
  if (!v || !p) return { error: 'NO_VEHICLE', message: 'There is no such vehicle.' };
  if (now < (p.koUntil || 0)) return { error: 'KO', message: 'You cannot drive while knocked out.' };
  if (now - (p.lastVehicleAt || 0) < LIMITS.enterCooldownMs) return { error: 'RATE', message: 'Not so fast.' };
  p.lastVehicleAt = now;
  if (drivenBy(room, playerId)) return { error: 'ALREADY', message: 'You are already driving.' };
  if (v.driver) return { error: 'TAKEN', message: v.driver === playerId ? 'You are already driving.' : 'Somebody is already driving that.' };
  if (!p.state) return { error: 'NO_STATE', message: 'Try again in a moment.' };
  const [vx, vz] = posOf(v);
  if (Math.hypot(p.state[0] - vx, p.state[2] - vz) > LIMITS.enterRange) return { error: 'TOO_FAR', message: 'You are too far from the vehicle.' };
  if (speedOf(v) > LIMITS.enterMaxSpeed) return { error: 'TOO_FAST', message: 'It is moving too fast to get into.' };
  v.driver = playerId; v.owner = playerId; v.at = now;
  return { ok: true, vehicle: v, info: describe(room, v) };
}

function exit(room, playerId, vehicleId, now = Date.now()) {
  const v = room.vehicles.get(String(vehicleId));
  if (!v || v.driver !== playerId) return { error: 'NOT_DRIVER', message: 'You are not driving that.' };
  const p = room.players.get(playerId); if (p) p.lastVehicleAt = now;
  v.driver = null;                       // owner stays: the car may still be rolling, and its owner simulates that
  return { ok: true, vehicle: v, info: describe(room, v) };
}

// ---- state streaming (owner only) ----
function sanitize(raw) {
  if (!Array.isArray(raw) || raw.length < STATE_LEN) return null;
  const s = [];
  const W = LIMITS.worldLimit;
  s.push(num(raw[0], -W, W), num(raw[1], -5, 60), num(raw[2], -W, W));
  let q = [num(raw[3], -1, 1), num(raw[4], -1, 1), num(raw[5], -1, 1), num(raw[6], -1, 1)];
  const l = Math.hypot(...q); q = l > 1e-6 ? q.map((x) => x / l) : [0, 0, 0, 1];
  s.push(...q);
  s.push(num(raw[7], -80, 80), num(raw[8], -80, 80), num(raw[9], -80, 80));
  s.push(num(raw[10], -40, 40), num(raw[11], -40, 40), num(raw[12], -40, 40));
  s.push(num(raw[13], -1, 1));
  for (let i = 14; i < 18; i++) s.push(num(raw[i], -500, 500));
  for (let i = 18; i < 22; i++) s.push(num(raw[i], 0, 1));
  s.push(num(raw[22], 0, 255) | 0, num(raw[23], 0, 1e6) | 0);
  return s;
}

function update(room, playerId, vehicleId, raw, now = Date.now(), skipRate = false) {
  const v = room.vehicles.get(String(vehicleId));
  const p = room.players.get(playerId);
  if (!v || !p) return { error: 'NO_VEHICLE' };
  if (v.owner !== playerId) return { error: 'NOT_OWNER', message: 'You do not control that vehicle.' };
  if (!skipRate && now - (p.lastVehicleStateAt || 0) < LIMITS.minUpdateMs) return { error: 'RATE' };
  const s = sanitize(raw);
  if (!s) return { error: 'BAD_STATE' };
  const prev = v.s ? [v.s[0], v.s[2]] : v.home;
  const dt = Math.min(2, Math.max(0.02, (now - (v.at || now)) / 1000));
  const dist = Math.hypot(s[0] - prev[0], s[2] - prev[1]);
  const lastSeq = v.s ? v.s[23] : s[23];
  if (s[23] !== lastSeq) {                                              // the owner says it reset the car (stood it up / moved it)
    if (now - v.lastResetAt < LIMITS.resetCooldownMs) return { error: 'RESET_RATE', message: 'Reset too soon.' };
    const home = Math.hypot(s[0] - v.home[0], s[2] - v.home[1]);
    if (dist > LIMITS.resetMaxDist && home > LIMITS.resetHomeDist) return { error: 'TELEPORT', message: 'Reset refused.' };
    v.lastResetAt = now;
  } else if (dist > LIMITS.maxSpeed * dt + LIMITS.jumpSlack) {
    return { error: 'TELEPORT', message: 'Vehicle moved too far.' };
  }
  p.lastVehicleStateAt = now;
  v.s = s; v.at = now;
  return { ok: true, vehicle: v, s };
}

// the owner says the car has come to rest and lets go of it (no driver)
function release(room, playerId, vehicleId, raw, now = Date.now()) {
  const v = room.vehicles.get(String(vehicleId));
  if (!v || v.owner !== playerId) return { error: 'NOT_OWNER' };
  if (v.driver) return { error: 'DRIVEN', message: 'It still has a driver.' };
  if (raw) { const r = update(room, playerId, vehicleId, raw, now, true); if (r.error) return r; }
  v.owner = null;
  return { ok: true, vehicle: v, info: describe(room, v) };
}

// a free, parked car that somebody's physics has set rolling (bumped by a crate, a slope...): the first claim wins
function claim(room, playerId, vehicleId, now = Date.now()) {
  const v = room.vehicles.get(String(vehicleId));
  const p = room.players.get(playerId);
  if (!v || !p) return { error: 'NO_VEHICLE' };
  if (v.owner || v.driver) return { error: 'TAKEN', owner: v.owner };
  if (v.s) { const d = p.state ? Math.hypot(p.state[0] - v.s[0], p.state[2] - v.s[2]) : 0; if (d > 60) return { error: 'TOO_FAR' }; }
  v.owner = playerId; v.at = now;
  return { ok: true, vehicle: v, info: describe(room, v) };
}

// ---- people going away ----
// Returns the vehicles whose driver/owner changed (the caller broadcasts them). A moving car goes to the host to slow down.
function onLeave(room, playerId) {
  const changed = [];
  for (const v of room.vehicles.values()) {
    let c = false;
    if (v.driver === playerId) { v.driver = null; c = true; }
    if (v.owner === playerId) {
      const next = room.hostId && room.hostId !== playerId && room.players.has(room.hostId) && speedOf(v) > LIMITS.handoverSpeed ? room.hostId : null;
      v.owner = next; if (next) v.at = Date.now(); c = true;
    }
    if (c) changed.push(describe(room, v));
  }
  return changed;
}

// knocked out / forced out of the seat. The owner keeps simulating until it stops.
function eject(room, playerId) {
  const v = drivenBy(room, playerId);
  if (!v) return null;
  v.driver = null;
  return describe(room, v);
}

module.exports = { VEHICLES, LIMITS, STATE_LEN, createVehicles, init, describe, enter, exit, update, release, claim, onLeave, eject, drivenBy, sanitize, posOf, speedOf };
