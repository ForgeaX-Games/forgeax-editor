import { describe, expect, test } from 'bun:test';
import {
  createEditorRuntimeEntry,
  EDITOR_RUNTIME_ENTRY_CAPABILITIES,
  EDITOR_RUNTIME_ENTRY_CONTRACT_VERSION,
  EDITOR_RUNTIME_ENTRY_ID,
  forwardViewportRuntimeTransportRequest,
  getViewportRuntimeClientSnapshot,
  subscribeViewportRuntimeClient,
} from '../bridge';
import { ViewportComponent } from '../viewport/ViewportComponent';

describe('public Editor runtime entry', () => {
  test('mounts the existing ViewportComponent and declares its World owner', () => {
    const entry = createEditorRuntimeEntry();

    expect(entry.contractVersion).toBe(EDITOR_RUNTIME_ENTRY_CONTRACT_VERSION);
    expect(entry.id).toBe(EDITOR_RUNTIME_ENTRY_ID);
    expect(entry.runtimeKind).toBe('world-backed');
    expect(entry.owner).toBe('editor-edit-runtime');
    expect(entry.capabilities).toEqual(EDITOR_RUNTIME_ENTRY_CAPABILITIES);
    expect(entry.mount({ gameSlug: 'gta-route-dev' }).type).toBe(ViewportComponent);
  });

  test('routes gameplay through the one Editor-owned bridge and fails closed after disposal', async () => {
    const entry = createEditorRuntimeEntry();
    // The public entry cannot accept or replace the bridge. The mounted
    // ViewportComponent is the sole publisher, so an unmounted entry must fail
    // closed instead of allowing a host-supplied fake to report success.
    expect('registerGameplayBridge' in entry).toBe(false);
    await expect(entry.executeGameplay({ version: 1, operation: 'describe' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'surface-unavailable' },
    });
  });

  test('publishes the existing viewport transport client through the host bridge', async () => {
    expect(getViewportRuntimeClientSnapshot()).toMatchObject({ status: 'disconnected', runtime: null });
    expect(typeof subscribeViewportRuntimeClient).toBe('function');
    await expect(forwardViewportRuntimeTransportRequest({
      jsonrpc: '2.0',
      version: 'editor-transport/v1',
      id: 'host-bridge-disconnected',
      correlationId: 'host-bridge-disconnected',
      scope: 'viewport:disconnected:0',
      method: 'discover',
      params: {},
    })).resolves.toMatchObject({
      error: { code: 'viewport-runtime-disconnected' },
    });
  });
});
