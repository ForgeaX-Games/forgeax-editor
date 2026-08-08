import { afterEach, describe, expect, it } from 'bun:test';
import type { RuntimeAssetBinding } from '@forgeax/engine-types';

import { AssetIOFacade } from '../io/asset-io-facade';

const originalFetch = globalThis.fetch;

function binding(): RuntimeAssetBinding {
  return {
    schemaVersion: 'runtime-asset-binding-v1',
    gameId: 'fps',
    scopeId: 'studio-fps',
    generation: 7,
    status: 'ready',
    catalogUrl: '/preview/__pack/scopes/studio-fps/7/catalog.json',
    importUrlBase: '/preview/__pack/scopes/studio-fps/7/import',
    packageUrlBase: '/preview/__pack/scopes/studio-fps/7/asset',
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('AssetIOFacade runtime scope', () => {
  it('fails closed instead of issuing an unscoped cook request', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      calls.push(String(input));
      return new Response('[]', { status: 200 });
    }) as typeof fetch;

    const result = await new AssetIOFacade().triggerCook('asset-guid');

    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('uses only the active binding generation for a cook', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      calls.push(String(input));
      return new Response('[]', { status: 200 });
    }) as typeof fetch;

    const facade = new AssetIOFacade();
    facade.setRuntimeBinding(binding());
    const result = await facade.triggerCook('asset-guid');

    expect(result.ok).toBe(true);
    expect(calls).toEqual(['/preview/__pack/scopes/studio-fps/7/import/asset-guid']);
  });
});
