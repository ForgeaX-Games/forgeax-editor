import { afterEach, describe, expect, it } from 'bun:test';
import type { RuntimeAssetBinding } from '@forgeax/engine-types';

import { AssetIOFacade, isRetryableCookTriggerFailure } from '../io/asset-io-facade';

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
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    const result = await new AssetIOFacade().triggerCook('asset-guid');

    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('uses only the active binding generation for a cook', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    const facade = new AssetIOFacade();
    facade.setRuntimeBinding(binding());
    const result = await facade.triggerCook('asset-guid');

    expect(result.ok).toBe(true);
    expect(calls).toEqual([{
      url: '/preview/__pack/scopes/studio-fps/7/import/asset-guid?import-mode=rebuild',
      init: {
        method: 'POST',
        headers: { 'x-forgeax-import-mode': 'rebuild' },
        signal: undefined,
      },
    }]);
  });

  it('forwards cold-cook mode through the generation-scoped import route', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    const facade = new AssetIOFacade();
    facade.setRuntimeBinding(binding());
    const result = await facade.triggerCook('asset-guid', undefined, 'cold-cook');

    expect(result.ok).toBe(true);
    expect(calls[0]?.init?.headers).toEqual({ 'x-forgeax-import-mode': 'cold-cook' });
  });

  it('retries meta-not-found for cold-cook until the sidecar is indexed', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts < 3) {
        return new Response(JSON.stringify({
          error: 'meta-not-found',
          hint: 'no source declares this GUID',
        }), { status: 404, headers: { 'content-type': 'application/json' } });
      }
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    const facade = new AssetIOFacade();
    facade.setRuntimeBinding(binding());
    const result = await facade.triggerCook('asset-guid', undefined, 'cold-cook');

    expect(result.ok).toBe(true);
    expect(attempts).toBe(3);
  });

  it('does not retry meta-not-found under rebuild mode', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response(JSON.stringify({
        error: 'meta-not-found',
        hint: 'no source declares this GUID',
      }), { status: 404, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const facade = new AssetIOFacade();
    facade.setRuntimeBinding(binding());
    const result = await facade.triggerCook('asset-guid', undefined, 'rebuild');

    expect(result.ok).toBe(false);
    expect(attempts).toBe(1);
  });

  it('classifies transient cook trigger failures', () => {
    expect(isRetryableCookTriggerFailure(404, { error: 'meta-not-found' }, 'cold-cook')).toBe(true);
    expect(isRetryableCookTriggerFailure(404, { error: 'meta-not-found' }, 'rebuild')).toBe(false);
    expect(isRetryableCookTriggerFailure(422, { code: 'stale-generation' })).toBe(true);
    expect(isRetryableCookTriggerFailure(422, { code: 'import-failed', error: 'import-failed' })).toBe(false);
  });
});
