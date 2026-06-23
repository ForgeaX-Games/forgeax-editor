// template-game-default-api-contract.test - the surface APIs that the
// `templates/game-default/main.ts` `instantiateScenePack` helper relies on
// must continue to exist and compose. Catches the API drift that produced
// `TypeError: Cannot read properties of undefined (reading
// 'setSceneAssetResolver')` at runtime when an earlier
// `world.sceneInstances.setSceneAssetResolver(...)` call survived a refactor
// that moved the resolver onto World itself + made `assets.instantiate`
// return the synthetic root Entity directly.
//
// Coverage (red-then-green tickets bundled into one file):
//   (a) `assets.instantiate(handle, world)` exists and returns a
//       Result<Entity>; when the handle is registered via
//       `assets.registerWithGuid<SceneAsset>(...)`, the call resolves
//       handle-typed component fields automatically (no caller-side
//       `setSceneAssetResolver` wiring required for in-registry handles).
//   (b) the synthetic root carries the `SceneInstance` component, whose
//       `mapping` Uint32Array is indexed by `localId` and yields the live
//       Entity for each authored node — the lookup the template's
//       `attachScenePhysics` / `setupPlayerRoot` walks per node.
//   (c) `world.sceneInstances` is NOT a thing on the current API
//       surface (placeholder anti-regression: the runtime exposes the
//       resolver via `world._setSceneAssetResolver` — already auto-wired
//       inside `assets.instantiate` for in-registry handles — and the
//       returned `instRes.value` is the synthetic root Entity, not an id
//       to look up via a non-existent `byRef`).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import type {
  Handle,
  LocalEntityId,
  MaterialAsset,
  SceneAsset,
  SceneEntity,
} from '@forgeax/engine-types';
import { unwrapHandle } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { AssetRegistry } from '../asset-registry';
// Importing the runtime components barrel populates the global component
// table consulted by `World._buildSceneEntityComponentDatas` — without
// these named bindings, Transform / MeshRenderer / ChildOf resolve to
// undefined during instantiate. ChildOf + SceneInstance are used directly
// below as values; Transform / MeshRenderer pin the side-effect import.
import { ChildOf, MeshRenderer, SceneInstance, Transform } from '../components';
import { createDefaultLoaderRegistry } from '../wire-default-loaders';
import { makeMockShaderRegistry } from './helpers/mock-shader-registry';

function lid(n: number): LocalEntityId {
  return n as LocalEntityId;
}

// Shape this fixture mirrors the `templates/game-default/scene.pack.json`
// SceneAsset payload after the template's `instantiateScenePack` helper has
// rewritten ref-int → GUID strings + lifted MeshRenderer.material → materials[].
// We register one MaterialAsset so the SceneAsset's MeshRenderer GUID slot
// resolves through the registry's two-phase parse.
const MAT_GUID = '00000000-0000-5000-8000-000000000001';
const SCENE_GUID = '00000000-0000-5000-8000-0000000000aa';

function buildSceneAssetWithGuidRef(): SceneAsset {
  // Touch the bindings so noUnusedLocals doesn't strip the import (which
  // would also strip its component-table side effect).
  void Transform;
  void MeshRenderer;

  const nodes: SceneEntity[] = [
    {
      localId: lid(0),
      components: {
        Transform: { posX: 0 },
        // GUID string (post template ref-int → GUID rewrite). The registry's
        // `_resolveSceneGuids` lifts this to a `Handle<MaterialAsset>` at
        // instantiate time.
        MeshRenderer: { materials: [MAT_GUID] },
      },
    },
    {
      localId: lid(1),
      components: {
        Transform: { posX: 1 },
        ChildOf: { parent: 0 as unknown as EntityHandle },
      },
    },
  ];
  return { kind: 'scene', entities: nodes };
}

