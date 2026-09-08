import { describe, expect, it } from 'bun:test';
import {
  projectGeneratedSceneOverrides,
  validateGeneratedSceneOverride,
  type GeneratedSceneOverride,
} from '../scene/spawn-asset-ref';
import type { EntityHandle } from '../scene/scene-types';

const handle = (value: number): EntityHandle => value as EntityHandle;
const override = (member: number, field: string, value: unknown): GeneratedSceneOverride => ({
  member: handle(member),
  component: 'Transform',
  field,
  value,
});

describe('generated Scene instance overrides', () => {
  it('accepts wrapper and member field overrides without changing identity', () => {
    expect(validateGeneratedSceneOverride({ member: handle(10), component: 'Transform', field: 'pos', value: [1, 2, 3] }, {
      members: new Set([handle(10)]),
      fields: new Set(['10:Transform:pos']),
    })).toEqual({ ok: true });
    const projected = projectGeneratedSceneOverrides(
      [override(10, 'pos', [1, 2, 3])],
      { members: new Set([handle(10)]), fields: new Set(['10:Transform:pos']) },
    );
    expect(projected).toEqual({ ok: true, value: [override(10, 'pos', [1, 2, 3])] });
  });

  it('reports removed members and fields as stale instead of guessing a migration', () => {
    const projected = projectGeneratedSceneOverrides(
      [override(10, 'pos', [1, 2, 3]), override(11, 'scale', [2, 2, 2])],
      { members: new Set([handle(10)]), fields: new Set(['10:Transform:pos']) },
      { sourcePath: 'assets/showcase.pack.ts', sourceKey: 'scene/main', generation: 4 },
    );
    expect(projected.ok).toBe(false);
    if (projected.ok) return;
    expect(projected.error).toMatchObject({
      code: 'generated-scene-stale-override',
      member: 11,
      component: 'Transform',
      field: 'scale',
      sourcePath: 'assets/showcase.pack.ts',
      sourceKey: 'scene/main',
      generation: 4,
      recoveryActions: ['asset.preflight', 'revealInFileManager', 'promoteImportedScene', 'asset-source.clone'],
    });
  });
});
