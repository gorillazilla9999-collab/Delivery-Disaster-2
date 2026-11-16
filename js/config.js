// All tweakable numbers live here. Units: metres, seconds, radians.
export const CONFIG = {
  modelUrl: 'assets/person.glb',

  // Rotates the model so its Blender "front" points along the game's forward (-Z).
  // Your model's hands/feet are spread along its local Z axis, so its front is local +X.
  // If the character ever looks sideways/backwards in third-person (V), change this.
  modelYawOffset: Math.PI / 2,
  eyeAboveHeadCenter: 0.2,        // eye height = head centre + this * head radius

  world: { limit: 90 },           // player/crates are kept inside +/- this on X and Z
  physics: { gravity: 22, terminalVelocity: 50, maxSubstep: 1 / 90 },

  player: {
    height: 1.8, radius: 0.3, mass: 1,
    walkSpeed: 4.2, runSpeed: 7.4, backwardFactor: 0.75,
    groundAccel: 55, groundDecel: 48, airAccel: 14, airDecel: 1.5,
    jumpSpeed: 6.6, coyoteTime: 0.1, jumpBuffer: 0.12,
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

  interaction: { reach: 2.4, rayLength: 3.0, pokeImpulse: 4.5 },

  combat: { reach: 2.1, hitboxHalf: 0.5, knockback: 7.5, knockLift: 3.2 },

  carry: { maxMass: 3.5, holdGap: 0.95, holdDrop: 0.35, gain: 14, maxSpeed: 14, breakDist: 2.2, throwSpeed: 9 },
};
