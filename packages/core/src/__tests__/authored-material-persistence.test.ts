// authored-material-persistence.test.ts — gray-card regression, end to end.
//
// Root cause this pins: createMaterial's applier used to DROP createAssetInPack's
// { ok }, so a failed/clobbered pack write still broadcast assetsChanged and the
// follow-up bindAssetRef raced the pack-index rebuild. loadByGuid then missed on
// the DDC path and fell back to POST /__import/{materialGuid} — a route that
// serves EXTERNAL import sources only, so internal materials 404'd and the entity
// stayed on the default gray material forever.
//
// This suite drives the REAL chain over an in-memory filesystem fetch stub:
//   EditGateway.dispatch(createMaterial)
//     → applyCreateMaterial → assetIO.createAssetInPack (write gate)
//     → authored-inline-asset tracking + catalog barrier (the SAME
//       createAuthoredAssetCatalogBarrier the ViewportComponent host registers)
//     → awaitAuthoredMaterialReady(guid) resolves ok
// and then asserts:
//   1. materials.pack.json on "disk" contains the material in the Pack v2 envelope;
//   2. the pack-index serves the material row (refreshCatalog sees it);
//   3. registry.loadByGuid(materialGuid) succeeds DIRECTLY from the Pack v2 body;
//   4. POST /__import/{materialGuid} was NEVER requested.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { ShaderRegistry, type ShaderRegistryDevice } from '@forgeax/engine-shader';
import { EditGateway } from '../io/gateway';
import { createEditSession } from '../session/document';
import type { EditSession } from '../types';
// Barrel side-effect: registers the document/session appliers (createMaterial).
import '../index';
import {
  awaitAuthoredMaterialReady,
  registerPostAssetWriteCatalogSync,
} from '../session/pack-ops';
import { createAuthoredAssetCatalogBarrier } from '../assets/authored-asset-barrier';
import { setPathResolver } from '../util/path-resolver';

/** Real ShaderRegistry over a dummy device: material loading consults
 *  findMaterialArtifact for texture-field discovery; unknown shaders degrade
 *  gracefully (the loader's documented late-register fallback). */
function makeShaderRegistry(): ShaderRegistry {
  const device: ShaderRegistryDevice = {
    createShaderModule() {
      return {
        ok: true,
        value: undefined,
        unwrap: () => undefined,
        unwrapOr: (fallback: unknown) => fallback,
      } as unknown as ReturnType<ShaderRegistryDevice['createShaderModule']>;
    },
  };
  return new ShaderRegistry({ device, manifestUrl: undefined });
}

const PACK_PATH = 'sample/assets/materials.pack.json';
const PACK_BODY_URL = '/packs/materials.pack.json';
const PACK_INDEX_URL = '/pack-index.json';
const TEXTURE_GUID = 'd1f2a3b4-c5d6-5e70-8901-234567890abc';

interface FetchStub {
  fs: Map<string, string>;
  importCalls: string[];
  install(): void;
  restore(): void;
}

function makeFetchStub(): FetchStub {
  const fs = new Map<string, string>();
  const importCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  return {
    fs,
    importCalls,
    install() {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST' && url === '/api/files') {
          const body = JSON.parse(String(init.body)) as { path: string; content: string };
          fs.set(body.path, body.content);
          return new Response('{}', { status: 200 });
        }
        if (url.startsWith('/api/files?')) {
          const path = new URL(url, 'http://test.local').searchParams.get('path') ?? '';
          const content = fs.get(path);
          if (content === undefined) return new Response(null, { status: 404 });
          return new Response(JSON.stringify({ content }), { status: 200 });
        }
        if (url === PACK_INDEX_URL) {
          const rows: unknown[] = [];
          for (const [path, content] of fs) {
            if (!path.endsWith('.pack.json')) continue;
            const pack = JSON.parse(content) as { assets: { guid: string; kind: string; name?: string }[] };
            for (const asset of pack.assets) {
              rows.push({
                guid: asset.guid,
                kind: asset.kind,
                packageUrl: PACK_BODY_URL,
                ...(asset.name !== undefined ? { name: asset.name } : {}),
              });
            }
          }
          return new Response(JSON.stringify(rows), { status: 200 });
        }
        if (url === PACK_BODY_URL) {
          const content = fs.get(PACK_PATH);
          if (content === undefined) return new Response(null, { status: 404 });
          return new Response(content, { status: 200 });
        }
        if (url.startsWith('/__import/')) {
          importCalls.push(url);
          return new Response(JSON.stringify({ error: 'not an external import source' }), { status: 404 });
        }
        return new Response(null, { status: 404 });
      }) as typeof fetch;
    },
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

