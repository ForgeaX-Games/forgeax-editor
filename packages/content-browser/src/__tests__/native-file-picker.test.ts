import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { pickNativeImportFiles } from '../native-file-picker';

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('native import file picker', () => {
  it('posts the project directory and decodes valid selections', async () => {
    let requestedUrl: string | undefined;
    let requestedInit: RequestInit | undefined;
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(JSON.stringify({
        ok: true,
        files: [
          { name: 'hello.txt', data: 'aGVsbG8=', type: 'text/plain' },
          { name: 'no-type.bin', data: 'AQI=' },
          { name: 42, data: 'ignored' },
          null,
        ],
      }), { headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;

    const result = await pickNativeImportFiles('/projects/demo');

    expect(requestedUrl).toBe('/api/fs/pick-files');
    expect(requestedInit?.method).toBe('POST');
    expect(JSON.parse(String(requestedInit?.body))).toEqual({ initialDir: '/projects/demo', multiple: true });
    expect(result.kind).toBe('selected');
    if (result.kind !== 'selected') return;
    expect(result.files).toHaveLength(2);
    expect(result.files[0]?.name).toBe('hello.txt');
    expect(result.files[0]?.type).toMatch(/^text\/plain(?:;|$)/);
    expect(await result.files[0]?.text()).toBe('hello');
    expect(new Uint8Array(await result.files[1]!.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
  });

  it('distinguishes cancellation, malformed responses, HTTP errors, and network errors', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ cancelled: true }))) as unknown as typeof globalThis.fetch;
    expect(await pickNativeImportFiles('/projects/demo')).toEqual({ kind: 'cancelled' });

    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, files: 'not-an-array' }))) as unknown as typeof globalThis.fetch;
    expect(await pickNativeImportFiles('/projects/demo')).toEqual({ kind: 'unavailable' });

    globalThis.fetch = (async () => new Response('server error', { status: 500 })) as unknown as typeof globalThis.fetch;
    expect(await pickNativeImportFiles('/projects/demo')).toEqual({ kind: 'unavailable' });

    globalThis.fetch = (async () => { throw new Error('offline'); }) as unknown as typeof globalThis.fetch;
    expect(await pickNativeImportFiles('/projects/demo')).toEqual({ kind: 'unavailable' });
  });
});
