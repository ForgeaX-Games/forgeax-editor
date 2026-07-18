import { describe, expect, it } from 'bun:test';
import { catalogPathToRoot, type CatalogAssetRoot } from './catalog-root';

const roots: readonly CatalogAssetRoot[] = [
  { root: 'assets', catalogPrefix: 'games/sample/assets' },
  { root: '@shared/characters', catalogPrefix: 'forgeax-editor-assets/characters' },
];

describe('catalogPathToRoot', () => {
  it('projects a declared local root from catalog coordinates', () => {
    expect(catalogPathToRoot('games/sample/assets/scene.pack.json', 'sample', roots))
      .toBe('assets/scene.pack.json');
  });

  it('keeps local assets visible when runtime catalog paths use a different prefix', () => {
    expect(catalogPathToRoot('projects/demo/sample/assets/scene.pack.json', 'sample', roots))
      .toBe('assets/scene.pack.json');
  });

  it('projects declared shared roots without accepting arbitrary external paths', () => {
    expect(catalogPathToRoot('forgeax-editor-assets/characters/Fox.glb.meta.json', 'sample', roots))
      .toBe('@shared/characters/Fox.glb.meta.json');
    expect(catalogPathToRoot('forgeax-editor-assets/template-game-default/sky.hdr.meta.json', 'sample', roots))
      .toBeNull();
  });
});
