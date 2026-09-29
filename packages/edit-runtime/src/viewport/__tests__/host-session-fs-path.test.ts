import { describe, expect, it } from 'bun:test';
import type { RuntimeAssetBinding } from '@forgeax/engine-types';
import { candidateGameRoots, runtimeGameModuleBase } from '../host-session';

describe('host-session game filesystem candidates', () => {
  it('tries the health path before appending a host-relative game root', () => {
    expect(candidateGameRoots('/workspace/games/sample', 'sample')).toEqual([
      '/workspace/games/sample',
      '/workspace/games/sample/sample',
    ]);
  });

  it('supports a health path that is the instance parent', () => {
    expect(candidateGameRoots('/workspace/games', 'sample')).toEqual([
      '/workspace/games',
      '/workspace/games/sample',
    ]);
  });

  it('does not append an empty game root', () => {
    expect(candidateGameRoots('/workspace/games/sample', '')).toEqual([
      '/workspace/games/sample',
    ]);
  });

  it('routes Studio game modules through the Play runtime Catalog owner', () => {
    const binding = {
      schemaVersion: 'runtime-asset-binding-v1',
      gameId: 'gameaw1',
      scopeId: 'studio-scope',
      generation: 4,
      status: 'ready',
      catalogUrl: '/preview/__pack/scopes/studio-scope/4/catalog.json',
      importUrlBase: '/preview/__pack/scopes/studio-scope/4/import',
      packageUrlBase: '/preview/__pack/scopes/studio-scope/4/asset',
      catalogRoots: [{ root: 'assets', catalogPrefix: 'host-games/gameaw1/assets' }],
    } satisfies RuntimeAssetBinding;

    expect(runtimeGameModuleBase(binding)).toBe('/preview/host-games/gameaw1');
    expect(runtimeGameModuleBase(undefined)).toBeNull();
  });

  it('keeps standalone --game hosts on the /@fs base (host origin /__pack is not the Play runtime owner)', () => {
    const binding = {
      schemaVersion: 'runtime-asset-binding-v1',
      gameId: 'sample',
      scopeId: 'standalone-sample',
      generation: 1,
      status: 'ready',
      catalogUrl: '/__pack/scopes/standalone-sample/1/catalog.json',
      importUrlBase: '/__pack/scopes/standalone-sample/1/import',
      packageUrlBase: '/__pack/scopes/standalone-sample/1/asset',
      catalogRoots: [{ root: 'assets', catalogPrefix: 'games/sample/assets' }],
    } satisfies RuntimeAssetBinding;

    expect(runtimeGameModuleBase(binding)).toBeNull();
  });
});
