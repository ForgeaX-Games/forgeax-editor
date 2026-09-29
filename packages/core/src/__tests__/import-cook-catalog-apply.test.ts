import { describe, expect, it, vi } from 'vitest';
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import {
  applyImportCookEntries,
  parseImportCookCatalogEntries,
} from '../session/import-cook-catalog-apply';

describe('import-cook-catalog-apply', () => {
  it('parseImportCookCatalogEntries accepts legacy bare arrays', () => {
    const entries = parseImportCookCatalogEntries([
      { guid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', kind: 'mesh', packageUrl: '/__pack/x' },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.guid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('applyImportCookEntries pins packIndexCache rows', () => {
    const registry = {
      packIndexCache: new Map(),
      packFileCache: new Map([['/__pack/x', {}]]),
    } as unknown as AssetRegistry;
    const applied = applyImportCookEntries(registry, [{
      guid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
      kind: 'scene',
      packageUrl: '/__pack/x',
    }]);
    expect(applied).toBe(1);
    expect(registry.packIndexCache?.get('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toMatchObject({
      packageUrl: '/__pack/x',
      kind: 'scene',
    });
    expect(registry.packFileCache?.has('/__pack/x')).toBe(false);
  });

  it('refreshCatalog runs after applyImportCookResult', async () => {
    const refreshCatalog = vi.fn(async () => true);
    const { applyImportCookResult } = await import('../session/import-cook-catalog-apply');
    const registry = {
      packIndexCache: new Map(),
      refreshCatalog,
    } as unknown as AssetRegistry;
    await applyImportCookResult(registry, [{
      guid: '11111111-2222-3333-4444-555555555555',
      kind: 'material',
      packageUrl: '/__pack/y',
    }]);
    expect(refreshCatalog).toHaveBeenCalledTimes(1);
  });
});
