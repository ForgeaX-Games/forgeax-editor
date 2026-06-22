// Ambient module shims for the @forgeax/engine-* packages, loaded by the
// editor's ROOT tsconfig.json (`include: ["src/**/*.ts"]`).
//
// The same shim file already lives in
//   packages/editor-core/src/forgeax-engine.d.ts
// and is sufficient when each subpackage typechecks itself through its OWN
// tsconfig (it `include`s its own src). But the editor's root `pnpm typecheck`
// runs `tsc --noEmit` from the editor package root, which resolves
// `@forgeax/editor-core` through the workspace symlink and pulls
// `packages/editor-core/src/*.ts` into the program — WITHOUT loading any
// .d.ts under that subpackage's src. Without this shim file at the editor
// root, the program sees `import { Materials } from '@forgeax/engine-runtime'`
// and errors with TS7016 ("Could not find a declaration file for module
// '@forgeax/engine-runtime'") because the engine packages currently emit
// only dist/*.mjs (no dist/*.d.ts) — the shim has to be reachable from the
// root program.
//
// When the engine packages start shipping .d.ts (engine submodule's tsup
// dts: true), delete this file along with editor-core/src/forgeax-engine.d.ts
// and edit-runtime/src/forgeax-engine.d.ts.

declare module '@forgeax/engine-runtime';
declare module '@forgeax/engine-ecs';
declare module '@forgeax/engine-gltf';
