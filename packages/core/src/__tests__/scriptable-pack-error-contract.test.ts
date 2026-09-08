import { describe, expect, it } from 'bun:test';
import { validateGeneratedSceneOperation } from '../session/scriptable-pack-ops';
import { projectGeneratedSceneOverrides } from '../scene/spawn-asset-ref';
import { createGeneratedSceneRefreshOwner } from '../scene/generated-scene-refresh';
import type { EntityHandle } from '../scene/scene-types';

const handle = (value: number): EntityHandle => value as EntityHandle;

describe('ScriptablePack generated Scene error contract', () => {
  it('projects read-only rejection with identity and recovery fields', () => {
    const result = validateGeneratedSceneOperation({
      kind: 'reparent', target: 'structure', sourcePath: 'assets/showcase.pack.ts',
      sourceKey: 'scene/main', outputGuid: 'scene-guid', candidateGeneration: 3,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: 'generated-scene-read-only', phase: 'validation', sourcePath: 'assets/showcase.pack.ts',
      sourceKey: 'scene/main', outputGuid: 'scene-guid', candidateGeneration: 3,
      retryable: false, recoveryActions: ['revealInFileManager', 'promoteImportedScene', 'asset-source.clone'],
    });
  });

  it('projects stale override identity without reassigning an EntityHandle', () => {
    const result = projectGeneratedSceneOverrides(
      [{ member: handle(10), component: 'Transform', field: 'scale', value: [2, 2, 2] }],
      { members: new Set([handle(10)]), fields: new Set(['10:Transform:pos']) },
      { sourcePath: 'assets/showcase.pack.ts', sourceKey: 'scene/main', generation: 4 },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: 'generated-scene-stale-override', member: handle(10), field: 'scale',
      sourcePath: 'assets/showcase.pack.ts', sourceKey: 'scene/main', generation: 4,
      retryable: false,
    });
  });

  it('keeps refresh failure structured and leaves the previous tree untouched', async () => {
    const owner = createGeneratedSceneRefreshOwner({
      snapshotWrapper: (root) => ({ root, parent: null, transform: {}, sourcePath: 'assets/showcase.pack.ts', sourceKey: 'scene/main', generation: 1 }),
      stageTree: async () => ({ ok: false, error: 'publication timeout' }),
      swapTree: () => ({ ok: true }),
    });
    const result = await owner.refresh({ wrapper: handle(10), sourcePath: 'assets/showcase.pack.ts', sourceKey: 'scene/main', generation: 2, overrides: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: 'generated-scene-refresh-failed', phase: 'publication', sourcePath: 'assets/showcase.pack.ts',
      sourceKey: 'scene/main', candidateGeneration: 2, currentGeneration: 1, retryable: true,
      recoveryActions: ['asset-source.rebuild', 'asset.preflight', 'reopen-scene'],
    });
  });
});
