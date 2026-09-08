import { afterEach, describe, expect, it } from 'bun:test';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { ShaderRegistry, type ShaderRegistryDevice } from '@forgeax/engine-shader';
import type { MaterialAsset } from '@forgeax/engine-types';
import { createAuthoredAssetCatalogBarrier } from '../authored-asset-barrier';

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

describe('createAuthoredAssetCatalogBarrier', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('accepts a catalog replica row before packIndexCache refresh succeeds', async () => {
    const guid = crypto.randomUUID();
    const key = guid.toLowerCase();
    const packageUrl = '/__pack/assets/Materials.pack.json';
    const packBody = JSON.stringify({
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [{ guid, kind: 'material', name: 'NewMaterial', payload: { kind: 'material' }, refs: [] }],
    });

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === packageUrl) return new Response(packBody, { status: 200 });
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const registry = new AssetRegistry(makeShaderRegistry());
    registry.catalogSnapshot = () => ({
      version: 1,
      stale: false,
      diagnostics: [],
      entries: [{
        guid,
        kind: 'material',
        name: 'NewMaterial',
        packageUrl,
        sourcePath: 'assets/Materials/NewMaterial.material',
        lifecycle: 'current',
      }],
    });
    registry.loadByGuid = (async () => ({ ok: true, value: { kind: 'material' } as MaterialAsset })) as unknown as typeof registry.loadByGuid;

    const barrier = createAuthoredAssetCatalogBarrier(registry, {
      deadlineMs: 2000,
      rowPollMs: 5,
      bodyPollMs: 5,
    });

    await expect(barrier(guid)).resolves.toBeUndefined();
    expect(registry.packIndexCache?.get(key)?.packageUrl).toBe(packageUrl);
  });

  it('ignores a stale imported catalog row when the pack body 404s', async () => {
    const guid = crypto.randomUUID();
    const key = guid.toLowerCase();
    const staleUrl = `/__forgeax-ddc/${guid}.pack.json`;
    const goodUrl = '/__pack/assets/Materials.pack.json';
    const packBody = JSON.stringify({
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [{ guid, kind: 'material', name: 'NewMaterial', payload: { kind: 'material' }, refs: [] }],
    });
    let useGoodRow = false;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === goodUrl) return new Response(packBody, { status: 200 });
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const registry = new AssetRegistry(makeShaderRegistry());
    registry.catalogSnapshot = () => ({
      version: useGoodRow ? 2 : 1,
      stale: false,
      diagnostics: [],
      entries: [{
        guid,
        kind: 'material',
        name: 'NewMaterial',
        packageUrl: useGoodRow ? goodUrl : staleUrl,
        sourcePath: 'assets/Materials/NewMaterial.material',
        lifecycle: 'current',
      }],
    });
    registry.refreshCatalog = async () => {
      useGoodRow = true;
      return true;
    };
    registry.loadByGuid = (async () => ({ ok: true, value: { kind: 'material' } as MaterialAsset })) as unknown as typeof registry.loadByGuid;

    const barrier = createAuthoredAssetCatalogBarrier(registry, {
      deadlineMs: 2000,
      rowPollMs: 5,
      bodyPollMs: 5,
    });

    await expect(barrier(guid)).resolves.toBeUndefined();
    expect(registry.packIndexCache?.get(key)?.packageUrl).toBe(goodUrl);
  });
});
