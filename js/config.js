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
    carrySlow: 0.006,                                        // walking speed is divided by (1 + carrySlow * carried kg)
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

  // kg. Anything heavier than maxMass can only be pushed. Throws: speed = throwPower / sqrt(kg) (a 10 kg crate flies ~8 m/s).
  carry: { maxMass: 40, holdGap: 0.95, holdDrop: 0.35, gain: 14, massLag: 0.04, maxSpeed: 14, breakDist: 2.2, throwPower: 26, maxThrow: 14 },

  // Materials. friction = Coulomb coefficient, restitution = bounciness. Pairs combine as sqrt(a*b) and max(a,b).
  materials: {
    ground: { friction: 0.9, restitution: 0.1 },
    wall:   { friction: 0.7, restitution: 0.1 },
    crate:  { friction: 0.5, restitution: 0.15, density: 75 },     // kg/m^3 of the whole (mostly empty) box: 0.8 m crate = 38 kg
    barrel: { friction: 0.45, restitution: 0.28, mass: 40 },       // steel drum, part full
  },
};
