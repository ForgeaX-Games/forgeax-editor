// External-asset CRUD round-trip on the `.meta.json` sidecar.
//
// Regression gate for the "external-asset CRUD packPath mismatch" bug: an
// imported FBX/GLB/HDR/audio/font asset's CRUD target is its `<source>.meta.json`
// sidecar (shape `subAssets[]` of `{guid, kind, sourceIndex, name?}`), NOT a
// `.pack.json` (shape `assets[]` of PackAssetEntry). Before the fix, the assetIO
// facade parsed EVERY packPath as a PackFile, so `readPackEntry` on a `.meta.json`
// returned null and `deletePackEntry` threw "entry not found" for all external
// assets — Delete/Rename/Duplicate/Undo silently failed for the majority of a
// user's assets. These tests pin the facade dispatching on the path suffix and the
// destroy→restore + rename round-trips working against the sidecar shape.
//
// The pack IO runs over the network (/api/files); an in-memory disk stub makes the
// async round-trips deterministic without a server.

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import {
  AssetIOFacade,
  AssetResourceConflictError,
  SOURCE_SIDECAR_REVISION_DOMAIN,
} from '../io/asset-io-facade';

const META_PATH = '/games/demo/assets/arrow_bow.fbx.meta.json';

// One external-asset sidecar with two sub-assets (mesh + material), mirroring a
// cooked FBX/GLB meta.json.
function initialMeta() {
  return {
    kind: 'external-asset-package',
    importer: 'gltf',
    schemaVersion: 1,
    source: 'arrow_bow.fbx',
    subAssets: [
      { guid: 'mesh-1', kind: 'mesh', sourceIndex: 0, name: 'Bow' },
      { guid: 'mat-1', kind: 'material', sourceIndex: 0, name: 'BowMat' },
    ],
  };
}

const originalFetch = globalThis.fetch;

// In-memory disk keyed by path. GET /api/files returns { content }, POST writes,
// DELETE removes. Mirrors the server's /api/files contract closely enough for the
// pack-ops JSON helpers (readJsonFile / writeJsonFile / deleteFile).
function installDiskStub(disk: Map<string, string>) {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = ((url: string, opts?: { method?: string; body?: string }) => {
    const u = String(url);
    const method = opts?.method ?? 'GET';
    const path = decodeURIComponent(u.replace(/^\/api\/files(\/raw)?\?path=/, '').replace(/^\/api\/files$/, ''));
    if (method === 'DELETE') {
      disk.delete(path);
      return Promise.resolve(new Response('', { status: 200 }));
    }
    if (method === 'POST') {
      const body = JSON.parse(opts?.body ?? '{}') as { path: string; content?: string };
      disk.set(body.path, body.content ?? '');
      return Promise.resolve(new Response('', { status: 200 }));
    }
    // GET
    const content = disk.get(path);
    if (content === undefined) return Promise.resolve(new Response('', { status: 404 }));
    return Promise.resolve(new Response(JSON.stringify({ content }), { status: 200 }));
  }) as unknown as typeof fetch;
}

describe('assetIO facade — external-asset .meta.json sidecar CRUD', () => {
  let disk: Map<string, string>;
  let io: AssetIOFacade;

  beforeEach(() => {
    disk = new Map([[META_PATH, JSON.stringify(initialMeta(), null, 2) + '\n']]);
    installDiskStub(disk);
    io = new AssetIOFacade();
  });

  afterEach(() => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  });

  it('readPackEntry resolves a sub-asset from a .meta.json sidecar', async () => {
    const entry = await io.readPackEntry(META_PATH, 'mesh-1');
    expect(entry).not.toBeNull();
    expect(entry).toMatchObject({ guid: 'mesh-1', kind: 'mesh', sourceIndex: 0, name: 'Bow' });
  });

  it('deletePackEntry removes ONE sub-asset (sidecar survives) and returns its snapshot', async () => {
    const snapshot = await io.deletePackEntry(META_PATH, 'mesh-1');
    expect(snapshot).toMatchObject({ guid: 'mesh-1', kind: 'mesh' });
    // sidecar still on disk (material sub-asset remains); mesh entry gone.
    const meta = JSON.parse(disk.get(META_PATH)!) as { subAssets: { guid: string }[] };
    expect(meta.subAssets.map((s) => s.guid)).toEqual(['mat-1']);
  });

  it('destroy → restore round-trips the sub-asset (undo of delete)', async () => {
    const snapshot = await io.deletePackEntry(META_PATH, 'mesh-1');
    // undo re-writes the snapshot back into the sidecar.
    const ok = await io.writePackEntry(META_PATH, snapshot);
    expect(ok).toBe(true);
    const restored = await io.readPackEntry(META_PATH, 'mesh-1');
    expect(restored).toMatchObject({ guid: 'mesh-1', kind: 'mesh', name: 'Bow' });
  });

  it('renamePackEntry changes the sub-asset name and returns the old one (for undo)', async () => {
    const r = await io.renamePackEntry(META_PATH, 'mat-1', 'BowMat (renamed)');
    expect(r).toEqual({ ok: true, oldName: 'BowMat' });
    const entry = await io.readPackEntry(META_PATH, 'mat-1');
    expect(entry).toMatchObject({ guid: 'mat-1', name: 'BowMat (renamed)' });
  });

  it('deleting the LAST sub-asset removes the sidecar AND the source file', async () => {
    // Seed the source file beside the sidecar so the cascade can delete it.
    disk.set('/games/demo/assets/arrow_bow.fbx', 'fake-fbx-bytes');
    await io.deletePackEntry(META_PATH, 'mesh-1');
    await io.deletePackEntry(META_PATH, 'mat-1');
    expect(disk.has(META_PATH)).toBe(false);
    expect(disk.has('/games/demo/assets/arrow_bow.fbx')).toBe(false);
  });

  it('deletePackEntry throws for a guid absent from the sidecar (fail-fast, not silent)', async () => {
    await expect(io.deletePackEntry(META_PATH, 'nope')).rejects.toThrow(/not found/);
  });
});

