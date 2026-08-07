// Regression gate for the MI "preview renders nothing / fields blank" bug.
//
// resolveOverrides is synchronous and reads registry.assetCatalog, which ONLY
// loadByGuid populates. A freshly opened Material Instance whose parent was
// never loaded this session therefore resolved to {} — blank inspector fields
// and an unshaded preview mesh. ensureMaterialChainCataloged is the warm-up
// that has to run first; these tests pin that it walks the WHOLE chain.

import { describe, expect, it } from 'bun:test';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  ensureMaterialChainCataloged,
  materialCatalogLookup,
} from '../assets/material-chain-catalog';
import { resolveOverrides } from '../assets/material-instance-resolve';
import { createDefaultMaterialInstancePayload } from '../assets/material-instance-schema';

const ROOT = '11111111-1111-4111-8111-111111111111';
const MID = '22222222-2222-4222-8222-222222222222';
const LEAF = '33333333-3333-4333-8333-333333333333';

interface Envelope {
  guid: string;
  kind: string;
  payload: Record<string, unknown>;
}

/** AssetRegistry stand-in: `assetCatalog` starts EMPTY (the real cold-session
 *  state) and only loadByGuid moves a row from `disk` into it. */
function fakeRegistry(disk: Record<string, Envelope>) {
  const assetCatalog = new Map<string, Envelope>();
  const loaded: string[] = [];
  return {
    loaded,
    assetCatalog,
    lookup(guid: string) {
      return assetCatalog.get(guid.toLowerCase())?.payload;
    },
    async loadByGuid(guid: unknown) {
      // ensureAssetCataloged hands over a parsed AssetGuid, not the raw string.
      const key = AssetGuid.format(guid as never).toLowerCase();
      loaded.push(key);
      const row = disk[key];
      if (row === undefined) return { ok: false, error: { code: 'asset-not-found' } };
      assetCatalog.set(key, row);
      return { ok: true, value: row.payload };
    },
  };
}

describe('ensureMaterialChainCataloged', () => {
  it('warms an MI → MI → material chain so resolveOverrides sees inherited values', async () => {
    const registry = fakeRegistry({
      [ROOT]: { guid: ROOT, kind: 'material', payload: { kind: 'material', values: { baseColor: [1, 0, 0, 1], roughness: 0.9 } } },
      [MID]: {
        guid: MID,
        kind: 'material-instance',
        payload: createDefaultMaterialInstancePayload(ROOT, {
          overrides: { roughness: { enabled: true, value: 0.3 } },
        }) as unknown as Record<string, unknown>,
      },
    });
    const leaf = createDefaultMaterialInstancePayload(MID, {
      overrides: { metallic: { enabled: true, value: 0.8 } },
    });

    // Cold: nothing catalogued, so the resolve sees only the leaf's own override.
    expect(resolveOverrides(leaf, materialCatalogLookup(registry as never))).toEqual({ metallic: 0.8 });

    expect(await ensureMaterialChainCataloged(registry as never, leaf)).toBe(true);
    expect(registry.loaded).toEqual([MID, ROOT]);

    expect(resolveOverrides(leaf, materialCatalogLookup(registry as never))).toEqual({
      baseColor: [1, 0, 0, 1],
      roughness: 0.3,
      metallic: 0.8,
    });
  });

  it('accepts a bare GUID start (parent picker preview)', async () => {
    const registry = fakeRegistry({
      [ROOT]: { guid: ROOT, kind: 'material', payload: { kind: 'material', values: { metallic: 0.25 } } },
    });
    expect(await ensureMaterialChainCataloged(registry as never, ROOT)).toBe(true);
    expect(resolveOverrides(ROOT, materialCatalogLookup(registry as never))).toEqual({ metallic: 0.25 });
  });

  it('reports false for a dangling parent without throwing', async () => {
    const registry = fakeRegistry({});
    const leaf = createDefaultMaterialInstancePayload(LEAF);
    expect(await ensureMaterialChainCataloged(registry as never, leaf)).toBe(false);
  });

  it('terminates on a parent cycle', async () => {
    const registry = fakeRegistry({
      [MID]: { guid: MID, kind: 'material-instance', payload: createDefaultMaterialInstancePayload(LEAF) as unknown as Record<string, unknown> },
      [LEAF]: { guid: LEAF, kind: 'material-instance', payload: createDefaultMaterialInstancePayload(MID) as unknown as Record<string, unknown> },
    });
    expect(await ensureMaterialChainCataloged(registry as never, MID)).toBe(true);
    expect(registry.loaded.length).toBeLessThanOrEqual(4);
  });

  it('is inert without a registry (headless / pre-boot)', async () => {
    expect(await ensureMaterialChainCataloged(undefined, ROOT)).toBe(false);
    expect(materialCatalogLookup(undefined)(ROOT)).toBeUndefined();
  });
});
