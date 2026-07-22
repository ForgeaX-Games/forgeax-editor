import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { gateway } from '../store/gateway';
import { clearSourceFileDeleteStatuses } from '../session/source-file-delete-status';
import { setPathResolver } from '../util/path-resolver';
import '../session/source-file-ops';

describe('deleteSourceFile session op (M1)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearSourceFileDeleteStatuses();
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

    expect(result).toEqual({ ok: true });
    expect(gateway.sourceFileDeleteStatus('delete-test-1')).toEqual({ phase: 'pending', path: 'assets/Fox.glb' });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(requests).toEqual([{ url: '/api/files?path=%2Fgames%2Ftest%2Fassets%2FFox.glb', method: 'DELETE' }]);
    expect(gateway.sourceFileDeleteStatus('delete-test-1')).toEqual({ phase: 'deleted', path: 'assets/Fox.glb' });
    expect(gateway.canUndo()).toBe(beforeUndo);
    expect(gateway.ledger.length).toBe(beforeLedger + 1);
    expect(gateway.auditLog().at(-1)?.origin).toBe('ai');
  });

  it('publishes a structured terminal failure for HTTP and network errors', async () => {
    globalThis.fetch = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    expect(gateway.dispatch({ kind: 'deleteSourceFile', path: 'assets/bad.glb', requestId: 'delete-test-http' })).toEqual({ ok: true });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const http = gateway.sourceFileDeleteStatus('delete-test-http');
    expect(http?.phase).toBe('failed');
    if (http?.phase === 'failed') expect(http.error.code).toBe('SOURCE_FILE_DELETE_FAILED');

    globalThis.fetch = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(gateway.dispatch({ kind: 'deleteSourceFile', path: 'assets/offline.glb', requestId: 'delete-test-network' })).toEqual({ ok: true });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
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
      error: { code: 'INVALID_ARGS' },
    });
  });

  it('rejects a reused request id so an older async completion cannot overwrite a retry', async () => {
    let resolveDelete!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>((resolve) => { resolveDelete = resolve; })) as unknown as typeof fetch;

    const first = gateway.dispatch({ kind: 'deleteSourceFile', path: 'assets/first.glb', requestId: 'reused-id' });
    expect(first).toEqual({ ok: true });
    expect(gateway.dispatch({ kind: 'deleteSourceFile', path: 'assets/retry.glb', requestId: 'reused-id' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_ARGS' },
    });

    resolveDelete(new Response('', { status: 204 }));
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(gateway.sourceFileDeleteStatus('reused-id')).toEqual({ phase: 'deleted', path: 'assets/first.glb' });
  });

  it('bounds terminal request history to the most recent 64 requests', async () => {
    globalThis.fetch = (async () => new Response('', { status: 204 })) as unknown as typeof fetch;
    for (let i = 0; i < 65; i++) {
      expect(gateway.dispatch({ kind: 'deleteSourceFile', path: `assets/${i}.glb`, requestId: `ring-${i}` })).toEqual({ ok: true });
    }
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(gateway.sourceFileDeleteStatus('ring-0')).toBeNull();
    expect(gateway.sourceFileDeleteStatus('ring-1')).toEqual({ phase: 'deleted', path: 'assets/1.glb' });
    expect(gateway.sourceFileDeleteStatus('ring-64')).toEqual({ phase: 'deleted', path: 'assets/64.glb' });
  });
});
