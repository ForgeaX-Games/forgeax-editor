import { afterEach, describe, expect, test } from 'bun:test';
import {
  bindViewportRuntimeClient,
  getViewportRuntimeClientSnapshot,
} from '../viewport-runtime-client';
import {
  canDispatchPanelDocumentOperations,
  getEditorPanelAuthoritySnapshot,
  usesCarrierHierarchyProjection,
  usesHostGatewayForPanelDispatch,
} from '../editor-panel-authority';
import type { MessagePortTransportClient, ViewportRuntimeIdentity } from '@forgeax/editor-product';
import { TRANSPORT_PROTOCOL_VERSION, VIEWPORT_RUNTIME_CONTRACT_VERSION } from '@forgeax/editor-product';

const runtime = (generation: number): ViewportRuntimeIdentity => ({
  version: VIEWPORT_RUNTIME_CONTRACT_VERSION,
  runtimeId: 'edit-runtime',
  runtimeGeneration: generation,
  carrierId: `frame-${generation}`,
  carrierKind: 'iframe',
});

function client(): MessagePortTransportClient {
  return {
    request: async () => ({
      jsonrpc: '2.0',
      version: TRANSPORT_PROTOCOL_VERSION,
      id: '1',
      correlationId: '1',
      result: {},
    }),
    dispose() {},
  };
}

function disconnectClient(): void {
  if (getViewportRuntimeClientSnapshot().status === 'disconnected') return;
  bindViewportRuntimeClient(runtime(Number.MAX_SAFE_INTEGER), client())();
}

describe('editor panel authority', () => {
  afterEach(() => {
    disconnectClient();
  });

  test('pairs host-coworker read/write when RuntimeUiGraph is mounted', () => {
    const snapshot = getEditorPanelAuthoritySnapshot();
    if (!snapshot.hasLocalRuntimeGraph) return;
    expect(snapshot.mode).toBe('host-coworker');
    expect(usesHostGatewayForPanelDispatch(snapshot)).toBe(true);
    expect(usesCarrierHierarchyProjection(snapshot)).toBe(false);
    expect(canDispatchPanelDocumentOperations(snapshot)).toBe(true);
  });

  test('pairs projection-client carrier read with runtime dispatch when graph is absent', () => {
    const snapshot = getEditorPanelAuthoritySnapshot();
    if (snapshot.hasLocalRuntimeGraph) return;
    expect(snapshot.mode).toBe('projection-client');
    expect(usesHostGatewayForPanelDispatch(snapshot)).toBe(false);
    if (snapshot.viewportRuntimeReady) {
      expect(usesCarrierHierarchyProjection(snapshot)).toBe(true);
      expect(canDispatchPanelDocumentOperations(snapshot)).toBe(true);
    }
  });

  test('returns a stable snapshot reference while authority facts are unchanged', () => {
    const first = getEditorPanelAuthoritySnapshot();
    const second = getEditorPanelAuthoritySnapshot();
    expect(second).toBe(first);
  });

  test('blocks projection-client dispatch until the viewport client is ready', () => {
    disconnectClient();
    const snapshot = getEditorPanelAuthoritySnapshot();
    if (snapshot.hasLocalRuntimeGraph) return;
    expect(snapshot.viewportRuntimeReady).toBe(false);
    expect(usesCarrierHierarchyProjection(snapshot)).toBe(false);
    expect(canDispatchPanelDocumentOperations(snapshot)).toBe(false);
  });
});
