// destroy-material-roundtrip.test.ts — locks the destroyEntity undo material-
// loss bug fix. The same class of bug as duplicateEntity: the old applyDestroy-
// Entity inverse used spawnEntity + a hardcoded component subset (Transform /
// ChildOf / MeshFilter / EditorHidden / Name), dropping MeshRenderer. The fix
// routes the inverse through instantiateSceneAsset (GUID round-trip) so undo
// faithfully restores materials and the child subtree. These tests assert:
//   1. delete + undo restores a mesh entity with NON-EMPTY MeshRenderer.materials
//   2. delete + undo preserves the child subtree
//   3. two consecutive delete-undo cycles keep materials (idempotent)
//   4. deleteManyCascade + undo restores all roots with materials
//   5. legacy fallback (no _asset) still works (names survive)

import { describe, it, expect, beforeEach } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { ShaderRegistryDevice } from '@forgeax/engine-shader';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { MaterialAsset } from '@forgeax/engine-types';
import {
  ChildOf,
  MeshFilter,
  MeshRenderer,
  Name,
  Transform,
} from '@forgeax/engine-runtime';
import type { Handle } from '@forgeax/engine-runtime';
import type { EntityHandle } from '../scene/scene-types';
import { createEditSession, childrenOf, applyCommand } from '../session/document';
import { gateway } from '../store/store';
import { deleteEntityCascade, deleteManyCascade } from '../session/ops';
import { entName } from '../store/entity-state';
import type { EditSession } from '../types';

// ── Registry / material setup (shared with duplicate-material-roundtrip) ────

function makeMockShaderRegistry(): ShaderRegistry {
  const mockDevice: ShaderRegistryDevice = {
    createShaderModule() {
      return {
        ok: true,
        value: undefined,
        unwrap: () => undefined,
        unwrapOr: (d: unknown) => d,
      } as unknown as ReturnType<ShaderRegistryDevice['createShaderModule']>;
    },
  };
  const sr = new ShaderRegistry({ device: mockDevice, manifestUrl: undefined });
  sr.registerMaterialShader('test::dummy', { source: 'fn main() {}', paramSchema: [] });
  return sr;
}

const MATERIAL_GUID = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';
const MATERIAL_GUID_2 = 'a1b2c3d4-5678-9012-3456-789abcdef012';

function makeMaterial(): MaterialAsset {
  return {
    kind: 'material',
    passes: [{ name: 'forward', shader: 'test::dummy', tags: { LightMode: 'Forward' } }],
    paramValues: {},
  };
}

function setupSessionWithMeshEntity(): { session: EditSession; ball: EntityHandle } {
  const registry = new AssetRegistry(makeMockShaderRegistry());
  const world = new World();

  const mat = makeMaterial();
  const g = AssetGuid.parse(MATERIAL_GUID);
  if (!g.ok) throw new Error('bad test GUID');
  const cat = registry.catalog(g.value, mat);
  if (!cat.ok) throw new Error(`material catalog failed: ${JSON.stringify(cat.error)}`);
  const matHandle = world.allocSharedRef('MaterialAsset', mat);

  const session = createEditSession();
  session.world = world as unknown as EditSession['world'];
  session.registry = registry;

  const r = world.spawn(
    { component: Name, data: { value: 'BouncyBall' } },
    { component: Transform, data: { pos: [1, 2, 3] } },
    { component: MeshFilter, data: {} },
    { component: MeshRenderer, data: { materials: [matHandle as unknown as Handle<'MaterialAsset', 'shared'>] } },
  );
  if (!r.ok) throw new Error(`spawn failed: ${r.error.message}`);
  return { session, ball: r.value };
}

function materialCount(world: World, e: EntityHandle): number {
  const mr = world.get(e, MeshRenderer);
  if (!mr.ok) return 0;
  const mats = (mr.value as unknown as { materials?: ArrayLike<number> }).materials;
  return mats ? mats.length : 0;
}

