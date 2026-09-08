import { describe, expect, test, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { World } from '@forgeax/engine-ecs';
import type { Plugin } from '@forgeax/engine-plugin';
import {
  gamePluginImportUrl,
  getPlayPluginFailure,
  loadGamePluginModules,
  addGamePluginSystems,
  describeGamePluginSystems,
  installGamePluginProducers,
  ensureGamePluginsLoaded,
  GAMEPLAY_PRODUCER_CONTRACT,
  GAMEPLAY_PRODUCER_CONTRACT_VERSION,
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
