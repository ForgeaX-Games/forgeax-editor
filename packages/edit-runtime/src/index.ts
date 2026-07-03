// @forgeax/editor-edit-runtime — Edit mode main entry
//
// This package bundles the editor Edit-mode vite app:
//   - Engine boot + camera + skylight + viewport
//   - React editor chrome (DockManager, panels, context menu)
//
// Shared runtime services (zustand store, entity ops, context menu,
// dock bridge, panel manifest) have moved to @forgeax/editor-shared to
// break the dep cycle between core, panels, and edit-runtime.
//
// Import those from @forgeax/editor-shared directly.
//
// Re-exported for AppKit / standalone consumers.

// ── UI / Components ──
export { DetachedPanel } from './DetachedPanel';
export { ViewportBar } from './ViewportBar';
export { ViewportHints } from './ViewportHints';

// M4: createEngineSync removed — sync.ts deleted (projection layer collapse).
// ── Engine ──
export { setupEditorSkylight } from './engine/skylight';
export { createViewport } from './engine/viewport';

// ── Hot reload (two-tier, D-8) ──
export { applyScriptChange, initHotReload } from './hot-reload';
export type { HotReloadHost, HotReloadOutcome } from './hot-reload';
// NOTE: writeback-chain (writebackInstance) was removed — it targeted the engine's
// old collectSceneAsset(world, root, handleToGuid) API, which the engine replaced
// (optimal>compatible, no compat shim) with rootsToSceneAsset(registry, world,
// roots[]). The old export did not exist in the pinned engine, so the code crashed
// at import ("Export named 'collectSceneAsset' not found"). It had no production
// caller and was not in the published surface. Rebuild against rootsToSceneAsset
// (threading renderer.assets as the AssetRegistry) when the durable-writeback
// feature is actually wired to a save path.
