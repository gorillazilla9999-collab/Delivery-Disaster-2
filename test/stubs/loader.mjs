// Redirects `import 'three'` (and the addons) to tiny stand-ins so client glue code can run in Node (no WebGL / network here).
export async function resolve(spec, ctx, next) {
  if (spec === 'three') return { url: new URL('./three-stub.mjs', import.meta.url).href, shortCircuit: true };
  if (spec.startsWith('three/addons')) return { url: new URL('./addons-stub.mjs', import.meta.url).href, shortCircuit: true };
  return next(spec, ctx);
}
