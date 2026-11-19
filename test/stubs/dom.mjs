// A forgiving fake DOM: every element accepts any property / method, canvases have a no-op 2D context.
const el = (id) => new Proxy({ id, hidden: false, textContent: '', innerHTML: '', style: {}, classes: new Set(), children: [],
  classList: { _s: new Set(), toggle(c, on) { on === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (on ? this._s.add(c) : this._s.delete(c)); }, contains(c) { return this._s.has(c); }, add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); } } },
  { get: (t, k) => (k in t ? t[k] : (k === 'getContext' ? () => new Proxy({}, { get: () => () => ({ width: 10 }), set: () => true }) : () => {})), set: (t, k, v) => { t[k] = v; return true; } });
const registry = new Map();
export function installDom() {
  const body = el('body');
  globalThis.document = { body, getElementById: (id) => { if (!registry.has(id)) registry.set(id, el(id)); return registry.get(id); }, createElement: (t) => el(t), addEventListener() {} };
  globalThis.addEventListener = () => {};
  return registry;
}
