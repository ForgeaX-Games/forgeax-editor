// @forgeax/editor/bridge — pass-through to editor-core's host-bridge surface.
//
// Host-facing editor bridge surface. Re-exported here so hosts consume the
// facade (`@forgeax/editor/*`) instead of reaching into editor-core.
import {
  resetEditRealm as resetRuntimeRealm,
  ViewportComponent,
  type ResetEditRealmOptions,
  type ViewportComponentProps,
} from './viewport/ViewportComponent';
import {
  executeLiveGameplay,
  registerLiveGameplayBridge,
} from '@forgeax/editor-core';
import type {
  GameplayOperationRequest,
  GameplayOperationResult,
} from '@forgeax/editor-core';

export {
  gateway,
  assetIO,
  installInterfaceBridge,
  setContextMenuRenderer,
  panelBridge,
  hasPendingDiskSave,
  bindViewportRuntimeClient,
  forwardViewportRuntimeTransportRequest,
  getViewportRuntimeClientSnapshot,
  subscribeViewportRuntimeClient,
  createEvalChannel,
  resolveGamePath,
} from '@forgeax/editor-core';

import type { AppExtension } from '@forgeax/interface/core/app-shell/types';
import { createElement } from 'react';
import type { FunctionComponent } from 'react';
import {
  createAssetEditorsPanelContributionsExtension,
  createHierarchyPanelContributionsExtension,
} from '@forgeax/editor-panels';
import { createViewportPanelContributionsExtension } from './viewport/ViewportPanel';

export { createViewportPanelContributionsExtension } from './viewport/ViewportPanel';
export {
  createAssetEditorsPanelContributionsExtension,
  createHierarchyPanelContributionsExtension,
} from '@forgeax/editor-panels';
export { createEditorPageExtension } from './page-extension';
export {
  EDITOR_LEVEL_PAGE_ID,
  EDITOR_PAGE_CARRIER_DESCRIPTOR,
  EDITOR_VIEWPORT_PANEL_ID,
} from './page-extension';
export { resetEditRealm } from './viewport/ViewportComponent';

// Hosts consume the editor carrier through this public bridge. The core
// implementation remains behind the editor package boundary.
export {
  createEditorCarrierFacade,
  EDITOR_CARRIER_CONTRACT_VERSION,
  EDITOR_CARRIER_RECOVERY_ACTIONS,
} from '@forgeax/editor-core';
export {
  executeLiveGameplay,
  registerLiveGameplayBridge,
} from '@forgeax/editor-core';
export type {
  CreateEditorCarrierFacadeOptions,
  EditorCarrierDiscovery,
  EditorCarrierFacade,
  EditorCarrierSchemaDescriptor,
  EditorPageCarrierDescriptor,
} from '@forgeax/editor-core';
export type {
  GameplayCarrierBridge,
  GameplayOperationRequest,
  GameplayOperationResult,
  ViewportRuntimeClientSnapshot,
} from '@forgeax/editor-core';
export type { TransportRequest, TransportResponse } from '@forgeax/editor-product';

/** Stable contract for the released Editor entry mounted by product hosts. */
export const EDITOR_RUNTIME_ENTRY_CONTRACT_VERSION = 'editor-runtime/v1' as const;
export const EDITOR_RUNTIME_ENTRY_ID = 'forgeax.editor.edit' as const;
export const EDITOR_RUNTIME_ENTRY_CAPABILITIES = Object.freeze([
  'editor.viewport.mount',
  'editor.world.runtime',
  'editor.gameplay.carrier',
] as const);

export interface EditorRuntimeEntry {
  readonly contractVersion: typeof EDITOR_RUNTIME_ENTRY_CONTRACT_VERSION;
  readonly id: typeof EDITOR_RUNTIME_ENTRY_ID;
  readonly runtimeKind: 'world-backed';
  readonly owner: 'editor-edit-runtime';
  readonly capabilities: typeof EDITOR_RUNTIME_ENTRY_CAPABILITIES;
  /** Return the real ViewportComponent; the host owns the React root. */
  readonly mount: (props?: ViewportComponentProps) => ReturnType<typeof ViewportComponent>;
  /** The Editor-owned realm teardown; hosts must not dispose the World directly. */
  readonly reset: (options?: ResetEditRealmOptions) => void;
  /** Execute a schema-typed request through the bridge published by the mounted viewport. */
  readonly executeGameplay: (input: GameplayOperationRequest) => Promise<GameplayOperationResult>;
}

/**
 * Compose the public FXE runtime entry from the existing World/renderer owner.
 * This is deliberately an adapter around ViewportComponent: it does not create
 * another World, mirror CarrierState, or let a host take over teardown.
 */
export function createEditorRuntimeEntry(): EditorRuntimeEntry {
  const viewport = ViewportComponent as FunctionComponent<ViewportComponentProps>;
  return Object.freeze({
    contractVersion: EDITOR_RUNTIME_ENTRY_CONTRACT_VERSION,
    id: EDITOR_RUNTIME_ENTRY_ID,
    runtimeKind: 'world-backed' as const,
    owner: 'editor-edit-runtime' as const,
    capabilities: EDITOR_RUNTIME_ENTRY_CAPABILITIES,
    mount: (props?: ViewportComponentProps) => createElement(viewport, props ?? null),
    reset: resetRuntimeRealm,
    executeGameplay: executeLiveGameplay,
  });
}

export function resetStudioEditRealm(nextGeneration: number): void {
  resetRuntimeRealm({ nextRuntimeGeneration: nextGeneration });
}

export type GenerationTransitionEvent =
  | 'checkout-complete'
  | 'old-runtime-barrier'
  | 'old-runtime-teardown'
  | 'successor-cold-ready'
  | 'lease-swap'
  | 'operation-terminal';

export interface GenerationTransitionHostTrace {
  readonly events: readonly GenerationTransitionEvent[];
  readonly terminalBeforeColdReady: boolean;
  readonly oldProjection: 'current' | 'stale';
}

export interface GenerationTransitionTrace {
  readonly record: (event: GenerationTransitionEvent) => void;
  readonly host: (host: 'standalone' | 'studio') => GenerationTransitionHostTrace;
}

/** Shared carrier-wiring trace used by Standalone and Studio integration tests. */
export function createGenerationTransitionTrace(): GenerationTransitionTrace {
  const events: GenerationTransitionEvent[] = [];
  return {
    record: (event) => { events.push(event); },
    host: (_host) => {
      const coldReady = events.indexOf('successor-cold-ready');
      const terminal = events.indexOf('operation-terminal');
      return Object.freeze({
        events: Object.freeze([...events]),
        terminalBeforeColdReady: terminal >= 0 && (coldReady < 0 || terminal < coldReady),
        oldProjection: coldReady >= 0 && terminal >= coldReady ? 'stale' : 'current',
      });
    },
  };
}

export function createEditorPanelContributionsExtension(): AppExtension {
  const viewport = createViewportPanelContributionsExtension();
  const hierarchy = createHierarchyPanelContributionsExtension();
  const assetEditors = createAssetEditorsPanelContributionsExtension();
  return {
    id: 'editor.panel-contributions',
    version: '1.0.0',
    requires: ['commands', 'panelActions', 'panelControls', 'contextKeys'],
    setup(ctx) {
      const cleanups = [viewport, hierarchy, assetEditors]
        .map((extension) => extension.setup?.(ctx))
        .filter((cleanup): cleanup is () => void => typeof cleanup === 'function');
      return () => {
        for (const cleanup of cleanups.slice().reverse()) cleanup();
      };
    },
  };
}
