// @forgeax/editor-edit-runtime — Edit mode main entry
//
// This package bundles the editor Edit-mode vite app:
//   - Engine boot + camera + viewport
//   - React editor chrome (DockManager, panels, context menu)
//
// Shared runtime services (zustand store, entity ops, context menu,
// dock bridge, panel manifest, i18n) live in @forgeax/editor-core.
//
// Import those from @forgeax/editor-core directly.
//
// Re-exported for AppKit / standalone consumers.

// ── UI / Components ──
export { ViewportBar } from './ViewportBar';
export { ViewportHints } from './ViewportHints';

// ── Engine ──
export { createViewport } from './viewport/viewport';
export { projectGatewayOps } from './gateway-action-projection';
export type { GatewayActionSource, ProjectedGatewayAction, RegisterGatewayAction } from './gateway-action-projection';

// ── Hot reload (two-tier) ──
export { applyScriptChange, initHotReload } from './hot-reload';
export type { HotReloadHost, HotReloadOutcome } from './hot-reload';
