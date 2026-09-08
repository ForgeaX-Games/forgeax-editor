import { describe, expect, test } from 'bun:test';
import type { Plugin } from '@forgeax/engine-app';
import {
  activatePlayGame,
  resolvePlayGameActivation,
} from '../play-game-activation';

const gameplay: Plugin = {
  name: 'game-3d',
  inject: ['world', 'gameHost'],
  apply() {},
};

describe('resolvePlayGameActivation', () => {
  test('admits the engine preview Cordis default export', async () => {
    const activation = await resolvePlayGameActivation('test2', { default: gameplay });
    expect(activation).toEqual({ kind: 'plugin', plugin: gameplay });
  });

  test('falls back to a named bootstrap(world, ctx) export', async () => {
    const bootstrap = () => {};
    const activation = await resolvePlayGameActivation('legacy', { bootstrap });
    expect(activation.kind).toBe('legacy');
    if (activation.kind === 'legacy') expect(activation.entry).toBe(bootstrap);
  });

  test('keeps a default-export bootstrap(world, ctx) function on the legacy path', async () => {
    const bootstrap = (_world: unknown, _ctx?: unknown) => {};
    const activation = await resolvePlayGameActivation('legacy-default', { default: bootstrap });
    expect(activation.kind).toBe('legacy');
    if (activation.kind === 'legacy') expect(activation.entry).toBe(bootstrap);
  });

  test('returns none when the module has no playable export', async () => {
    expect(await resolvePlayGameActivation('empty', { foo: 1 })).toEqual({ kind: 'none' });
    expect(await resolvePlayGameActivation('missing', null)).toEqual({ kind: 'none' });
  });
});

describe('activatePlayGame', () => {
  test('provides gameHost then mounts the Cordis plugin', async () => {
    const mounted: string[] = [];
    await activatePlayGame({
      app: {
        pluginContext: {
          plugin: async (plugin: Plugin) => {
            mounted.push(plugin.name ?? 'anonymous');
          },
        },
      } as never,
      world: {} as never,
      gameHost: { canvas: {} as HTMLCanvasElement } as never,
      ctx: {} as never,
      activation: { kind: 'plugin', plugin: gameplay },
    });
    expect(mounted).toEqual(['game-host', 'game-3d']);
  });

  test('invokes a legacy bootstrap function with world and ctx', async () => {
    const calls: unknown[] = [];
    await activatePlayGame({
      app: { pluginContext: { plugin: async () => {} } } as never,
      world: { id: 'world' } as never,
      gameHost: { canvas: {} as HTMLCanvasElement } as never,
      ctx: { uiRoot: 'root' } as never,
      activation: {
        kind: 'legacy',
        entry: (world, ctx) => {
          calls.push([world, ctx]);
        },
      },
    });
    expect(calls).toEqual([[{ id: 'world' }, { uiRoot: 'root' }]]);
  });
});
