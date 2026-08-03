import { describe, expect, it } from 'bun:test';
import { computeDeleteImpact, computeSceneDeleteGuards } from './delete-guard';

// tex ← mat ← mesh ; standalone has no referencers.
const graph = {
  schemaVersion: 'asset-workspace/v1' as const,
  revision: 'workspace:r1',
  resourceRevision: 'resource:r1',
  identity: 'workspace-snapshot:test',
  subjects: [],
  relations: [
    { kind: 'depends-on' as const, from: 'mesh', to: 'mat' },
    { kind: 'depends-on' as const, from: 'mat', to: 'tex' },
  ],
  issues: [],
};

describe('computeDeleteImpact', () => {
  it('flags a target still referenced from outside the batch', () => {
    const impact = computeDeleteImpact(['tex'], graph);
    expect(impact.hasExternalReferencers).toBe(true);
    expect(impact.externalReferencers.get('tex')).toEqual(['mat']);
    expect(impact.externalReferencerCount).toBe(1);
  });

  it('reports no impact for an unreferenced target', () => {
    const impact = computeDeleteImpact(['standalone'], graph);
    expect(impact.hasExternalReferencers).toBe(false);
    expect(impact.externalReferencers.size).toBe(0);
    expect(impact.externalReferencerCount).toBe(0);
  });

  it('ignores referencers that are part of the same delete batch', () => {
    // Deleting mat + tex together: mat references tex, but mat is also going, so
    // tex has no *external* referencer.
    const impact = computeDeleteImpact(['mat', 'tex'], graph);
    expect(impact.externalReferencers.get('tex')).toBeUndefined();
    // mat is still referenced by mesh (outside the batch).
    expect(impact.externalReferencers.get('mat')).toEqual(['mesh']);
    expect(impact.hasExternalReferencers).toBe(true);
  });

  it('counts distinct external referencers across targets', () => {
    const g = { ...graph, relations: [
      { kind: 'depends-on' as const, from: 'consumer', to: 'x' },
      { kind: 'depends-on' as const, from: 'consumer', to: 'y' },
    ] };
    const impact = computeDeleteImpact(['x', 'y'], g);
    // Both x and y are referenced by the same consumer → distinct count is 1.
    expect(impact.externalReferencerCount).toBe(1);
  });
});

describe('computeSceneDeleteGuards', () => {
  const sceneModel = {
    gameId: 'shoot',
    currentScene: { id: 'main', guid: 'main' },
    defaultScene: { id: 'main', guid: 'main' },
    scenes: [
      { id: 'main', name: 'Main', pack: 'main.pack.json', guid: 'main', isCurrent: true, isDefault: true },
      { id: 'target', name: 'Target', pack: 'target.pack.json', guid: 'target', isCurrent: false, isDefault: false },
    ],
  } as const;

  it('projects current/default protection and external scene refs into one human guard', () => {
    const workspace = {
      ...graph,
      relations: [{ kind: 'depends-on' as const, from: 'consumer', to: 'target' }],
    };
    const guards = computeSceneDeleteGuards([
      { guid: 'main', kind: 'scene' },
      { guid: 'target', kind: 'scene' },
    ], sceneModel, workspace);
    expect(guards.get('main')).toEqual({ reasons: ['current', 'default'], referencers: [] });
    expect(guards.get('target')).toEqual({ reasons: ['referenced'], referencers: ['consumer'] });
  });

  it('does not guard an unreferenced non-current scene', () => {
    const guards = computeSceneDeleteGuards([{ guid: 'target', kind: 'scene' }], sceneModel, graph);
    expect(guards.size).toBe(0);
  });
});
