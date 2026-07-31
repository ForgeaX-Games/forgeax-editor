import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { gateway } from '../store/gateway';
import { setPathResolver } from '../util/path-resolver';
import '../session/source-file-ops';

describe('deleteSourceFile session op (OperationRun convergence)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setPathResolver((rel) => `/games/test/${rel}`);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setPathResolver(null);
  });

  it('is catalogued as one session op and accepts a game-relative path', async () => {
    const descriptor = gateway.listOps().find((op) => op.id === 'deleteSourceFile');
    expect(descriptor?.domain).toBe('session');

    const requests: Array<{ url: string; method?: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method });
      return new Response('', { status: 204 });
    }) as unknown as typeof fetch;

    const beforeUndo = gateway.canUndo();
    const beforeLedger = gateway.ledger.length;
    const result = gateway.dispatch({
      kind: 'deleteSourceFile',
      path: 'assets/Fox.glb',
      requestId: 'delete-test-1',
    }, 'ai');

    expect(result).toMatchObject({ ok: true, result: { operationRun: { status: 'running', operationId: 'deleteSourceFile' } } });
    const runId = gateway.getOperationRun('delete-test-1')?.runId;
    expect(runId).toBeDefined();
    expect(gateway.sourceFileDeleteStatus('delete-test-1')).toMatchObject({ phase: 'pending', path: 'assets/Fox.glb', runId });
    expect(gateway.ledger.length).toBe(beforeLedger);
    const terminal = await gateway.waitOperationRun('delete-test-1');
    expect(terminal).toMatchObject({ ok: true, value: { status: 'succeeded', operationId: 'deleteSourceFile', runId } });
    expect(requests).toEqual([{ url: '/api/files?path=%2Fgames%2Ftest%2Fassets%2FFox.glb', method: 'DELETE' }]);
    expect(gateway.sourceFileDeleteStatus('delete-test-1')).toMatchObject({ phase: 'deleted', path: 'assets/Fox.glb', runId });
    expect(gateway.canUndo()).toBe(beforeUndo);
    expect(gateway.ledger.length).toBe(beforeLedger + 1);
    expect(gateway.auditLog().at(-1)?.origin).toBe('ai');
  });

  it('publishes a structured terminal failure for HTTP and network errors', async () => {
    globalThis.fetch = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    expect(gateway.dispatch({ kind: 'deleteSourceFile', path: 'assets/bad.glb', requestId: 'delete-test-http' })).toMatchObject({ ok: true, result: { operationRun: { status: 'running' } } });
    await gateway.waitOperationRun('delete-test-http');
    const http = gateway.sourceFileDeleteStatus('delete-test-http');
    expect(http?.phase).toBe('failed');
    if (http?.phase === 'failed') expect(http.error.code).toBe('SOURCE_FILE_DELETE_FAILED');

    globalThis.fetch = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(gateway.dispatch({ kind: 'deleteSourceFile', path: 'assets/offline.glb', requestId: 'delete-test-network' })).toMatchObject({ ok: true, result: { operationRun: { status: 'running' } } });
    await gateway.waitOperationRun('delete-test-network');
    const network = gateway.sourceFileDeleteStatus('delete-test-network');
    expect(network?.phase).toBe('failed');
    if (network?.phase === 'failed') expect(network.error.code).toBe('SOURCE_FILE_DELETE_FAILED');
  });

  it('rejects empty path and request id at the gateway boundary', () => {
    expect(gateway.dispatch({ kind: 'deleteSourceFile', path: '', requestId: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGS' },
    });
    expect(gateway.dispatch({ kind: 'deleteSourceFile', path: 'assets/x.glb', requestId: '' })).toMatchObject({
      ok: false,
      error: { code: 'invalid-request-id' },
    });
  });

  it('rejects a reused request id so an older async completion cannot overwrite a retry', async () => {
    let resolveDelete!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>((resolve) => { resolveDelete = resolve; })) as unknown as typeof fetch;

    const first = gateway.dispatch({ kind: 'deleteSourceFile', path: 'assets/first.glb', requestId: 'reused-id' });
    expect(first).toMatchObject({ ok: true, result: { operationRun: { status: 'running' } } });
    expect(gateway.dispatch({ kind: 'deleteSourceFile', path: 'assets/retry.glb', requestId: 'reused-id' })).toMatchObject({
      ok: false,
      error: { code: 'operation-request-id-conflict' },
    });

    resolveDelete(new Response('', { status: 204 }));
    await gateway.waitOperationRun('reused-id');
    expect(gateway.sourceFileDeleteStatus('reused-id')).toMatchObject({ phase: 'deleted', path: 'assets/first.glb' });
  });

  it('bounds terminal request history to the most recent 64 requests', async () => {
    globalThis.fetch = (async () => new Response('', { status: 204 })) as unknown as typeof fetch;
    for (let i = 0; i < 65; i++) {
      expect(gateway.dispatch({ kind: 'deleteSourceFile', path: `assets/${i}.glb`, requestId: `ring-${i}` })).toMatchObject({ ok: true, result: { operationRun: { status: 'running' } } });
    }
    await Promise.all(Array.from({ length: 65 }, (_, i) => gateway.waitOperationRun(`ring-${i}`)));
    expect(gateway.sourceFileDeleteStatus('ring-0')).toBeNull();
    expect(gateway.sourceFileDeleteStatus('ring-1')).toMatchObject({ phase: 'deleted', path: 'assets/1.glb' });
    expect(gateway.sourceFileDeleteStatus('ring-64')).toMatchObject({ phase: 'deleted', path: 'assets/64.glb' });
  });
});
