// EditSurface.test.ts — TDD red-stage tests for EditorImportError + probe logic.
//
// These tests are written BEFORE the full implementation (w13). In the red
// stage, the stubs in EditSurface.tsx will throw — tests WILL fail. They
// will turn green when w13 implements the real logic.
//
// Anchors:
//   plan-tasks.json w11: TDD red-green-refactor
//   plan-strategy §2 D-2: mount probe + structured EditorImportError
//   requirements §8 E-1: standalone asset import explicit failure
//   charter P3: structured error with code/hint/expected

import { describe, expect, it, mock, afterEach } from 'bun:test';
import {
  EditorImportError,
  type EditorImportErrorCode,
  probeServer,
} from './EditSurface';

// ── Helpers ────────────────────────────────────────────────────────────────────

function mockFetch(
  impl: (url: string, init?: RequestInit) => Promise<Partial<Response>>,
): void {
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    return impl(url, init) as Response;
  }) as unknown as typeof globalThis.fetch;
}

function restoreFetch(): void {
  // Restore the original fetch by deleting the mock override — bun will
  // restore the real globalThis.fetch after mock.restore().
  mock.restore();
}

// ── EditorImportError (type contract) ──────────────────────────────────────────

describe('EditorImportError (type contract)', () => {
  it('should define EditorImportErrorCode as union of known codes', () => {
    const code1: EditorImportErrorCode = 'SERVER_UNAVAILABLE';
    expect(code1).toBe('SERVER_UNAVAILABLE');
  });
});

// ── EditorImportError (runtime properties) ─────────────────────────────────────

describe('EditorImportError (runtime properties)', () => {
  it('should be an Error subclass with code, hint, expected', () => {
    const err = new EditorImportError('SERVER_UNAVAILABLE');

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(EditorImportError);
    expect(err.name).toBe('EditorImportError');
    expect(err.code).toBe('SERVER_UNAVAILABLE');
    expect(typeof err.hint).toBe('string');
    expect(err.hint.length).toBeGreaterThan(0);
    expect(typeof err.expected).toBe('string');
    expect(err.expected.length).toBeGreaterThan(0);
  });

  it('should produce distinct hints per error code', () => {
    const unavailable = new EditorImportError('SERVER_UNAVAILABLE');
    const unknown = new EditorImportError('UNKNOWN');

    expect(unavailable.code).not.toBe(unknown.code);
    expect(unavailable.hint).not.toBe(unknown.hint);
  });
});

// ── probeServer (success path) ─────────────────────────────────────────────────

describe('probeServer (success path)', () => {
  afterEach(() => {
    restoreFetch();
  });

  it('should return { available: true, slug } when server is reachable', async () => {
    const fakeSlug = 'my-game';
    mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ activeSlug: fakeSlug }),
    }));

    const result = await probeServer();
    expect(result.available).toBe(true);
    expect(result.slug).toBe(fakeSlug);
  });

  it('should prepend serverBase to the probe URL', async () => {
    let fetchedUrl = '';
    mockFetch(async (url: string) => {
      fetchedUrl = url;
      return { ok: true, status: 200, json: async () => ({ activeSlug: 't' }) };
    });

    await probeServer('https://example.com');
    expect(fetchedUrl).toBe('https://example.com/api/workbench/active-slug');
  });
});

// ── probeServer (failure paths) ────────────────────────────────────────────────

describe('probeServer (failure paths)', () => {
  afterEach(() => {
    restoreFetch();
  });

  it('should return { available: false, error } on HTTP 404', async () => {
    mockFetch(async () => ({ ok: false, status: 404 }));

    const result = await probeServer();
    expect(result.available).toBe(false);
    expect(result.error).toBeInstanceOf(EditorImportError);
    expect(result.error!.code).toBe('SERVER_UNAVAILABLE');
    expect(typeof result.error!.hint).toBe('string');
    expect(typeof result.error!.expected).toBe('string');
  });

  it('should return { available: false, error } on network failure', async () => {
    mockFetch(async () => { throw new Error('NetworkError'); });

    const result = await probeServer();
    expect(result.available).toBe(false);
    expect(result.error).toBeInstanceOf(EditorImportError);
    expect(result.error!.code).toBe('SERVER_UNAVAILABLE');
  });

  it('should return { available: false, error } on non-2xx status', async () => {
    mockFetch(async () => ({ ok: false, status: 500 }));

    const result = await probeServer();
    expect(result.available).toBe(false);
    expect(result.error).toBeInstanceOf(EditorImportError);
  });
});

// ── probeServer (edge cases) ───────────────────────────────────────────────────

describe('probeServer (edge cases)', () => {
  afterEach(() => {
    restoreFetch();
  });

  it('should handle response with null activeSlug', async () => {
    mockFetch(async () => ({
      ok: true, status: 200, json: async () => ({ activeSlug: null }),
    }));

    const result = await probeServer();
    expect(result.available).toBe(true);
    expect(result.slug).toBeNull();
  });

  it('should treat JSON parse failure on 200 as unavailable', async () => {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error('JSON parse error'); },
    }));

    const result = await probeServer();
    expect(result.available).toBe(false);
    expect(result.error).toBeInstanceOf(EditorImportError);
  });
});