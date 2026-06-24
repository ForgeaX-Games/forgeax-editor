// Re-exports from @forgeax/engine-app (authoritative source per plan-strategy D-2).
// BootstrapContext carries the wider (7-field) host-provided startup context
// including renderer, defaultSceneRoot, and defaultScene. BootstrapEntry is
// (world: World, ctx?: BootstrapContext) => void | Promise<void>.
export type { BootstrapContext, BootstrapEntry } from '@forgeax/engine-app';
export type { GameContext } from '@forgeax/engine-app';

// Legacy alias for consumers that still reference EngineGameEntry.
export type { BootstrapEntry as EngineGameEntry } from '@forgeax/engine-app';