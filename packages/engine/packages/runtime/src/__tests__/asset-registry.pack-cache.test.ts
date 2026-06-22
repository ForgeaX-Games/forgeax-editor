// asset-registry.pack-cache.spec — M3/Fix B in-memory pack-file cache + in-flight
// dedup (TDD red phase for AC-02 / AC-06). The test file compiles and the
// "red" stage is intentional (type=test task) because fetchPackFile currently
// has no cache.
//
// Coverage:
//   AC-02-sequential — pack.json fetched once per URL for sequential loads
//   AC-02-concurrent  — pack.json fetched once per URL for concurrent loads
//   AC-02-reject      — fetch reject clears in-flight, retry re-fetches

import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { MeshAsset as TypesMeshAsset } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssetRegistry } from '../asset-registry';
import { createDefaultLoaderRegistry } from '../wire-default-loaders';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

// ── test GUIDs ──────────────────────────────────────────────────────────────
const MESH_A_GUID = 'f0000000-0000-4000-f000-000000000001';
const MESH_B_GUID = 'f0000000-0000-4000-f000-000000000002';
const SHARED_PACK_URL = '/packs/shared-mesh.pack.json';

function parseGuid(s: string): AssetGuid {
  const r = AssetGuid.parse(s);
  if (!r.ok) throw new Error(`invalid test GUID: ${s}`);
  return r.value;
}

// ── registry setup ──────────────────────────────────────────────────────────

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry(), createDefaultLoaderRegistry());
}

// ── pack fixture: two meshes sharing the same .pack.json ────────────────────

function makePackIndex(): Array<{ guid: string; relativeUrl: string; kind: string }> {
  return [
    { guid: MESH_A_GUID, relativeUrl: SHARED_PACK_URL, kind: 'mesh' },
    { guid: MESH_B_GUID, relativeUrl: SHARED_PACK_URL, kind: 'mesh' },
  ];
}

function makeSharedPack(): unknown {
  return {
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: MESH_A_GUID,
        kind: 'mesh',
        payload: {
          vertices: [
            -0.5, 0, 0.5, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0.5, 0, 0.5, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0.5, 0,
            -0.5, 0, 1, 0, 1, 1, 1, 0, 0, 1,
          ],
          indices: [0, 1, 2],
          attributes: {},
          submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
        },
      },
      {
        guid: MESH_B_GUID,
        kind: 'mesh',
        payload: {
          vertices: [
            0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0,
            0, 0, 1, 1, 1, 0, 0,
          ],
          indices: [1, 0, 2],
          attributes: {},
          submeshes: [{ indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list' }],
        },
      },
    ],
  };
}

// ── AC-02 / AC-06: pack-file dedup ──────────────────────────────────────────

describe('pack-file cache', () => {
  let originalFetch: typeof globalThis.fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalFetch !== undefined) {
      globalThis.fetch = originalFetch;
    } else {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });

  it('AC-02 sequential: two loadByGuid calls sharing one pack URL trigger one fetch', async () => {
    const reg = makeRegistry();
    reg.configurePackIndex('/pack-index.json');

    const packIndex = makePackIndex();
    const sharedPack = makeSharedPack();

    let packFetchCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === SHARED_PACK_URL) {
        packFetchCount++;
        return Promise.resolve({ ok: true, json: () => Promise.resolve(sharedPack) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      const guidA = parseGuid(MESH_A_GUID);
      const guidB = parseGuid(MESH_B_GUID);

      const rA = await reg.loadByGuid<TypesMeshAsset>(guidA);
      const rB = await reg.loadByGuid<TypesMeshAsset>(guidB);

      expect(rA.ok).toBe(true);
      expect(rB.ok).toBe(true);

      // RED assertion: without cache, fetchPackFile is called twice (once per
      // loadByGuid). With cache (after M3 impl), this must be 1.
      expect(packFetchCount).toBe(1);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });

  it('AC-02 concurrent: two concurrent loadByGuid calls share one in-flight fetch', async () => {
    const reg = makeRegistry();
    reg.configurePackIndex('/pack-index.json');

    const packIndex = makePackIndex();
    const sharedPack = makeSharedPack();

    let packFetchCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === SHARED_PACK_URL) {
        packFetchCount++;
        return Promise.resolve({ ok: true, json: () => Promise.resolve(sharedPack) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      const guidA = parseGuid(MESH_A_GUID);
      const guidB = parseGuid(MESH_B_GUID);

      const [rA, rB] = await Promise.all([
        reg.loadByGuid<TypesMeshAsset>(guidA),
        reg.loadByGuid<TypesMeshAsset>(guidB),
      ]);

      expect(rA.ok).toBe(true);
      expect(rB.ok).toBe(true);

      // RED assertion: without in-flight dedup, concurrent loads each trigger
      // a fetch. With dedup (after M3 impl), this must be 1.
      expect(packFetchCount).toBe(1);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });

  it('AC-02 reject: fetch failure clears in-flight entry, retry fetches again', async () => {
    const reg = makeRegistry();
    reg.configurePackIndex('/pack-index.json');

    const packIndex = makePackIndex();
    const sharedPack = makeSharedPack();

    let packFetchCount = 0;
    let shouldReject = true;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/pack-index.json') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(packIndex) });
      }
      if (url === SHARED_PACK_URL) {
        packFetchCount++;
        if (shouldReject) {
          return Promise.reject(new Error('network failure'));
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(sharedPack) });
      }
      return Promise.resolve({ ok: false, status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      const guidA = parseGuid(MESH_A_GUID);

      // First attempt: reject.
      const r1 = await reg.loadByGuid<TypesMeshAsset>(guidA);
      expect(r1.ok).toBe(false);
      expect(packFetchCount).toBe(1);

      // Second attempt: should fetch again (error not cached).
      shouldReject = false;
      const r2 = await reg.loadByGuid<TypesMeshAsset>(guidA);
      expect(r2.ok).toBe(true);
      expect(packFetchCount).toBe(2);
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test teardown
      delete (globalThis as any).fetch;
    }
  });
});
