// A minimal stand-in for the parts of three.js the vehicle code touches. It is NOT a renderer: it only lets the glue code
// (VehicleSystem, VehicleModel, RemotePlayer seat code...) execute with sensible vector / quaternion maths.
export class Vector2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }
export class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
  lerpVectors(a, b, t) { this.x = a.x + (b.x - a.x) * t; this.y = a.y + (b.y - a.y) * t; this.z = a.z + (b.z - a.z) * t; return this; }
  lerp(v, t) { return this.lerpVectors(this, v, t); }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  setScalar(s) { return this.set(s, s, s); }
}
export class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  copy(q) { return this.set(q.x, q.y, q.z, q.w); }
  clone() { return new Quaternion(this.x, this.y, this.z, this.w); }
  identity() { return this.set(0, 0, 0, 1); }
  slerp(q, t) { return this.slerpQuaternions(this, q, t); }
  slerpQuaternions(a, b, t) {                                   // normalised lerp: good enough for a stand-in
    const d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w, s = d < 0 ? -1 : 1;
    const x = a.x + (b.x * s - a.x) * t, y = a.y + (b.y * s - a.y) * t, z = a.z + (b.z * s - a.z) * t, w = a.w + (b.w * s - a.w) * t;
    const l = Math.hypot(x, y, z, w) || 1; return this.set(x / l, y / l, z / l, w / l);
  }
}
class Euler { constructor() { this.x = 0; this.y = 0; this.z = 0; this.order = 'XYZ'; } set(x, y, z, o) { this.x = x; this.y = y; this.z = z; if (o) this.order = o; return this; } }
export class Object3D {
  constructor() { this.position = new Vector3(); this.quaternion = new Quaternion(); this.rotation = new Euler(); this.scale = new Vector3(1, 1, 1); this.children = []; this.parent = null; this.visible = true; this.name = ''; }
  add(...o) { for (const c of o) { c.parent = this; this.children.push(c); } return this; }
  remove(...o) { for (const c of o) this.children = this.children.filter((x) => x !== c); return this; }
  lookAt(v) { this.lookedAt = new Vector3(v.x, v.y, v.z); }
  traverse(fn) { fn(this); for (const c of this.children) c.traverse(fn); }
  getWorldPosition(out) { return out.copy(this.position); }
}
export class Group extends Object3D {}
export class Mesh extends Object3D { constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; this.isMesh = true; } }
export class Sprite extends Object3D { constructor(material) { super(); this.material = material; } }
export class PerspectiveCamera extends Object3D { constructor(fov = 70) { super(); this.fov = fov; this.updates = 0; } updateProjectionMatrix() { this.updates++; } }
export class Scene extends Object3D {}
class Geo { constructor(...a) { this.args = a; } rotateX() { return this; } rotateY() { return this; } rotateZ() { return this; } translate() { return this; } computeVertexNormals() {} dispose() {} }
export class BoxGeometry extends Geo {}
export class CylinderGeometry extends Geo {}
export class ExtrudeGeometry extends Geo {}
export class Shape { constructor(points) { this.points = points; } }
class Mat { constructor(o = {}) { Object.assign(this, o); } clone() { return new Mat(this); } dispose() {} }
export class MeshStandardMaterial extends Mat {}
export class SpriteMaterial extends Mat {}
export class CanvasTexture { constructor(c) { this.image = c; this.repeat = new Vector2(); } clone() { return new CanvasTexture(this.image); } dispose() {} }
export const SRGBColorSpace = 'srgb', RepeatWrapping = 1000, PCFSoftShadowMap = 2;
