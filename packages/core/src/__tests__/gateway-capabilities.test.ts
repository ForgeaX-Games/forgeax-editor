// gateway-capabilities.test.ts — public Gateway capability matrix.
//
// This suite is intentionally organized around the caller-visible contract, not
// gateway implementation files. Existing narrow unit tests remain the detailed
// proofs; these scenarios protect the AI/human golden path:
// discover → identify → create/compose → collect/duplicate → reject → lifecycle.
//
// The duplicate fixture uses a real AssetRegistry plus a catalogued material and
// shader. A placeholder cube would only prove ECS spawning, not the GUID-backed
// material round-trip required for Edit = reopen = Play.

import { beforeEach, describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { ShaderRegistry } from '@forgeax/engine-shader';
import type { ShaderRegistryDevice } from '@forgeax/engine-shader';
import {
  ChildOf,
  MeshFilter,
  MeshRenderer,
  Name,
  Transform,
} from '@forgeax/engine-runtime';
import type { Handle } from '@forgeax/engine-runtime';
import type { MaterialAsset } from '@forgeax/engine-types';
import { EditGateway } from '../io/gateway';
import { childrenOf, createEditSession } from '../session/document';
import type { EditorOp, EditSession } from '../types';
import type { EntityHandle } from '../scene/scene-types';

const MATERIAL_GUID = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';

function makeShaderRegistry(): ShaderRegistry {
  const device: ShaderRegistryDevice = {
    createShaderModule() {
      return {
        ok: true,
        value: undefined,
        unwrap: () => undefined,
        unwrapOr: (fallback: unknown) => fallback,
      } as unknown as ReturnType<ShaderRegistryDevice['createShaderModule']>;
    },
  };
  const shaders = new ShaderRegistry({ device, manifestUrl: undefined });
  shaders.registerMaterialShader('test::dummy', {
    source: 'fn main() {}',
    paramSchema: [],
  });
  return shaders;
}

function material(): MaterialAsset {
  return {
    kind: 'material',
    passes: [{ name: 'forward', shader: 'test::dummy', tags: { LightMode: 'Forward' } }],
    paramValues: {},
  };
}

function setupBall(opts: { catalogMaterial?: boolean } = {}): {
  gateway: EditGateway;
  world: World;
  ball: EntityHandle;
} {
  const world = new World();
  const registry = new AssetRegistry(makeShaderRegistry());
  const mat = material();
  if (opts.catalogMaterial !== false) {
    const guid = AssetGuid.parse(MATERIAL_GUID);
    if (!guid.ok) throw new Error('bad material test GUID');
    const catalogued = registry.catalog(guid.value, mat);
    if (!catalogued.ok) throw new Error(`material catalog failed: ${String(catalogued.error)}`);
  }
  const matHandle = world.allocSharedRef('MaterialAsset', mat);
  const ball = world.spawn(
    { component: Name, data: { value: 'BouncyBall' } },
    { component: Transform, data: { pos: [-5, 0.55, 4] } },
    { component: MeshFilter, data: {} },
    { component: MeshRenderer, data: { materials: [matHandle as unknown as Handle<'MaterialAsset', 'shared'>] } },
  );
  if (!ball.ok) throw new Error(`ball spawn failed: ${String(ball.error)}`);
  const child = world.spawn(
    { component: Name, data: { value: 'BouncyBallChild' } },
    { component: Transform, data: { pos: [0, 0, 0] } },
    { component: ChildOf, data: { parent: ball.value } },
  );
  if (!child.ok) throw new Error(`child spawn failed: ${String(child.error)}`);

  const session = createEditSession();
  session.world = world as unknown as EditSession['world'];
  session.registry = registry;
  return { gateway: new EditGateway(session), world, ball: ball.value };
}

function materialCount(world: World, entity: EntityHandle): number {
  const renderer = world.get(entity, MeshRenderer);
  if (!renderer.ok) return 0;
  const materials = (renderer.value as unknown as { materials?: ArrayLike<number> }).materials;
  return materials?.length ?? 0;
}

function roots(world: World): EntityHandle[] {
  return childrenOf(world, null);
}

describe('Gateway public capability matrix', () => {
  let gateway: EditGateway;
  let world: World;
  let ball: EntityHandle;

  beforeEach(() => {
    ({ gateway, world, ball } = setupBall());
  });

  it('Discover: listOps exposes a self-describing document duplicate capability', () => {
    const duplicate = gateway.listOps().find((op) => op.id === 'duplicateEntity');
    expect(duplicate).toBeDefined();
    expect(duplicate?.domain).toBe('document');
    expect(duplicate?.source).toBe('builtin');
    expect(duplicate?.argsSchema?.required).toContain('entity');
    expect(duplicate?.argsSchema?.properties?.entity?.type).toBe('number');
  });

  it('Identify: query resolves names while retaining JSON-safe transform data', () => {
    const snapshot = gateway.buildQueryFn()({ with: ['Name', 'Transform'] });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    const row = snapshot.rows.find((candidate) => candidate.entity === ball);
    expect(row).toBeDefined();
    expect((row?.Name as { value?: unknown }).value).toBe('BouncyBall');
    const pos = (row?.Transform as { pos?: number[] }).pos;
    expect(pos?.[0]).toBe(-5);
    expect(pos?.[1]).toBeCloseTo(0.55, 5);
    expect(pos?.[2]).toBe(4);
    expect(JSON.parse(JSON.stringify(row))).toEqual(row);
  });

  it('Create: AI-origin dispatch is queryable, traced, and undo/redo symmetric', () => {
    const command: EditorOp = {
      kind: 'spawnEntity',
      name: 'AI Light',
      components: { Transform: { pos: [1, 2, 3] } },
    };
    const created = gateway.dispatch(command, 'ai');
    expect(created.ok).toBe(true);
    const entity = (command as { _id?: EntityHandle })._id;
    expect(entity).toBeDefined();
    expect(gateway.origins.at(-1)).toBe('ai');
    expect(gateway.trace.last()?.name).toBe('spawnEntity');

    const found = gateway.buildQueryFn()({ with: ['Name'] });
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.rows.some((row) => row.entity === entity && (row.Name as { value?: unknown }).value === 'AI Light')).toBe(true);
    }
    expect(gateway.undo()).toBe(true);
    expect(world.get(entity!, Name).ok).toBe(false);
    expect(gateway.redo()).toBe(true);
    const restored = gateway.buildQueryFn()({ with: ['Name'] });
    expect(restored.ok).toBe(true);
    if (restored.ok) {
      expect(restored.rows.some((row) => (row.Name as { value?: unknown }).value === 'AI Light')).toBe(true);
    }
  });

  it('Compose: a public transaction is one document undo step', () => {
    const beforeUndo = gateway.appliedCount();
    const beforeLedger = gateway.ledger.length;
    const result = gateway.dispatch({
      kind: 'transaction',
      label: 'rename ball and child',
      commands: [
        { kind: 'rename', entity: ball, name: 'RenamedBall' },
        { kind: 'rename', entity: childrenOf(world, ball)[0]!, name: 'RenamedChild' },
      ],
    }, 'ai');
    expect(result.ok).toBe(true);
    expect(gateway.appliedCount()).toBe(beforeUndo + 1);
    expect(gateway.ledger.length).toBe(beforeLedger + 1);
    expect(gateway.origins.at(-1)).toBe('ai');
    expect(gateway.undo()).toBe(true);
    expect(world.get(ball, Name).unwrap().value).toBe('BouncyBall');
  });

  it('Collect + Duplicate: AI can round-trip material and child subtree with one undo/redo', () => {
    const collected = gateway.collectSceneAsset(ball);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;
    expect(JSON.stringify(collected.asset)).toContain(MATERIAL_GUID);
    expect(gateway.ledger).toHaveLength(0); // read API does not leave an audit write

    const command: EditorOp = { kind: 'duplicateEntity', entity: ball };
    const duplicated = gateway.dispatch(command, 'ai');
    expect(duplicated.ok).toBe(true);
    const copy = (command as { _newRoots?: EntityHandle[] })._newRoots?.[0];
    expect(copy).toBeDefined();
    expect(materialCount(world, copy!)).toBe(1);
    expect(childrenOf(world, copy!)).toHaveLength(1);
    expect(gateway.ledger).toHaveLength(1);
    expect(gateway.ledger[0]?.kind).toBe('duplicateEntity');
    expect(gateway.origins[0]).toBe('ai');
    expect(gateway.trace.last()?.name).toBe('duplicateEntity');

    expect(gateway.undo()).toBe(true);
    expect(roots(world)).toEqual([ball]);
    expect(gateway.redo()).toBe(true);
    const redone = roots(world).find((entity) => entity !== ball);
    expect(redone).toBeDefined();
    expect(materialCount(world, redone!)).toBe(1);
    expect(childrenOf(world, redone!)).toHaveLength(1);
  });

  it('Reject: stale collection and duplicate leave no ledger or undo residue', () => {
    const beforeLedger = gateway.ledger.length;
    const beforeUndo = gateway.appliedCount();
    const collected = gateway.collectSceneAsset(999_999 as EntityHandle);
    expect(collected.ok).toBe(false);
    if (!collected.ok) expect(collected.error.code).toBe('NO_SUCH_ENTITY');

    const duplicated = gateway.dispatch({ kind: 'duplicateEntity', entity: 999_999 }, 'ai');
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) expect(duplicated.error.code).toBe('NO_SUCH_ENTITY');
    expect(gateway.ledger.length).toBe(beforeLedger);
    expect(gateway.appliedCount()).toBe(beforeUndo);
  });

  it('Reject: missing registry and unresolved material collection are structured', () => {
    const withoutRegistry = new EditGateway(createEditSession());
    const noRegistry = withoutRegistry.collectSceneAsset(ball);
    expect(noRegistry.ok).toBe(false);
    if (!noRegistry.ok) expect(noRegistry.error.code).toBe('NO_REGISTRY');

    const unresolvable = setupBall({ catalogMaterial: false });
    const failed = unresolvable.gateway.dispatch({ kind: 'duplicateEntity', entity: unresolvable.ball }, 'ai');
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe('SCENE_COLLECT_FAILED');
    expect(unresolvable.gateway.ledger).toHaveLength(0);
    expect(unresolvable.gateway.appliedCount()).toBe(0);
  });

  it('Continuous + Boundary: one committed gesture is one undo, and duplicate is blocked in play', () => {
    const handle = gateway.begin({
      kind: 'setComponent',
      entity: ball,
      component: 'Transform',
      patch: { pos: [-5, 0.55, 4] },
    });
    expect(handle.ok).toBe(true);
    if (!handle.ok) return;
    expect(gateway.update(handle.handle, { patch: { pos: [-4, 0.55, 4] } }).ok).toBe(true);
    expect(gateway.commit(handle.handle).ok).toBe(true);
    expect(gateway.appliedCount()).toBe(1);
    expect(gateway.undo()).toBe(true);

    gateway.enterPlay(new World());
    const blocked = gateway.dispatch({ kind: 'duplicateEntity', entity: ball }, 'ai');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('edit-rejected-in-play');
  });
});