describe('assetIO facade — source sidecar file CAS', () => {
  afterEach(() => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  });

  it('reads exact contents and revision from one revision-aware HTTP response', async () => {
    const calls: string[] = [];
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
      calls.push(String(url));
      return new Response('exact-sidecar\n', {
        status: 200,
        headers: { ETag: '"sha256:exact"' },
      });
    }) as typeof fetch;

    const result = await new AssetIOFacade().readMetaSidecar(META_PATH);

    expect(result).toEqual({
      ok: true,
      value: { contents: 'exact-sidecar\n', revision: '"sha256:exact"' },
    });
    expect(calls).toEqual([`/api/files/raw?path=${encodeURIComponent(META_PATH)}&revision=1`]);
  });

  it('reads an existing meta sidecar through the optional text-file route', async () => {
    const calls: string[] = [];
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ content: JSON.stringify(initialMeta()) }), { status: 200 });
    }) as typeof fetch;

    await expect(new AssetIOFacade().readExistingMeta(META_PATH)).resolves.toEqual(initialMeta());
    expect(calls).toEqual([`/api/files?path=${encodeURIComponent(META_PATH)}&optional=1`]);
  });

  it('built-in prepare performs no write and commit posts the file CAS', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ revision: '"sha256:new"' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const io = new AssetIOFacade();
    const prepared = await io.prepareRevisionAwareResourceTransaction({
      resource: { kind: 'source-sidecar', path: META_PATH },
      expectedRevision: '"sha256:old"',
      content: 'next',
      changes: [{ kind: 'put', path: META_PATH, content: 'next' }],
    });

    expect(prepared).not.toBeNull();
    expect(calls).toHaveLength(0);
    expect(await prepared!.commit()).toMatchObject({ revision: '"sha256:new"' });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      path: META_PATH,
      content: 'next',
      expectedRevision: '"sha256:old"',
    });
  });

  it('maps HTTP 409 to a structured resource conflict', async () => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () =>
      new Response(JSON.stringify({ currentRevision: '"sha256:current"' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const prepared = await new AssetIOFacade().prepareRevisionAwareResourceTransaction({
      resource: { kind: 'source-sidecar', path: META_PATH },
      expectedRevision: '"sha256:old"',
      content: 'next',
    });

    try {
      await prepared!.commit();
      throw new Error('expected conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(AssetResourceConflictError);
      expect(error).toMatchObject({
        code: 'asset-resource-conflict',
        expectedRevision: '"sha256:old"',
        currentRevision: '"sha256:current"',
      });
    }
  });

  it('uses an injected snapshot and transaction only when their revision domain matches', async () => {
    const commits: unknown[] = [];
    const io = new AssetIOFacade();
    io.setResourceTransactionPort({
      supportsExpectedRevision: true,
      revisionDomain: SOURCE_SIDECAR_REVISION_DOMAIN,
      readResource: async () => ({ contents: 'port bytes', revision: 'port:r1' }),
      prepare: async (input) => ({
        commit: async () => {
          commits.push(input);
          return { revision: 'port:r2' };
        },
      }),
    });

    expect(await io.readMetaSidecar(META_PATH)).toEqual({
      ok: true,
      value: { contents: 'port bytes', revision: 'port:r1' },
    });
    const prepared = await io.prepareRevisionAwareResourceTransaction({ expectedRevision: 'port:r1' });
    expect(await prepared!.commit()).toEqual({ revision: 'port:r2' });
    expect(commits).toEqual([{ expectedRevision: 'port:r1' }]);
  });
});
