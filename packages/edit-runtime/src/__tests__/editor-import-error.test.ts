// editor-import-error.test.ts — M5 (w15) property-access contract for the
// EditorImportError structured-error cluster.
//
// WHY property access, not string parsing (charter P3 / AC-09):
//   An AI user recovers from an import failure by READING `.code` (branch on a
//   stable enum), `.hint` (surface human guidance), and `.expected` (state the
//   contract that was violated) — never by regex-scraping `.message`. This test
//   pins that the cluster keeps those three fields reachable AS PROPERTIES after
//   the M5 move out of EditSurface.tsx, so the extraction is a pure relocation
//   (OOS-1 zero behavior change) rather than a silent stringification.
//
// This test imports from the POST-MOVE module path (`../editor-import-error`),
// so in the w15 red stage it fails to resolve (module absent) and turns green
// once w16 lands the extracted module. It is the equivalence safety net the
// §5.1 red-green exemption for the w16 structural refactor relies on.
//
// Anchors:
//   plan-tasks.json w15/w16 (M5 EditSurface import-pipeline extraction)
//   requirements AC-09 (structured error consumed via property access)
//   research §Finding "EditSurface structured-error location" (EditorImportError)
//   plan-strategy §2 D-7 (AC-09 movable surface narrowed to EditorImportError)
//   charter P3 (explicit structured failure — code/hint/expected)

import { describe, expect, it, mock, afterEach } from 'bun:test';
import {
  EditorImportError,
  type EditorImportErrorCode,
  probeServer,
  type ProbeResult,
} from '../editor-import-error';

// ── fetch stubbing ──────────────────────────────────────────────────────────
// probeServer calls editor-core `apiFetch`, which is `fetch(path, init)` against
// the same origin. Overriding globalThis.fetch drives probeServer headlessly
// (no network), exercising the SERVER_UNAVAILABLE classification branches.

function mockFetch(
  impl: (url: string, init?: RequestInit) => Promise<Partial<Response>>,
): void {
  globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
    return impl(url, init) as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

function restoreFetch(): void {
  mock.restore();
}

// ── EditorImportError: property-access contract (AC-09 / charter P3) ─────────

describe('EditorImportError structured-property contract (AC-09)', () => {
  it('exposes code / hint / expected as direct properties (not parsed from message)', () => {
    const err = new EditorImportError('SERVER_UNAVAILABLE');

    // Property access — the AI-user recovery path. No string parsing anywhere.
    expect(err.code).toBe('SERVER_UNAVAILABLE');
    expect(typeof err.hint).toBe('string');
    expect(err.hint.length).toBeGreaterThan(0);
    expect(typeof err.expected).toBe('string');
    expect(err.expected.length).toBeGreaterThan(0);
  });

  it('remains an Error subclass so it flows through catch(e: unknown) sites', () => {
    const err = new EditorImportError('SERVER_UNAVAILABLE');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(EditorImportError);
    expect(err.name).toBe('EditorImportError');
  });

  it('gives distinct code + hint per error code (branchable enum)', () => {
    const unavailable = new EditorImportError('SERVER_UNAVAILABLE');
    const unknown = new EditorImportError('UNKNOWN');

    const codeA: EditorImportErrorCode = unavailable.code;
    const codeB: EditorImportErrorCode = unknown.code;
    expect(codeA).not.toBe(codeB);
    expect(unavailable.hint).not.toBe(unknown.hint);
    expect(unavailable.expected).not.toBe(unknown.expected);
  });
});

// ── probeServer: classification path returns structured error, not string ───

describe('probeServer classification (AC-09 property access)', () => {
  afterEach(() => {
    restoreFetch();
  });

  it('returns { available: true, slug } and no error when reachable', async () => {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ activeSlug: 'my-game' }),
    }));

    const result: ProbeResult = await probeServer();
    expect(result.available).toBe(true);
    expect(result.slug).toBe('my-game');
    expect(result.error).toBeUndefined();
  });

  it('classifies a non-ok HTTP response as a SERVER_UNAVAILABLE EditorImportError', async () => {
    mockFetch(async () => ({ ok: false, status: 404 }));

    const result = await probeServer();
    expect(result.available).toBe(false);
    // Consume the failure via property access, never by parsing result.error.message.
    expect(result.error).toBeInstanceOf(EditorImportError);
    expect(result.error!.code).toBe('SERVER_UNAVAILABLE');
    expect(result.error!.hint.length).toBeGreaterThan(0);
    expect(result.error!.expected.length).toBeGreaterThan(0);
  });

  it('classifies a thrown network failure as a SERVER_UNAVAILABLE EditorImportError', async () => {
    mockFetch(async () => {
      throw new Error('NetworkError');
    });

    const result = await probeServer();
    expect(result.available).toBe(false);
    expect(result.error).toBeInstanceOf(EditorImportError);
    expect(result.error!.code).toBe('SERVER_UNAVAILABLE');
  });

  it('probes the same-origin /api/workbench/active-slug endpoint (serverBase retired, D-7)', async () => {
    let fetchedUrl = '';
    mockFetch(async (url: string) => {
      fetchedUrl = url;
      return { ok: true, status: 200, json: async () => ({ activeSlug: 't' }) };
    });

    await probeServer();
    expect(fetchedUrl).toBe('/api/workbench/active-slug');
  });

  it('treats a JSON parse failure on a 200 as unavailable with a structured error', async () => {
    mockFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('JSON parse error');
      },
    }));

    const result = await probeServer();
    expect(result.available).toBe(false);
    expect(result.error).toBeInstanceOf(EditorImportError);
  });
});