describe('authored material persistence (write → catalog → load, no /__import)', () => {
  let net: FetchStub;
  beforeEach(() => setPathResolver((relativePath) => relativePath));
  afterEach(() => {
    net.restore();
    registerPostAssetWriteCatalogSync(null);
    setPathResolver(null);
  });

  it('createMaterial lands in materials.pack.json (Pack v2) and loadByGuid resolves it without /__import', async () => {
    net = makeFetchStub();
    net.install();
    const world = new World();
    const registry = new AssetRegistry(makeShaderRegistry());
    registry.configurePackIndex(PACK_INDEX_URL);
    // The material's baseColorTexture must be a KNOWN catalogued GUID (the
    // applier's phantom-ref Fail Fast probe). Catalog the texture POD inline.
    const texGuid = AssetGuid.parse(TEXTURE_GUID);
    if (!texGuid.ok) throw new Error('bad texture test GUID');
    const catalogued = registry.catalog(texGuid.value, {
      kind: 'texture',
      width: 2,
      height: 2,
      format: 'rgba8unorm',
      data: new Uint8Array(2 * 2 * 4),
    } as never);
    if (!catalogued.ok) throw new Error(`texture catalog failed: ${String(catalogued.error)}`);

    const session: EditSession = createEditSession();
    session.world = world as unknown as EditSession['world'];
    session.registry = registry;
    const gateway = new EditGateway(session);

    // Register the SAME barrier the ViewportComponent host installs.
    registerPostAssetWriteCatalogSync(
      createAuthoredAssetCatalogBarrier(registry, { deadlineMs: 4000, rowPollMs: 5, bodyPollMs: 5 }),
    );

    const materialGuid = crypto.randomUUID();
    const r = gateway.dispatch({
      kind: 'createMaterial',
      guid: materialGuid,
      name: 'M_Wood',
      baseColor: [1, 1, 1, 1],
      baseColorTexture: TEXTURE_GUID,
      packPath: PACK_PATH,
    } as never);
    expect(r.ok).toBe(true);

    const ready = await awaitAuthoredMaterialReady(materialGuid);
    expect(ready).toEqual({ ok: true });

    // (1) The pack on "disk" carries the material in the runtime Pack v2 envelope.
    const stored = net.fs.get(PACK_PATH);
    expect(stored).toBeDefined();
    const pack = JSON.parse(stored as string) as {
      schemaVersion: string;
      assets: {
        guid: string;
        kind: string;
        name?: string;
        artifacts?: unknown;
        refs?: string[];
        payload?: { values?: Record<string, unknown> };
      }[];
    };
    expect(pack.schemaVersion).toBe('2.0.0');
    const entry = pack.assets.find((a) => a.guid === materialGuid);
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe('material');
    expect(entry?.name).toBe('M_Wood');
    expect(entry?.artifacts).toBeDefined();
    expect(entry?.refs).toContain(TEXTURE_GUID);
    expect(entry?.payload?.values?.baseColorTexture).toBe(0);
    expect(entry?.payload?.values?.metallic).toBe(0);

    // (2) The pack-index row is visible after the barrier's refresh.
    const row = registry.packIndexCache?.get(materialGuid.toLowerCase());
    expect(row?.packageUrl).toBe(PACK_BODY_URL);

    // (3) loadByGuid resolves the material DIRECTLY from the Pack v2 body
    // (phase 3 of the barrier already proved this; prove it is stable).
    const parsed = AssetGuid.parse(materialGuid);
    if (!parsed.ok) throw new Error('bad material GUID');
    const loaded = await registry.loadByGuid(parsed.value);
    expect(loaded.ok).toBe(true);

    // (4) The erroneous fallback never fired: internal materials are served
    // from their pack, never from the external-import route.
    expect(net.importCalls).toEqual([]);
  });

  it('a refused pack write (HTTP 500) yields stage:write readiness and NO pack file', async () => {
    net = makeFetchStub();
    net.install();
    // Poison only the write; reads stay clean.
    const baseFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST' && String(input) === '/api/files') {
        return new Response(null, { status: 500 });
      }
      return baseFetch(input, init);
    }) as typeof fetch;

    const world = new World();
    const registry = new AssetRegistry(makeShaderRegistry());
    const session: EditSession = createEditSession();
    session.world = world as unknown as EditSession['world'];
    session.registry = registry;
    const gateway = new EditGateway(session);
    registerPostAssetWriteCatalogSync(
      createAuthoredAssetCatalogBarrier(registry, { deadlineMs: 200, rowPollMs: 5, bodyPollMs: 5 }),
    );

    const materialGuid = crypto.randomUUID();
    const r = gateway.dispatch({
      kind: 'createMaterial',
      guid: materialGuid,
      name: 'M_Broken',
      baseColor: [1, 1, 1, 1],
      packPath: PACK_PATH,
    } as never);
    expect(r.ok).toBe(true); // synchronous contract (undo ledger) unchanged

    const ready = await awaitAuthoredMaterialReady(materialGuid);
    expect(ready.ok).toBe(false);
    if (!ready.ok) {
      expect(ready.stage).toBe('write');
      expect(ready.hint).toContain('HTTP 500');
    }
    // No phantom pack: the failed write must not leave a materials.pack.json.
    expect(net.fs.has(PACK_PATH)).toBe(false);
    expect(net.importCalls).toEqual([]);
  });
});
