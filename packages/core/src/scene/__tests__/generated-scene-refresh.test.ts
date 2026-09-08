import { describe, expect, it } from 'bun:test';
import {
  createGeneratedSceneRefreshOwner,
  type GeneratedSceneRefreshHost,
} from '../generated-scene-refresh';
import type { EntityHandle } from '../scene-types';
import type { GeneratedSceneOverride } from '../spawn-asset-ref';

const handle = (value: number): EntityHandle => value as EntityHandle;
const override = (member: number, field: string, value: unknown): GeneratedSceneOverride => ({
  member: handle(member), component: 'Transform', field, value,
});

function host(overrides: Partial<GeneratedSceneRefreshHost> = {}): GeneratedSceneRefreshHost & {
  swaps: unknown[];
  discarded: string[];
} {
  const swaps: unknown[] = [];
  const discarded: string[] = [];
  return {
    swaps,
    discarded,
    snapshotWrapper: (root) => ({
      root,
      parent: handle(2),
      transform: { pos: [3, 4, 5] },
      sourcePath: 'assets/showcase.pack.ts',
      sourceKey: 'scene/main',
      generation: 1,
    }),
    stageTree: async () => ({
      ok: true,
      value: {
        token: 'stage-2',
        members: [handle(20), handle(21)],
        memberMap: new Map([[handle(10), handle(20)]]),
        state: { members: new Set([handle(20)]), fields: new Set(['20:Transform:pos']) },
      },
    }),
    swapTree: (input) => { swaps.push(input); return { ok: true }; },
    discardTree: (tree) => { discarded.push(tree.token); },
    ...overrides,
  };
}

describe('generated Scene whole replacement owner', () => {
  it('swaps a complete staged tree while preserving wrapper identity and overrides', async () => {
    const world = host();
    const result = await createGeneratedSceneRefreshOwner(world).refresh({
      wrapper: handle(10), sourcePath: 'assets/showcase.pack.ts', sourceKey: 'scene/main', generation: 2,
      overrides: [override(20, 'pos', [8, 9, 10])],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        root: handle(10), parent: handle(2), transform: { pos: [3, 4, 5] },
        members: [handle(20), handle(21)], generation: 2,
        appliedOverrides: [override(20, 'pos', [8, 9, 10])],
      },
    });
    expect(world.swaps).toHaveLength(1);
  });

  it('keeps the old tree when staging fails', async () => {
    const world = host({ stageTree: async () => ({ ok: false, error: 'invalid output tuple' }) });
    const result = await createGeneratedSceneRefreshOwner(world).refresh({
      wrapper: handle(10), sourcePath: 'assets/showcase.pack.ts', sourceKey: 'scene/main', generation: 2,
      overrides: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'generated-scene-refresh-failed', currentGeneration: 1, retryable: true });
    expect(world.swaps).toHaveLength(0);
  });

  it('keeps the wrapper handle, parent, and transform while replacing every member', async () => {
    const world = host({
      stageTree: async () => ({
        ok: true,
        value: {
          token: 'stage-3',
          members: [handle(30), handle(31)],
          state: { members: new Set([handle(30)]), fields: new Set(['30:Transform:pos']) },
        },
      }),
    });
    const result = await createGeneratedSceneRefreshOwner(world).refresh({
      wrapper: handle(10), sourcePath: 'assets/showcase.pack.ts', sourceKey: 'scene/main', generation: 3,
      overrides: [override(30, 'pos', [6, 7, 8])],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.root).toBe(handle(10));
    expect(result.value.parent).toBe(handle(2));
    expect(result.value.transform).toEqual({ pos: [3, 4, 5] });
    expect(result.value.members).toEqual([handle(30), handle(31)]);
    expect(result.value.members).not.toContain(handle(20));
    expect(world.swaps).toHaveLength(1);
  });

  it('remaps a preserved override by the engine member identity before validation', async () => {
    const world = host({
      stageTree: async () => ({
        ok: true,
        value: {
          token: 'stage-remap',
          members: [handle(20)],
          memberMap: new Map([[handle(10), handle(20)]]),
          state: { members: new Set([handle(20)]), fields: new Set(['20:Transform:pos']) },
        },
      }),
    });
    const result = await createGeneratedSceneRefreshOwner(world).refresh({
      wrapper: handle(10), sourcePath: 'assets/showcase.pack.ts', sourceKey: 'scene/main', generation: 2,
      overrides: [override(10, 'pos', [8, 9, 10])],
    });
    expect(result).toMatchObject({ ok: true, value: { appliedOverrides: [override(20, 'pos', [8, 9, 10])] } });
  });
});
