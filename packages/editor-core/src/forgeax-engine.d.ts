// Ambient module shims for the @forgeax/engine-* packages.
//
// These packages ship runtime ESM (dist/*.mjs) but, in this checkout, their
// declaration files (dist/*.d.ts) are NOT built — so tsc cannot resolve their
// types. esbuild/vite strip types at dev/build time, so the runtime is fine;
// these `declare module` shims just let tsc treat the engine surface as `any`
// instead of erroring on the missing declarations. Mirrors editor-runtime's
// src/forgeax-engine.d.ts. When the engine ships .d.ts, delete this file.

declare module '@forgeax/engine-runtime';
declare module '@forgeax/engine-ecs';
declare module '@forgeax/engine-gltf';
// engine-types: SceneAsset / SceneEntity / LocalEntityId are imported here as
// `import type` (edit-session.ts, open-project.ts, scene-types.ts, types.ts).
// Declared with an explicit surface (not a bare `declare module`) so these
// names resolve in TYPE space — a bare declaration only supplies value-space
// `any`, which trips TS2709 when used as a type. Until the engine ships real
// .d.ts, CI's engine dist (no .d.ts, deploy.sh runs `pnpm -r build` only)
// would otherwise trip TS7016. Mirrors the editor root shim.
declare module '@forgeax/engine-types' {
  export type SceneAsset = any;
  export type SceneEntity = any;
  export type LocalEntityId = any;
}

// engine-project is imported here (store.ts) for both values
// (loadGameProject, FORGE_JSON, GameProjectError) AND types
// (`type GameProject`). A bare `declare module` only supplies value-space
// `any`, so `type GameProject` fails with TS2709. Declare the surface
// explicitly so both spaces resolve until the engine ships real .d.ts.
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
