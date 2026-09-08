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
  VIEWPORT_RUNTIME_PROJECTION_INVALIDATED,
  VIEWPORT_PREVIEW_EXECUTOR_CONNECT,
  VIEWPORT_PREVIEW_EXECUTOR_CONNECTED,
  VIEWPORT_PREVIEW_EXECUTOR_DISCONNECT,
  createInProcessViewportRuntimeClient,
  shouldBindInProcessViewportRuntimeClient,
  createViewportProjectionQuery,
  createViewportReferenceCreationJournalStore,
  createViewportRuntimeTransportService,
  installViewportRuntimeConnectionHost,
  isViewportRuntimeProjectionInvalidatedMessage,
  readViewportRuntimeIdentity,
  readViewportRuntimeHostOrigin,
} from '../viewport-runtime-transport';
import { createPreviewExecutorLeaseIdentity } from '../preview-executor-lease';
import type { HierarchyRuntimeProjection, HierarchyStructureProjection } from '@forgeax/editor-panels';
import type { VersionControlSnapshot } from '@forgeax/editor-core';
import { createExecutionReport, unavailableExecutionCapabilities } from '@forgeax/engine-app';
import { createMaterialPublicationBinding } from '../../viewport/render-diagnostics';

const runtime: ViewportRuntimeIdentity = {
  version: VIEWPORT_RUNTIME_CONTRACT_VERSION,
  runtimeId: 'runtime-a',
  runtimeGeneration: 4,
  carrierId: 'frame-a',
  carrierKind: 'iframe',
};
const referenceCreationScope = { gameRoot: 'game-a', sceneId: 'scene-a' };

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

function transportGatewayStub(overrides: Record<string, unknown> = {}) {
  return {
    listOps: () => [],
    assetCatalog: () => [],
    buildQueryFn: () => () => ({ ok: true, rows: [] }),
    subscribeOperationCapabilities: () => () => {},
    dispatch: () => ({ ok: true }),
    getOperationRunResult: () => ({ ok: false, error: { code: 'unused', hint: 'unused' } }),
    waitOperationRun: async () => ({ ok: false, error: { code: 'unused', hint: 'unused' } }),
    retryOperationRun: () => ({ ok: false, error: { code: 'unused', hint: 'unused' } }),
    subscribeOperationRun: () => () => {},
    cancelOperationRun: () => ({ ok: false, error: { code: 'unused', hint: 'unused' } }),
    operationRunSnapshot: () => ({ revision: 0, runs: [] }),
    diagnostics: { snapshot: () => ({ revision: 0, entries: [] }) },
    activeWorld: null,
    doc: { registry: undefined },
    reconnectCapabilitySnapshot: () => ({ revision: 0, ops: [] }),
    ...overrides,
  } as any;
}

