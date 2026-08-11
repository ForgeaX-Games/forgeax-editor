import { describe, expect, it } from 'bun:test';
import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import { MeshFilter, MeshRenderer, Materials } from '@forgeax/engine-render';
import { HANDLE_CUBE, resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { EngineFacade } from '@forgeax/editor-core';
import type { MeshAsset } from '@forgeax/engine-types';

import { createSelectionStencilOutlinePool } from '../selection-stencil-outline';

function fakeEditorFacade(): {
  facade: EngineFacade;
  spawned: Set<EntityHandle>;
  despawned: Set<EntityHandle>;
  sets: Array<EntityHandle>;
  spawns: Array<readonly unknown[]>;
  allocations: Array<unknown>;
} {
  let next = 100;
  const spawned = new Set<EntityHandle>();
  const despawned = new Set<EntityHandle>();
  const sets: EntityHandle[] = [];
  const spawns: Array<readonly unknown[]> = [];
  const allocations: unknown[] = [];
  const facade = {
    allocSharedRef: (_kind: string, asset: unknown) => {
      allocations.push(asset);
      return next++ as never;
    },
    spawn: (...components: readonly unknown[]) => {
      const entity = next++ as EntityHandle;
      spawned.add(entity);
      spawns.push(components);
      return { ok: true, value: entity, unwrap: () => entity };
    },
    set: (entity: EntityHandle) => {
      sets.push(entity);
      return { ok: true, value: undefined, unwrap: () => undefined };
    },
    despawn: (entity: EntityHandle) => {
      spawned.delete(entity);
      despawned.add(entity);
      return { ok: true, value: undefined, unwrap: () => undefined };
    },
  } as unknown as EngineFacade;
  return { facade, spawned, despawned, sets, spawns, allocations };
}

function sceneWithMesh(submeshCount = 1): { world: World; entity: EntityHandle } {
  const world = new World();
  const material = world.allocSharedRef('MaterialAsset', Materials.unlit([0.5, 0.5, 0.5, 1]));
  const base = resolveAssetHandle<MeshAsset>(world, HANDLE_CUBE).unwrap();
  const mesh = submeshCount === 1
    ? HANDLE_CUBE
    : world.allocSharedRef('MeshAsset', {
      ...base,
      submeshes: Array.from({ length: submeshCount }, () => base.submeshes[0]!),
    });
  const entity = world.spawn(
    { component: Transform, data: { pos: [1, 2, 3] } },
    { component: MeshFilter, data: { assetHandle: mesh } },
    { component: MeshRenderer, data: { materials: [material] } },
  ).unwrap();
  return { world, entity };
}

describe('createSelectionStencilOutlinePool', () => {
  it('creates and removes writer/shell ghosts without mutating the scene world', () => {
    const { world, entity } = sceneWithMesh();
    const fake = fakeEditorFacade();
    let selected = new Set<EntityHandle>([entity]);
    const pool = createSelectionStencilOutlinePool({
      sceneWorld: () => world,
      editorEngine: fake.facade,
      getSelectionList: () => selected,
      getRenderableHandles: () => [entity],
      isAuxVisible: () => true,
      isEditMode: () => true,
    });

    pool.update();
    expect(fake.spawned).toHaveLength(2);
    expect(fake.sets).toHaveLength(2);
    const materialAssets = fake.allocations.filter(
      (asset): asset is { passes: Array<{ renderState?: Record<string, unknown> }> } =>
        typeof asset === 'object' && asset !== null && 'passes' in asset,
    );
    expect(materialAssets).toHaveLength(2);
    expect(materialAssets[0]!.passes[0]!.renderState?.stencilReference).toBe(1);
    expect(materialAssets[1]!.passes[0]!.renderState?.stencilReference).toBe(1);
    expect(world.get(entity, Transform).ok).toBe(true);

    selected = new Set<EntityHandle>();
    pool.update();
    expect(fake.spawned).toHaveLength(0);
    expect(fake.despawned).toHaveLength(2);
    pool.dispose();
  });

  it('copies the material slot for every submesh', () => {
    const { world, entity } = sceneWithMesh(2);
    const fake = fakeEditorFacade();
    const pool = createSelectionStencilOutlinePool({
      sceneWorld: () => world,
      editorEngine: fake.facade,
      getSelectionList: () => new Set<EntityHandle>([entity]),
      getRenderableHandles: () => [entity],
      isAuxVisible: () => true,
      isEditMode: () => true,
    });

    pool.update();
    for (const components of fake.spawns) {
      const renderer = components.find(
        (component): component is { component: { name?: string }; data: { materials?: unknown[] } } =>
          typeof component === 'object' && component !== null
          && 'data' in component
          && Array.isArray((component as { data?: { materials?: unknown[] } }).data?.materials),
      );
      expect(renderer?.data.materials).toHaveLength(2);
    }
    pool.dispose();
  });

  it('projects selection of a parent onto its renderable child', () => {
    const world = new World();
    const material = world.allocSharedRef('MaterialAsset', Materials.unlit([0.5, 0.5, 0.5, 1]));
    const root = world.spawn({ component: Transform, data: {} }).unwrap();
    const child = world.spawn(
      { component: Transform, data: { pos: [1, 0, 0] } },
      { component: ChildOf, data: { parent: root } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
    ).unwrap();
    const fake = fakeEditorFacade();
    const pool = createSelectionStencilOutlinePool({
      sceneWorld: () => world,
      editorEngine: fake.facade,
      getSelectionList: () => new Set<EntityHandle>([root]),
      getRenderableHandles: () => [child],
      isAuxVisible: () => true,
      isEditMode: () => true,
    });

    pool.update();
    expect(fake.spawned).toHaveLength(2);
    pool.dispose();
  });
});
