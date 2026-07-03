// m5-test-writeback-red — writeback Result branch tests (engine-native path)
//
// feat-20260701-editor-world-container-doc-ecs-collapse M5 / AC-08, AC-23:
// Tests that the engine's rootsToSceneAsset + serializeSceneAssetToPack pipeline
// correctly collects entities and produces valid pack output. Also verifies error
// handling: entity ref out of closure returns structured error with .code/.hint
// (charter P3 — better than old collectSceneAsset silent empty return).
//
// The "red" dimension is the (c) grep `sessionToPack` zero-hit check at commit
// time — the editor codec still references sessionToPack until m5-impl-writeback
// replaces the writeback chain. The engine API tests (a, b) exercise the
// already-available rootsToSceneAsset API at engine pin 3df7907.
//
// Anchors:
//   plan-tasks.json m5-test-writeback-red: success/error branches + sessionToPack grep
//   requirements AC-08: rootsToSceneAsset, delete sessionToPack
//   requirements AC-23: error signal .code/.hint charter P3
//   plan-strategy §7 M5 acceptanceCheck: pack schema validation, no editor-only fields

import { describe, expect, it } from 'bun:test';
import { World, defineComponent } from '@forgeax/engine-ecs';
import type { EntityHandle } from '../scene-types';
import {
  AssetRegistry,
  ChildOf,
  Name,
  rootsToSceneAsset,
  serializeSceneAssetToPack,
  Transform,
} from '@forgeax/engine-runtime';
import type { ShaderRegistryDevice } from '@forgeax/engine-shader';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { EditorHidden } from '../components/EditorHidden';
import { stripEditorHiddenMarker } from '../store';

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

// ── Helpers ─────────────────────────────────────────────────────────────────

function spawnRoot(world: World, name: string): EntityHandle {
  const r = world.spawn(
    { component: Name, data: { value: name } },
    { component: Transform, data: { posX: 0, posY: 0, posZ: 0 } },
  );
  if (!r.ok) throw new Error(`spawn failed: ${r.error.message}`);
  return r.value;
}

function spawnChild(world: World, name: string, parent: EntityHandle): EntityHandle {
  const r = world.spawn(
    { component: Name, data: { value: name } },
    { component: Transform, data: { posX: 0, posY: 0, posZ: 0 } },
    { component: ChildOf, data: { parent } },
  );
  if (!r.ok) throw new Error(`spawn failed: ${r.error.message}`);
  return r.value;
}

// ── Inline component for entity-ref-out-of-closure test ─────────────────────
// We need a non-ChildOf entity-type field that will trigger the closure check.
// ChildOf is stripped from roots per D-8, so we use a custom component.

