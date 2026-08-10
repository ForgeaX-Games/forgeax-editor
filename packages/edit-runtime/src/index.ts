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

// ── Engine ──
export { createViewport } from './viewport/viewport';
export { projectGatewayActions, projectGatewayOps, projectViewportRuntimeOps } from './gateway-action-projection';
export {
  VIEWPORT_RUNTIME_CONNECT,
  VIEWPORT_RUNTIME_CONNECTED,
  VIEWPORT_RUNTIME_READY,
  createViewportProjectionQuery,
  createViewportRuntimeTransportService,
  installViewportRuntimeConnectionHost,
  isViewportRuntimeConnectMessage,
  isViewportRuntimeConnectedMessage,
  isViewportRuntimeReadyMessage,
  readViewportRuntimeIdentity,
  readViewportRuntimeHostOrigin,
  viewportRuntimeTransportScope,
} from './runtime/viewport-runtime-transport';
export { ViewportRuntimeFrame, buildViewportRuntimeUrl } from './runtime/ViewportRuntimeFrame';
export type { ViewportRuntimeFrameProps, ViewportRuntimeFrameStatus } from './runtime/ViewportRuntimeFrame';
export type {
  ViewportRuntimeConnectMessage,
  ViewportRuntimeConnectedMessage,
  ViewportRuntimeReadyMessage,
  ViewportRuntimeConnectionHostOptions,
  ViewportRuntimeMessageSource,
  ViewportRuntimeMessageTarget,
} from './runtime/viewport-runtime-transport';
export type {
  GatewayActionSource,
  ProjectedGatewayAction,
  RegisterGatewayAction,
  ViewportGatewayActionSource,
} from './gateway-action-projection';

// Public host seam for a managed Studio page. The port wraps the existing
// RunLifecycle; it does not create a second World or own the editor session.
export { createBrowserGameRuntimePort } from './runtime/browser-game-runtime-port';
export type {
  BrowserGameRuntimePort,
  BrowserGameRuntimePortOptions,
  BrowserRuntimeAvailability,
} from './runtime/browser-game-runtime-port';

// ── Hot reload (two-tier) ──
export { applyScriptChange, initHotReload } from './hot-reload';
export type { HotReloadHost, HotReloadOutcome } from './hot-reload';
