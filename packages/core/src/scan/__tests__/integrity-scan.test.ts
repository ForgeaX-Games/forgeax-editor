import { afterEach, describe, expect, test } from 'bun:test';
import { assetIO } from '../../io/asset-io-facade';
import { setPathResolver } from '../../util/path-resolver';
import { scanAssetsIntegrity } from '../integrity-scan';

const originalListSourceFiles = assetIO.listSourceFiles;

afterEach(() => {
  assetIO.listSourceFiles = originalListSourceFiles;
  setPathResolver(null);
});

describe('scanAssetsIntegrity', () => {
  test('does not warn for normal source-only runtime files', async () => {
    setPathResolver((relativePath) => relativePath ? `game/${relativePath}` : 'game');
    assetIO.listSourceFiles = async () => [
      'game/assets/scene.glb',
      'game/assets/scene.glb.meta.json',
      'game/assets/hud/icon.png',
      'game/assets/hud/template.html',
    ];
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };

    try {
      const result = await scanAssetsIntegrity();

      expect(result.needsMeta).toEqual([{
        sourcePath: 'game/assets/hud/icon.png',
        sourceName: 'icon.png',
      }]);
      expect(result.diagnostics).toEqual([]);
      expect(warnings).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });
});
