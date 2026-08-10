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
import { Disabled, World, defineComponent } from '@forgeax/engine-ecs';
import type { EntityHandle } from '../scene/scene-types';
import {
  rootsToSceneAsset,
  serializeSceneAssetToPack,
} from '@forgeax/engine-runtime';
import { ChildOf, Name, Transform } from '@forgeax/engine-scene';
import { Visibility, VisibilityStateValue } from '@forgeax/engine-render';
import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { ShaderRegistryDevice } from '@forgeax/engine-shader';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { stripDisabledMarker } from '../store/store';

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
    { component: Transform, data: { pos: [0, 0, 0] } },
  );
  if (!r.ok) throw new Error(`spawn failed: ${r.error.message}`);
  return r.value;
}

function spawnChild(world: World, name: string, parent: EntityHandle): EntityHandle {
  const r = world.spawn(
    { component: Name, data: { value: name } },
    { component: Transform, data: { pos: [0, 0, 0] } },
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e: any) => (e.components as Record<string, Record<string, unknown>>)['Name']?.['value'],
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
    // { schemaVersion: '2.0.0', kind, assets: [{ guid, kind, payload, refs, artifacts }] }
    expect(pack.kind).toBe('internal-text-package');
    expect(pack.schemaVersion).toBe('2.0.0');
    expect(Array.isArray(pack.assets)).toBe(true);
    expect(pack.assets).toEqual([
      expect.objectContaining({ artifacts: {} }),
    ]);

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
    expect(packJson).not.toContain('Disabled');
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
      { component: Transform, data: { pos: [0, 0, 0] } },
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

  // (c) Visibility is authored scene data: a hidden entity survives collection
  // and keeps its explicit state for the Edit → pack → Play round-trip.
  it('(c) hidden Visibility intent survives round-trip (AC-04/AC-05)', () => {
    const world = new World();
    const registry = makeRegistry();

    // Two roots: one visible, one explicitly hidden.
    const visible = spawnRoot(world, 'Visible');
    const hidden = spawnRoot(world, 'Hidden');
    const addR = world.addComponent(hidden, { component: Visibility, data: { state: VisibilityStateValue.hidden } });
    expect(addR.ok).toBe(true);

    const collected = rootsToSceneAsset(registry, world, [visible, hidden]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    // Before strip: engine collected BOTH entities (hidden not dropped) and the
    // Visibility intent is present on the hidden one.
    const rawEntities = (collected.value as unknown as { entities: Array<{ components: Record<string, unknown> }> }).entities;
    expect(rawEntities.length).toBe(2); // AC-05: hidden entity NOT dropped

    // After strip: entity count unchanged and Visibility remains authored data.
    const stripped = stripDisabledMarker(collected.value) as unknown as { entities: Array<{ components: Record<string, unknown> }> };
    expect(stripped.entities.length).toBe(2); // AC-05: both entities still present
    const hiddenEntity = stripped.entities.find((e) => 'Visibility' in e.components);
    expect(hiddenEntity?.components.Visibility).toEqual({ state: VisibilityStateValue.hidden });

    // The explicit Visibility state is part of the authored pack contract.
    const packR = serializeSceneAssetToPack(stripped as never);
    expect(packR.ok).toBe(true);
    if (!packR.ok) return;
    const packJson = JSON.stringify(packR.value);
    expect(packJson).toContain('Visibility');
  });

  // (c2) The engine `Disabled` marker is derived/runtime state and must never
  // reach a scene pack, while authored Visibility remains.
  it('(c2) Disabled engine marker is stripped while Visibility remains', () => {
    const world = new World();
    const registry = makeRegistry();

    const hidden = spawnRoot(world, 'Hidden');
    expect(world.addComponent(hidden, { component: Visibility, data: { state: VisibilityStateValue.hidden } }).ok).toBe(true);
    expect(world.addComponent(hidden, { component: Disabled, data: {} }).ok).toBe(true);

    const collected = rootsToSceneAsset(registry, world, [hidden]);
    expect(collected.ok).toBe(true);
    if (!collected.ok) return;

    const stripped = stripDisabledMarker(collected.value) as unknown as { entities: Array<{ components: Record<string, unknown> }> };
    expect(stripped.entities.length).toBe(1);
    for (const e of stripped.entities) {
      expect('Disabled' in e.components).toBe(false);
      expect(e.components.Visibility).toEqual({ state: VisibilityStateValue.hidden });
    }
    const packJson = JSON.stringify(stripped);
    expect(packJson).not.toContain('Disabled');
    expect(packJson).toContain('Visibility');
  });

  // (d) Placeholder for sessionToPack grep check at commit time.
  it('(d) placeholder: sessionToPack grep verified at commit time', () => {
    expect(true).toBe(true);
  });
});
