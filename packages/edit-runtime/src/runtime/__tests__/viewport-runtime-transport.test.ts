import { describe, expect, test } from 'bun:test';
import {
  TRANSPORT_PROTOCOL_VERSION,
  VIEWPORT_RUNTIME_CONTRACT_VERSION,
  type TransportMessagePort,
  type TransportService,
  type ViewportRuntimeIdentity,
} from '@forgeax/editor-product';
import {
  VIEWPORT_RUNTIME_CONNECT,
  VIEWPORT_RUNTIME_CONNECTED,
  VIEWPORT_RUNTIME_READY,
  VIEWPORT_PREVIEW_EXECUTOR_CONNECT,
  VIEWPORT_PREVIEW_EXECUTOR_CONNECTED,
  VIEWPORT_PREVIEW_EXECUTOR_DISCONNECT,
  createInProcessViewportRuntimeClient,
  createViewportProjectionQuery,
  createViewportRuntimeTransportService,
  installViewportRuntimeConnectionHost,
  readViewportRuntimeIdentity,
  readViewportRuntimeHostOrigin,
} from '../viewport-runtime-transport';
import { createPreviewExecutorLeaseIdentity } from '../preview-executor-lease';
import type { HierarchyRuntimeProjection, HierarchyStructureProjection } from '@forgeax/editor-panels';
import { createExecutionReport, unavailableExecutionCapabilities } from '@forgeax/engine-app';

const runtime: ViewportRuntimeIdentity = {
  version: VIEWPORT_RUNTIME_CONTRACT_VERSION,
  runtimeId: 'runtime-a',
  runtimeGeneration: 4,
  carrierId: 'frame-a',
  carrierKind: 'iframe',
};

class FakeTarget {
  listener: ((event: any) => void) | null = null;
  addEventListener(_type: 'message', listener: (event: any) => void) { this.listener = listener; }
  removeEventListener(_type: 'message', listener: (event: any) => void) {
    if (this.listener === listener) this.listener = null;
  }
  emit(event: any) { this.listener?.(event); }
}

function fakePort(): TransportMessagePort & { closed: boolean } {
  return {
    closed: false,
    postMessage() {},
    addEventListener() {},
    removeEventListener() {},
    close() { this.closed = true; },
  };
}

