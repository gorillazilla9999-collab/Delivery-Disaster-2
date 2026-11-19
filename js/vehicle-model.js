// The car's looks. A placeholder built from simple geometry (no asset needed): an extruded hatchback side profile, glass,
// a roof sign, lights, and four wheels that each hang from their own suspension, steer (front pair) and spin.
// It only READS the Vehicle (pose + wheel state), so the same model draws the car whether we drive it or somebody else does.
import * as THREE from 'three';
import { CONFIG } from './config.js';

// Extrude a side profile [[u, v], ...] (u = metres forward, v = metres up, car-centre coordinates) across `width` metres.
// Forward is -Z in the world, so shape-x maps to -z and the extrusion runs along x.
export function profileGeometry(points, width) {
  const shape = new THREE.Shape(points.map(([u, v]) => new THREE.Vector2(u, v)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
  geo.rotateY(Math.PI / 2);                  // (x, y, z) -> (z, y, -x)
  geo.translate(-width / 2, 0, 0);
  geo.computeVertexNormals();
  return geo;
}

function signTexture(text) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = '#fff6dc'; g.fillRect(0, 0, 256, 96);
  g.strokeStyle = '#1b1b1b'; g.lineWidth = 8; g.strokeRect(4, 4, 248, 88);
  g.fillStyle = '#1b1b1b'; g.font = 'bold 46px "Trebuchet MS", "Segoe UI", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 128, 52, 230);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class VehicleModel {
  constructor(vehicle) {
    this.vehicle = vehicle;
    const cfg = vehicle.cfg, W = cfg.wheels;
    const group = this.group = new THREE.Group();
    group.name = 'Vehicle';

    const paint = new THREE.MeshStandardMaterial({ color: 0xe8432e, roughness: 0.5, metalness: 0.25 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.7, metalness: 0.2 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x1d2a3a, roughness: 0.1, metalness: 0.6, transparent: true, opacity: 0.55 });
    const cream = new THREE.MeshStandardMaterial({ color: 0xfff6dc, roughness: 0.6 });
    this.headMat = new THREE.MeshStandardMaterial({ color: 0xfff2c8, emissive: 0xffe9a0, emissiveIntensity: 0.9, roughness: 0.3 });
    this.tailMat = new THREE.MeshStandardMaterial({ color: 0x7a1010, emissive: 0xff2a1a, emissiveIntensity: 0.35, roughness: 0.4 });
    const add = (mesh, cast = true) => { mesh.castShadow = cast; mesh.receiveShadow = true; group.add(mesh); return mesh; };

    // lower body and cabin (u forward, v up; the chassis centre is v = 0, the ground is at about v = -0.58)
    add(new THREE.Mesh(profileGeometry([[-2.10, -0.30], [2.10, -0.30], [2.14, -0.05], [2.02, 0.18], [1.30, 0.30], [0.60, 0.32], [-1.75, 0.34], [-2.08, 0.24], [-2.14, -0.02]], 1.72), paint));
    add(new THREE.Mesh(profileGeometry([[0.72, 0.32], [0.12, 0.86], [-1.00, 0.88], [-1.62, 0.34]], 1.58), glass), false);
    const roof = add(new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.05, 1.16), paint)); roof.position.set(0, 0.905, 0.44);
    // pillars so the glass reads as windows
    for (const sx of [-1, 1]) {
      const a = add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.62, 0.06), paint)); a.position.set(sx * 0.79, 0.59, -0.30); a.rotation.x = -0.82;
      const c = add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.60, 0.07), paint)); c.position.set(sx * 0.79, 0.60, 1.32); c.rotation.x = 0.88;
    }
    // bumpers, lights, plate
    for (const z of [-2.16, 2.15]) { const m = add(new THREE.Mesh(new THREE.BoxGeometry(1.78, 0.16, 0.12), dark)); m.position.set(0, -0.19, z); }
    for (const sx of [-1, 1]) {
      const hl = add(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.13, 0.07), this.headMat), false); hl.position.set(sx * 0.60, 0.06, -2.12);
      const tl = add(new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.14, 0.07), this.tailMat), false); tl.position.set(sx * 0.64, 0.12, 2.10);
    }
    // roof sign (it is a delivery car)
    const tex = signTexture('DELIVERY');
    const sideMat = cream, faceMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 });
    const sign = add(new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.22, 0.26), [sideMat, sideMat, sideMat, sideMat, faceMat, faceMat]));
    sign.position.set(0, 1.04, 0.5);

    // wheels: pivot (placed at the end of the suspension, steered) -> spinner (rolls) -> tyre, rim, spokes
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.9 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xcfd4da, roughness: 0.35, metalness: 0.7 });
    const tireGeo = new THREE.CylinderGeometry(W.radius, W.radius, W.width, 28); tireGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(W.radius * 0.62, W.radius * 0.62, W.width + 0.012, 20); rimGeo.rotateZ(Math.PI / 2);
    const spokeGeo = new THREE.BoxGeometry(0.02, W.radius * 1.05, 0.05);
    this.wheelNodes = vehicle.wheels.map((w) => {
      const pivot = new THREE.Group(), spinner = new THREE.Group();
      const tire = new THREE.Mesh(tireGeo, tireMat); tire.castShadow = true;
      spinner.add(tire, new THREE.Mesh(rimGeo, rimMat));
      for (const sx of [-1, 1]) for (let k = 0; k < 5; k++) {           // spokes on both faces: you can see the wheel turn
        const sp = new THREE.Mesh(spokeGeo, dark); sp.position.x = sx * (W.width / 2 + 0.008);
        const holder = new THREE.Group(); holder.rotation.x = (k / 5) * Math.PI * 2; holder.add(sp); spinner.add(holder);
      }
      const lug = new THREE.Mesh(new THREE.BoxGeometry(W.width + 0.03, 0.05, 0.05), new THREE.MeshStandardMaterial({ color: 0xffd23f }));
      lug.position.set(0, W.radius * 0.8, 0); spinner.add(lug);        // a bright mark near the tread
      pivot.add(spinner); group.add(pivot);
      return { pivot, spinner, w };
    });
    this.update(vehicle);
  }

  // copy the car's pose and wheel state onto the meshes (call once per frame)
  update(v) {
    const b = v.body, g = this.group;
    g.position.set(b.pos.x, b.pos.y, b.pos.z);
    g.quaternion.set(b.quat.x, b.quat.y, b.quat.z, b.quat.w);
    for (const n of this.wheelNodes) {
      const w = n.w, L = w.local;
      n.pivot.position.set(L[0], L[1] - w.length, L[2]);              // car space: mount point, hanging down by the suspension length
      n.pivot.rotation.y = w.front ? -v.steerAngle : 0;               // positive steer = right; three.js yaw is counter-clockwise
      n.spinner.rotation.x = -w.spin;                                 // forward motion = top of the tyre moves towards -z
    }
    this.tailMat.emissiveIntensity = v.brakeLight ? 2.4 : 0.35;
  }
}
