import { describe, expect, it } from 'bun:test';
import {
  catalogStoragePath,
  catalogGameStoragePath,
  projectCatalogPathToRoots,
} from '../assets/catalog-storage-path';

describe('catalogStoragePath', () => {
  it('keeps authored packs as the writable container', () => {
    expect(catalogStoragePath({
      packageUrl: '/preview/.forgeax/games/demo/assets/ui.pack.json',
      sourcePath: '.forgeax/games/demo/assets/ui.pack.json',
    })).toBe('.forgeax/games/demo/assets/ui.pack.json');
  });

  it('derives imported source sidecars and rejects runtime-only DDC rows', () => {
    expect(catalogStoragePath({
      packageUrl: '/__forgeax-ddc/mesh.pack.json',
      sourcePath: 'assets/hero.glb',
    })).toBe('assets/hero.glb.meta.json');
    expect(catalogStoragePath({
      packageUrl: '/__forgeax-ddc/generated.pack.json',
    })).toBeNull();
  });
});

// Regression (Studio destroyAsset 400): the producer catalog reports sourcePath
// in the play-runtime serve-mount space (host-games/<slug>/...), which the
// /api/files whitelist rejects. Storage derivation must project through the
// declared catalog roots into game-internal coordinates first.
describe('projectCatalogPathToRoots', () => {
  const roots = [
    { root: 'assets', catalogPrefix: 'host-games/testgame0812/assets' },
    { root: '@shared/template-game-default', catalogPrefix: 'shared-assets/template-game-default' },
  ] as const;

  it('projects serve-mount paths into the declared-root space', () => {
    expect(projectCatalogPathToRoots('host-games/testgame0812/assets/bed.glb', roots))
      .toBe('assets/bed.glb');
    expect(projectCatalogPathToRoots('/host-games/testgame0812/assets/', roots))
      .toBe('assets');
  });

  it('returns null when no declared root prefix matches (no silent pass-through)', () => {
    expect(projectCatalogPathToRoots('unrelated/x.glb', roots)).toBeNull();
  });
});

describe('catalogGameStoragePath', () => {
  const roots = [{ root: 'assets', catalogPrefix: 'host-games/testgame0812/assets' }] as const;

  it('derives a game-internal sidecar path from a serve-mount sourcePath', () => {
    expect(catalogGameStoragePath({
      packageUrl: '/__forgeax-ddc/mesh.pack.json',
      sourcePath: 'host-games/testgame0812/assets/bed.glb',
    }, roots)).toBe('assets/bed.glb.meta.json');
  });

  it('derives a game-internal pack path for authored packs', () => {
    expect(catalogGameStoragePath({
      packageUrl: '/preview/host-games/testgame0812/assets/ui.pack.json',
      sourcePath: 'host-games/testgame0812/assets/ui.pack.json',
    }, roots)).toBe('assets/ui.pack.json');
  });

  it('returns null when the sourcePath matches no declared root', () => {
    expect(catalogGameStoragePath({
      packageUrl: '/__forgeax-ddc/mesh.pack.json',
      sourcePath: 'elsewhere/bed.glb',
    }, roots)).toBeNull();
  });

  it('falls back to catalogStoragePath for rows without a sourcePath', () => {
    expect(catalogGameStoragePath({
      packageUrl: 'assets/ui.pack.json',
    }, roots)).toBe('assets/ui.pack.json');
    expect(catalogGameStoragePath({
      packageUrl: '/__forgeax-ddc/generated.pack.json',
    }, roots)).toBeNull();
  });
});