describe('viewport runtime transport', () => {
  test('adapts the canonical service for the in-process shell and fences disposal', async () => {
    const requests: unknown[] = [];
    const service = {
      handle: async (request: unknown) => {
        requests.push(request);
        return { jsonrpc: '2.0', id: 'request-1', correlationId: 'request-1', result: { ok: true } };
      },
    } as never;
    const client = createInProcessViewportRuntimeClient(service);
    const request = {
      jsonrpc: '2.0',
      version: 'editor-transport/v1',
      id: 'request-1',
      correlationId: 'request-1',
      scope: 'viewport:runtime:1',
      method: 'transport.describe',
      params: {},
    } as const;

    await expect(client.request(request)).resolves.toMatchObject({ result: { ok: true } });
    expect(requests).toEqual([request]);

    client.dispose();
    await expect(client.request(request)).rejects.toThrow('viewport-runtime-client-disposed');
  });

  test('accepts one trusted generation and rejects source, stale, and replayed connections', () => {
    const target = new FakeTarget();
    const acknowledgements: unknown[] = [];
    const source = { postMessage: (message: unknown) => acknowledgements.push(message) };
    const rejected: string[] = [];
    const service = { handle: async () => { throw new Error('unused'); } } as unknown as TransportService;
    const dispose = installViewportRuntimeConnectionHost({
      target,
      expectedSource: source,
      expectedOrigin: 'https://editor.test',
      runtime,
      service,
      onReject: (reason) => rejected.push(reason),
    });
    const connect = { type: VIEWPORT_RUNTIME_CONNECT, challenge: 'challenge-a', runtime };
    const port = fakePort();

    target.emit({
      data: { type: 'VAG_CARRIER_HEARTBEAT', payload: { renderReadiness: 'ready' } },
      origin: 'https://editor.test',
      source: {},
      ports: [],
    });
    target.emit({ data: connect, origin: 'https://evil.test', source, ports: [port] });
    target.emit({ data: { ...connect, runtime: { ...runtime, runtimeGeneration: 3 } }, origin: 'https://editor.test', source, ports: [port] });
    target.emit({ data: connect, origin: 'https://editor.test', source, ports: [port] });
    target.emit({ data: connect, origin: 'https://editor.test', source, ports: [fakePort()] });

    expect(acknowledgements).toEqual([
      { type: VIEWPORT_RUNTIME_READY, runtime },
      { type: VIEWPORT_RUNTIME_CONNECTED, challenge: 'challenge-a', runtime },
    ]);
    expect(rejected).toEqual([
      'viewport-runtime-untrusted-source',
      'viewport-runtime-generation-mismatch',
      'viewport-runtime-challenge-replayed',
    ]);
    dispose();
    expect(port.closed).toBe(true);
  });

  test('authorizes a separate reverse preview port only inside the active forward challenge', () => {
    const target = new FakeTarget();
    const acknowledgements: unknown[] = [];
    const source = { postMessage: (message: unknown) => acknowledgements.push(message) };
    const rejected: string[] = [];
    const bindings: string[] = [];
    const service = { handle: async () => { throw new Error('unused'); } } as unknown as TransportService;
    const dispose = installViewportRuntimeConnectionHost({
      target,
      expectedSource: source,
      expectedOrigin: 'https://editor.test',
      runtime,
      service,
      onPreviewExecutorLeaseConnect: (lease) => {
        bindings.push(`bind:${lease.leaseId}`);
        return () => bindings.push(`unbind:${lease.leaseId}`);
      },
      onReject: (reason) => rejected.push(reason),
    });
    const challenge = 'challenge-preview';
    target.emit({
      data: { type: VIEWPORT_RUNTIME_CONNECT, challenge, runtime },
      origin: 'https://editor.test', source, ports: [fakePort()],
    });
    const lease = createPreviewExecutorLeaseIdentity('vfx-preview/v1', 'vfx-a', () => 'lease-preview');
    const previewPort = fakePort();
    target.emit({
      data: { type: VIEWPORT_PREVIEW_EXECUTOR_CONNECT, challenge: 'wrong', runtime, lease },
      origin: 'https://editor.test', source, ports: [previewPort],
    });
    target.emit({
      data: { type: VIEWPORT_PREVIEW_EXECUTOR_CONNECT, challenge, runtime, lease },
      origin: 'https://editor.test', source, ports: [previewPort],
    });

    expect(bindings).toEqual(['bind:lease-preview']);
    expect(acknowledgements).toContainEqual({
      type: VIEWPORT_PREVIEW_EXECUTOR_CONNECTED,
      challenge,
      runtime,
      lease,
    });
    expect(rejected).toEqual(['viewport-preview-executor-generation-mismatch']);

    target.emit({
      data: { type: VIEWPORT_PREVIEW_EXECUTOR_DISCONNECT, challenge, runtime, lease },
      origin: 'https://editor.test', source, ports: [],
    });
    expect(bindings).toEqual(['bind:lease-preview', 'unbind:lease-preview']);
    expect(previewPort.closed).toBe(true);
    dispose();
  });

  test('derives one fenced identity from the carrier URL', () => {
    expect(readViewportRuntimeIdentity(
      '?runtimeId=runtime-b&runtimeGeneration=7&carrierId=popup-b&carrierKind=browser-page',
      () => 'unused',
    )).toEqual({
      version: VIEWPORT_RUNTIME_CONTRACT_VERSION,
      runtimeId: 'runtime-b',
      runtimeGeneration: 7,
      carrierId: 'popup-b',
      carrierKind: 'browser-page',
    });
    expect(readViewportRuntimeIdentity('?runtimeGeneration=bad&carrierKind=bad', () => 'nonce')).toEqual({
      version: VIEWPORT_RUNTIME_CONTRACT_VERSION,
      runtimeId: 'visible-nonce',
      runtimeGeneration: 1,
      carrierId: 'local-nonce',
      carrierKind: 'local',
    });
  });

  test('uses an explicit host origin for a separately served iframe', () => {
    expect(readViewportRuntimeHostOrigin('?hostOrigin=https%3A%2F%2Fshell.test%2Fpath', 'https://runtime.test'))
      .toBe('https://shell.test');
    expect(readViewportRuntimeHostOrigin('?hostOrigin=not-a-url', 'https://runtime.test'))
      .toBe('https://runtime.test');
  });

  test('separates empty, unavailable, ready, and invalid projection states', () => {
    let status: 'bound' | 'unbound' = 'unbound';
    const graph = {
      stats: () => ({ status }),
    } as any;
    let rows: unknown[] = [];
    const gateway = { buildQueryFn: () => () => ({ ok: true, rows }) } as any;
    const query = createViewportProjectionQuery({ runtime, graph, gateway });

    expect(query({ kind: 'world.snapshot', with: ['Name'] }).status).toBe('unavailable');
    status = 'bound';
    expect(query({ kind: 'world.snapshot', with: ['Name'] }).status).toBe('empty');
    rows = [{ entity: 1, Name: { value: 'Cube' } }];
    const ready = query({ kind: 'world.snapshot', with: ['Name'] });
    expect(ready.status).toBe('ready');
    expect(ready.revision).toBe(3);
    expect(query({ kind: 'unknown' }).status).toBe('faulted');
  });

  test('serves the Runtime-owned hierarchy baseline without exposing its World', () => {
    const graph = { stats: () => ({ status: 'bound' }) } as any;
    const gateway = { buildQueryFn: () => () => ({ ok: true, rows: [] }) } as any;
    const hierarchy = {
      structureEpoch: 2,
      rows: [{ id: 1, name: 'Cube', typeId: 'MeshFilter', mobility: 'static', childIds: [] }],
    } as unknown as HierarchyStructureProjection;
    const panelProjection = {
      structure: hierarchy,
      selectionIds: [hierarchy.rows[0]!.id],
    } satisfies HierarchyRuntimeProjection;
    const query = createViewportProjectionQuery({ runtime, graph, gateway, readHierarchy: () => panelProjection });
    const result = query({ kind: 'hierarchy.structure' });
    expect(result).toMatchObject({ status: 'ready', value: panelProjection });
    expect(JSON.stringify(result)).not.toContain('activeWorld');
  });

  test('serves viewport chrome state as a disposable Runtime projection', () => {
    const graph = { stats: () => ({ status: 'bound' }) } as any;
    const gateway = { buildQueryFn: () => () => ({ ok: true, rows: [] }) } as any;
    const viewport = {
      quadrant: { run: 'play', display: 'game', control: 'game', inputTarget: 'game' },
      playPhase: 'play',
      lastPlayError: null,
      canUndo: false,
      canRedo: true,
    };
    const query = createViewportProjectionQuery({
      runtime,
      graph,
      gateway,
      readViewportStatus: () => viewport,
    });
    expect(query({ kind: 'viewport.status' })).toMatchObject({
      status: 'ready',
      value: viewport,
    });
  });

  test('projects producer-owned diagnostics and Engine execution reports', () => {
    const graph = { stats: () => ({ status: 'bound' }) } as any;
    const gateway = { buildQueryFn: () => () => ({ ok: true, rows: [] }) } as any;
    const diagnostics = { schemaVersion: 'diagnostics/v1', revision: 7 } as any;
    const execution = createExecutionReport(
      'auto',
      unavailableExecutionCapabilities('test'),
    );
    const query = createViewportProjectionQuery({
      runtime,
      graph,
      gateway,
      readDiagnostics: () => diagnostics,
      readExecutionReport: () => execution,
    });

    expect(query({ kind: 'diagnostics.snapshot' })).toMatchObject({
      status: 'ready',
      value: diagnostics,
    });
    expect(query({ kind: 'engine.execution' })).toMatchObject({
      status: 'ready',
      value: { schemaVersion: 1, requestedTier: 'auto' },
    });
  });

  test('serves the selected Inspector entity as a disposable value projection', () => {
    const graph = { stats: () => ({ status: 'bound' }) } as any;
    const gateway = { buildQueryFn: () => () => ({ ok: true, rows: [] }) } as any;
    const entity = {
      id: 3 as HierarchyStructureProjection['rows'][number]['id'],
      name: 'Camera',
      components: { Transform: { pos: [1, 2, 3] }, Camera: { fov: 60 } },
    };
    const query = createViewportProjectionQuery({
      runtime,
      graph,
      gateway,
      readInspector: () => ({ selectionIds: [entity.id], entities: [entity], entity }),
    });
    expect(query({ kind: 'inspector.selection' })).toMatchObject({
      status: 'ready',
      value: { selectionIds: [entity.id], entity },
    });
  });

  test('projects the Runtime AssetRegistry catalog without creating a shell registry', () => {
    const graph = { stats: () => ({ status: 'bound' }) } as any;
    const gateway = { buildQueryFn: () => () => ({ ok: true, rows: [] }) } as any;
    const entries = [{ guid: 'mesh-a', kind: 'mesh', name: 'Mesh A', packageUrl: '/assets/a.pack.json' }];
    const query = createViewportProjectionQuery({ runtime, graph, gateway, readAssetCatalog: () => entries });
    expect(query({ kind: 'assets.catalog' })).toMatchObject({
      status: 'ready',
      value: { entries },
    });
  });

  test('projects one Runtime AssetRegistry payload without copying the registry into the shell', async () => {
    const graph = { stats: () => ({ status: 'bound' }) } as any;
    const gateway = { buildQueryFn: () => () => ({ ok: true, rows: [] }) } as any;
    const payload = { kind: 'mesh', vertices: new Float32Array([0, 0, 0]) };
    const query = createViewportProjectionQuery({
      runtime,
      graph,
      gateway,
      readAssetPayload: async (guid) => guid === 'mesh-a' ? payload : undefined,
    });

    await expect(query({ kind: 'assets.payload', guid: 'mesh-a' })).resolves.toMatchObject({
      status: 'ready',
      value: { guid: 'mesh-a', payload },
    });
    await expect(query({ kind: 'assets.payload', guid: 'missing' })).resolves.toMatchObject({
      status: 'empty',
    });
  });

  test('projects one Runtime-owned asset payload by stable guid', async () => {
    const graph = { stats: () => ({ status: 'bound' }) } as any;
    const gateway = { buildQueryFn: () => () => ({ ok: true, rows: [] }) } as any;
    const payload = { guid: 'vfx-a', program: { emitters: [] } };
    const query = createViewportProjectionQuery({
      runtime,
      graph,
      gateway,
      readAssetPayload: async (guid) => guid === 'vfx-a' ? payload : undefined,
    });
    await expect(query({ kind: 'assets.payload', guid: 'vfx-a' })).resolves.toMatchObject({
      status: 'ready',
      value: { guid: 'vfx-a', payload },
    });
    await expect(query({ kind: 'assets.payload', guid: 'missing' })).resolves.toMatchObject({
      status: 'empty',
    });
  });

  test('accepts panel writes in the fenced viewport journal scope', async () => {
    const dispatched: unknown[] = [];
    const graph = {
      stats: () => ({ status: 'bound', worldGeneration: 1 }),
      mount: () => ({ getSnapshot: () => ({ structureEpoch: 1, rows: [] }), subscribe: () => () => {}, unsubscribe() {} }),
    } as any;
    const gateway = {
      listOps: () => [{
        id: 'setSelection', domain: 'session', title: 'Set Selection',
        argsSchema: { type: 'object', properties: { id: { type: 'number', nullable: true } }, required: ['id'] },
        source: 'builtin', availability: { available: true },
      }],
      subscribeOperationCapabilities: () => () => {},
      dispatch: (operation: unknown) => { dispatched.push(operation); return { ok: true }; },
      buildQueryFn: () => () => ({ ok: true, rows: [] }),
      retryOperationRun: () => ({ ok: false, error: { code: 'unused', hint: 'unused' } }),
      getOperationRunResult: () => ({ ok: false, error: { code: 'unused', hint: 'unused' } }),
      waitOperationRun: async () => ({ ok: false, error: { code: 'unused', hint: 'unused' } }),
      subscribeOperationRun: () => () => {},
      cancelOperationRun: () => ({ ok: false, error: { code: 'unused', hint: 'unused' } }),
      assetCatalog: () => [],
      activeWorld: null,
    } as any;
    const service = createViewportRuntimeTransportService({ runtime, graph, gateway });
    const scope = 'viewport:runtime-a:4';
    const response = await service.handle({
      jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION,
      id: 'select-1', correlationId: 'select-1', scope, method: 'run.dispatch',
      params: {
        operationId: 'editor.setSelection', input: { id: 7 },
        actor: { id: 'hierarchy', kind: 'human' }, sessionId: 'panel',
      },
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({ status: 'succeeded', scope });
    expect(dispatched).toEqual([{ kind: 'setSelection', id: 7 }]);
    service.dispose();
  });

  test('releases hierarchy and live capability subscriptions exactly once', () => {
    let hierarchyDisposals = 0;
    let capabilityDisposals = 0;
    const graph = {
      stats: () => ({ status: 'bound', worldGeneration: 1 }),
      mount: () => ({
        getSnapshot: () => ({ structureEpoch: 1, rows: [] }),
        subscribe: () => () => {},
        unsubscribe: () => { hierarchyDisposals += 1; },
      }),
    } as any;
    const gateway = {
      listOps: () => [],
      subscribeOperationCapabilities: () => () => { capabilityDisposals += 1; },
      dispatch: () => ({ ok: true }),
      buildQueryFn: () => () => ({ ok: true, rows: [] }),
      retryOperationRun: () => ({ ok: false, error: { code: 'unused', hint: 'unused' } }),
      getOperationRunResult: () => ({ ok: false, error: { code: 'unused', hint: 'unused' } }),
      waitOperationRun: async () => ({ ok: false, error: { code: 'unused', hint: 'unused' } }),
      subscribeOperationRun: () => () => {},
      cancelOperationRun: () => ({ ok: false, error: { code: 'unused', hint: 'unused' } }),
      assetCatalog: () => [],
      operationRunSnapshot: () => ({ revision: 0, runs: [] }),
      diagnostics: { snapshot: () => ({ revision: 0, entries: [] }) },
      activeWorld: null,
      doc: { registry: undefined },
    } as any;
    const service = createViewportRuntimeTransportService({ runtime, graph, gateway });

    service.dispose();
    service.dispose();

    expect(hierarchyDisposals).toBe(1);
    expect(capabilityDisposals).toBe(1);
  });
});
