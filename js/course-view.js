// Draws the driving course from js/course.js: striped speed bumps and a ramp. Visual only.
import * as THREE from 'three';
import { COURSE, rampPose } from './course.js';
import { profileGeometry } from './vehicle-model.js';

function stripes(a, b) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = a; g.fillRect(0, 0, 64, 64); g.fillStyle = b;
  for (let i = -1; i < 4; i++) { g.beginPath(); g.moveTo(i * 24, 64); g.lineTo(i * 24 + 16, 64); g.lineTo(i * 24 + 48, 0); g.lineTo(i * 24 + 32, 0); g.fill(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildCourseView(scene, course = COURSE) {
  const group = new THREE.Group(); group.name = 'DrivingCourse';
  const hazard = stripes('#ffd23f', '#1b1b1b');

  const B = course.bumps;
  const bt = hazard.clone(); bt.repeat.set(B.length / 0.9, 1); bt.needsUpdate = true;
  const bumpMat = new THREE.MeshStandardMaterial({ map: bt, roughness: 0.8 });
  for (const z of B.zs) {
    const geo = new THREE.CylinderGeometry(B.radius, B.radius, B.length, 24); geo.rotateZ(Math.PI / 2);
    const m = new THREE.Mesh(geo, bumpMat); m.position.set(B.x, 0, z); m.castShadow = true; m.receiveShadow = true; group.add(m);
  }

  const R = course.ramp, p = rampPose(R);
  const slabTex = hazard.clone(); slabTex.repeat.set(R.width / 1.2, R.length / 1.2); slabTex.needsUpdate = true;
  const slab = new THREE.Mesh(new THREE.BoxGeometry(...p.size), new THREE.MeshStandardMaterial({ map: slabTex, roughness: 0.8 }));
  slab.position.set(...p.pos); slab.quaternion.set(...p.quat); slab.castShadow = true; slab.receiveShadow = true; group.add(slab);
  // solid-looking wedge under the slab (the physics slab is thin; nothing can get under it)
  const u0 = -R.lowZ, u1 = u0 + R.length * Math.cos(p.phi);
  const wedge = new THREE.Mesh(profileGeometry([[u0, 0], [u1, 0], [u1, R.rise - 0.5], [u0 + 0.5, 0.0]], R.width * 0.98), new THREE.MeshStandardMaterial({ color: 0x555a63, roughness: 0.9 }));
  wedge.position.x = R.x; wedge.castShadow = true; wedge.receiveShadow = true; group.add(wedge);

  scene.add(group);
  return group;
}
