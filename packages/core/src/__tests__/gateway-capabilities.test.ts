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
import { defineComponent, World } from '@forgeax/engine-ecs';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
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
import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { EditGateway } from '../io/gateway';
import { childrenOf, createEditSession } from '../session/document';
import type { EditorOp, EditSession } from '../types';
import type { EntityHandle } from '../scene/scene-types';

const MATERIAL_GUID = 'cbe42beb-8975-5096-b3a1-3dda4cb4c077';
const TEXTURE_GUID = 'd1f2a3b4-c5d6-5e70-8901-234567890abc';

// A tiny 2×2 RGBA texture — small enough to keep the test cheap, but its `data`
// buffer is exactly what describeAssetByGuid must NOT return (the friction that
// motivated this leg: lookupAsset drags the full pixel buffer into scope).
function texture(): TextureAsset {
  return {
    kind: 'texture',
    width: 2,
    height: 2,
    format: 'rgba8unorm',
    data: new Uint8Array(2 * 2 * 4),
    colorSpace: 'srgb',
    mipmap: false,
  };
}

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
    if (!created.ok) return;
    // The new handle comes back on result.created (length 1 for a single spawn).
    expect(created.result?.created).toHaveLength(1);
    const entity = created.result?.created[0];
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

    const duplicated = gateway.dispatch({ kind: 'duplicateEntity', entity: ball }, 'ai');
    expect(duplicated.ok).toBe(true);
    if (!duplicated.ok) return;
    const copy = duplicated.result?.created[0];
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

// Part 1 — the created channel: creating ops return their new roots on
// result.created (single spawn = [handle]; transaction = all sub-ops' roots
// flattened in op order; non-creating ops = []).
describe('Gateway created channel', () => {
  let gateway: EditGateway;
  let ball: EntityHandle;

  beforeEach(() => {
    ({ gateway, ball } = setupBall());
  });

  it('spawnEntity returns the new handle on result.created', () => {
    const r = gateway.dispatch({ kind: 'spawnEntity', name: 'X', components: {} }, 'ai');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result?.created).toHaveLength(1);
  });

  it('duplicateEntity returns the copy roots on result.created', () => {
    const r = gateway.dispatch({ kind: 'duplicateEntity', entity: ball }, 'ai');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result?.created).toHaveLength(1);
    expect(r.result?.created[0]).not.toBe(ball);
  });

  it('transaction flattens every sub-op root; reparent contributes none', () => {
    const r = gateway.dispatch({
      kind: 'transaction',
      label: 'two spawns + a rename',
      commands: [
        { kind: 'spawnEntity', name: 'A', components: {} },
        { kind: 'rename', entity: ball, name: 'Renamed' },
        { kind: 'spawnEntity', name: 'B', components: {} },
      ],
    }, 'ai');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Two spawns → two roots; the rename adds nothing.
    expect(r.result?.created).toHaveLength(2);
  });

  it('non-creating document op returns an empty created array', () => {
    const r = gateway.dispatch({ kind: 'rename', entity: ball, name: 'Renamed' }, 'ai');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result?.created).toEqual([]);
  });
});

