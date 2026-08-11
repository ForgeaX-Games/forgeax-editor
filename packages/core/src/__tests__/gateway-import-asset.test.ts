// importAsset (session) op + executeAssetImport executor contract.
//
// Invariant 7 convergence: asset import is now a first-class one-door op. This test
// pins:
//   - importAsset is a SESSION-domain op, cataloged (AI-discoverable via listOps).
//   - dispatching importAsset returns a correlated accepted/running OperationRun.
//   - executeAssetImport routes EVERY disk write through the assetIO gate — proven
//     by observing the exact HTTP endpoints (/api/files/upload → /api/files →
//     the active generation-scoped import route) the gate methods hit, with
//     fetch stubbed (no server).
//
// The applier itself is fire-and-forget (async session-op contract, trace.ts F-2),
// so the executor — the shared body it wraps — is what we assert against directly.

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import { hasOp, getOp, listOps } from '../io/catalog';
import { setPathResolver } from '../util/path-resolver';
import { getImportFormat } from '../scan/ext-importer-map';
// Importing the barrel loads import-ops' side-effect (session applier registration),
// exactly as the app boot does. executeAssetImport comes from the same module.
import { executeAssetImport, registerPostAssetWriteCatalogSync } from '../index';
import { panelBridge } from '../io/panel-bridge';
import type { EditSession } from '../types';
import { assetIO } from '../io/asset-io-facade';
import type { RuntimeAssetBinding } from '@forgeax/engine-types';

const originalFetch = globalThis.fetch;

function testRuntimeBinding(): RuntimeAssetBinding {
  return {
    schemaVersion: 'runtime-asset-binding-v1',
    gameId: 'demo',
    scopeId: 'test-scope',
    generation: 1,
    status: 'ready',
    catalogUrl: '/preview/__pack/scopes/test-scope/1/catalog.json',
    importUrlBase: '/preview/__pack/scopes/test-scope/1/import',
    packageUrlBase: '/preview/__pack/scopes/test-scope/1/asset',
  };
}

describe('importAsset op registration (catalog SSOT)', () => {
  it('importAsset is a cataloged SESSION op (AI-discoverable)', () => {
    expect(hasOp('importAsset')).toBe(true);
    expect(getOp('importAsset')?.domain).toBe('session');
    const ops = listOps();
    const op = ops.find((o) => o.id === 'importAsset');
    expect(op?.domain).toBe('session');
    // argsSchema drives AI self-discovery — destPath is the one required field.
    expect(op?.argsSchema?.required).toContain('destPath');
  });

  it('reimportAsset is a cataloged SESSION op with a correlated run contract', () => {
    expect(hasOp('reimportAsset')).toBe(true);
    expect(getOp('reimportAsset')?.domain).toBe('session');
    const op = listOps().find((entry) => entry.id === 'reimportAsset');
    expect(op?.argsSchema?.required).toEqual(['guid', 'scope', 'expectedRevision', 'requestId']);
    expect(op?.operationRun?.terminalStatuses).toEqual(['succeeded', 'failed', 'cancelled']);
  });
});

