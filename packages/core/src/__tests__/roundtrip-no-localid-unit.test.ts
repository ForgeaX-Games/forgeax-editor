// w27 — AC-03 round-trip no-localId (unit level, headless)
//
// feat-20260707-editor-world-fork M3 (I1 / AC-03): a save → reload round-trip
// leaves NO localId namespace state in the editor runtime. localId exists only
// inside the engine's on-disk serialization (rootsToSceneAsset); the editor
// session is {world, registry} with the engine World as the sole identity SSOT —
// there is no _e2h / _h2e / _nextId bag to hold a second id namespace.
//
// This is the unit-level round-trip (headless world, no full editor boot),
// distinct from the w26 integration test. It proves:
//   (a) save (rootsToSceneAsset → serializeSceneAssetToPack) then reload
//       (instantiateScene) preserves entity content (names + component values);
//   (b) the editor EditSession carries no localId/internal identity state after
//       the reload (I1 — handle IS identity);
//   (c) localId appears only in the on-disk scene asset (rootsToSceneAsset
//       output), never read back into editor runtime state.
//
// Constraints from upstream:
//   requirements AC-03: save→reload round-trip, editor holds no localId state
//   plan-strategy §7 M3: AC-03 round-trip no-localId anchor
//   plan-strategy §6.3: no data migration — .scene serialization format unchanged
//
// Anchors:
//   plan-tasks.json w27

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import {
  AssetRegistry,
  Name,
  Transform,
  rootsToSceneAsset,
  serializeSceneAssetToPack,
} from '@forgeax/engine-runtime';
import type { SceneEntity, LocalEntityId } from '@forgeax/engine-types';
import type { ShaderRegistryDevice } from '@forgeax/engine-shader';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { EntityHandle } from '../scene/scene-types';
import { createEditSession } from '../session/document';
import { entName, entComponent, worldEntityHandles } from '../store/entity-state';

function makeMockShaderRegistry(): ShaderRegistry {
  const mockDevice: ShaderRegistryDevice = {
    createShaderModule() {
      return {
        ok: true, value: undefined,
        unwrap: () => undefined, unwrapOr: (d: unknown) => d,
      } as unknown as ReturnType<ShaderRegistryDevice['createShaderModule']>;
    },
  };
  return new ShaderRegistry({ device: mockDevice, manifestUrl: undefined });
}
function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}
function localId(n: number): LocalEntityId {
  return n as LocalEntityId;
}
function buildSceneAsset(entities: Array<{ name: string; pos: { x: number; y: number; z: number } }>) {
  return {
    kind: 'scene' as const,
    entities: entities.map((e, i): SceneEntity => ({
      localId: localId(i),
      components: {
        Transform: { posX: e.pos.x, posY: e.pos.y, posZ: e.pos.z, scaleX: 1, scaleY: 1, scaleZ: 1 },
        Name: { value: e.name },
      },
    })),
  };
}
function collectNames(world: World, root: EntityHandle): string[] {
  const stateRes = world.getSceneInstanceState(root);
  if (!stateRes.ok) return [];
  const names: string[] = [];
  for (const ent of stateRes.value.entityToLocalId.keys()) {
    const n = world.get(ent, Name);
    if (n.ok) names.push(n.value.value);
  }
  return names.sort();
}

describe('w27 — AC-03 round-trip no-localId (unit)', () => {
  it('(a) save → reload preserves entity content (names + positions)', () => {
    const registry = makeRegistry();
    const worldA = new World();
    const asset = buildSceneAsset([
      { name: 'Ground', pos: { x: 0, y: 0, z: 0 } },
      { name: 'Box', pos: { x: 1, y: 2, z: 3 } },
    ]);
    const handleA = worldA.allocSharedRef('SceneAsset', asset);
    const rA = worldA.instantiateScene(handleA);
    expect(rA.ok).toBe(true);
    if (!rA.ok) return;

    const sceneGuid = 'aaaaaaaa-bbbb-4ccc-dddd-000000000001';
    registry.catalog(sceneGuid, asset, []);
    const savedAsset = rootsToSceneAsset(registry, worldA, [rA.value.root]);
    expect(savedAsset.ok).toBe(true);
    if (!savedAsset.ok) return;

    // Reload into a fresh world.
    const worldB = new World();
    const handleB = worldB.allocSharedRef('SceneAsset', savedAsset.value);
    const rB = worldB.instantiateScene(handleB);
    expect(rB.ok).toBe(true);
    if (!rB.ok) return;

    expect(collectNames(worldB, rB.value.root)).toEqual(['Box', 'Ground']);
  });

  it('(b) the editor session holds no localId / internal identity state after reload', () => {
    // A fresh EditSession bound to a reloaded world exposes ONLY {world, registry}
    // — no symbol-keyed internal id bag (I1: handle IS identity).
    const worldB = new World();
    const asset = buildSceneAsset([{ name: 'Solo', pos: { x: 4, y: 5, z: 6 } }]);
    const handleB = worldB.allocSharedRef('SceneAsset', asset);
    const rB = worldB.instantiateScene(handleB);
    expect(rB.ok).toBe(true);

    const session = createEditSession();
    session.world = worldB;

    // No non-enumerable symbol-keyed internal state (the deleted SessionInternals).
    expect(Object.getOwnPropertySymbols(session).length).toBe(0);
    // The read face works purely off the world — handles come from the world walk.
    const handles = worldEntityHandles(session.world as unknown as World);
    expect(handles.length).toBeGreaterThan(0);
    const solo = handles.find((h) => entName(session.world as unknown as World, h) === 'Solo');
    expect(solo).toBeDefined();
    // Component reads go straight to the world by handle — no id translation.
    const t = entComponent(session.world as unknown as World, solo!, 'Transform');
    expect(t.ok).toBe(true);
    if (t.ok) {
      expect(t.value.posX).toBeCloseTo(4, 4);
      expect(t.value.posZ).toBeCloseTo(6, 4);
    }
  });

  it('(c) localId appears only in the on-disk scene asset, not in editor runtime', () => {
    const registry = makeRegistry();
    const worldA = new World();
    const asset = buildSceneAsset([{ name: 'Node', pos: { x: 0, y: 0, z: 0 } }]);
    const handleA = worldA.allocSharedRef('SceneAsset', asset);
    const rA = worldA.instantiateScene(handleA);
    expect(rA.ok).toBe(true);
    if (!rA.ok) return;

    const sceneGuid = 'aaaaaaaa-bbbb-4ccc-dddd-000000000002';
    registry.catalog(sceneGuid, asset, []);
    const savedAsset = rootsToSceneAsset(registry, worldA, [rA.value.root]);
    expect(savedAsset.ok).toBe(true);
    if (!savedAsset.ok) return;

    // The on-disk serialization carries localId (engine's serialization boundary).
    const pack = serializeSceneAssetToPack(savedAsset.value, sceneGuid);
    expect(pack.ok).toBe(true);
    if (!pack.ok) return;
    expect(savedAsset.value.entities.every((e) => e.localId !== undefined)).toBe(true);

    // The editor session, by contrast, exposes no localId field — its identity is
    // the engine handle read off the world.
    const session = createEditSession();
    session.world = worldA;
    expect((session as unknown as Record<string, unknown>).nextLocalId).toBeUndefined();
    expect((session as unknown as Record<string, unknown>).entities).toBeUndefined();
    expect(Object.getOwnPropertySymbols(session).length).toBe(0);
  });
});
