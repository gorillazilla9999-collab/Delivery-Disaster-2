// Uneven terrain to drive over: a row of speed bumps and a kicker ramp. Static bodies in the normal physics world, so
// the wheels' suspension rays, the chassis box and crates all treat them like any other scenery. No rendering in here
// (js/course-view.js draws them) so the same terrain can be built headless for the tests.
import { Body } from './physics.js';
import { CONFIG } from './config.js';

export const COURSE = {
  // half-buried cylinders lying across the road: [x, z] of the middle, radius and length
  bumps: { x: 34, zs: [10, 13.5, 17, 20.5], radius: 0.17, length: 7 },
  // a ramp you drive up toward -Z: low end at lowZ, `rise` metres high at the top
  ramp: { x: 46, lowZ: 36, width: 5, length: 9, rise: 1.5, thickness: 0.4 },
};

// Centre, orientation and size of the ramp slab (a thin tilted box whose low edge meets the ground)
export function rampPose(r = COURSE.ramp) {
  const phi = Math.asin(r.rise / r.length), s = Math.sin(phi), c = Math.cos(phi);
  return {
    phi, size: [r.width, r.thickness, r.length],
    pos: [r.x, (r.length / 2) * s - (r.thickness / 2) * c - 0.01, r.lowZ - (r.length / 2) * c],
    quat: [Math.sin(phi / 2), 0, 0, Math.cos(phi / 2)],               // rotation about X: the -Z end goes up
  };
}

// Adds the bodies; returns { bumps: [Body], ramp: Body }.
export function buildCoursePhysics(physics, course = COURSE) {
  const mat = CONFIG.materials.wall;
  const bumps = course.bumps.zs.map((z) => {
    const b = physics.add(new Body({ shape: 'cyl', radius: course.bumps.radius, height: course.bumps.length, position: [course.bumps.x, 0, z], dynamic: false, baseOrigin: false, name: 'speed bump', ...mat }));
    b.setQuat(0, 0, Math.SQRT1_2, Math.SQRT1_2);                      // lie along X
    return b;
  });
  const p = rampPose(course.ramp);
  const ramp = physics.add(new Body({ size: p.size, position: p.pos, dynamic: false, baseOrigin: false, name: 'ramp', ...mat }));
  ramp.setQuat(...p.quat);
  return { bumps, ramp };
}
