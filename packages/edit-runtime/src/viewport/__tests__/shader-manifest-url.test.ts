import { describe, expect, it } from 'bun:test';
import {
  mergeViewportShaderManifests,
  needsViewportShaderManifestMerge,
  prepareViewportShaderManifestUrl,
  resolveViewportShaderManifestUrl,
} from '../shader-manifest-url';

describe('viewport shader manifest URL', () => {
  it('uses the local editor manifest for a standalone game runtime', () => {
    expect(resolveViewportShaderManifestUrl('/editor/', true, '/tmp/game')).toBe('/editor/shaders/manifest.json');
    expect(needsViewportShaderManifestMerge('/editor/', true, '/tmp/game')).toBe(false);
  });

  it('uses the editor manifest for a Studio late-bound runtime', () => {
    expect(resolveViewportShaderManifestUrl('/editor/', true, null)).toBe('/editor/shaders/manifest.json');
    expect(needsViewportShaderManifestMerge('/editor/', true, null)).toBe(false);
  });

  it('keeps the local manifest for an unscoped empty scene', () => {
    expect(resolveViewportShaderManifestUrl('/editor/', false, null)).toBe('/editor/shaders/manifest.json');
    expect(needsViewportShaderManifestMerge('/editor/', false, null)).toBe(false);
  });

  it('keeps the host manifest contract on the Studio IDE shell carrier', () => {
    expect(resolveViewportShaderManifestUrl('/', true, null)).toBe('/shaders/manifest.json');
    expect(needsViewportShaderManifestMerge('/', true, null)).toBe(true);
  });
});

describe('mergeViewportShaderManifests', () => {
  it('deduplicates entries by hash and material shaders by identifier', () => {
    const play = {
      entries: [{ hash: 'engine', wgsl: 'engine', glsl: '', bindings: '[]' }],
      materialShaders: [{ identifier: 'forgeax::default-standard-pbr', sourcePath: 'pbr.wgsl', composedWgsl: 'pbr', paramSchema: '[]', variants: [] }],
    };
    const host = {
      entries: [{ hash: 'grid', wgsl: 'grid', glsl: '', bindings: '[]' }],
      materialShaders: [{ identifier: 'editor::infinite-grid', sourcePath: 'infinite-grid.wgsl', composedWgsl: 'grid', paramSchema: '[]', variants: [] }],
    };
    const merged = mergeViewportShaderManifests(play, host);
    expect(merged.entries.map((entry) => entry.hash)).toEqual(['engine', 'grid']);
    expect(merged.materialShaders?.map((entry) => entry.identifier)).toEqual([
      'forgeax::default-standard-pbr',
      'editor::infinite-grid',
    ]);
  });
});

describe('compressed shader manifest integration', () => {
  it('verifies and expands each source table before merging viewport shaders', async () => {
    const publication = (source: string, hash: string) => {
      const digest = new Bun.CryptoHasher('sha256').update(source).digest('hex');
      return { schemaVersion: '2.0.0', fragments: [source], sources: { [digest]: [0] }, entries: [{ hash, sourceDigest: digest, glsl: '', bindings: '[]' }], materialShaders: [] };
    };
    const originalFetch = globalThis.fetch;
    const originalCreateObjectURL = URL.createObjectURL;
    const mergedBlobs: Blob[] = [];
    URL.createObjectURL = ((blob: Blob) => {
      mergedBlobs.push(blob);
      return `https://shader.test/merged-${mergedBlobs.length}.json`;
    }) as typeof URL.createObjectURL;
    let tamper = false;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const play = String(input).includes('/preview/');
      const manifest = publication(play ? 'engine source' : 'grid source', play ? 'engine' : 'grid');
      if (tamper) manifest.fragments[0] = 'corrupted source';
      return Response.json(manifest);
    }) as typeof fetch;
    try {
      await prepareViewportShaderManifestUrl('/', true, null);
      const mergedBlob = mergedBlobs[0];
      if (mergedBlob === undefined) throw new Error('viewport shader merge did not produce a manifest');
      const merged = JSON.parse(await mergedBlob.text());
      expect(merged.schemaVersion).toBeUndefined();
      expect(merged.entries).toEqual([
        { hash: 'engine', wgsl: 'engine source', glsl: '', bindings: '[]' },
        { hash: 'grid', wgsl: 'grid source', glsl: '', bindings: '[]' },
      ]);
      tamper = true;
      await expect(prepareViewportShaderManifestUrl('/', true, null)).rejects.toThrow('digest mismatch');
    } finally {
      globalThis.fetch = originalFetch;
      URL.createObjectURL = originalCreateObjectURL;
    }
  });
});
