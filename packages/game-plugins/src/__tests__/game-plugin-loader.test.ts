import { describe, expect, test, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { World } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import {
  activatesBeforeScene,
  gamePluginImportUrl,
  getPlayPluginFailure,
  loadGamePluginModules,
  addGamePluginSystems,
  describeGamePluginSystems,
  installGamePluginProducers,
  ensureGamePluginsLoaded,
  GAMEPLAY_PRODUCER_CONTRACT,
  GAMEPLAY_PRODUCER_CONTRACT_VERSION,
  isNativeCordisPlugin,
  listForgeEnginePluginModulePaths,
  normalizePlayGameEntry,
  resolveGamePluginModuleDescriptors,
  resolvePhysicsBackendFromForgePlugins,
} from '../index';

describe('asset-resident game plugin loader contract', () => {
  test('keeps plugin imports game-relative under the supplied fs base', () => {
    expect(gamePluginImportUrl(
      'sample/assets/rotator.plugin.ts',
      'sample',
      '/preview/host-games/sample',
    )).toBe('/preview/host-games/sample/assets/rotator.plugin.ts');
  });

  test('projects an import failure as a Play terminal fact', () => {
    expect(getPlayPluginFailure({ errors: [
      { clientPath: 'sample/assets/broken.plugin.ts', message: 'module syntax error' },
    ] })).toEqual({
      code: 'play-plugin-failed',
      hint: 'Play plugin sample/assets/broken.plugin.ts failed to load: module syntax error',
    });
    expect(getPlayPluginFailure({ errors: [] })).toBeNull();
  });

  test('resolvePhysicsBackendFromForgePlugins reads rapier engine plugins', () => {
    expect(resolvePhysicsBackendFromForgePlugins([
      { name: '@forgeax/engine/physics/rapier3d', realm: 'engine' },
    ])).toBe('rapier-3d');
    expect(resolvePhysicsBackendFromForgePlugins(undefined)).toBeUndefined();
  });

  test('listForgeEnginePluginModulePaths prefers forge.json 2.0 composer over *.plugin.ts glob', () => {
    const paths = listForgeEnginePluginModulePaths([
      { name: '@forgeax/engine/physics/rapier3d', realm: 'engine' },
      { name: './assets/plugin.ts', realm: 'engine' },
    ]);
    expect(paths).toEqual(['assets/plugin.ts']);
    const modules = resolveGamePluginModuleDescriptors(
      paths,
      ['assets/player/player.plugin.ts'],
      'my-game',
      '/preview/g/my-game',
    );
    expect(modules).toEqual([{ clientPath: 'assets/plugin.ts', url: '/preview/g/my-game/assets/plugin.ts' }]);
  });

  test('normalizePlayGameEntry accepts bootstrap fn and default Cordis plugins', () => {
    const bootstrap = () => {};
    expect(normalizePlayGameEntry({ bootstrap })).toBe(bootstrap);
    const plugin: Plugin = { name: 'game-3d', inject: ['world', 'gameHost'], apply: () => undefined };
    expect(normalizePlayGameEntry({ default: plugin })).toBe(plugin);
    expect(isNativeCordisPlugin(plugin)).toBe(true);
    expect(isNativeCordisPlugin(bootstrap)).toBe(false);
  });

  test('admits only opted-in component plugins before scene materialization', () => {
    const componentPlugin: Plugin & { readonly beforeScene: true } = { name: 'rotator', inject: ['world'], beforeScene: true, apply: () => undefined };
    const scenePlugin: Plugin = { name: 'player', inject: ['world', 'gameHost'], apply: () => undefined };
    expect(activatesBeforeScene(componentPlugin)).toBe(true);
    expect(activatesBeforeScene(scenePlugin)).toBe(false);
    expect(activatesBeforeScene({ name: 'unspecified', inject: ['world'], apply: () => undefined })).toBe(false);
  });

  test('exports game plugin loader and lifecycle functions', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(source).toContain('loadGamePluginModules');
    expect(source).toContain('addGamePluginSystems');
    expect(source).toContain('installGamePluginProducers');
  });

  test('loadGamePluginModules loads modules and extracts producer and errors', async () => {
    const nativePlugin: Plugin = { name: 'test-plugin', apply: () => undefined };
    const validProducer = {
      descriptor: {
        contract: GAMEPLAY_PRODUCER_CONTRACT,
        version: GAMEPLAY_PRODUCER_CONTRACT_VERSION,
        id: 'test-producer',
        title: 'Test Producer',
      },
      register: (ctx: any) => {
        ctx.report({ code: 'producer-report', severity: 'info', message: 'ready' });
        ctx.onDispose(() => {});
        ctx.onReload?.(() => {});
      },
    };

    const result = await loadGamePluginModules({
      modules: [
        { clientPath: 'assets/good.plugin.ts', url: '/good.plugin.ts' },
        { clientPath: 'assets/invalid.plugin.ts', url: '/invalid.plugin.ts' },
        { clientPath: 'assets/fail.plugin.ts', url: '/fail.plugin.ts' },
      ],
      importModule: async (url) => {
        if (url === '/good.plugin.ts') {
          return { default: nativePlugin, gameplay: validProducer };
        }
        if (url === '/invalid.plugin.ts') {
          return {
            default: nativePlugin,
            gameplay: { descriptor: { contract: 'wrong' } },
          };
        }
        throw new Error('network error');
      },
    });

    expect(result.plugins).toHaveLength(2);
    expect(result.errors).toHaveLength(2);
    expect(result.plugins[0]?.descriptor?.id).toBe('test-producer');
  });

  test('installGamePluginProducers manages producer lifecycle and diagnostics', async () => {
    let disposed = false;
    let reloaded = false;

    const validProducer = {
      descriptor: {
        contract: GAMEPLAY_PRODUCER_CONTRACT,
        version: GAMEPLAY_PRODUCER_CONTRACT_VERSION,
        id: 'mock-producer',
        title: 'Mock Producer',
      },
      register: (ctx: any) => {
        ctx.report({ code: 'producer-report', severity: 'info', message: 'registered' });
        ctx.onDispose(() => {
          disposed = true;
        });
        ctx.onReload(() => {
          reloaded = true;
        });
      },
    };

    const loadResult = {
      plugins: [
        {
          clientPath: 'assets/mock.plugin.ts',
          url: '/mock.plugin.ts',
          components: [],
          systems: [],
          descriptor: validProducer.descriptor,
          producer: validProducer,
        },
      ],
      systems: [],
      components: [],
      errors: [],
    };

    const world = new World();
    const install = await installGamePluginProducers(loadResult, { world });
    expect(install.ok).toBe(true);
    if (!install.ok) return;

    expect(install.value.descriptors).toHaveLength(1);
    expect(install.value.diagnostics()).toHaveLength(1);

    const reloadRes = await install.value.reload();
    expect(reloadRes.ok).toBe(true);
    expect(reloaded).toBe(true);

    install.value.dispose();
    expect(disposed).toBe(true);

    const reloadAfterDispose = await install.value.reload();
    expect(reloadAfterDispose.ok).toBe(false);
  });

  test('addGamePluginSystems and describeGamePluginSystems', () => {
    const world = new World();
    const loadResult = {
      plugins: [
        {
          clientPath: 'assets/sys.plugin.ts',
          url: '/sys.plugin.ts',
          components: [],
          systems: ['custom-system'],
        },
      ],
      systems: ['custom-system'],
      components: [],
      errors: [],
    };

    const added = addGamePluginSystems(world, loadResult);
    expect(Array.isArray(added)).toBe(true);

    const descriptions = describeGamePluginSystems(loadResult, ['custom-system']);
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]?.system).toBe('custom-system');
  });

  test('ensureGamePluginsLoaded fetches and caches file tree', async () => {
    const fakeDeps = {
      fetch: async (path: string) => {
        return {
          ok: true,
          json: async () => ({
            tree: {
              name: 'assets',
              path: 'sample/assets',
              type: 'dir',
              children: [
                { name: 'rotator.plugin.ts', path: 'sample/assets/rotator.plugin.ts', type: 'file' },
              ],
            },
          }),
        } as any;
      },
      gameRoot: 'sample',
      resolveGameFsBase: async () => '/preview/host-games/sample',
    };

    const result = await ensureGamePluginsLoaded(fakeDeps);
    expect(result.plugins).toBeDefined();
  });
});
