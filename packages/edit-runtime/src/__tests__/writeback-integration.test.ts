// writeback-integration.test.ts (w39) — REAL-CHAIN writeback integration test.
//
// Drives the PRODUCTION save chain `writebackInstance` (writeback-chain.ts) end to end:
//
//   writebackInstance(world, target, registry)
//     -> rootsToSceneAsset(registry, world, [root])       // @forgeax/engine-runtime (M5)
//     -> serializeSceneAssetToPack(asset, sceneGuid)        // @forgeax/engine-runtime (M5)
//     -> POST /api/files                                     // (stubbed here to capture the pack)
//
// M5: Spawns entities directly via world.spawn (NOT instantiateScene — which adds
// SceneInstance.source shared<> fields requiring a catalogued AssetRegistry).
// This keeps the test focused on the rootsToSceneAsset + serialize pipeline.
//
// Anchors:
//   requirements AC-14/16 (writeback real chain to disk + disk round-trip)
//   plan-strategy §2 D-1 / §5.3 real-chain integration test

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { defineComponent, World } from '@forgeax/engine-ecs';
import { Name, Transform } from '@forgeax/engine-runtime';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { ShaderRegistryDevice } from '@forgeax/engine-shader';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { writebackInstance } from '../writeback-chain';

// ── Minimal mock ShaderRegistry for AssetRegistry constructor ──────────────

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
  return new ShaderRegistry({ device: mockDevice, manifestUrl: undefined });
}

function makeRegistry(): AssetRegistry {
  return new AssetRegistry(makeMockShaderRegistry());
}

// ── fetch capture stub ───────────────────────────────────────────────────────

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
// w39 — real-chain writeback integration (writebackInstance -> engine rootsToSceneAsset)
// ═══════════════════════════════════════════════════════════════════════════════

describe('w39 — writebackInstance drives the real engine rootsToSceneAsset chain', () => {
  it('(a) collects spawned entities, serializes a pack, and writes it to disk', async () => {
    const W39_Transform = defineComponent('W39_Transform', { posX: 'f32', posY: 'f32', posZ: 'f32' });

    const world = new World();
    // Spawn entities directly (no instantiateScene — avoids SceneInstance.source
    // shared<> field requiring a catalogued AssetRegistry).
    const r0 = world.spawn({ component: Name, data: { value: 'A' } }, { component: W39_Transform as any, data: { posX: 1, posY: 2, posZ: 3 } });
    if (!r0.ok) throw new Error('spawn failed');
    const root = r0.value as number;

    const result = await writebackInstance(world, {
      packPath: 'assets/scenes/main.pack.json',
      sceneGuid: SCENE_GUID,
      instanceRoot: root,
    }, makeRegistry());

    expect(result.ok).toBe(true);
    expect(captured).not.toBeNull();
    expect(captured!.path).toBe('assets/scenes/main.pack.json');

    const entities = payloadEntities(captured!.content);
    expect(entities).toHaveLength(1);

    const n = comp(entities[0]!, 'Name');
    expect(n).toBeDefined();
  });

  it('(b) component field values are semantically equivalent through the real chain', async () => {
    const W39_Pos3 = defineComponent('W39_Pos3', { x: 'f32', y: 'f32', z: 'f32' });

    const world = new World();
    const r0 = world.spawn({ component: Name, data: { value: 'P' } }, { component: W39_Pos3 as any, data: { x: 10.5, y: 20.5, z: 30.5 } });
    if (!r0.ok) throw new Error('spawn failed');
    const root = r0.value as number;

    const result = await writebackInstance(world, {
      packPath: 'assets/scenes/pos.pack.json',
      sceneGuid: SCENE_GUID,
      instanceRoot: root,
    }, makeRegistry());

    expect(result.ok).toBe(true);
    const entities = payloadEntities(captured!.content);
    expect(entities).toHaveLength(1);

    const p = comp(entities[0]!, 'W39_Pos3');
    expect(p).toBeDefined();
    expect(Math.abs((p!.x as number) - 10.5)).toBeLessThan(0.001);
    expect(Math.abs((p!.y as number) - 20.5)).toBeLessThan(0.001);
    expect(Math.abs((p!.z as number) - 30.5)).toBeLessThan(0.001);
  });

  it('(c) the written pack carries the source scene GUID (single-instance addressing)', async () => {
    const W39_Tag = defineComponent('W39_Tag', { v: 'f32' });

    const world = new World();
    const r0 = world.spawn({ component: Name, data: { value: 'T' } }, { component: W39_Tag as any, data: { v: 1 } });
    if (!r0.ok) throw new Error('spawn failed');
    const root = r0.value as number;

    const result = await writebackInstance(world, {
      packPath: 'assets/scenes/tag.pack.json',
      sceneGuid: SCENE_GUID,
      instanceRoot: root,
    }, makeRegistry());

    expect(result.ok).toBe(true);
    const pack = JSON.parse(captured!.content) as {
      assets: Array<{ guid: string; kind: string }>;
    };
    expect(pack.assets[0]!.guid).toBe(SCENE_GUID);
    expect(pack.assets[0]!.kind).toBe('scene');
  });

  it('(d) omitting registry surfaces a visible warning (not silent)', async () => {
    const W39_Warn = defineComponent('W39_Warn', { v: 'f32' });

    const world = new World();
    const r0 = world.spawn({ component: Name, data: { value: 'W' } }, { component: W39_Warn as any, data: { v: 1 } });
    if (!r0.ok) throw new Error('spawn failed');
    const root = r0.value as number;

    // No registry argument — should warn.
    const result = await writebackInstance(world, {
      packPath: 'assets/scenes/warn.pack.json',
      sceneGuid: SCENE_GUID,
      instanceRoot: root,
    });

    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes('registry'))).toBe(true);
  });

  it('(e) a write failure carries a machine-readable .code', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 500 }) as Response) as unknown as typeof globalThis.fetch;

    const W39_Code = defineComponent('W39_Code', { v: 'f32' });
    const world = new World();
    const r0 = world.spawn({ component: Name, data: { value: 'C' } }, { component: W39_Code as any, data: { v: 1 } });
    if (!r0.ok) throw new Error('spawn failed');
    const root = r0.value as number;

    const result = await writebackInstance(
      world,
      { packPath: 'assets/scenes/code.pack.json', sceneGuid: SCENE_GUID, instanceRoot: root },
      makeRegistry(),
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('write-failed');
  });
});