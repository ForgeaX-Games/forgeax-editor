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

// ── Engine ──
export { createEngineSync } from './engine/sync';
export { setupEditorSkylight } from './engine/skylight';
export { createViewport } from './engine/viewport';
