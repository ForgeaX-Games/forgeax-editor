// writeback-integration.test.ts (w39) — REAL-CHAIN writeback integration test.
//
// Unlike the w31 editor-core unit test (which exercises the editor's OWN codec
// sessionToPack/packToSession and never touches the engine), this test drives
// the PRODUCTION save chain `writebackInstance` (writeback-chain.ts) end to end:
//
//   writebackInstance(world, target, handleToGuid)
//     -> collectSceneAsset(world, root, handleToGuid)   // @forgeax/engine-runtime (M2 w11)
//     -> serializeSceneAssetToPack(asset, sceneGuid)     // @forgeax/engine-runtime (M2 w12)
//     -> POST /api/files                                  // (stubbed here to capture the pack)
//
// It builds a REAL @forgeax/engine-ecs World, instantiates a SceneInstance via
// the engine's own instantiateScene, then asserts the pack JSON written to disk
// is semantically equivalent to the authored SceneAsset (entity count, localId
// set, component field values). The engine collector is NOT mocked.
//
// TDD red-before-bump (plan-strategy §5.3, implement-review §4 finding #3 /
// §5 Issue #2):
//   - Before the editor nested-engine bump (w40), the resolved
//     `@forgeax/engine-runtime` barrel (dist/index.mjs of the editor's
//     workspace-resolved engine) does NOT export collectSceneAsset — the named
//     import is `undefined`, so `writebackInstance` returns ok:false with a
//     "collect/serialize failed" error. The chain-success assertions go RED.
//   - After w40 bumps the engine pin to the commit carrying
//     collect-scene-asset.ts (and the resolved runtime barrel re-exports it),
//     the real collector runs and the semantic-equivalence assertions go GREEN.
//
// Anchors:
//   requirements AC-14/16 (writeback real chain to disk + disk round-trip)
//   plan-strategy §2 D-1 / §5.3 real-chain integration test
//   implement-review §4 finding #3 + §5 Issue #2 (w31 tested codec, not real chain)
//   charter P3: an absent engine export surfaces as an explicit ok:false signal,
//     not a silent green test.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { writebackInstance } from '../writeback-chain';

// ── fetch capture stub ───────────────────────────────────────────────────────
//
// writebackInstance POSTs the serialized pack to /api/files. We replace fetch to
// capture that body (the disk write target) instead of hitting a server. This
// keeps the test focused on the REAL collect/serialize chain (the engine path),
// not the network.

interface CapturedWrite {
  path: string;
  content: string;
}

let captured: CapturedWrite | null = null;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  captured = null;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as CapturedWrite;
    captured = { path: body.path, content: body.content };
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a real World, register the SceneAsset, instantiate it through the
 * engine's own instantiateScene, and return the live world + synthetic root.
 * Throws (test fails) if instantiation does not succeed.
 */
function materialise(asset: {
  kind: 'scene';
  entities: Array<{ localId: number; components: Record<string, Record<string, unknown>> }>;
}): { world: World; root: number } {
  const world = new World();
  // allocSharedRef('SceneAsset', asset) registers the authored asset so
  // instantiateScene can resolve it — same path the engine's own collector
  // round-trip test uses.
  const handle = (world as unknown as {
    allocSharedRef: (kind: string, value: unknown) => unknown;
  }).allocSharedRef('SceneAsset', asset);

  const res = (world as unknown as {
    instantiateScene: (h: unknown) => { ok: boolean; value?: { root: number } };
  }).instantiateScene(handle);

  if (!res.ok || !res.value) {
    throw new Error('instantiateScene failed — cannot run real-chain writeback test');
  }
  return { world, root: res.value.root };
}

/** Parse the captured pack and return its single scene asset payload entities. */
function payloadEntities(content: string): Array<Record<string, unknown>> {
  const pack = JSON.parse(content) as { assets: Array<{ payload: { entities: unknown[] } }> };
  expect(Array.isArray(pack.assets)).toBe(true);
  expect(pack.assets.length).toBe(1);
  return pack.assets[0]!.payload.entities as Array<Record<string, unknown>>;
}

function comp(
  entity: Record<string, unknown>,
  name: string,
): Record<string, unknown> | undefined {
  const map = entity.components as Record<string, Record<string, unknown>>;
  return map?.[name];
}

const SCENE_GUID = 'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee';

// ═══════════════════════════════════════════════════════════════════════════════
// w39 — real-chain writeback integration (writebackInstance -> engine collector)
// ═══════════════════════════════════════════════════════════════════════════════

