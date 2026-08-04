import { describe, expect, it } from 'bun:test';
import { catalogStoragePath } from '../assets/catalog-storage-path';

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
