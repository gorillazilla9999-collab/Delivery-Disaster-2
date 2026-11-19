// All tweakable numbers live here. Units: metres, seconds, radians.
export const CONFIG = {
  modelUrl: 'assets/person.glb',

  // Rotates the model so its Blender "front" points along the game's forward (-Z).
  // Your model's hands/feet are spread along its local Z axis, so its front is local +X.
  // If the character ever looks sideways/backwards in third-person (V), change this.
  modelYawOffset: Math.PI / 2,
  eyeAboveHeadCenter: 0.2,        // eye height = head centre + this * head radius

  world: { limit: 90 },           // player/crates are kept inside +/- this on X and Z
  // Real-world units: metres, seconds, kilograms. Gravity is Earth's; terminal velocity is a falling person's.
  physics: { gravity: 9.81, terminalVelocity: 55, maxSubstep: 1 / 120 },

  player: {
    height: 1.8, radius: 0.3, mass: 75,                      // kg: this is what decides who wins a shoving match with a crate
    walkSpeed: 4.2, runSpeed: 7.4, backwardFactor: 0.75,
    groundAccel: 32, groundDecel: 28,                        // legs can only push so hard (was arcade-snappy 55 / 48)
    airAccel: 6, airDecel: 0.3,                              // in the air you mostly keep your momentum
    jumpSpeed: 4.3, coyoteTime: 0.1, jumpBuffer: 0.12,       // v = sqrt(2 g h): about a 0.94 m jump under real gravity
    pushForce: 1000,                                         // N the legs can push with while shoving a crate (a 130 kg crate on grass barely budges)
    carrySlow: 0.01,                                        // walking speed is divided by (1 + carrySlow * carried kg)
    stepHeight: 0.5,
    spawn: [0, 0, 12],
  },

  look: { baseSensitivity: 0.0022, smoothing: 55, maxPitch: Math.PI / 2 - 0.02 },

  camera: {
    fov: 75, runFovBoost: 7, near: 0.05, far: 800,
    bobFrequency: 2.1, bobAmount: 0.022, swayAmount: 0.012, tilt: 0.014,
  },

  hands: {
    viewScale: 1.5,                      // how much bigger than the model the hands look in view
    restX: 0.30, restY: -0.25, restZ: -0.58,   // camera-local rest position (right hand; left mirrors X)
    lagGain: 0.6, lagMax: 0.12,
    reachRate: 12,
    pokeDuration: 0.32,
  },

  interaction: { reach: 2.4, rayLength: 3.0, pokeImpulse: 45 },   // punch / shove, in N*s (10 kg crate -> 4.5 m/s, 40 kg -> 1.1 m/s)

  combat: { reach: 2.1, hitboxHalf: 0.5, knockback: 7.5, knockLift: 3.2 },

  // kg. You can lift anything; heavy loads just slow you down (see player.carrySlow). Throws: speed = throwPower / sqrt(kg) (a 10 kg crate flies ~8 m/s).
  carry: { holdGap: 0.95, holdDrop: 0.35, gain: 14, massLag: 0.04, maxSpeed: 14, breakDist: 2.2, throwPower: 26, maxThrow: 14 },

  // The hydraulic press (heights in metres, times in seconds; everything is derived from synced time).
  crusher: { x: -11, z: 12, size: 3, thick: 0.6, cycle: 9, top: 3.2, bottom: 0.02, waitTop: 4.5, slam: 0.55, hold: 1.2, warn: 1.6, headY: 4.2, crushBelow: 0.9, respawn: 10 },

  // The spawn tool: Q cycles the item, F spawns it where you look, X removes the item you look at.
  spawner: { perType: 6, types: [
    { id: 'crate-s', label: 'Small crate (0.5 m)', kind: 'crate', size: 0.5 },
    { id: 'crate-m', label: 'Crate (0.8 m)', kind: 'crate', size: 0.8 },
    { id: 'crate-l', label: 'Big crate (1.2 m)', kind: 'crate', size: 1.2 },
    { id: 'barrel-r', label: 'Red barrel', kind: 'barrel', color: 'red' },
    { id: 'barrel-b', label: 'Blue barrel', kind: 'barrel', color: 'blue' },
  ] },

  // ---------------------------------------------------------------------------------------------------------------
  // The drivable car (js/vehicle*.js). Units: metres, seconds, kilograms, newtons, radians. Forward is -Z (yaw 0).
  // The chassis is ONE rigid body in the normal physics world; the four wheels are suspension rays that push on it.
  // ---------------------------------------------------------------------------------------------------------------
  vehicle: {
    id: 'car1', name: 'Courier Hatch',
    spawn: { x: 6, z: 16, yaw: 0 },                          // keep in sync with HOMES in server/vehicles.js (npm test checks it)

    // collision box (centre = centre of mass). A compact hatchback: 4.2 m long, 1.84 m wide, 1250 kg.
    chassis: { size: [1.84, 0.70, 4.20], mass: 1250, friction: 0.25, restitution: 0.05, linDamp: 0, angDamp: 0.3 },

    // wheel layout (z is measured from the centre of mass: front axle at -frontZ, rear axle at +rearZ)
    wheels: { radius: 0.32, width: 0.22, track: 1.60, frontZ: 1.30, rearZ: 1.30, attachY: 0 },

    // springs. A wheel hangs `maxLength` below its mount when unloaded; the car's weight compresses it by about 10 cm
    suspension: { maxLength: 0.36, minLength: 0.12, stiffness: 30000, damperCompress: 2800, damperRebound: 4200, bumpStop: 160000, bumpMargin: 0.04, maxForceG: 5 },

    // tyres: a slip-angle curve for sideways grip (peak at `slipPeak`, falling to ~70% when sliding), a friction ellipse
    // so braking/accelerating eats into cornering grip, and a lower coefficient for locked / spinning wheels
    tires: { mu: 1.15, muLong: 1.10, muSlide: 0.80, slipPeak: 0.14, shapeC: 1.25, lowSpeed: 1.2, rollInfluence: 0.25 },

    engine: { power: 85000, launchForce: 5200, maxSpeed: 42, reverseForce: 3000, reversePower: 18000, reverseMaxSpeed: 9, driveFront: 0.3 },
    brakes: { force: 12500, frontBias: 0.62, handbrake: 0.75, idleBrake: 0.55, holdSpeed: 0.6, holdBrake: 0.5, ramp: 9 },
    pedals: { throttleUp: 5, throttleDown: 9, reverseSwitchSpeed: 1.2 },
    steering: { maxLock: 0.58, minLock: 0.085, lockSpeedLow: 4, lockSpeedHigh: 30, rate: 3.0, rateHigh: 1.5, returnRate: 4.0, counterSteer: 1.1 },
    resistance: { cdA: 0.42, rolling: 0.014, engineBrake: 160 },     // aero drag = cdA * v^2 (N), rolling = coefficient * load

    // where the driver sits (character feet position in car coordinates) and how the character is lowered into the seat
    seat: { x: -0.40, y: -0.99, z: -0.10 },

    enterRange: 2.3,                 // m from the car's body to the player
    exitMaxSpeed: 6,                 // m/s: you cannot jump out of a car that is going faster than this
    exitClearance: { radius: 0.42, height: 1.8 },
    flipUpDot: 0.35,                 // body-up . world-up below this = overturned (offer the reset)

    reset: { key: 'KeyR', cooldown: 2.0, lift: 0.15, searchRadius: 9, maxDistance: 15 },

    camera: {
      distance: 6.6, distanceSpeed: 2.2, height: 2.5, heightSpeed: 0.3, lookHeight: 1.0, lookAhead: 0.12,
      fov: 70, fovSpeed: 12, yawFollow: 4.5, velocityFollow: 0.6, distIn: 18, distOut: 2.5, collisionPad: 0.35, minDistance: 1.4,
      mouseOrbit: true, orbitReturnDelay: 1.4, orbitReturnRate: 3.0, blendIn: 0.55, blendOut: 0.45,
    },

    net: { sendInterval: 50, staleOwner: 1.5, releaseAfterRest: 1.0, interpDelay: 0.12 },
  },

  // Materials. friction = Coulomb coefficient, restitution = bounciness. Pairs combine as sqrt(a*b) and max(a,b).
  materials: {
    ground: { friction: 0.9, restitution: 0.1 },
    wall:   { friction: 0.7, restitution: 0.1 },
    crate:  { friction: 0.5, restitution: 0.15, density: 75 },     // kg/m^3 of the whole (mostly empty) box: 0.8 m crate = 38 kg
    barrel: { friction: 0.45, restitution: 0.28, mass: 40 },       // steel drum, part full
  },
};
