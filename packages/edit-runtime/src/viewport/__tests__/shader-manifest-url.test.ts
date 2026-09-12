import { describe, expect, it } from 'bun:test';
import {
  mergeViewportShaderManifests,
  needsViewportShaderManifestMerge,
  resolveViewportShaderManifestUrl,
} from '../shader-manifest-url';

describe('viewport shader manifest URL', () => {
  it('uses the local editor manifest for a standalone game runtime', () => {
    expect(resolveViewportShaderManifestUrl('/editor/', true, '/tmp/game')).toBe(
      '/editor/shaders/manifest.json',
    );
    expect(needsViewportShaderManifestMerge('/editor/', true, '/tmp/game')).toBe(false);
  });

  it('uses the editor manifest for a Studio late-bound runtime', () => {
    expect(resolveViewportShaderManifestUrl('/editor/', true, null)).toBe(
      '/editor/shaders/manifest.json',
    );
    expect(needsViewportShaderManifestMerge('/editor/', true, null)).toBe(false);
  });

  it('keeps the local manifest for an unscoped empty scene', () => {
    expect(resolveViewportShaderManifestUrl('/editor/', false, null)).toBe(
      '/editor/shaders/manifest.json',
    );
    expect(needsViewportShaderManifestMerge('/editor/', false, null)).toBe(false);
  });

  it('keeps the host manifest contract on the Studio IDE shell carrier', () => {
    expect(resolveViewportShaderManifestUrl('/', true, null)).toBe(
      '/shaders/manifest.json',
    );
    expect(needsViewportShaderManifestMerge('/', true, null)).toBe(true);
  });
});

describe('mergeViewportShaderManifests', () => {
  it('deduplicates entries by hash and material shaders by identifier', () => {
    const play = {
      entries: [{ hash: 'engine', wgsl: 'engine', glsl: '', bindings: '[]' }],
      materialShaders: [{
        identifier: 'forgeax::default-standard-pbr',
        sourcePath: 'pbr.wgsl',
        composedWgsl: 'pbr',
        paramSchema: '[]',
        variants: [],
      }],
    };
    const host = {
      entries: [{ hash: 'grid', wgsl: 'grid', glsl: '', bindings: '[]' }],
      materialShaders: [{
        identifier: 'editor::infinite-grid',
        sourcePath: 'infinite-grid.wgsl',
        composedWgsl: 'grid',
        paramSchema: '[]',
        variants: [],
      }],
    };
    const merged = mergeViewportShaderManifests(play, host);
    expect(merged.entries.map((entry) => entry.hash)).toEqual(['engine', 'grid']);
    expect(merged.materialShaders?.map((entry) => entry.identifier)).toEqual([
      'forgeax::default-standard-pbr',
      'editor::infinite-grid',
    ]);
  });
});
