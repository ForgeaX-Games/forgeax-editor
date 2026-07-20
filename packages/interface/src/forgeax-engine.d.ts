// Ambient module shims for the @forgeax/engine-* packages.
//
// interface root tsconfig pulls editor-core sources into its program via
// workspace symlinks (@forgeax/editor-edit-runtime/viewport/viewport-component,
// etc.), so when editor-core does `import { Materials } from '@forgeax/engine-runtime'`,
// tsc resolves to forgeax-engine/packages/runtime/dist/index.mjs — engine
// packages currently emit dist/*.mjs only (no dist/*.d.ts), and the
// matching shim that lives in the editor submodule
// (packages/editor/src/forgeax-engine.d.ts) is NOT loaded by interface's
// program (interface's tsconfig.include is rooted at its own src/, not
// editor's). Without a duplicate shim here, interface typecheck reds out
// at TS7016 ("Could not find a declaration file for module
// '@forgeax/engine-runtime'").
//
// When the engine packages start shipping .d.ts (engine submodule's tsup
// `dts: true` plus root `tsc -b`), delete this file along with the editor-
// side equivalents.

declare module '@forgeax/engine-runtime';
declare module '@forgeax/engine-ecs';
declare module '@forgeax/engine-gltf';
