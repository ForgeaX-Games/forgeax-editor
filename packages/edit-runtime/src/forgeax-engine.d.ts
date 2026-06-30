// Ambient module shims for the @forgeax/engine-* packages.
//
// These packages ship runtime ESM (dist/*.mjs) but, in this checkout, their
// declaration files (dist/*.d.ts) are NOT built — so tsc cannot resolve their
// types. esbuild/vite strip types at dev/build time, so the runtime is fine;
// these `declare module` shims just let tsc treat the engine surface as `any`
// instead of erroring on the missing declarations.
//
// The editor's OWN code keeps strict typing; only the (externally-owned, untyped)
// engine boundary is loosened. When the engine starts shipping .d.ts, delete this
// file and the real types take over.

declare module '@forgeax/engine-runtime';
declare module '@forgeax/engine-app';
declare module '@forgeax/engine-ecs';
declare module '@forgeax/engine-types';
declare module '@forgeax/engine-pack/guid';
declare module '@forgeax/engine-vite-plugin-shader';
declare module '@forgeax/engine-vite-plugin-pack';