describe('viewport runtime transport', () => {
  test('accepts only precise asset publication invalidations', () => {
    expect(isViewportRuntimeProjectionInvalidatedMessage({
      type: VIEWPORT_RUNTIME_PROJECTION_INVALIDATED,
      runtime,
      projection: 'assets',
      revision: 9,
      guid: 'mesh-guid',
    })).toBe(true);
    expect(isViewportRuntimeProjectionInvalidatedMessage({
      type: VIEWPORT_RUNTIME_PROJECTION_INVALIDATED,
      runtime,
      projection: 'assets',
      revision: 9,
    })).toBe(false);
  });
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

  test('binds the in-process shell client for desktop hosts so Play is not stuck disabled', () => {
    expect(shouldBindInProcessViewportRuntimeClient('local')).toBe(true);
    expect(shouldBindInProcessViewportRuntimeClient('browser-page')).toBe(true);
    expect(shouldBindInProcessViewportRuntimeClient('tauri-webview')).toBe(true);
    expect(shouldBindInProcessViewportRuntimeClient('iframe')).toBe(false);
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

  test('repeats the ready handshake when a shell rebinds an existing carrier generation', () => {
    const target = new FakeTarget();
    const acknowledgements: unknown[] = [];
    const source = { postMessage: (message: unknown) => acknowledgements.push(message) };
    const service = { handle: async () => { throw new Error('unused'); } } as unknown as TransportService;
    const dispose = installViewportRuntimeConnectionHost({
      target,
      expectedSource: source,
      expectedOrigin: 'https://editor.test',
      runtime,
      service,
    });
    target.emit({ data: { type: VIEWPORT_RUNTIME_READY, runtime }, origin: 'https://editor.test', source, ports: [] });
    expect(acknowledgements).toEqual([
      { type: VIEWPORT_RUNTIME_READY, runtime },
      { type: VIEWPORT_RUNTIME_READY, runtime },
    ]);
    dispose();
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

  test('projects only externally authored visual review facts after capture and renderer validation', () => {
    const graph = { stats: () => ({ status: 'bound' }) } as any;
    const gateway = { buildQueryFn: () => () => ({ ok: true, rows: [] }) } as any;
    const facts = {
      authoredBy: 'verify', executor: 'step-verify-visual-executor', expectation: 'edit-prop-after-reopen',
      observed: { targetCount: 3 }, verdict: 'pass', confidence: 0.98,
      capture: { runId: 'edit-artifact', tapePath: '.forgeax-debug/edit-artifact/frame-0.tape.bin', reportPath: '.forgeax-debug/edit-artifact/frame-0.report.json' },
      renderer: { backend: 'webgpu', generation: 1, carrierGeneration: 1, rendererIdentity: 'edit-renderer-1' },
    } as const;
    const query = createViewportProjectionQuery({ runtime, graph, gateway, readVisualReview: (_expectation, creationRunId) => creationRunId === 'run-a' ? facts : undefined });
    expect(query({ kind: 'reference-creation.visual-review', expectation: 'edit-prop-after-reopen', creationRunId: 'run-a' })).toMatchObject({ status: 'ready', value: facts });
    expect(query({ kind: 'reference-creation.visual-review', expectation: 'edit-prop-after-reopen', creationRunId: 'run-b' })).toMatchObject({ status: 'unavailable', error: { code: 'visual-review-unavailable' } });
    expect(query({ kind: 'reference-creation.visual-review', expectation: 'play-prop-roundtrip', creationRunId: 'run-a' })).toMatchObject({ status: 'faulted', error: { code: 'visual-review-invalid' } });
    const unavailable = createViewportProjectionQuery({ runtime, graph, gateway });
    expect(unavailable({ kind: 'reference-creation.visual-review', expectation: 'edit-prop-after-reopen', creationRunId: 'run-a' })).toMatchObject({ status: 'unavailable', error: { code: 'visual-review-unavailable' } });
    expect(unavailable({ kind: 'reference-creation.visual-review', expectation: 'edit-prop-after-reopen' })).toMatchObject({ status: 'faulted', error: { code: 'projection-query-invalid' } });
  });

  test('isolates persisted reference journals by game, runtime identity, and exact creation run', () => {
    const previous = (globalThis as { localStorage?: unknown }).localStorage;
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
      },
    });
    try {
      const scope = { gameRoot: 'game-a', sceneId: 'scene-a' };
      const storeA = createViewportReferenceCreationJournalStore(runtime, scope)!;
      const storeSameRuntime = createViewportReferenceCreationJournalStore(runtime, scope)!;
      const storeOtherRuntime = createViewportReferenceCreationJournalStore({ ...runtime, runtimeId: 'runtime-b' }, scope)!;
      const storeReconnectedRuntime = createViewportReferenceCreationJournalStore({ ...runtime, runtimeGeneration: runtime.runtimeGeneration + 1 }, scope)!;
      const storeOtherScope = createViewportReferenceCreationJournalStore(runtime, { gameRoot: 'game-b', sceneId: 'scene-a' })!;
      const record = { creationRunId: 'run-a', kind: 'run-created' } as never;

      storeA.write([record]);
      expect(storeSameRuntime.read()).toEqual([record]);
      expect(storeOtherRuntime.read()).toEqual([]);
      expect(storeReconnectedRuntime.read()).toEqual([record]);
      expect(storeOtherScope.read()).toEqual([]);
    } finally {
      if (previous === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
      else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previous });
    }
  });

  test('recovers a scoped journal across a legal reconnect while stale requests stay fenced', async () => {
    const previous = (globalThis as { localStorage?: unknown }).localStorage;
    const values = new Map<string, string>();
    let requestedKey = '';
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => { requestedKey = key; return values.get(key) ?? null; },
        setItem: (key: string, value: string) => { values.set(key, value); },
      },
    });
    try {
      const reconnectRuntime = { ...runtime, runtimeId: 'runtime-reconnect' };
      const reconnectScope = { gameRoot: 'game-reconnect', sceneId: 'scene-reconnect' };
      const store = createViewportReferenceCreationJournalStore(reconnectRuntime, reconnectScope)!;
      const record = { creationRunId: 'reconnect-run', kind: 'run-created' } as never;
      store.write([record]);
      const reconnected = createViewportReferenceCreationJournalStore({ ...reconnectRuntime, runtimeGeneration: 5 }, reconnectScope)!;
      expect(reconnected.read()).toEqual([record]);
      expect(requestedKey).not.toContain(':4');

      const gateway = transportGatewayStub();
      const service = createViewportRuntimeTransportService({
        runtime: { ...reconnectRuntime, runtimeGeneration: 5 },
        referenceCreationScope: reconnectScope,
        graph: { stats: () => ({ status: 'bound' }), mount: () => ({ getSnapshot: () => ({ structureEpoch: 1, rows: [] }), subscribe: () => () => {}, unsubscribe: () => {} }) } as any,
        gateway,
        referenceCreationJournalStore: reconnected,
      });
      const stale = await service.handle({
        jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: 'stale', correlationId: 'stale', scope: 'viewport:runtime-reconnect:4', method: 'reference-creation',
        params: { action: 'journal', creationRunId: 'reconnect-run', actor: { id: 'test', kind: 'ai' }, sessionId: 'test' },
      });
      expect(stale).toMatchObject({ error: { code: 'scope-mismatch' } });
      service.dispose();
    } finally {
      if (previous === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
      else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previous });
    }
  });

  test('revokes retained older services when a newer generation claims the same runtime scope', async () => {
    const fenceRuntime = { ...runtime, runtimeId: 'runtime-fence' };
    const fenceScope = { gameRoot: 'game-fence', sceneId: 'scene-fence' };
    const dispatched: unknown[] = [];
    const graph = {
      stats: () => ({ status: 'bound', worldGeneration: 1 }),
      mount: () => ({ getSnapshot: () => ({ structureEpoch: 1, rows: [] }), subscribe: () => () => {}, unsubscribe() {} }),
    } as any;
    const gateway = transportGatewayStub({
      listOps: () => [{ id: 'setSelection', domain: 'session', title: 'Set Selection', argsSchema: { type: 'object' }, source: 'builtin', availability: { available: true } }],
      dispatch: (operation: unknown) => { dispatched.push(operation); return { ok: true }; },
    });
    const oldService = createViewportRuntimeTransportService({ runtime: fenceRuntime, referenceCreationScope: fenceScope, graph, gateway });
    const currentRuntime = { ...fenceRuntime, runtimeGeneration: fenceRuntime.runtimeGeneration + 1 };
    const currentService = createViewportRuntimeTransportService({ runtime: currentRuntime, referenceCreationScope: fenceScope, graph, gateway });
    const request = (id: string, scope: string) => ({
      jsonrpc: '2.0' as const, version: TRANSPORT_PROTOCOL_VERSION, id, correlationId: id, scope, method: 'run.dispatch',
      params: { operationId: 'editor.setSelection', input: { id: 7 }, actor: { id: 'test', kind: 'human' }, sessionId: 'test' },
    });

    await expect(oldService.handle(request('old-read', 'viewport:runtime-fence:4'))).resolves.toMatchObject({ error: { code: 'host-restarted' } });
    expect(oldService.getRun('old-run')).toMatchObject({ ok: false, error: { code: 'host-restarted' } });
    expect(oldService.listEvents('old-run')).toMatchObject({ ok: false, error: { code: 'host-restarted' } });
    await expect(currentService.handle(request('stale-request', 'viewport:runtime-fence:4'))).resolves.toMatchObject({ error: { code: 'scope-mismatch' } });
    expect(dispatched).toEqual([]);

    await expect(currentService.handle(request('current-write', 'viewport:runtime-fence:5'))).resolves.toMatchObject({ result: { status: 'succeeded' } });
    expect(dispatched).toEqual([{ kind: 'setSelection', id: 7 }]);

    currentService.dispose();
    await expect(currentService.handle(request('disposed-read', 'viewport:runtime-fence:5'))).resolves.toMatchObject({ error: { code: 'transport-port-disposed' } });
    expect(currentService.getRun('disposed-run')).toMatchObject({ ok: false, error: { code: 'transport-port-disposed' } });
    expect(currentService.listEvents('disposed-run')).toMatchObject({ ok: false, error: { code: 'transport-port-disposed' } });
    expect(dispatched).toEqual([{ kind: 'setSelection', id: 7 }]);
    oldService.dispose();
  });

  test('constructs viewport services transactionally and preserves the older service on failed replacement', async () => {
    const makeGraph = (shouldThrow: () => boolean) => ({
      stats: () => ({ status: 'bound', worldGeneration: 1 }),
      mount: () => {
        if (shouldThrow()) throw new Error('graph-mount-failed');
        return { getSnapshot: () => ({ structureEpoch: 1, rows: [] }), subscribe: () => () => {}, unsubscribe() {} };
      },
    }) as any;
    const gateway = transportGatewayStub();
    const store = { read: () => [], write: () => { throw new Error('failed construction must not persist'); } };
    const freshRuntime = { ...runtime, runtimeId: 'runtime-transaction-fresh', runtimeGeneration: 1 };
    let failFresh = true;
    expect(() => createViewportRuntimeTransportService({ runtime: freshRuntime, referenceCreationScope, graph: makeGraph(() => failFresh), gateway, referenceCreationJournalStore: store })).toThrow('graph-mount-failed');
    failFresh = false;
    const retry = createViewportRuntimeTransportService({ runtime: freshRuntime, referenceCreationScope, graph: makeGraph(() => failFresh), gateway, referenceCreationJournalStore: store });
    await expect(retry.handle({ jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: 'retry', correlationId: 'retry', scope: 'viewport:runtime-transaction-fresh:1', method: 'transport.describe', params: {} })).resolves.toMatchObject({ result: expect.any(Object) });
    retry.dispose();

    const replacementRuntime = { ...runtime, runtimeId: 'runtime-transaction-replace', runtimeGeneration: 10 };
    let failReplacement = false;
    const older = createViewportRuntimeTransportService({ runtime: replacementRuntime, referenceCreationScope, graph: makeGraph(() => failReplacement), gateway, referenceCreationJournalStore: store });
    failReplacement = true;
    expect(() => createViewportRuntimeTransportService({ runtime: { ...replacementRuntime, runtimeGeneration: 11 }, referenceCreationScope, graph: makeGraph(() => failReplacement), gateway, referenceCreationJournalStore: store })).toThrow('graph-mount-failed');
    await expect(older.handle({ jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: 'older', correlationId: 'older', scope: 'viewport:runtime-transaction-replace:10', method: 'transport.describe', params: {} })).resolves.toMatchObject({ result: expect.any(Object) });
    failReplacement = false;
    const newer = createViewportRuntimeTransportService({ runtime: { ...replacementRuntime, runtimeGeneration: 11 }, referenceCreationScope, graph: makeGraph(() => failReplacement), gateway, referenceCreationJournalStore: store });
    await expect(older.handle({ jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: 'fenced', correlationId: 'fenced', scope: 'viewport:runtime-transaction-replace:10', method: 'transport.describe', params: {} })).resolves.toMatchObject({ error: { code: 'host-restarted' } });
    await expect(newer.handle({ jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: 'newer', correlationId: 'newer', scope: 'viewport:runtime-transaction-replace:11', method: 'transport.describe', params: {} })).resolves.toMatchObject({ result: expect.any(Object) });
    older.dispose();
    newer.dispose();
  });

  test('retains disposed generation high-water and keeps stale dispose from revoking the newer service', async () => {
    const fencedRuntime = { ...runtime, runtimeId: 'runtime-high-water', runtimeGeneration: 30 };
    const graph = {
      stats: () => ({ status: 'bound', worldGeneration: 1 }),
      mount: () => ({ getSnapshot: () => ({ structureEpoch: 1, rows: [] }), subscribe: () => () => {}, unsubscribe() {} }),
    } as any;
    let gatewayCalls = 0;
    let storageWrites = 0;
    const gateway = transportGatewayStub({
      dispatch: () => { gatewayCalls += 1; return { ok: true }; },
    });
    const store = { read: () => [], write: () => { storageWrites += 1; } };
    const service30 = createViewportRuntimeTransportService({ runtime: fencedRuntime, referenceCreationScope, graph, gateway, referenceCreationJournalStore: store });
    service30.dispose();
    const service29 = createViewportRuntimeTransportService({ runtime: { ...fencedRuntime, runtimeGeneration: 29 }, referenceCreationScope, graph, gateway, referenceCreationJournalStore: store });
    const service30Again = createViewportRuntimeTransportService({ runtime: fencedRuntime, referenceCreationScope, graph, gateway, referenceCreationJournalStore: store });
    for (const [service, generation] of [[service29, 29], [service30Again, 30]] as const) {
      await expect(service.handle({ jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: `stale-${generation}`, correlationId: `stale-${generation}`, scope: `viewport:runtime-high-water:${generation}`, method: 'transport.describe', params: {} })).resolves.toMatchObject({ error: { code: 'host-restarted' } });
      await expect(service.handleLine('{}')).resolves.toContain('host-restarted');
      expect(service.getRun(`run-${generation}`)).toMatchObject({ ok: false, error: { code: 'host-restarted' } });
      expect(service.listEvents(`run-${generation}`)).toMatchObject({ ok: false, error: { code: 'host-restarted' } });
      service.dispose();
    }
    expect(gatewayCalls).toBe(0);
    expect(storageWrites).toBe(0);

    const service31 = createViewportRuntimeTransportService({ runtime: { ...fencedRuntime, runtimeGeneration: 31 }, referenceCreationScope, graph, gateway, referenceCreationJournalStore: store });
    await expect(service31.handle({ jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: 'active-31', correlationId: 'active-31', scope: 'viewport:runtime-high-water:31', method: 'transport.describe', params: {} })).resolves.toMatchObject({ result: expect.any(Object) });
    service29.dispose();
    await expect(service31.handle({ jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: 'still-active', correlationId: 'still-active', scope: 'viewport:runtime-high-water:31', method: 'transport.describe', params: {} })).resolves.toMatchObject({ result: expect.any(Object) });
    service31.dispose();
  });

  test('surfaces corrupt localStorage journals without mutating Gateway or preserving bytes through normalization', async () => {
    const previous = (globalThis as { localStorage?: unknown }).localStorage;
    const values = new Map<string, string>();
    let requestedKey = '';
    let writes = 0;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => { requestedKey = key; return values.get(key) ?? null; },
        setItem: (key: string, value: string) => { writes++; values.set(key, value); },
        removeItem: (key: string) => { writes++; values.delete(key); },
      },
    });
    try {
      const corruptRuntime = { ...runtime, runtimeId: 'runtime-corrupt' };
      const corruptScope = { gameRoot: 'game-corrupt', sceneId: 'scene-corrupt' };
      const seedStore = createViewportReferenceCreationJournalStore(corruptRuntime, corruptScope)!;
      seedStore.read();
      const corruptBytes = '{"records": [broken';
      values.set(requestedKey, corruptBytes);
      let gatewayMutations = 0;
      const gateway = transportGatewayStub({
        dispatch: () => { gatewayMutations++; return { ok: true }; },
      });
      const service = createViewportRuntimeTransportService({
        runtime: corruptRuntime,
        referenceCreationScope: corruptScope,
        graph: { stats: () => ({ status: 'bound' }), mount: () => ({ getSnapshot: () => ({ structureEpoch: 1, rows: [] }), subscribe: () => () => {}, unsubscribe: () => {} }) } as any,
        gateway,
      });
      const response = await service.handle({
        jsonrpc: '2.0', version: TRANSPORT_PROTOCOL_VERSION, id: 'corrupt', correlationId: 'corrupt', scope: 'viewport:runtime-corrupt:4', method: 'reference-creation',
        params: {
          action: 'preflight',
          input: {
            creationRunId: 'corrupt-run', referenceFingerprint: 'sha256:corrupt', targetProject: 'games/reference', targetScene: 'default', originalStage: 'blockout', viewSemantics: 'front',
            visibleFacts: ['silhouette'], inferredFacts: ['inferred'], unknownFacts: ['back'], fidelityFocus: ['shape'], correctionBudget: { perStage: 1, total: 1 },
          },
          actor: { id: 'test', kind: 'ai' }, sessionId: 'test',
        },
      });
      expect(response).toMatchObject({ error: { code: 'creation-journal-corrupt' } });
      expect(gatewayMutations).toBe(0);
      expect(writes).toBe(0);
      expect(values.get(requestedKey)).toBe(corruptBytes);
      service.dispose();

      const malformedTopLevel = '{"records": []}';
      values.set(requestedKey, malformedTopLevel);
      const topLevelStore = createViewportReferenceCreationJournalStore(corruptRuntime, corruptScope)!;
      expect(topLevelStore.read()).toEqual({ records: [] });
      expect(writes).toBe(0);
      expect(values.get(requestedKey)).toBe(malformedTopLevel);
    } finally {
      if (previous === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
      else Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previous });
    }
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
      editorWorld: {
        cameraId: 42 as any,
        rows: [{
          id: 42 as any,
          name: 'Editor Camera',
          typeId: 'Camera' as const,
          camera: { fov: 1.047 },
          transform: { pos: [0, 1.5, 9] },
        }],
      },
    } satisfies HierarchyRuntimeProjection;
    const query = createViewportProjectionQuery({ runtime, graph, gateway, readHierarchy: () => panelProjection });
    const result = query({ kind: 'hierarchy.structure' });
    expect(result).toMatchObject({ status: 'ready', value: panelProjection });
    expect((result as any).value.editorWorld.rows[0].name).toBe('Editor Camera');
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

  test('keeps viewport.status ready when the selector graph is still unbound', () => {
    const graph = { stats: () => ({ status: 'unbound' }) } as any;
    const gateway = { buildQueryFn: () => () => ({ ok: true, rows: [] }) } as any;
    const viewport = {
      quadrant: { run: 'edit', display: 'scene', control: 'editor' },
      playPhase: 'edit',
      lastPlayError: null,
      fps: 60,
      canUndo: false,
      canRedo: false,
    };
    const query = createViewportProjectionQuery({
      runtime,
      graph,
      gateway,
      readViewportStatus: () => viewport,
    });
    expect(query({ kind: 'world.snapshot', with: ['Name'] }).status).toBe('unavailable');
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

  test('projects cooked material inspection by GUID without reading a shader manifest', () => {
    const graph = { stats: () => ({ status: 'bound' }) } as any;
    const gateway = { buildQueryFn: () => () => ({ ok: true, rows: [] }) } as any;
    const inspection = {
      ok: true,
      materialGuid: 'material-guid',
      publicationGeneration: 7,
      specializationKey: 'spec-key',
      sourceClosure: [{ module: 'materials/example.material.json', digest: 'sha256:source' }],
      artifactDigest: 'sha256:artifact',
      parameterContract: { parameters: [], values: {} },
      transport: { url: '/__pack/material-guid', host: 'editor' },
    } as const;
    const ready = {
      status: 'Ready',
      guid: 'material-guid',
      materialGuid: 'material-guid',
      publicationGeneration: 7,
      specializationKey: 'spec-key',
      sourceClosure: ['materials/example.material.json'],
      artifactDigest: 'sha256:artifact',
      parameterContract: { parameters: [], values: {} },
      record: { receipt: { inputDigest: 'sha256:source' } },
      artifact: {},
    } as any;
    const binding = createMaterialPublicationBinding(
      {
        getMaterialReadiness: (guid) => guid === 'material-guid' ? ready : undefined,
        materialReadiness: new Map([['material-guid', ready]]),
      },
      { url: 'http://localhost:15290/', host: 'editor' },
    );
    const query = createViewportProjectionQuery({
      runtime,
      graph,
      gateway,
      readMaterialInspection: binding.readMaterialInspection,
    });

    expect(query({ kind: 'material.inspection', guid: 'material-guid' })).toMatchObject({
      status: 'ready',
      value: {
        ...inspection,
        sourceClosure: [{ module: 'materials/example.material.json', digest: 'sha256:source' }],
        transport: { url: 'http://localhost:15290/', host: 'editor' },
      },
    });
  });

  test('does not treat transport URLs as material publication identity', () => {
    const query = createViewportProjectionQuery({
      runtime,
      graph: { stats: () => ({ status: 'bound' }) } as any,
      gateway: { buildQueryFn: () => () => ({ ok: true, rows: [] }) } as any,
      readMaterialInspection: () => ({
        ok: true,
        materialGuid: 'material-guid',
        publicationGeneration: 7,
        specializationKey: 'spec-key',
        sourceClosure: [{ module: 'materials/example.material.json', digest: 'sha256:source' }],
        artifactDigest: 'sha256:artifact',
        parameterContract: { parameters: [], values: {} },
        transport: { url: 'http://127.0.0.1:15390/', host: 'standalone' },
      }),
    });
    const result = query({ kind: 'material.inspection', guid: 'material-guid' });
    expect(result).toMatchObject({
      status: 'ready',
      value: {
        materialGuid: 'material-guid',
        publicationGeneration: 7,
        specializationKey: 'spec-key',
        artifactDigest: 'sha256:artifact',
        parameterContract: { parameters: [], values: {} },
        transport: { host: 'standalone' },
      },
    });
    expect(result).not.toMatchObject({ value: { materialGuid: 'standalone' } });
  });

  test('keeps version-control snapshot states inside the shared value projection', () => {
    const graph = { stats: () => ({ status: 'bound' }) } as any;
    const gateway = { buildQueryFn: () => () => ({ ok: true, rows: [] }) } as any;
    const snapshots: VersionControlSnapshot[] = [
      { generation: runtime.runtimeGeneration, status: 'uninitialized', error: { code: 'version-control-unavailable', hint: 'Initialize the repository' } as never },
      { generation: runtime.runtimeGeneration, status: 'recovery-required', error: { code: 'version-control-recovery-required', hint: 'Inspect the repository' } as never },
      {
        generation: runtime.runtimeGeneration,
        status: 'ready',
        repositoryIdentity: 'repo:game-a',
        head: null,
        currentTag: null,
        snapshotId: 'snapshot-a',
        dirtyRecords: [],
        graph: { nodes: [], edges: [] },
      },
    ];
    for (const snapshot of snapshots) {
      const query = createViewportProjectionQuery({ runtime, graph, gateway, readVersionControlSnapshot: () => snapshot });
      expect(query({ kind: 'version-control.snapshot' })).toMatchObject({ status: 'ready', value: snapshot });
    }
  });

  test('refreshes the Host-owned version-control snapshot on an explicit UI read', async () => {
    const graph = { stats: () => ({ status: 'bound' }) } as any;
    const gateway = { buildQueryFn: () => () => ({ ok: true, rows: [] }) } as any;
    const clean: VersionControlSnapshot = {
      generation: runtime.runtimeGeneration,
      status: 'ready',
      repositoryIdentity: 'repo:game-a',
      head: null,
      currentTag: null,
      snapshotId: 'snapshot-clean',
      dirtyRecords: [],
      graph: { nodes: [], edges: [] },
    };
    const dirty: VersionControlSnapshot = {
      ...clean,
      snapshotId: 'snapshot-dirty',
      dirtyRecords: [{ path: 'main.ts', kind: 'modified' }],
    };
    let refreshes = 0;
    const query = createViewportProjectionQuery({
      runtime,
      graph,
      gateway,
      readVersionControlSnapshot: () => clean,
      refreshVersionControlSnapshot: async () => {
        refreshes += 1;
        return dirty;
      },
    });

    expect(query({ kind: 'version-control.snapshot' })).toMatchObject({ value: clean });
    await expect(query({ kind: 'version-control.snapshot', refresh: true })).resolves.toMatchObject({
      status: 'ready',
      value: dirty,
    });
    expect(refreshes).toBe(1);
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

  test('routes compatible asset queries to the Runtime catalog authority', () => {
    const graph = { stats: () => ({ status: 'bound' }) } as any;
    const gateway = { buildQueryFn: () => () => ({ ok: true, rows: [] }) } as any;
    const material = {
      guid: 'material-a',
      kind: 'material',
      name: 'Material A',
      packageUrl: '/assets/a.pack.json',
    };
    const calls: (string | undefined)[] = [];
    const readAssetCatalog = (compatibleWith?: string) => {
      calls.push(compatibleWith);
      return compatibleWith === 'MaterialAsset' ? [material] : [];
    };
    const query = createViewportProjectionQuery({ runtime, graph, gateway, readAssetCatalog });

    expect(query({ kind: 'assets.catalog', compatibleWith: 'MaterialAsset' })).toMatchObject({
      status: 'ready',
      value: { entries: [material] },
    });
    expect(calls).toEqual(['MaterialAsset']);
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

  test('projects the Runtime asset binding for bounded preview worlds', () => {
    const graph = { stats: () => ({ status: 'bound' }) } as any;
    const gateway = { buildQueryFn: () => () => ({ ok: true, rows: [] }) } as any;
    const binding = {
      schemaVersion: 'runtime-asset-binding-v1',
      gameId: 'game-a',
      scopeId: 'scope-a',
      generation: 1,
      status: 'ready',
      catalogUrl: '/__pack/scopes/scope-a/1/catalog.json',
      importUrlBase: '/__pack/scopes/scope-a/1/import',
      packageUrlBase: '/__pack/scopes/scope-a/1/asset',
    } as const;
    const query = createViewportProjectionQuery({
      runtime,
      graph,
      gateway,
      readRuntimeBinding: () => binding,
    });
    expect(query({ kind: 'assets.runtime-binding' })).toMatchObject({
      status: 'ready',
      value: binding,
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
    const panelRuntime = { ...runtime, runtimeId: 'runtime-panel' };
    const panelScope = { gameRoot: 'game-panel', sceneId: 'scene-panel' };
    const dispatched: unknown[] = [];
    const graph = {
      stats: () => ({ status: 'bound', worldGeneration: 1 }),
      mount: () => ({ getSnapshot: () => ({ structureEpoch: 1, rows: [] }), subscribe: () => () => {}, unsubscribe() {} }),
    } as any;
    const gateway = transportGatewayStub({
      listOps: () => [{
        id: 'setSelection', domain: 'session', title: 'Set Selection',
        argsSchema: { type: 'object', properties: { id: { type: 'number', nullable: true } }, required: ['id'] },
        source: 'builtin', availability: { available: true },
      }],
      dispatch: (operation: unknown) => { dispatched.push(operation); return { ok: true }; },
    });
    const service = createViewportRuntimeTransportService({ runtime: panelRuntime, referenceCreationScope: panelScope, graph, gateway });
    const scope = 'viewport:runtime-panel:4';
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

  test('routes reference creation through the live Gateway entry and its journal seam', async () => {
    const routeRuntime = { ...runtime, runtimeId: 'runtime-route' };
    const routeScope = { gameRoot: 'game-route', sceneId: 'scene-route' };
    const persisted: unknown[][] = [];
    const gateway = transportGatewayStub({
      listOps: () => [
        { id: 'spawnEntity', availability: { available: true }, operationRun: true, source: 'builtin', title: 'Spawn Entity' },
        { id: 'createAsset', availability: { available: false }, operationRun: true, capabilityGeneration: 'generation-test', source: 'builtin', title: 'Create Asset' },
      ],
      dispatch: (command: { kind: string }) => command.kind === 'spawnEntity'
        ? { ok: true, result: { operationRun: { requestId: 'viewport-transport-run:native-seed', runId: 'seed-run', status: 'accepted' } } }
        : { ok: false, error: { code: 'capability-gap', hint: 'owner blocked', capabilityGeneration: 'generation-test' } },
      waitOperationRun: async () => ({ ok: true, value: { requestId: 'viewport-transport-run:native-seed', runId: 'seed-run', status: 'succeeded' } }),
    });
    const service = createViewportRuntimeTransportService({
      runtime: routeRuntime,
      referenceCreationScope: routeScope,
      graph: {
        stats: () => ({ status: 'bound' }),
        mount: () => ({ getSnapshot: () => ({ structureEpoch: 1, rows: [] }), subscribe: () => () => {}, unsubscribe: () => {} }),
      } as any,
      gateway,
      referenceCreationJournalStore: {
        read: () => persisted.length === 0 ? [] : persisted[persisted.length - 1]!,
        write: (records) => persisted.push([...records]),
      },
    });
    const request = (id: string, params: unknown) => service.handle({
      jsonrpc: '2.0',
      version: TRANSPORT_PROTOCOL_VERSION,
      id,
      correlationId: id,
      scope: 'viewport:runtime-route:4',
      method: 'reference-creation',
      params: { ...(params as Record<string, unknown>), actor: { id: 'test', kind: 'ai' }, sessionId: 'test' },
    });

    await expect(request('discover', { action: 'discover' })).resolves.toMatchObject({
      result: { id: 'forgeax-reference-creation', publicRoute: 'reference-creation' },
    });
    await expect(request('journal', { action: 'journal', creationRunId: 'viewport-transport-run' })).resolves.toMatchObject({
      result: { creationRunId: 'viewport-transport-run', records: expect.any(Array) },
    });
    service.dispose();
  });

  test('releases hierarchy and live capability subscriptions exactly once', () => {
    const disposedRuntime = { ...runtime, runtimeId: 'runtime-dispose' };
    const disposedScope = { gameRoot: 'game-dispose', sceneId: 'scene-dispose' };
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
    const gateway = transportGatewayStub({
      subscribeOperationCapabilities: () => () => { capabilityDisposals += 1; },
    });
    const service = createViewportRuntimeTransportService({ runtime: disposedRuntime, referenceCreationScope: disposedScope, graph, gateway });

    service.dispose();
    service.dispose();

    expect(hierarchyDisposals).toBe(1);
    expect(capabilityDisposals).toBe(1);
  });
});
