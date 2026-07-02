// SHARED explicit-surface shims for the FEW @forgeax/engine-* packages that ship
// NO TypeScript declarations even after a full engine build (their tsup config
// omits `dts`). This is the SINGLE source of truth for those surfaces — every
// editor package tsconfig includes this one file, so a consumer that recompiles
// another editor package's source (the no-build, source-`exports` design) sees
// the same engine surface. Do NOT re-scatter per-package copies: ambient
// `declare module` is per-compilation, so N copies drift (that drift is the bug
// this file replaces).
//
// WHY EXPLICIT, NOT BARE:
// A bodyless `declare module 'X';` erases module X to `any`, so tsc stops
// checking named imports from it — exactly how the non-existent `{ Socket }`
// import from @forgeax/engine-runtime slipped past typecheck and crashed at the
// user's runtime in studio (AGENTS.md anti-pattern #5). Every block below is an
// explicit allowlist: importing a name not declared here still fails typecheck.
// `scripts/lint-no-bare-engine-shim.mjs` (CI-enforced) forbids the bare form.
//
// Every OTHER engine package (runtime / ecs / types / gltf / app / pack /
// vite-plugins / …) now resolves to its real dist/*.d.ts — do NOT add it here.
// When engine-project / engine-fbx-wasm start shipping real .d.ts, delete the
// matching block.

// engine-project — value + type space. store.ts / open-project.ts import both
// runtime values (loadGameProject / FORGE_JSON / GameProjectError) AND types
// (`type GameProject`); a bare declaration would only supply value-space `any`
// and trip TS2709 on the type use, so declare both spaces. These are REAL engine
// exports (engine-project/src/{schema,errors}.ts) — the module just ships no .d.ts.
declare module '@forgeax/engine-project' {
  export const loadGameProject: any;
  export const loadGameProjectSync: any;
  export const resolveDefaultScene: any;
  export const validateGameProject: any;
  export const GameProjectSchema: any;
  export const GameProjectError: any;
  export const FORGE_JSON: string;
  export type GameProject = any;
  export type ResolvedScene = any;
  export type GameProjectErrorCode = any;
  export type GameProjectErrorDetail = any;
}

// engine-fbx-wasm — the wasm importer shell ships only .mjs (no .d.ts).
// fbx-cook.ts imports these three values.
declare module '@forgeax/engine-fbx-wasm' {
  export const initFbxWasm: any;
  export const parseFbx: any;
  export const isFbxWasmReady: any;
}