// Part 4 — asset read surface: resolve a shared<T> handle (query's opaque-handle
// .raw) into payload / human-readable identity, plus catalog reads. Builds its own
// world so it can set MeshFilter.assetHandle to a builtin mesh (scalar shared<T>,
// which query returns cleanly as opaque-handle.raw — no array decoding).
describe('Gateway asset read surface', () => {
  // A gateway whose ball carries a builtin cube mesh + a catalogued material,
  // with both handles captured directly (== what query's opaque-handle.raw is).
  // Also catalogs a TEXTURE (heavy-data kind) to exercise the lightweight
  // describe-by-guid summary path (shape metadata, no pixel buffer).
  function setup(): {
    gateway: EditGateway;
    ball: EntityHandle;
    meshHandle: number;
    matHandle: number;
    texHandle: number;
  } {
    const world = new World();
    const registry = new AssetRegistry(makeShaderRegistry());
    const mat = material();
    const guid = AssetGuid.parse(MATERIAL_GUID);
    if (!guid.ok) throw new Error('bad material test GUID');
    const catalogued = registry.catalog(guid.value, mat);
    if (!catalogued.ok) throw new Error(`material catalog failed: ${String(catalogued.error)}`);
    // Catalog a small texture (heavy-data kind) so describeAssetByGuid's
    // shape-metadata-not-pixels contract is testable.
    const tex = texture();
    const texGuid = AssetGuid.parse(TEXTURE_GUID);
    if (!texGuid.ok) throw new Error('bad texture test GUID');
    const texCatalogued = registry.catalog(texGuid.value, tex);
    if (!texCatalogued.ok) throw new Error(`texture catalog failed: ${String(texCatalogued.error)}`);
    const texHandle = world.allocSharedRef('TextureAsset', tex);
    const matHandle = world.allocSharedRef('MaterialAsset', mat);
    const spawned = world.spawn(
      { component: Name, data: { value: 'Cube' } },
      { component: Transform, data: { pos: [0, 0, 0] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [matHandle as unknown as Handle<'MaterialAsset', 'shared'>] } },
    );
    if (!spawned.ok) throw new Error(`spawn failed: ${String(spawned.error)}`);
    const session = createEditSession();
    session.world = world as unknown as EditSession['world'];
    session.registry = registry;
    return {
      gateway: new EditGateway(session),
      ball: spawned.value,
      meshHandle: HANDLE_CUBE as unknown as number,
      matHandle: matHandle as unknown as number,
      texHandle: texHandle as unknown as number,
    };
  }

  it('resolveAsset resolves a catalogued material handle to its payload', () => {
    const { gateway, matHandle } = setup();
    const r = gateway.resolveAsset(matHandle);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.asset.kind).toBe('material');
  });

  it('describeAsset gives GUID + name for a catalogued asset', () => {
    const { gateway, matHandle } = setup();
    const d = gateway.describeAsset(matHandle);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.kind).toBe('material');
      expect(d.guid).toBe(MATERIAL_GUID);
    }
  });

  it('describeAsset marks a builtin mesh (HANDLE_CUBE) as builtin with no GUID', () => {
    const { gateway, meshHandle } = setup();
    const d = gateway.describeAsset(meshHandle);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.kind).toBe('mesh');
      expect(d.builtin).toBe(true);
      expect(d.guid).toBeUndefined();
    }
  });

  it('query MeshFilter.assetHandle.raw feeds resolveAsset (the end-to-end path)', () => {
    const { gateway, ball } = setup();
    const snap = gateway.buildQueryFn()({ with: ['MeshFilter'] });
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    const row = snap.rows.find((r) => r.entity === ball);
    const raw = (row?.MeshFilter as { assetHandle?: { raw?: number } }).assetHandle?.raw;
    expect(typeof raw).toBe('number');
    const d = gateway.describeAsset(raw!);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.kind).toBe('mesh');
  });

  it('resolveAsset returns a structured miss for slot 0 (unset)', () => {
    const { gateway } = setup();
    const r = gateway.resolveAsset(0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ASSET_NOT_FOUND');
  });

  it('assetCatalog + lookupAsset project the registry catalog', () => {
    const { gateway } = setup();
    expect(gateway.assetCatalog().some((e) => e.guid === MATERIAL_GUID)).toBe(true);
    const payload = gateway.lookupAsset(MATERIAL_GUID);
    expect((payload as { kind?: string } | undefined)?.kind).toBe('material');
  });

  // ── describeAssetByGuid: the lightweight by-GUID leg (friction #4) ──────────
  // A material POD exposes its texture bindings as GUID strings. Before this leg,
  // the only by-GUID path was lookupAsset(guid), which returns the FULL payload —
  // for a texture that's the entire pixel buffer. describeAssetByGuid is the
  // by-GUID complement of describeAsset(handle): identity + shape, no buffer.

  it('describeAssetByGuid returns texture shape metadata WITHOUT the pixel buffer', () => {
    const { gateway } = setup();
    const d = gateway.describeAssetByGuid(TEXTURE_GUID);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.kind).toBe('texture');
      expect(d.guid).toBe(TEXTURE_GUID);
      // Lightweight POD fields flow through `meta` (kind-agnostic projection).
      expect(d.meta?.width).toBe(2);
      expect(d.meta?.height).toBe(2);
      expect(d.meta?.format).toBe('rgba8unorm');
      // The whole point: the heavy `data` buffer is stripped, at any nesting.
      expect(d.meta?.data).toBeUndefined();
      // And the summary is small — the friction was a multi-MB pixel dump.
      expect(JSON.stringify(d).length).toBeLessThan(512);
    }
  });

  it('describeAssetByGuid and describeAsset agree on the same asset (SSOT — no drift)', () => {
    const { gateway, matHandle } = setup();
    const byHandle = gateway.describeAsset(matHandle);
    const byGuid = gateway.describeAssetByGuid(MATERIAL_GUID);
    expect(byHandle.ok && byGuid.ok).toBe(true);
    if (byHandle.ok && byGuid.ok) {
      expect(byGuid.kind).toBe(byHandle.kind);
      expect(byGuid.guid).toBe(byHandle.guid);
      expect(byGuid.name).toBe(byHandle.name);
      expect(byGuid.meta).toEqual(byHandle.meta);
    }
  });

  it('describeAssetByGuid returns a structured miss for an unknown GUID', () => {
    const { gateway } = setup();
    const d = gateway.describeAssetByGuid('00000000-0000-0000-0000-000000000000');
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error.code).toBe('ASSET_NOT_FOUND');
  });

  it('describeAsset(handle) carries the same buffer-stripped meta (shared summary, kind-agnostic)', () => {
    const { gateway, texHandle } = setup();
    const d = gateway.describeAsset(texHandle);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.kind).toBe('texture');
      expect(d.meta?.width).toBe(2);
      expect(d.meta?.height).toBe(2);
      // No hard-coded per-kind field list: the heavy buffer is dropped by shape.
      expect(d.meta?.data).toBeUndefined();
    }
  });
});