function roots(): EntityHandle[] {
  return childrenOf(gateway.activeWorld, null);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('destroyEntity undo material round-trip (bug lock)', () => {
  let ball: EntityHandle;

  beforeEach(() => {
    const s = setupSessionWithMeshEntity();
    ball = s.ball;
    gateway.replaceDoc(s.session);
  });

  it('delete + undo restores a mesh entity with NON-EMPTY MeshRenderer.materials', () => {
    const world = gateway.activeWorld as unknown as World;
    expect(materialCount(world, ball)).toBe(1);
    expect(roots().length).toBe(1);

    deleteEntityCascade(ball);

    expect(roots().length).toBe(0);

    const undone = gateway.undo();
    expect(undone).toBe(true);

    const rs = roots();
    expect(rs.length).toBe(1);
    const restored = rs[0]!;
    expect(entName(gateway.activeWorld, restored)).toBe('BouncyBall');
    expect(materialCount(world, restored)).toBe(1);
  });

  it('delete + undo preserves the child subtree', () => {
    const world = gateway.activeWorld as unknown as World;
    // Child without its own material — matching the duplicate-material-roundtrip
    // test pattern (subtree preservation is the assertion target, not child mats).
    const cr = world.spawn(
      { component: Name, data: { value: 'ChildNode' } },
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: ChildOf, data: { parent: ball } },
    );
    if (!cr.ok) throw new Error('child spawn failed');

    deleteEntityCascade(ball);
    expect(roots().length).toBe(0);

    gateway.undo();

    const rs = roots();
    expect(rs.length).toBe(1);
    const restored = rs[0]!;
    expect(entName(gateway.activeWorld, restored)).toBe('BouncyBall');
    expect(materialCount(world, restored)).toBe(1);
    const kids = childrenOf(gateway.activeWorld, restored);
    expect(kids.length).toBe(1);
    expect(entName(gateway.activeWorld, kids[0]!)).toBe('ChildNode');
  });

  it('undo is idempotent: two consecutive delete-undo cycles keep materials', () => {
    const world = gateway.activeWorld as unknown as World;
    expect(materialCount(world, ball)).toBe(1);

    // First cycle: delete + undo
    deleteEntityCascade(ball);
    expect(roots().length).toBe(0);

    gateway.undo();
    let rs = roots();
    expect(rs.length).toBe(1);
    expect(materialCount(world, rs[0]!)).toBe(1);

    // Second cycle: delete the restored entity + undo again
    const restored = rs[0]!;
    deleteEntityCascade(restored);
    expect(roots().length).toBe(0);

    gateway.undo();
    rs = roots();
    expect(rs.length).toBe(1);
    expect(materialCount(world, rs[0]!)).toBe(1);
  });

  it('deleteManyCascade + undo restores all roots with materials', () => {
    const world = gateway.activeWorld as unknown as World;
    const session = gateway.doc as unknown as EditSession;
    // Catalog + alloc a second material so rootsToSceneAsset can reverse-lookup its GUID.
    const mat2 = makeMaterial();
    const g2 = AssetGuid.parse(MATERIAL_GUID_2);
    if (!g2.ok) throw new Error('bad test GUID 2');
    const cat2 = session.registry!.catalog(g2.value, mat2);
    if (!cat2.ok) throw new Error(`material 2 catalog failed: ${JSON.stringify(cat2.error)}`);
    const matHandle2 = world.allocSharedRef('MaterialAsset', mat2);
    const r2 = world.spawn(
      { component: Name, data: { value: 'Cube' } },
      { component: Transform, data: { pos: [4, 5, 6] } },
      { component: MeshFilter, data: {} },
      { component: MeshRenderer, data: { materials: [matHandle2 as unknown as Handle<'MaterialAsset', 'shared'>] } },
    );
    if (!r2.ok) throw new Error('spawn failed');
    const cube = r2.value;

    expect(roots().length).toBe(2);
    expect(materialCount(world, ball)).toBe(1);
    expect(materialCount(world, cube)).toBe(1);

    deleteManyCascade([ball, cube]);
    expect(roots().length).toBe(0);

    gateway.undo();

    const rs = roots();
    expect(rs.length).toBe(2);
    for (const e of rs) {
      expect(materialCount(world, e)).toBe(1);
    }
  });

  it('legacy fallback (no _asset, direct applyCommand) still restores names', () => {
    const session = gateway.doc as unknown as EditSession;
    expect(roots().length).toBe(1);

    // Bypass gateway — call applyCommand directly so _asset is never set.
    const r = applyCommand(session, { kind: 'destroyEntity', entity: ball });
    expect(r.ok).toBe(true);
    expect(roots().length).toBe(0);

    const undoR = applyCommand(session, (r as { ok: true; inverse: any }).inverse);
    expect(undoR.ok).toBe(true);

    const rs = roots();
    expect(rs.length).toBe(1);
    expect(entName(gateway.activeWorld, rs[0]!)).toBe('BouncyBall');
  });
});
