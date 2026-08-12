import { describe, expect, it } from 'bun:test';
import { resolveViewportShaderManifestUrl } from '../shader-manifest-url';

describe('viewport shader manifest URL', () => {
  it('uses the local editor manifest for a standalone game runtime', () => {
    expect(resolveViewportShaderManifestUrl('/editor/', true, '/tmp/game')).toBe(
      '/editor/shaders/manifest.json',
    );
  });

  it('uses the Play manifest for a Studio late-bound runtime', () => {
    expect(resolveViewportShaderManifestUrl('/editor/', true, null)).toBe(
      '/editor/preview/shaders/manifest.json',
    );
  });

  it('keeps the local manifest for an unscoped empty scene', () => {
    expect(resolveViewportShaderManifestUrl('/editor/', false, null)).toBe(
      '/editor/shaders/manifest.json',
    );
  });
});
