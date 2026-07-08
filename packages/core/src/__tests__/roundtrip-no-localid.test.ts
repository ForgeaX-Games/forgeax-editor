// w26 — M3 integration: round-trip + AC-14 stale-handle + AC-09 hierarchy-live
//
// feat-20260707-editor-world-fork M3 boundary integration (headless). Weaves the
// three M3 acceptance strands into one end-to-end story on a gateway + worlds:
//   (a) AC-03 round-trip: save (rootsToSceneAsset -> serialize) -> reload
//       (instantiateScene) with no localId namespace held by the editor;
//   (b) AC-14 stale-entity-handle: a handle captured in play mode, accessed after
//       stop, yields a structured stale-entity-handle error (not silent undefined);
//   (c) AC-09 hierarchy-live: a runtime-spawned play entity appears in the
//       activeWorld hierarchy walk while playing.
//
// Distinct from w27 (unit round-trip): this drives the gateway enterPlay/exitPlay
// lifecycle + the stale-handle read face together.
//
// Constraints from upstream:
//   requirements AC-03: round-trip, editor holds no localId state
//   requirements AC-14: stale handle explicit structured error
//   requirements AC-09: play-mode hierarchy walks playWorld
//   plan-strategy §5.2 / §7 M3 boundary: round-trip + AC-03/09/14 regression
//
// Anchors:
//   plan-tasks.json w26

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import {
  AssetRegistry,
  Name,
  Transform,
  ChildOf,
  rootsToSceneAsset,
} from '@forgeax/engine-runtime';
import type { SceneEntity, LocalEntityId } from '@forgeax/engine-types';
import type { ShaderRegistryDevice } from '@forgeax/engine-shader';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { EntityHandle } from '../scene/scene-types';
import { EditGateway } from '../io/gateway';
import { createEditSession, childrenOf } from '../session/document';
import { entComponent, entName, worldEntityHandles } from '../store/entity-state';

function makeMockShaderRegistry(): ShaderRegistry {
  const mockDevice: ShaderRegistryDevice = {
    createShaderModule() {
      return { ok: true, value: undefined, unwrap: () => undefined, unwrapOr: (d: unknown) => d } as unknown as ReturnType<ShaderRegistryDevice['createShaderModule']>;
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
function spawn(world: World, name: string, parent?: EntityHandle): EntityHandle {
  const comps: Array<{ component: unknown; data: Record<string, unknown> }> = [
    { component: Name, data: { value: name } },
    { component: Transform, data: { posX: 0, posY: 0, posZ: 0, quatX: 0, quatY: 0, quatZ: 0, quatW: 1, scaleX: 1, scaleY: 1, scaleZ: 1 } },
  ];
  if (parent !== undefined) comps.push({ component: ChildOf, data: { parent } });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = world.spawn(...(comps as any));
  if (!r.ok) throw new Error(`spawn failed: ${String(r.error)}`);
  return r.value as EntityHandle;
}

describe('w26 — M3 integration (round-trip / stale-handle / hierarchy-live)', () => {
  // ── (a) AC-03 round-trip, editor holds no localId ────────────────────────
  it('(a) AC-03: round-trip preserves content; editor session has no id namespace', () => {
    const registry = makeRegistry();
    const worldA = new World();
    const asset = buildSceneAsset([
      { name: 'Ground', pos: { x: 0, y: 0, z: 0 } },
      { name: 'Prop', pos: { x: 5, y: 0, z: -2 } },
    ]);
    const hA = worldA.allocSharedRef('SceneAsset', asset);
    const rA = worldA.instantiateScene(hA);
    expect(rA.ok).toBe(true);
    if (!rA.ok) return;

    const guid = 'bbbbbbbb-cccc-4ddd-eeee-000000000010';
    registry.catalog(guid, asset, []);
    const saved = rootsToSceneAsset(registry, worldA, [rA.value.root]);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const worldB = new World();
    const rB = worldB.instantiateScene(worldB.allocSharedRef('SceneAsset', saved.value));
    expect(rB.ok).toBe(true);

    // Editor session bound to the reloaded world carries no internal id bag.
    const session = createEditSession();
    session.world = worldB;
    expect(Object.getOwnPropertySymbols(session).length).toBe(0);
    const names = worldEntityHandles(worldB)
      .map((h) => entName(worldB, h))
      .filter((n) => n === 'Ground' || n === 'Prop')
      .sort();
    expect(names).toEqual(['Ground', 'Prop']);
  });

  // ── (b) AC-14 stale-entity-handle after play/stop ────────────────────────
  it('(b) AC-14: a play-mode handle accessed after stop yields stale-entity-handle', () => {
    const session = createEditSession();
    const editWorld = new World();
    session.world = editWorld;
    spawn(editWorld, 'EditOnly'); // occupies edit slot 0 / gen 0
    const gw = new EditGateway(session);

    // Enter play with a fresh playWorld. Engine handles are per-world and both
    // first spawns would be slot 0 / gen 0 — a collision that would mask the
    // stale check. Bump the play entity's generation (despawn a throwaway slot-0
    // entity, then spawn) so its handle (slot 0 / gen 1) is a value the gen-0-only
    // editWorld never contains — making the post-stop staleness unambiguous.
    const playWorld = new World();
    const throwaway = spawn(playWorld, 'Throwaway');
    playWorld.despawn(throwaway);
    const playEnt = spawn(playWorld, 'RuntimeThing');
    expect(playEnt).not.toBe(throwaway); // generation bumped
    gw.enterPlay(playWorld);
    // While playing the handle resolves in the active (play) world.
    const live = entComponent(gw.activeWorld, playEnt, 'Transform');
    expect(live.ok).toBe(true);

    // Stop → activeWorld returns to editWorld; the play handle is now stale there.
    gw.exitPlay();
    const stale = entComponent(gw.activeWorld, playEnt, 'Transform');
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      // Explicit, structured signal — not silent undefined (charter P3 / AC-14).
      expect(stale.error.code).toBe('stale-entity-handle');
      expect(typeof stale.error.hint).toBe('string');
      expect(stale.error.hint.length).toBeGreaterThan(0);
      expect(stale.error.entity).toBe(playEnt);
    }
  });

  // ── (c) AC-09 hierarchy-live: runtime spawn appears in the walk ──────────
  it('(c) AC-09: a runtime-spawned entity appears in the play-mode hierarchy walk', () => {
    const session = createEditSession();
    session.world = new World();
    spawn(session.world as unknown as World, 'EditRoot');
    const gw = new EditGateway(session);

    const playWorld = new World();
    const playRoot = spawn(playWorld, 'PlayRoot');
    gw.enterPlay(playWorld);

    // Runtime spawns a NEW entity mid-play (e.g. a game system) — it appears.
    const runtimeSpawn = spawn(playWorld, 'Bullet', playRoot);
    const kids = childrenOf(gw.activeWorld, playRoot);
    expect(kids).toContain(runtimeSpawn);
    expect(entName(gw.activeWorld, runtimeSpawn)).toBe('Bullet');
  });
});