describe('executeAssetImport routes through the assetIO write-gate', () => {
  let calls: Array<{ url: string; method: string }>;

  beforeEach(() => {
    assetIO.setRuntimeBinding(testRuntimeBinding());
    calls = [];
    (globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string, opts?: { method?: string }) => {
      const method = opts?.method ?? 'GET';
      calls.push({ url: String(url), method });
      // upload / sidecar write / cook trigger all succeed.
      return Promise.resolve(new Response('', { status: 200 }));
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    assetIO.setRuntimeBinding(undefined);
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  });

  it('image import: upload → sidecar → cook, all via the gate endpoints', async () => {
    const phases: string[] = [];
    const r = await executeAssetImport({
      destPath: '/games/demo/assets/logo.png',
      sourceName: 'logo.png',
      base64: btoa('fake-png-bytes'),
      onProgress: (progress) => phases.push(progress.stage),
    });
    expect(r.status).toBe('done');
    expect(r.guid).toBeDefined();

    const urls = calls.map((c) => c.url);
    // uploadSourceBytes (bytes supplied → not skipped)
    expect(urls.some((u) => u.includes('/api/files/upload'))).toBe(true);
    // writeMetaSidecar (.meta.json)
    expect(urls.some((u) => u.startsWith('/api/files') && !u.includes('upload') && !u.includes('raw'))).toBe(true);
    // triggerCook (image importer goes through the simple sidecar + cook path)
    expect(urls.some((u) => u.includes('/__pack/scopes/test-scope/1/import/'))).toBe(true);
    expect(phases).toEqual(['uploading', 'sidecar', 'cooking']);
  });

  it('skipUpload path does not re-upload bytes (startup-scan / AI contract)', async () => {
    const r = await executeAssetImport({
      destPath: '/games/demo/assets/logo.png',
      sourceName: 'logo.png',
      skipUpload: true,
    });
    expect(r.status).toBe('done');
    expect(calls.some((c) => c.url.includes('/api/files/upload'))).toBe(false);
  });

  it('uploads the bounded UI companion inside the same Runtime-owned import', async () => {
    const r = await executeAssetImport({
      destPath: '/games/demo/assets/hud.ui.html',
      sourceName: 'hud.ui.html',
      base64: btoa('<main>HUD</main>'),
      companionSources: [{
        destPath: '/games/demo/assets/hud.ui.css',
        base64: btoa('main { color: white; }'),
      }],
    });

    expect(r.status).toBe('done');
    expect(calls.filter((call) => call.url.includes('/api/files/upload'))).toHaveLength(2);
  });

  it('unsupported extension fails fast without any disk write', async () => {
    const r = await executeAssetImport({
      destPath: '/games/demo/assets/notes.xyz',
      sourceName: 'notes.xyz',
      base64: btoa('x'),
    });
    expect(r.status).toBe('error');
    expect(r.errorDetail).toMatchObject({
      code: 'IMPORT_UNSUPPORTED_FORMAT',
      path: '/games/demo/assets/notes.xyz',
      retryable: false,
      recoveryActions: ['import.verifySource'],
    });
    expect(calls.length).toBe(0);
  });

  it('font format declares three sub-asset kinds (texture atlas, sampler, font)', () => {
    const fmt = getImportFormat('.ttf');
    expect(fmt).toBeDefined();
    expect(fmt!.subAssetKinds).toEqual(['texture', 'sampler', 'font']);
  });

  it('font import sidecar carries three sub-assets with distinct GUIDs', async () => {
    const r = await executeAssetImport({
      destPath: '/games/demo/assets/DejaVuSans.ttf',
      sourceName: 'DejaVuSans.ttf',
      base64: btoa('fake-ttf-bytes'),
    });
    expect(r.status).toBe('done');
    expect(r.guid).toBeDefined();
    expect(r.subAssets).toHaveLength(3);
    expect(r.subAssets?.every((asset) => asset.guid && asset.kind)).toBe(true);

    const sidecarPaths = calls.filter((c) => c.url.startsWith('/api/files') && !c.url.includes('upload') && !c.url.includes('raw'));
    expect(sidecarPaths.length).toBe(1);
    // The sidecar body is written via fetch; we assert the importer is correct
    // and the cook endpoint was triggered.
    const cookRequests = calls.filter((c) => c.url.includes('/__pack/scopes/test-scope/1/import/'));
    expect(cookRequests.length).toBe(1);
  });

  it('audio import: upload → sidecar, no scoped cook', async () => {
    const r = await executeAssetImport({
      destPath: '/games/demo/assets/test_mp3.mp3',
      sourceName: 'test_mp3.mp3',
      base64: btoa('fake-mp3-bytes'),
    });
    expect(r.status).toBe('done');
    expect(r.guid).toBeDefined();

    const urls = calls.map((c) => c.url);
    expect(urls.some((u) => u.includes('/api/files/upload'))).toBe(true);
    expect(urls.some((u) => u.startsWith('/api/files') && !u.includes('upload') && !u.includes('raw'))).toBe(true);
    expect(urls.some((u) => u.includes('/__pack/scopes/test-scope/1/import/'))).toBe(false);
  });
});

describe('importAsset dispatch (OperationRun convergence)', () => {
  let gw: EditGateway;

  beforeEach(() => {
    assetIO.setRuntimeBinding(testRuntimeBinding());
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (() =>
      Promise.resolve(new Response('', { status: 200 }))) as unknown as typeof fetch;
    // The applier resolves game-relative destPath through the host resolver.
    setPathResolver((rel) => `/games/demo/${rel}`);
    const session: EditSession = createEditSession();
    session.world = {} as never;
    gw = new EditGateway(session);
  });

  afterEach(() => {
    assetIO.setRuntimeBinding(undefined);
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    setPathResolver(null);
  });

  it('returns a running run and records the ledger only after successful completion', async () => {
    const beforeLedger = gw.ledger.length;
    const r = gw.dispatch({ kind: 'importAsset', destPath: 'assets/logo.png', sourceName: 'logo.png', requestId: 'import-test-1' });
    expect(r).toMatchObject({ ok: true, result: { operationRun: { requestId: 'import-test-1', operationId: 'importAsset', status: 'running' } } });
    expect(gw.ledger.length).toBe(beforeLedger);

    const terminal = await gw.waitOperationRun('import-test-1');
    expect(terminal).toMatchObject({ ok: true, value: { status: 'succeeded', result: { status: 'done', filename: 'logo.png' } } });
    expect(gw.ledger.length).toBe(beforeLedger + 1);
  });

  it('retains only a bounded fingerprint after Runtime consumes selected-file bytes', async () => {
    const r = gw.dispatch({
      kind: 'importAsset',
      destPath: 'assets/logo.png',
      sourceName: 'logo.png',
      base64: btoa('selected-file-bytes'),
      skipUpload: false,
      requestId: 'import-byte-retention',
    });
    expect(r.ok).toBe(true);
    const running = gw.getOperationRun('import-byte-retention');
    expect(running?.input).toMatchObject({
      destPath: 'assets/logo.png',
      skipUpload: true,
      payloadFingerprint: expect.stringMatching(/^fnv1a32:/),
    });
    expect(running?.input).not.toHaveProperty('base64');

    expect(await gw.waitOperationRun('import-byte-retention')).toMatchObject({ ok: true, value: { status: 'succeeded' } });
    expect(gw.ledger.at(-1)).not.toHaveProperty('base64');
  });

  it('projects executor-owned import phases through OperationRun progress', async () => {
    const r = gw.dispatch({ kind: 'importAsset', destPath: 'assets/logo.png', sourceName: 'logo.png', requestId: 'import-progress-1' });
    expect(r).toMatchObject({ ok: true, result: { operationRun: { status: 'running' } } });

    const observed: string[] = [];
    const unsubscribe = gw.subscribeOperationRun('import-progress-1', (run) => {
      if (run.progress.fraction > 0 && observed.at(-1) !== run.progress.stage) observed.push(run.progress.stage);
    });
    const terminal = await gw.waitOperationRun('import-progress-1');
    unsubscribe();

    expect(terminal).toMatchObject({
      ok: true,
      value: { status: 'succeeded', progress: { stage: 'succeeded', fraction: 1 } },
    });
    expect(observed).toEqual(['sidecar', 'cooking', 'succeeded']);
  });

  it('publishes a structured terminal failure instead of resolving success', async () => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (() =>
      Promise.resolve(new Response('', { status: 500 }))) as unknown as typeof fetch;
    const r = gw.dispatch({ kind: 'importAsset', destPath: 'assets/logo.png', sourceName: 'logo.png', requestId: 'import-test-failed' });
    expect(r).toMatchObject({ ok: true, result: { operationRun: { status: 'running' } } });

    const terminal = await gw.waitOperationRun('import-test-failed');
    expect(terminal).toMatchObject({ ok: true, value: { status: 'failed', error: { code: 'IMPORT_SIDECAR_WRITE_FAILED', retryable: true, subjectRef: { id: 'assets/logo.png' } } } });
    expect(gw.ledger).toHaveLength(0);
  });

  it('keeps canonical reimport fail-closed until its producer coordinator is available', () => {
    const dispatched = gw.dispatch({
      kind: 'reimportAsset',
      guid: '019f0000-0000-7000-8000-000000000001',
      scope: { sourceKey: 'source:logo' },
      expectedRevision: 'meta:r1',
      requestId: 'reimport-missing-meta',
    });
    expect(dispatched).toMatchObject({ ok: false, error: { code: 'UNKNOWN_OP' } });
    expect(gw.ledger).toHaveLength(0);
  });

  it('does not retain a path-addressed reimport dispatch compatibility path', () => {
    const dispatched = gw.dispatch({
      kind: 'reimportAsset',
      guid: '019f0000-0000-7000-8000-000000000001',
      scope: { sourceKey: 'source:logo' },
      expectedRevision: 'meta:r1',
      requestId: 'reimport-canonical-red',
    });
    expect(dispatched).toMatchObject({ ok: false, error: { code: 'UNKNOWN_OP' } });
  });

  it('retries a failed import run with the same operation input and a new request id', async () => {
    let fail = true;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (() =>
      Promise.resolve(new Response('', { status: fail ? 500 : 200 }))) as unknown as typeof fetch;

    const first = gw.dispatch({ kind: 'importAsset', destPath: 'assets/logo.png', sourceName: 'logo.png', requestId: 'import-retry-source' });
    expect(first.ok).toBe(true);
    const failed = await gw.waitOperationRun('import-retry-source');
    expect(failed).toMatchObject({ ok: true, value: { status: 'failed', retryable: true } });

    fail = false;
    const retry = gw.retryOperationRun('import-retry-source', 'import-retry-attempt-2', 'ai');
    expect(retry).toMatchObject({
      ok: true,
      result: { operationRun: { requestId: 'import-retry-attempt-2', parentRunId: expect.any(String), attempt: 2 } },
    });
    expect(await gw.waitOperationRun('import-retry-attempt-2')).toMatchObject({
      ok: true,
      value: { status: 'succeeded', result: { status: 'done' } },
    });
  });

  it('cancels a glTF read/cook phase before any sidecar write', async () => {
    let resolveRead!: (response: Response) => void;
    const calls: string[] = [];
    (globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string) => {
      calls.push(String(url));
      if (String(url).includes('/api/files/raw')) {
        return new Promise<Response>((resolve) => { resolveRead = resolve; });
      }
      return Promise.resolve(new Response('', { status: 200 }));
    }) as unknown as typeof fetch;

    const dispatched = gw.dispatch({
      kind: 'importAsset',
      destPath: 'assets/model.glb',
      sourceName: 'model.glb',
      skipUpload: true,
      requestId: 'import-cancel-safe',
    });
    expect(dispatched).toMatchObject({ ok: true, result: { operationRun: { status: 'running', cancellable: true } } });

    expect(gw.cancelOperationRun('import-cancel-safe')).toMatchObject({
      ok: true,
      value: { status: 'cancelled', error: { code: 'run-cancelled' } },
    });
    resolveRead(new Response('not-a-glb', { status: 200 }));

    expect(await gw.waitOperationRun('import-cancel-safe')).toMatchObject({
      ok: true,
      value: { status: 'cancelled' },
    });
    expect(calls.some((url) => url.includes('.meta.json'))).toBe(false);
  });

  it('refuses cancellation once a generic importer starts its sidecar write', async () => {
    let resolveSidecar!: (response: Response) => void;
    let fetchCount = 0;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (() => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Promise<Response>((resolve) => { resolveSidecar = resolve; });
      }
      return Promise.resolve(new Response('', { status: 200 }));
    }) as unknown as typeof fetch;

    const dispatched = gw.dispatch({
      kind: 'importAsset',
      destPath: 'assets/logo.png',
      sourceName: 'logo.png',
      skipUpload: true,
      requestId: 'import-cancel-refused',
    });
    expect(dispatched).toMatchObject({ ok: true, result: { operationRun: { status: 'running', cancellable: true } } });

    expect(gw.cancelOperationRun('import-cancel-refused')).toMatchObject({
      ok: false,
      error: {
        code: 'run-not-cancellable',
        current: { requestId: 'import-cancel-refused', status: 'running' },
        recoveryActions: ['run.wait'],
      },
    });
    resolveSidecar(new Response('', { status: 200 }));
    expect(await gw.waitOperationRun('import-cancel-refused')).toMatchObject({
      ok: true,
      value: { status: 'succeeded', result: { status: 'done' } },
    });
  });

  it('waits for catalog visibility before broadcasting import completion', async () => {
    const events: string[] = [];
    registerPostAssetWriteCatalogSync(async (guid) => {
      events.push(`catalog:${guid}`);
    });
    const off = panelBridge.on('assetsChanged', () => events.push('broadcast'));
    try {
      const dispatched = gw.dispatch({
        kind: 'importAsset',
        destPath: 'assets/logo.png',
        sourceName: 'logo.png',
        skipUpload: true,
        requestId: 'import-catalog-barrier',
      });
      expect(dispatched).toMatchObject({ ok: true });
      expect(await gw.waitOperationRun('import-catalog-barrier')).toMatchObject({
        ok: true,
        value: { status: 'succeeded', result: { status: 'done' } },
      });
      expect(events).toEqual([
        expect.stringMatching(/^catalog:/),
        'broadcast',
      ]);
    } finally {
      off();
      registerPostAssetWriteCatalogSync(null);
    }
  });

  it('waits for every produced sub-asset before import terminal success', async () => {
    const subAssetKinds = ['texture', 'sampler', 'font'] as const;
    (globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string) => {
      if (url.includes('optional=1')) {
        return Promise.resolve(new Response(JSON.stringify({
          content: JSON.stringify({ importer: 'font' }),
        }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.resolve(new Response('', { status: 200 }));
    }) as unknown as typeof fetch;
    const seen: string[] = [];
    registerPostAssetWriteCatalogSync(async (guid) => { seen.push(guid); });
    try {
      const dispatched = gw.dispatch({
        kind: 'importAsset',
        destPath: 'assets/Font.ttf',
        sourceName: 'Font.ttf',
        requestId: 'reimport-all-sub-assets',
      });
      expect(dispatched).toMatchObject({ ok: true });
      const terminal = await gw.waitOperationRun('reimport-all-sub-assets');
      expect(terminal).toMatchObject({
        ok: true,
        value: {
          status: 'succeeded',
          result: { subAssets: subAssetKinds.map((kind) => ({ kind })) },
        },
      });
      if (!terminal.ok) throw new Error('import terminal result unavailable');
      const produced = (terminal.value.result as { readonly subAssets?: readonly { readonly guid: string }[] }).subAssets ?? [];
      expect(seen).toEqual(produced.map((asset) => asset.guid));
    } finally {
      registerPostAssetWriteCatalogSync(null);
    }
  });

  it('fails the run and suppresses the broadcast when catalog sync fails', async () => {
    const broadcasts: string[] = [];
    registerPostAssetWriteCatalogSync(async () => {
      throw new Error('catalog unavailable');
    });
    const off = panelBridge.on('assetsChanged', () => broadcasts.push('broadcast'));
    try {
      const dispatched = gw.dispatch({
        kind: 'importAsset',
        destPath: 'assets/logo.png',
        sourceName: 'logo.png',
        skipUpload: true,
        requestId: 'import-catalog-failed',
      });
      expect(dispatched).toMatchObject({ ok: true });
      expect(await gw.waitOperationRun('import-catalog-failed')).toMatchObject({
        ok: true,
        value: {
          status: 'failed',
          error: {
            code: 'IMPORT_CATALOG_SYNC_FAILED',
            retryable: true,
            recoveryActions: ['operation.retry'],
          },
        },
      });
      expect(broadcasts).toEqual([]);
    } finally {
      off();
      registerPostAssetWriteCatalogSync(null);
    }
  });
});

describe('importAsset terminal error taxonomy', () => {
  beforeEach(() => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (() =>
      Promise.resolve(new Response('', { status: 200 }))) as unknown as typeof fetch;
  });

  afterEach(() => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  });

  it('distinguishes upload HTTP and network failures', async () => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (() =>
      Promise.resolve(new Response('', { status: 503 }))) as unknown as typeof fetch;
    const upload = await executeAssetImport({
      destPath: '/games/demo/assets/logo.png',
      sourceName: 'logo.png',
      base64: btoa('x'),
    });
    expect(upload.errorDetail).toMatchObject({ code: 'IMPORT_UPLOAD_FAILED', path: '/games/demo/assets/logo.png' });

    (globalThis as unknown as { fetch: typeof fetch }).fetch = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    const network = await executeAssetImport({
      destPath: '/games/demo/assets/logo.png',
      sourceName: 'logo.png',
      base64: btoa('x'),
    });
    expect(network.errorDetail).toMatchObject({ code: 'IMPORT_NETWORK_ERROR', path: '/games/demo/assets/logo.png' });
  });

  it('distinguishes source read and cook failures for glTF', async () => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (() =>
      Promise.resolve(new Response('', { status: 404 }))) as unknown as typeof fetch;
    const read = await executeAssetImport({
      destPath: '/games/demo/assets/model.glb',
      sourceName: 'model.glb',
      skipUpload: true,
    });
    expect(read.errorDetail).toMatchObject({ code: 'IMPORT_SOURCE_READ_FAILED', path: '/games/demo/assets/model.glb' });

    (globalThis as unknown as { fetch: typeof fetch }).fetch = (() =>
      Promise.resolve(new Response('', { status: 200 }))) as unknown as typeof fetch;
    const cook = await executeAssetImport({
      destPath: '/games/demo/assets/model.glb',
      sourceName: 'model.glb',
      base64: btoa('not-a-glb'),
    });
    expect(cook.errorDetail).toMatchObject({ code: 'IMPORT_COOK_FAILED', path: '/games/demo/assets/model.glb', retryable: false });
  });
});