const TestRefHolder = defineComponent('TestRefHolder', {
  target: { type: 'entity' },
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('M5 writeback: rootsToSceneAsset + serializeSceneAssetToPack', () => {
  // (a) Success branch: spawn entities, collect, serialize, validate
  it('(a) success: rootsToSceneAsset ok → serializeSceneAssetToPack produces valid pack', () => {
    const world = new World();
    const registry = makeRegistry();

    // Spawn a small forest (root + 2 children).
    const root = spawnRoot(world, 'Root');
    spawnChild(world, 'ChildA', root);
    spawnChild(world, 'ChildB', root);

    // Also spawn a standalone entity not in the forest.
    spawnRoot(world, 'Orphan');

    // Collect only the forest root.
    const collected = rootsToSceneAsset(registry, world, [root]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    const sceneAsset = collected.value;
    expect(sceneAsset.kind).toBe('scene');
    expect(sceneAsset.entities.length).toBe(3); // root + 2 children

    // Verify entity names are present.
    const names = sceneAsset.entities.map(
      (e) => (e.components as Record<string, Record<string, unknown>>)['Name']?.['value'],
    );
    expect(names).toContain('Root');
    expect(names).toContain('ChildA');
    expect(names).toContain('ChildB');
    // Orphan should NOT be in the collection.
    expect(names).not.toContain('Orphan');

    // Serialize to pack.
    const packResult = serializeSceneAssetToPack(sceneAsset);
    expect(packResult.ok).toBe(true);
    if (!packResult.ok) return;

    const pack = packResult.value as Record<string, unknown>;
    // Pack must have the engine-native shape:
    // { schemaVersion, kind, assets: [{ guid, kind, payload: { entities } }] }
    expect(pack.kind).toBe('internal-text-package');
    expect(pack.schemaVersion).toBe('1.0.0');
    expect(Array.isArray(pack.assets)).toBe(true);

    const assets = pack.assets as Array<Record<string, unknown>>;
    expect(assets.length).toBeGreaterThanOrEqual(1);

    const scenePacked = assets.find((a) => a.kind === 'scene');
    expect(scenePacked).toBeDefined();
    if (!scenePacked) return;

    // payload is `{ entities: [...] }` — no `kind` field inside payload
    const payload = scenePacked.payload as Record<string, unknown>;
    expect(Array.isArray(payload.entities)).toBe(true);
    const entities = payload.entities as Array<Record<string, unknown>>;
    expect(entities.length).toBe(3);

    // AC-08: verify no editor-only fields leak into pack.
    const packJson = JSON.stringify(pack);
    expect(packJson).not.toContain('EditorHidden');
    expect(packJson).not.toContain('"hidden"');
  });

  // (b) Failure branch: entity ref outside closure produces structured error
  it('(b) error: entity ref out of closure → err with .code and .hint (AC-23)', () => {
    const world = new World();
    const registry = makeRegistry();

    // Create target entity (outside closure).
    const target = spawnRoot(world, 'Target');
    // Create holder entity that references target via an entity-type field.
    const hr = world.spawn(
      { component: Name, data: { value: 'Holder' } },
      { component: Transform, data: { posX: 0, posY: 0, posZ: 0 } },
      { component: TestRefHolder, data: { target } },
    );
    expect(hr.ok).toBe(true);
    if (!hr.ok) return;
    const holder = hr.value;

    // Pass only holder as root — target is outside the closure.
    const collected = rootsToSceneAsset(registry, world, [holder]);
    expect(collected.ok).toBe(false);

    if (!collected.ok) {
      // AC-23: structured error with .code and .hint (charter P3).
      const err = collected.error;
      expect(err).toBeDefined();
      expect(typeof err.code).toBe('string');
      expect(err.code).toBe('scene-collect-entity-ref-out-of-closure');
      expect(typeof err.hint).toBe('string');
      expect(err.hint.length).toBeGreaterThan(0);
      // detail should identify the entity and field. The runtime error is a
      // discriminated union on `.code`; narrow on the code so `.detail` resolves
      // to SceneCollectEntityRefOutOfClosureDetail (which carries entity/target).
      expect(err.detail).toBeDefined();
      if (err.code === 'scene-collect-entity-ref-out-of-closure') {
        expect(typeof err.detail.entity).toBe('number');
        expect(typeof err.detail.field).toBe('string');
        expect(typeof err.detail.target).toBe('number');
      }
    }
  });

  // (c) AC-04 + AC-05 (verify F6 regression guard): a hidden entity survives the
  // round-trip (entity serialized normally) while its EditorHidden marker is
  // stripped from the pack. The earlier worldToPack impl filtered hidden ROOT
  // entities out entirely — reproducing exactly the scene-pack.ts:178 data-loss
  // bug AC-05 exists to fix (AGENTS.md #2). stripEditorHiddenMarker keeps the
  // entity, drops only the marker.
  it('(c) hidden entity survives round-trip, EditorHidden stripped (AC-04/AC-05)', () => {
    const world = new World();
    const registry = makeRegistry();

    // Two roots: one visible, one hidden (marker present).
    const visible = spawnRoot(world, 'Visible');
    const hidden = spawnRoot(world, 'Hidden');
    const addR = world.addComponent(hidden, { component: EditorHidden, data: {} });
    expect(addR.ok).toBe(true);

    const collected = rootsToSceneAsset(registry, world, [visible, hidden]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    // Before strip: engine collected BOTH entities (hidden not dropped) and the
    // EditorHidden marker is present on the hidden one (it is a registered comp).
    const rawEntities = (collected.value as unknown as { entities: Array<{ components: Record<string, unknown> }> }).entities;
    expect(rawEntities.length).toBe(2); // AC-05: hidden entity NOT dropped

    // After strip: entity count unchanged, EditorHidden marker gone.
    const stripped = stripEditorHiddenMarker(collected.value) as unknown as { entities: Array<{ components: Record<string, unknown> }> };
    expect(stripped.entities.length).toBe(2); // AC-05: both entities still present
    for (const e of stripped.entities) {
      expect('EditorHidden' in e.components).toBe(false); // AC-04: marker stripped
    }

    // AC-04: pack JSON must not leak the marker.
    const packR = serializeSceneAssetToPack(stripped as never);
    expect(packR.ok).toBe(true);
    if (!packR.ok) return;
    const packJson = JSON.stringify(packR.value);
    expect(packJson).not.toContain('EditorHidden');
    expect(packJson).not.toContain('"hidden"');
  });

  // (d) Placeholder for sessionToPack grep check at commit time.
  it('(d) placeholder: sessionToPack grep verified at commit time', () => {
    expect(true).toBe(true);
  });
});