describe('templates/game-default API contract (regression for `world.sceneInstances` drift)', () => {
  it('(a) assets.instantiate returns the synthetic root Entity directly (no `byRef` indirection)', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry(), createDefaultLoaderRegistry());
    const world = new World();

    const matGuid = AssetGuid.parse(MAT_GUID);
    expect(matGuid.ok).toBe(true);
    if (!matGuid.ok) return;
    const mat: MaterialAsset = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          shader: 'forgeax::default-unlit',
          tags: { LightMode: 'Forward' },
          queue: 2000,
        },
      ],
      paramValues: { baseColor: [1, 1, 1, 1] as [number, number, number, number] },
    };
    reg.registerWithGuid<MaterialAsset>(matGuid.value, mat);

    const sceneGuid = AssetGuid.parse(SCENE_GUID);
    expect(sceneGuid.ok).toBe(true);
    if (!sceneGuid.ok) return;
    reg.registerWithGuid<SceneAsset>(sceneGuid.value, buildSceneAssetWithGuidRef());

    const handleRes = await reg.loadByGuid<SceneAsset>(sceneGuid.value);
    expect(handleRes.ok).toBe(true);
    if (!handleRes.ok) return;

    // The template uses precisely this 2-line shape; both must compile +
    // succeed without touching a `world.sceneInstances` surface.
    const instRes = reg.instantiate<SceneAsset>(handleRes.value, world);
    expect(instRes.ok).toBe(true);
    if (!instRes.ok) return;
    // `instRes.value` is an Entity (the synthetic SceneInstance root), not
    // an id needing a separate lookup.
    const root: EntityHandle = instRes.value;
    expect(typeof root).toBe('number');
  });

  it('(b) the synthetic root carries SceneInstance.mapping[localId] = Entity (per-node lookup the template walks)', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry(), createDefaultLoaderRegistry());
    const world = new World();

    const matGuid = AssetGuid.parse(MAT_GUID);
    if (!matGuid.ok) throw new Error('parse');
    const mat: MaterialAsset = {
      kind: 'material',
      passes: [
        {
          name: 'Forward',
          shader: 'forgeax::default-unlit',
          tags: { LightMode: 'Forward' },
          queue: 2000,
        },
      ],
      paramValues: { baseColor: [1, 1, 1, 1] as [number, number, number, number] },
    };
    reg.registerWithGuid<MaterialAsset>(matGuid.value, mat);

    const sceneGuid = AssetGuid.parse(SCENE_GUID);
    if (!sceneGuid.ok) throw new Error('parse');
    reg.registerWithGuid<SceneAsset>(sceneGuid.value, buildSceneAssetWithGuidRef());

    const handleRes = await reg.loadByGuid<SceneAsset>(sceneGuid.value);
    if (!handleRes.ok) throw new Error('load');
    const instRes = reg.instantiate<SceneAsset>(handleRes.value, world);
    if (!instRes.ok) throw new Error('inst');
    const root = instRes.value;

    const inst = world.get(root, SceneInstance);
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;

    // mapping is positional: mapping[localId] = packed Entity u32
    const mapping = inst.value.mapping as unknown as ArrayLike<number>;
    expect(mapping.length).toBeGreaterThanOrEqual(2);
    const node0 = mapping[0];
    const node1 = mapping[1];
    expect(node0).toBeDefined();
    expect(node1).toBeDefined();
    if (node0 === undefined || node1 === undefined) return;
    expect(node0).not.toBe(node1);

    // The two member entities both ChildOf the synthetic root (template
    // walks Children to find PlayerTorso/Head/etc).
    const child0 = world.get(node0 as EntityHandle, ChildOf);
    const child1 = world.get(node1 as EntityHandle, ChildOf);
    // node 1 explicitly authored ChildOf{parent:0}; that resolves to node 0.
    expect(child1.ok).toBe(true);
    if (child1.ok) {
      expect(child1.value.parent as unknown as number).toBe(node0);
    }
    // node 0 has no authored ChildOf but the synthetic root attaches one
    // pointing at root for tree-walking.
    expect(child0.ok).toBe(true);
    if (child0.ok) {
      expect(child0.value.parent as unknown as number).toBe(root as unknown as number);
    }
  });

  it('(c) world has no `sceneInstances` member; resolver wiring lives on world._setSceneAssetResolver', () => {
    const world = new World();
    expect((world as unknown as { sceneInstances?: unknown }).sceneInstances).toBeUndefined();
    // Guard the rename: the API the template MUST migrate to.
    expect(
      typeof (world as unknown as { _setSceneAssetResolver?: unknown })._setSceneAssetResolver,
    ).toBe('function');
  });

  // The template main.ts source file must consume the current API. Catches
  // the literal regression we hit at runtime: `world.sceneInstances.
  // setSceneAssetResolver(...)` survived a refactor that removed
  // `world.sceneInstances`. Lint the file statically so a TS compile
  // doesn't pass while runtime explodes (the template is a workspace
  // sibling that the engine packages don't import — typecheck never sees
  // it).
  it('(c2) [regression] templates/game-default/main.ts must not call `world.sceneInstances`', () => {
    const here = fileURLToPath(import.meta.url);
    // here = packages/runtime/src/__tests__/<file> → 4 levels up = repo root
    const repoRoot = resolve(here, '..', '..', '..', '..', '..');
    const main = readFileSync(resolve(repoRoot, 'templates', 'game-default', 'main.ts'), 'utf-8');
    // Strip line comments so prose explaining the rename does not trip the
    // grep gate; the gate targets actual member access only.
    const noComments = main
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    // No member access on the removed container surface (e.g.
    // `world.sceneInstances.setSceneAssetResolver(...)` /
    // `world.sceneInstances.byRef(id)`).
    expect(noComments).not.toMatch(/\.sceneInstances\b/);
    // And no `byRef`, the indirection that came with it.
    expect(noComments).not.toMatch(/\.byRef\(/);
  });

  it('(d) handle returned by registerWithGuid + loadByGuid round-trips to the same numeric id', async () => {
    const reg = new AssetRegistry(makeMockShaderRegistry(), createDefaultLoaderRegistry());
    const sceneGuid = AssetGuid.parse(SCENE_GUID);
    if (!sceneGuid.ok) throw new Error('parse');
    const handleA = reg.registerWithGuid<SceneAsset>(sceneGuid.value, {
      kind: 'scene',
      entities: [],
    });
    const handleB = await reg.loadByGuid<SceneAsset>(sceneGuid.value);
    expect(handleB.ok).toBe(true);
    if (!handleB.ok) return;
    expect(unwrapHandle(handleB.value as Handle<'SceneAsset', 'unmanaged'>)).toBe(
      unwrapHandle(handleA),
    );
  });
});
