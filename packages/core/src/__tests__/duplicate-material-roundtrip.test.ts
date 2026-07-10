// duplicate-material-roundtrip.test.ts — locks the duplicateEntity + clipboard
// copy/paste material-loss bug fix (HANDOFF-duplicateEntity-material-fix.md).
//
// The bug: duplicateEntity (Ctrl+D) and clipboard paste copied an entity via the
// entComponents → spawnComponentData path, which dropped the source MeshRenderer
// (BASELINE_NAMES skip + empty-fallback suppressed because extraComponents already
// carried a MeshRenderer). The copy landed in the [Entity,MeshFilter,Name,
// Transform] archetype — no MeshRenderer → invisible, non-rendering.
//
// The fix routes BOTH paths through the engine scene-asset round-trip
// (rootsToSceneAsset collect → EngineFacade.instantiateSceneAssetFlat →
// registry.instantiateFlat), so materials round-trip by GUID and the child
// subtree survives. These tests assert:
//   1. a duplicated mesh entity has a NON-EMPTY MeshRenderer.materials (bug lock)
//   2. the child subtree is preserved (old single-entity duplicate dropped it)
//   3. one undo removes the whole duplicate
//   4. clipboard copy → paste reproduces the material + preserves hierarchy

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
import { createEditSession, childrenOf } from '../session/document';
import { gateway } from '../store/store';
import { duplicateEntity, copySelected, pasteClipboard } from '../session/ops';
import { entName } from '../store/entity-state';
import type { EditSession } from '../types';

// ── Registry / material setup ───────────────────────────────────────────────

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
  // catalog(material) validates each pass's shader against the registry; register
  // the shader the test material references so catalog() succeeds.
  sr.registerMaterialShader('test::dummy', { source: 'fn main() {}', paramSchema: [] });
  return sr;
}

const MATERIAL_GUID = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';

function makeMaterial(): MaterialAsset {
  return {
    kind: 'material',
    passes: [{ name: 'forward', shader: 'test::dummy', tags: { LightMode: 'Forward' } }],
    paramValues: {},
  };
}

/** Build a fresh session whose world carries a red-ball-like mesh entity with a
 *  registry-catalogued material handle, so rootsToSceneAsset can reverse-look-up
 *  its GUID (the collect path the fix depends on). */
function setupSessionWithMeshEntity(): { session: EditSession; ball: EntityHandle } {
  const registry = new AssetRegistry(makeMockShaderRegistry());
  const world = new World();

  // Catalog + alloc a material shared-ref so _guidForAsset(resolve(handle)) hits.
  const mat = makeMaterial();
  const g = AssetGuid.parse(MATERIAL_GUID);
  if (!g.ok) throw new Error('bad test GUID');
  const cat = registry.catalog(g.value, mat);
  if (!cat.ok) throw new Error(`material catalog failed: ${JSON.stringify(cat.error)}`);
  const matHandle = world.allocSharedRef('MaterialAsset', mat);

  const session = createEditSession();
  session.world = world as unknown as EditSession['world'];
  session.registry = registry;

  // Spawn a mesh entity carrying MeshFilter + MeshRenderer(material) — the shape
  // the bug rendered invisible after duplicate.
  const r = world.spawn(
    { component: Name, data: { value: 'BouncyBall' } },
    { component: Transform, data: { pos: [1, 2, 3] } },
    { component: MeshFilter, data: {} },
    { component: MeshRenderer, data: { materials: [matHandle as unknown as Handle<'MaterialAsset', 'shared'>] } },
  );
  if (!r.ok) throw new Error(`spawn failed: ${r.error.message}`);
  return { session, ball: r.value };
}

/** Read an entity's MeshRenderer.materials length (0 when the component is
 *  absent — the exact bug signature). */
function materialCount(world: World, e: EntityHandle): number {
  const mr = world.get(e, MeshRenderer);
  if (!mr.ok) return 0;
  const mats = (mr.value as unknown as { materials?: ArrayLike<number> }).materials;
  return mats ? mats.length : 0;
}

function roots(): EntityHandle[] {
  return childrenOf(gateway.activeWorld, null);
}

describe('duplicateEntity + clipboard material round-trip (bug lock)', () => {
  let ball: EntityHandle;

  beforeEach(() => {
    const s = setupSessionWithMeshEntity();
    ball = s.ball;
    gateway.replaceDoc(s.session);
  });

  it('duplicateEntity produces a copy with NON-EMPTY MeshRenderer.materials', () => {
    const world = gateway.activeWorld as unknown as World;
    expect(materialCount(world, ball)).toBe(1); // source has the material

    duplicateEntity(ball);

    // Two roots now: source + copy.
    const rs = roots();
    expect(rs.length).toBe(2);
    const copy = rs.find((e) => e !== ball)!;
    expect(copy).toBeDefined();

    // The FIX: the copy renders — it has the MeshRenderer with the material,
    // not the invisible [MeshFilter,Name,Transform] archetype of the bug.
    expect(materialCount(world, copy)).toBe(1);
    expect(entName(gateway.activeWorld, copy)).toBe('BouncyBall copy');
  });

  it('duplicateEntity preserves the child subtree', () => {
    const world = gateway.activeWorld as unknown as World;
    // Give the ball a child so the subtree-drop regression is observable.
    const cr = world.spawn(
      { component: Name, data: { value: 'ChildNode' } },
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: ChildOf, data: { parent: ball } },
    );
    if (!cr.ok) throw new Error('child spawn failed');

    duplicateEntity(ball);

    const copy = roots().find((e) => e !== ball)!;
    const copyKids = childrenOf(gateway.activeWorld, copy);
    expect(copyKids.length).toBe(1);
    expect(entName(gateway.activeWorld, copyKids[0]!)).toBe('ChildNode');
  });

  it('one undo removes the whole duplicate', () => {
    expect(roots().length).toBe(1);
    duplicateEntity(ball);
    expect(roots().length).toBe(2);

    const undone = gateway.undo();
    expect(undone).toBe(true);
    expect(roots().length).toBe(1);
    expect(roots()[0]).toBe(ball);
  });

  it('clipboard copy → paste reproduces the material and preserves hierarchy', () => {
    const world = gateway.activeWorld as unknown as World;
    // Add a child so paste hierarchy preservation is checked too.
    const cr = world.spawn(
      { component: Name, data: { value: 'ChildNode' } },
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: ChildOf, data: { parent: ball } },
    );
    if (!cr.ok) throw new Error('child spawn failed');

    const n = copySelected([ball]);
    expect(n).toBe(1);

    pasteClipboard();

    const rs = roots();
    expect(rs.length).toBe(2);
    const pasted = rs.find((e) => e !== ball)!;
    expect(materialCount(world, pasted)).toBe(1);
    // hierarchy preserved
    const kids = childrenOf(gateway.activeWorld, pasted);
    expect(kids.length).toBe(1);
    expect(entName(gateway.activeWorld, kids[0]!)).toBe('ChildNode');
  });
});
