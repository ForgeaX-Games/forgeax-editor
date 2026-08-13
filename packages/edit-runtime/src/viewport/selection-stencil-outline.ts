// selection-stencil-outline — editorWorld stencil shell chrome.

import { ChildOf, Transform } from '@forgeax/engine-scene';
import { MeshFilter, MeshRenderer, Materials } from '@forgeax/engine-render';
import type { EntityHandle, Handle, World } from '@forgeax/engine-ecs';
import type { EngineFacade } from '@forgeax/editor-core';
import { resolveVisibility } from '@forgeax/editor-core';
import { mat4, vec3, quat as quatMath } from '@forgeax/engine-math';
import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { MaterialAsset, MaterialPass, MeshAsset } from '@forgeax/engine-types';
import { isEntEffectivelyHidden } from './viewport-entity-read';

const STENCIL_REFERENCE = 1;
const OUTLINE_QUEUE = 2001;
const OUTLINE_SCALE = 1.05;
const OUTLINE_COLOR: [number, number, number] = [1, 0.55, 0.05];

type RenderTarget = {
  readonly entity: EntityHandle;
  readonly mesh: Handle<'MeshAsset', 'shared'>;
  readonly material: Handle<'MaterialAsset', 'shared'>;
  readonly materialCount: number;
  readonly world: ArrayLike<number>;
};

type GhostPair = { readonly writer: EntityHandle; readonly shell: EntityHandle };

export type SelectionStencilOutlineDeps = {
  readonly sceneWorld: () => World | undefined;
  readonly editorEngine: EngineFacade;
  readonly getSelectionList: () => ReadonlySet<EntityHandle>;
  readonly getRenderableHandles: (scene: World) => readonly EntityHandle[];
  readonly isAuxVisible: () => boolean;
  readonly isEditMode: () => boolean;
};

export type SelectionStencilOutlinePool = { update(): void; dispose(): void };

