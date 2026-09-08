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

/// <reference path="./globals.d.ts" />

// ── UI / Components ──
export { ViewportBar } from './ViewportBar';
export {
  EDITOR_RUNTIME_ENTRY_CAPABILITIES,
  EDITOR_RUNTIME_ENTRY_CONTRACT_VERSION,
  EDITOR_RUNTIME_ENTRY_ID,
  createEditorRuntimeEntry,
} from './bridge';
export type { EditorRuntimeEntry } from './bridge';
export { ViewportComponent } from './viewport/ViewportComponent';
export type {
  ResetEditRealmOptions,
  ViewportComponentProps,
} from './viewport/ViewportComponent';
export { versionControlStatusBarExtension, versionControlStatusItem } from './version-control/contribution';

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
export {
  VIEWPORT_RUNTIME_BROADCAST_CHANNEL,
  createBroadcastViewportRuntimeClient,
  installBroadcastViewportRuntimeHost,
  subscribeBroadcastViewportRuntimeReady,
} from './runtime/viewport-runtime-broadcast';
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
export { createToolCarrierHost } from './runtime/tool-carrier-host';
export type { ToolCarrierHost, ToolCarrierHostOptions } from './runtime/tool-carrier-host';
export { createToolCarrierProvider } from './runtime/tool-carrier-provider';
export type {
  ToolCarrierError,
  ToolCarrierOffer,
  ToolCarrierPhase,
  ToolCarrierProvider,
  ToolCarrierResult,
} from './runtime/tool-carrier-provider';
export { createAuthoringOperationsProjection } from './runtime/tool-client-operations';
export type { AuthoringOperationsProjection } from './runtime/tool-client-operations';
export { createAuthoringToolClientTransport } from './runtime/tool-client-transport';
export type { AuthoringToolClientTransport, AuthoringTransportError } from './runtime/tool-client-transport';
export { decidePlayDirtyPolicy } from './runtime/play-dirty-policy';
export type { PlayDirtyChoice, PlayDirtyDecision } from './runtime/play-dirty-policy';

export {
  createReferenceCreationEntry,
  createReferenceCreationRuntime,
  createReferenceCreationSkill,
} from '@forgeax/editor-product';
export type {
  ReferenceCreationEntry,
  ReferenceCreationEntryOptions,
  ReferenceCreationFinalReport,
  ReferenceCreationJournalStore,
  ReferenceCreationNativeEntitySpec,
  ReferenceCreationSkillDescriptor,
} from '@forgeax/editor-product';

// ── Hot reload (two-tier) ──
export { applyScriptChange, initHotReload } from './hot-reload';
export type { HotReloadHost, HotReloadOutcome } from './hot-reload';
