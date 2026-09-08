// Legacy Host bootstrap types remain Editor-owned. Engine 7dd's app package
// reserves its bootstrap entry for native Cordis execution plugins; the
// editor's main-serial path intentionally keeps the world-first contract.
// BootstrapContext carries the wider (7-field) host-provided startup context
// including renderer, defaultSceneRoot, and defaultScene. BootstrapEntry is
// (world: World, ctx?: BootstrapContext) => void | Promise<void>.
export type { BootstrapContext, BootstrapEntry, GameContext } from '@forgeax/editor-game-plugins';

// Legacy alias for consumers that still reference EngineGameEntry.
export type { BootstrapEntry as EngineGameEntry } from '@forgeax/editor-game-plugins';