export function createSelectionStencilOutlinePool(
  deps: SelectionStencilOutlineDeps,
): SelectionStencilOutlinePool {
  const ghosts = new Map<number, GhostPair>();
  const editorMeshes = new Map<number, Handle<'MeshAsset', 'shared'>>();
  let writerMaterial: Handle<'MaterialAsset', 'shared'> | null = null;
  let outlineMaterial: Handle<'MaterialAsset', 'shared'> | null = null;
  let disposed = false;

  function ensureWriterMaterial(): Handle<'MaterialAsset', 'shared'> {
    if (writerMaterial !== null) return writerMaterial;
    const base = Materials.unlit([1, 1, 1, 1], { castShadow: false }) as {
      passes?: readonly MaterialPass[];
    };
    writerMaterial = deps.editorEngine.allocSharedRef('MaterialAsset', {
      ...base,
      passes: (base.passes ?? []).map((pass) => ({
        ...pass,
        name: 'Forward',
        renderState: {
          ...(pass.renderState ?? {}),
          queue: 2000,
          depthWriteEnabled: false,
          stencilWriteMask: 0xff,
          stencil: { compare: 'always' as const, passOp: 'replace' as const },
          stencilReference: STENCIL_REFERENCE,
          tags: { LightMode: 'Forward' },
        },
      })),
    } as unknown as MaterialAsset);
    return writerMaterial;
  }

  function ensureOutlineMaterial(): Handle<'MaterialAsset', 'shared'> {
    if (outlineMaterial !== null) return outlineMaterial;
    const base = Materials.unlit([...OUTLINE_COLOR, 1], { castShadow: false }) as {
      passes?: readonly MaterialPass[];
    };
    const passes = (base.passes ?? []).map((pass) => ({
      ...pass,
      name: 'Forward',
      renderState: {
        ...(pass.renderState ?? {}),
        queue: OUTLINE_QUEUE,
        depthWriteEnabled: false,
        stencilReadMask: 0xff,
        stencil: { compare: 'not-equal' as const },
        stencilReference: STENCIL_REFERENCE,
        tags: { LightMode: 'Forward' },
      },
    }));
    outlineMaterial = deps.editorEngine.allocSharedRef('MaterialAsset', {
      ...base,
      passes,
    } as unknown as MaterialAsset);
    return outlineMaterial;
  }

  function resolveEditorMesh(
    scene: World,
    source: Handle<'MeshAsset', 'shared'>,
  ): Handle<'MeshAsset', 'shared'> | null {
    const key = source as unknown as number;
    const cached = editorMeshes.get(key);
    if (cached !== undefined) return cached;
    const resolved = resolveAssetHandle<MeshAsset>(scene, source);
    if (!resolved.ok) return null;
    const handle = deps.editorEngine.allocSharedRef('MeshAsset', resolved.value);
    editorMeshes.set(key, handle);
    return handle;
  }

  function readTarget(scene: World, entity: EntityHandle): RenderTarget | null {
    const meshResult = scene.get(entity, MeshFilter);
    const rendererResult = scene.get(entity, MeshRenderer);
    const transformResult = scene.get(entity, Transform);
    if (!meshResult.ok || !rendererResult.ok || !transformResult.ok) return null;
    const sourceMesh = (meshResult.value as { assetHandle: Handle<'MeshAsset', 'shared'> }).assetHandle;
    const mesh = resolveEditorMesh(scene, sourceMesh);
    if (mesh === null) return null;
    const world = (transformResult.value as { world?: ArrayLike<number> }).world;
    if (world === undefined || world.length < 16) return null;
    const meshAsset = resolveAssetHandle<MeshAsset>(scene, sourceMesh);
    if (!meshAsset.ok) return null;
    const materialCount = Math.max(1, meshAsset.value.submeshes?.length ?? 1);
    return { entity, mesh, material: ensureWriterMaterial(), materialCount, world };
  }

  function isDescendantOf(scene: World, entity: EntityHandle, root: EntityHandle): boolean {
    let current: EntityHandle | undefined = entity;
    const seen = new Set<number>();
    while (current !== undefined && !seen.has(current as number)) {
      if (current === root) return true;
      seen.add(current as number);
      const parent = scene.get(current, ChildOf) as
        | { ok: true; value: { parent: EntityHandle } }
        | { ok: false };
      if (!parent.ok) return false;
      current = parent.value.parent;
    }
    return false;
  }

  function targets(scene: World): RenderTarget[] {
    const selected = deps.getSelectionList();
    if (selected.size === 0) return [];
    // worldRenderableHandles intentionally includes hidden entities; the
    // outline is chrome for what is on screen, so a hidden selection must
    // not keep drawing ghosts (the scene mesh itself is already skipped by
    // the engine extract).
    const visibility = resolveVisibility(scene);
    const roots = [...selected];
    return deps.getRenderableHandles(scene)
      .filter((entity) => roots.some((root) => isDescendantOf(scene, entity, root)))
      .filter((entity) => !isEntEffectivelyHidden(scene, entity, visibility))
      .map((entity) => readTarget(scene, entity))
      .filter((target): target is RenderTarget => target !== null);
  }

  function despawn(pair: GhostPair): void {
    try { deps.editorEngine.despawn(pair.writer); } catch { /* stale chrome */ }
    try { deps.editorEngine.despawn(pair.shell); } catch { /* stale chrome */ }
  }

  function syncTransform(entity: EntityHandle, world: ArrayLike<number>, expansion: number): void {
    // Full TRS decompose: column-length scale extraction alone drops the world
    // rotation, leaving the ghost axis-aligned whenever the source is rotated.
    const pos = vec3.create();
    const rot = quatMath.create();
    const scl = vec3.create();
    mat4.decompose(pos, rot, scl, world as unknown as Parameters<typeof mat4.decompose>[3]);
    deps.editorEngine.set(entity, Transform, {
      pos: [pos[0]!, pos[1]!, pos[2]!],
      quat: [rot[0]!, rot[1]!, rot[2]!, rot[3]!],
      scale: [scl[0]! * expansion, scl[1]! * expansion, scl[2]! * expansion],
    });
  }

  function spawnGhost(
    mesh: Handle<'MeshAsset', 'shared'>,
    material: Handle<'MaterialAsset', 'shared'>,
    materialCount: number,
  ): EntityHandle {
    const result = deps.editorEngine.spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: mesh } },
      { component: MeshRenderer, data: { materials: Array(materialCount).fill(material) } },
    ) as unknown as EntityHandle | { unwrap?: () => EntityHandle };
    // EngineFacade normally returns Result<EntityHandle>, while older Studio
    // runtime adapters returned the handle directly. Support both shapes so a
    // selection change cannot take down the whole RenderSystem.
    if (typeof result === 'object' && result !== null && typeof result.unwrap === 'function') {
      return result.unwrap();
    }
    return result as EntityHandle;
  }

  function update(): void {
    if (disposed) return;
    const scene = deps.sceneWorld();
    if (!scene || !deps.isEditMode() || !deps.isAuxVisible()) {
      for (const pair of ghosts.values()) despawn(pair);
      ghosts.clear();
      return;
    }
    const next = new Map<number, RenderTarget>();
    for (const target of targets(scene)) next.set(target.entity as number, target);
    for (const [key, pair] of ghosts) {
      if (!next.has(key)) {
        despawn(pair);
        ghosts.delete(key);
      }
    }
    const shellMaterial = ensureOutlineMaterial();
    for (const [key, target] of next) {
      let pair = ghosts.get(key);
      if (pair === undefined) {
        pair = {
          writer: spawnGhost(target.mesh, target.material, target.materialCount),
          shell: spawnGhost(target.mesh, shellMaterial, target.materialCount),
        };
        ghosts.set(key, pair);
      }
      syncTransform(pair.writer, target.world, 1);
      syncTransform(pair.shell, target.world, OUTLINE_SCALE);
    }
  }

  return {
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const pair of ghosts.values()) despawn(pair);
      ghosts.clear();
    },
  };
}