describe('w39 — writebackInstance drives the real engine collectSceneAsset chain', () => {
  it('(a) collects a live SceneInstance, serializes a pack, and writes it to disk', async () => {
    defineComponent('W39_Transform', { posX: 'f32', posY: 'f32', posZ: 'f32' });

    const asset = {
      kind: 'scene' as const,
      entities: [
        { localId: 0, components: { W39_Transform: { posX: 1, posY: 2, posZ: 3 } } },
        { localId: 1, components: { W39_Transform: { posX: 4, posY: 5, posZ: 6 } } },
        { localId: 2, components: { W39_Transform: { posX: 7, posY: 8, posZ: 9 } } },
      ],
    };

    const { world, root } = materialise(asset);

    const result = await writebackInstance(world, {
      packPath: 'assets/scenes/main.pack.json',
      sceneGuid: SCENE_GUID,
      instanceRoot: root,
    });

    // RED before bump: collectSceneAsset is undefined -> writebackInstance
    // returns ok:false "collect/serialize failed". GREEN after bump.
    expect(result.ok).toBe(true);
    expect(captured).not.toBeNull();
    expect(captured!.path).toBe('assets/scenes/main.pack.json');

    const entities = payloadEntities(captured!.content);
    expect(entities).toHaveLength(3);

    const localIds = entities.map((e) => Number(e.localId)).sort((a, b) => a - b);
    expect(localIds).toEqual([0, 1, 2]);
  });

  it('(b) component field values are semantically equivalent through the real chain', async () => {
    defineComponent('W39_Pos3', { x: 'f32', y: 'f32', z: 'f32' });

    const asset = {
      kind: 'scene' as const,
      entities: [{ localId: 0, components: { W39_Pos3: { x: 10.5, y: 20.5, z: 30.5 } } }],
    };

    const { world, root } = materialise(asset);

    const result = await writebackInstance(world, {
      packPath: 'assets/scenes/pos.pack.json',
      sceneGuid: SCENE_GUID,
      instanceRoot: root,
    });

    expect(result.ok).toBe(true);
    const entities = payloadEntities(captured!.content);
    expect(entities).toHaveLength(1);

    const p = comp(entities[0]!, 'W39_Pos3');
    expect(p).toBeDefined();
    expect(Math.abs((p!.x as number) - 10.5)).toBeLessThan(0.001);
    expect(Math.abs((p!.y as number) - 20.5)).toBeLessThan(0.001);
    expect(Math.abs((p!.z as number) - 30.5)).toBeLessThan(0.001);
  });

  it('(c) handle->GUID reverse index resolves a shared field through the real chain', async () => {
    // Field named 'assetHandle' triggers the collector's handle->GUID allowlist;
    // f32 type avoids shared-ref schema validation (same trick as engine w10).
    // The collector resolves the live handle int -> GUID string; the serializer
    // then de-dupes GUID strings into the pack's refs[] and replaces each inline
    // occurrence with the ref index (engine M2 D-1). So the assertion checks
    // refs[] carries the GUID and the inline field is a numeric ref index, NOT
    // the raw GUID string (the same contract the engine's own w10 (g) test uses).
    defineComponent('W39_MeshRef', { assetHandle: 'f32' });

    const fakeHandle = 777;
    const meshGuid = 'mesh-guid-mesh-guid-mesh-guid-meshguid0';
    const handleToGuid = new Map<number, string>([[fakeHandle, meshGuid]]);

    const asset = {
      kind: 'scene' as const,
      entities: [{ localId: 0, components: { W39_MeshRef: { assetHandle: fakeHandle } } }],
    };

    const { world, root } = materialise(asset);

    const result = await writebackInstance(
      world,
      { packPath: 'assets/scenes/mesh.pack.json', sceneGuid: SCENE_GUID, instanceRoot: root },
      handleToGuid,
    );

    expect(result.ok).toBe(true);

    // The GUID survives the real collect->serialize chain into refs[].
    const pack = JSON.parse(captured!.content) as {
      assets: Array<{ refs: string[] }>;
    };
    expect(pack.assets[0]!.refs).toContain(meshGuid);

    // The inline field is the ref index pointing at that GUID (not the raw int,
    // not the raw GUID) — proving the handle->GUID->ref-index path ran.
    const entities = payloadEntities(captured!.content);
    const refIndex = pack.assets[0]!.refs.indexOf(meshGuid);
    expect(comp(entities[0]!, 'W39_MeshRef')!.assetHandle).toBe(refIndex);
  });

  it('(d) the written pack carries the source scene GUID (single-instance addressing)', async () => {
    defineComponent('W39_Tag', { v: 'f32' });

    const asset = {
      kind: 'scene' as const,
      entities: [{ localId: 0, components: { W39_Tag: { v: 1 } } }],
    };

    const { world, root } = materialise(asset);

    const result = await writebackInstance(world, {
      packPath: 'assets/scenes/tag.pack.json',
      sceneGuid: SCENE_GUID,
      instanceRoot: root,
    });

    expect(result.ok).toBe(true);
    const pack = JSON.parse(captured!.content) as {
      assets: Array<{ guid: string; kind: string }>;
    };
    expect(pack.assets[0]!.guid).toBe(SCENE_GUID);
    expect(pack.assets[0]!.kind).toBe('scene');
  });
});