// Part 5 — component read surface: discover component names + field schemas
// BEFORE constructing a spawn/setComponent payload, instead of learning them
// only from a SPAWN_FAILED. Parallel to the asset read surface above.
describe('Gateway component read surface', () => {
  function gw(): EditGateway {
    return new EditGateway(createEditSession());
  }

  it('listComponents lists registered names, sorted, including Transform', () => {
    const names = gw().listComponents();
    expect(names).toContain('Transform');
    expect(names).toContain('Name');
    expect(names).toContain('MeshFilter');
    // sorted
    expect([...names]).toEqual([...names].sort());
  });

  it('listComponents is same-source as the UNKNOWN_COMPONENT hint (no drift)', () => {
    const gateway = gw();
    const names = gateway.listComponents();
    const miss = gateway.describeComponent('DefinitelyNotAComponent');
    expect(miss.ok).toBe(false);
    if (!miss.ok) {
      // every listed name appears in the miss hint's enumeration
      for (const n of names) expect(miss.error.hint).toContain(n);
    }
  });

  it('describeComponent returns the field schema of a known component', () => {
    const d = gw().describeComponent('Transform');
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.name).toBe('Transform');
      // Transform's engine schema fields — the exact knowledge an AI needs pre-spawn
      expect(Object.keys(d.schema)).toEqual(expect.arrayContaining(['pos', 'quat', 'scale']));
      // values are string type-keywords, JSON-safe
      for (const t of Object.values(d.schema)) expect(typeof t).toBe('string');
    }
  });

  it('describeComponent result round-trips through JSON (no live handles)', () => {
    const d = gw().describeComponent('Transform');
    expect(d.ok).toBe(true);
    if (d.ok) expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });

  it('describeComponent on an unknown name returns structured UNKNOWN_COMPONENT', () => {
    const d = gw().describeComponent('Nope');
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.error.code).toBe('UNKNOWN_COMPONENT');
      expect(d.error.hint).toContain('registered component names:');
    }
  });

  // solo round-24 (P7 residue): enum-field label→value maps are projected under
  // `enums` so a docs-only AI learns the legal variants + integers from the
  // schema alone (e.g. RigidBody.type → static=0/dynamic=1/kinematic=2) instead
  // of reading engine source (the recurring friction #1, rounds 15/20/22).
  // Register a synthetic labels-bearing component so the projection is tested
  // generically (no physics dep, no registration-order coupling).
  it('describeComponent projects an enum field label map under `enums`', () => {
    // Uniquely-named to avoid clobbering the global component registry across runs.
    const compName = `R24_DescribeEnum_${Math.floor(performance.now())}_${Math.random().toString(36).slice(2, 8)}`;
    defineComponent(compName, {
      motion: { type: 'enum', default: 1, labels: { static: 0, dynamic: 1, kinematic: 2 } },
      mass: { type: 'f32', default: 1 },
    });

    const d = gw().describeComponent(compName);
    expect(d.ok).toBe(true);
    if (d.ok) {
      // the enum field is projected with its full label map
      expect(d.enums).toBeDefined();
      expect(d.enums?.motion).toEqual({ static: 0, dynamic: 1, kinematic: 2 });
      // a non-enum field carries no entry (only labelled fields appear)
      expect(d.enums?.mass).toBeUndefined();
      // still JSON-safe (no live handles)
      expect(JSON.parse(JSON.stringify(d))).toEqual(d);
    }
  });

  it('describeComponent omits `enums` for a component with no labelled fields', () => {
    // Transform has no enum-with-labels field → key absent (backward-compatible).
    const d = gw().describeComponent('Transform');
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.enums).toBeUndefined();
  });
});
