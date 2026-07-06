// m2-test-preset-red — preset native component assertions (RED stage)
//
// feat-20260701-editor-world-container-doc-ecs-collapse M2 / AC-18:
// Tests that ENTITY_PRESETS produce correct engine native component
// combinations. RED because the old presets use editor-native component
// names ('Mesh', 'Material', 'Light', 'Collider', 'Anim', 'MatGraph')
// that cannot be resolved by resolveToken → only Name + Transform end up
// on the spawned entity.
//
// After m2-impl-preset rewrites presets to engine-native component
// combinations (MeshFilter/MeshRenderer/PointLight/SpotLight/DirectionalLight),
// these assertions turn GREEN.
//
// Test approach: use buildPresetComponents() output as spawnEntity components,
// then assert world.get(e, C) for expected engine components.
//
// Anchors:
//   plan-tasks.json m2-test-preset-red: Object/Ground/Character/3 lights
//   requirements AC-18: preset = engine component composition
//   requirements AC-17: 3 independent light presets
//   plan-strategy S2 D-3: Light scheme A
//   research F-EngineComponents: verbatim field names

import { describe, expect, it } from 'bun:test';
import { World } from '@forgeax/engine-ecs';
import type { EntityHandle } from '../scene/scene-types';
import {
  MeshFilter,
  MeshRenderer,
  Transform,
  Name,
  PointLight,
  DirectionalLight,
  SpotLight,
  HANDLE_CUBE,
  HANDLE_CYLINDER,
} from '@forgeax/engine-runtime';
import { applyCommand, createEditSession } from '../session/document';
import { entHandle } from '../store/entity-state';
import { ENTITY_PRESETS, buildPresetComponents, getPreset } from '../scene/presets';
import type { EditorCommand, EditSession } from '../types';

// ── Test helpers ──────────────────────────────────────────────────────────────

// M7 / AC-15: sessions built via createEditSession + injected world; legacy ID
// → engine handle read via entHandle (doc.entities deleted).
function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

function presetSpawn(
  session: EditSession,
  presetLabel: string,
): EntityHandle {
  const preset = getPreset(presetLabel);
  if (!preset) throw new Error(`preset ${presetLabel} not found`);
  const components = buildPresetComponents(preset);
  const cmd: EditorCommand = { kind: 'spawnEntity', name: preset.label, components };
  const r = applyCommand(session, cmd);
  if (!r.ok) throw new Error(`preset spawn ${presetLabel} failed: ${r.error.hint}`);
  if (cmd._id === undefined) throw new Error('spawnCmd did not set ._id');
  const engineHandle = entHandle(session, cmd._id);
  if (engineHandle === undefined) throw new Error(`no engineHandle for legacyId ${cmd._id}`);
  return engineHandle;
}

// ── Object preset ─────────────────────────────────────────────────────────────

describe('preset — Object', () => {
  it('Object preset: RED — MeshFilter{assetHandle:HANDLE_CUBE} exists on world entity', () => {
    // RED: old Object preset uses 'Material' not 'MeshFilter'
    // → resolveToken('Material') returns undefined → no MeshFilter spawned
    const s = createSession();
    const eH = presetSpawn(s, 'Object');
    const mf = s.world.get(eH, MeshFilter);
    // After impl, this turns GREEN: preset has MeshFilter{HANDLE_CUBE}
    expect(mf.ok).toBe(true);
    if (mf.ok) {
      expect(mf.value.assetHandle).toBe(HANDLE_CUBE);
    }
  });

  it('Object preset: MeshRenderer exists with EMPTY materials (engine default-material fallback)', () => {
    // The Object preset carries a MeshFilter; spawnComponentData auto-adds a
    // MeshRenderer so the entity is renderable. That MeshRenderer has EMPTY
    // materials (NOT a synthetic uncataloged MaterialAsset handle, which would
    // abort save via SceneCollectAssetGuidUnresolvedError) — the engine's own
    // default-material fallback paints it mid-grey and it serializes cleanly.
    const s = createSession();
    const eH = presetSpawn(s, 'Object');
    const mr = s.world.get(eH, MeshRenderer);
    expect(mr.ok).toBe(true);
    if (mr.ok) {
      const mats = mr.value.materials as ReadonlyArray<unknown>;
      expect(mats.length).toBe(0);
    }
  });
});

// ── Ground preset ─────────────────────────────────────────────────────────────

describe('preset — Ground', () => {
  it('Ground preset: RED — MeshFilter + MeshRenderer exist', () => {
    // RED: old Ground preset uses 'Mesh'/'Material' which don't resolve
    const s = createSession();
    const eH = presetSpawn(s, 'Ground');
    const mf = s.world.get(eH, MeshFilter);
    expect(mf.ok).toBe(true);
    const mr = s.world.get(eH, MeshRenderer);
    expect(mr.ok).toBe(true);
  });
});

// ── Character preset ──────────────────────────────────────────────────────────

describe('preset — Character', () => {
  it('Character preset: RED — MeshFilter{HANDLE_CYLINDER} + MeshRenderer exist', () => {
    // RED: old Character uses 'Mesh{kind:cylinder}' which doesn't resolve
    const s = createSession();
    const eH = presetSpawn(s, 'Character');
    const mf = s.world.get(eH, MeshFilter);
    expect(mf.ok).toBe(true);
    if (mf.ok) {
      expect(mf.value.assetHandle).toBe(HANDLE_CYLINDER);
    }
    const mr = s.world.get(eH, MeshRenderer);
    expect(mr.ok).toBe(true);
  });
});

// ── PointLight preset ─────────────────────────────────────────────────────────

describe('preset — Point Light', () => {
  it('Point Light preset: RED — new preset label exists and spawns PointLight', () => {
    // RED: old 'Light' preset doesn't exist under 'Point Light'; even
    // the old 'Light' preset uses Light+type enum which doesn't resolve.
    const s = createSession();
    const p = getPreset('Point Light');
    // After impl, 'Point Light' is a new, valid preset entry
    expect(p).toBeDefined();
    if (!p) return; // RED short-circuit — no preset yet
    const components = buildPresetComponents(p);
    const cmd: EditorCommand = { kind: 'spawnEntity', name: p.label, components };
    const r = applyCommand(s, cmd);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (cmd._id === undefined) return;
    const eH = entHandle(s, cmd._id);
    if (eH === undefined) return;
    const pl = s.world.get(eH, PointLight);
    expect(pl.ok).toBe(true);
    if (pl.ok) {
      expect(pl.value.colorR).toBeCloseTo(1, 5);
      expect(pl.value.colorG).toBeCloseTo(1, 5);
      expect(pl.value.colorB).toBeCloseTo(1, 5);
    }
  });
});

// ── Spot Light preset ─────────────────────────────────────────────────────────

describe('preset — Spot Light', () => {
  it('Spot Light preset: RED — new preset label exists and spawns SpotLight', () => {
    const s = createSession();
    const p = getPreset('Spot Light');
    expect(p).toBeDefined();
    if (!p) return;
    const components = buildPresetComponents(p);
    const cmd: EditorCommand = { kind: 'spawnEntity', name: p.label, components };
    const r = applyCommand(s, cmd);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (cmd._id === undefined) return;
    const eH = entHandle(s, cmd._id);
    if (eH === undefined) return;
    const sl = s.world.get(eH, SpotLight);
    expect(sl.ok).toBe(true);
    if (sl.ok) {
      expect(sl.value.colorR).toBeCloseTo(1, 5);
      expect(sl.value.colorG).toBeCloseTo(1, 5);
      expect(sl.value.colorB).toBeCloseTo(1, 5);
    }
  });
});

// ── Directional Light preset ──────────────────────────────────────────────────

describe('preset — Directional Light', () => {
  it('Directional Light preset: RED — new preset label exists and spawns DirectionalLight', () => {
    const s = createSession();
    const p = getPreset('Directional Light');
    expect(p).toBeDefined();
    if (!p) return;
    const components = buildPresetComponents(p);
    const cmd: EditorCommand = { kind: 'spawnEntity', name: p.label, components };
    const r = applyCommand(s, cmd);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (cmd._id === undefined) return;
    const eH = entHandle(s, cmd._id);
    if (eH === undefined) return;
    const dl = s.world.get(eH, DirectionalLight);
    expect(dl.ok).toBe(true);
    if (dl.ok) {
      expect(dl.value.colorR).toBeCloseTo(1, 5);
      expect(dl.value.colorG).toBeCloseTo(1, 5);
      expect(dl.value.colorB).toBeCloseTo(1, 5);
    }
  });
});

// ── Animated/MatGraph removal ─────────────────────────────────────────────────

describe('preset — removal of Animated/MatGraph', () => {
  it('Animated preset: RED — no longer exists in ENTITY_PRESETS', () => {
    // RED: old presets have 'Animated' and 'MatGraph' entries
    const animatedPreset = getPreset('Animated');
    // After impl, these presets are deleted → undefined
    expect(animatedPreset).toBeUndefined();
  });

  it('MatGraph preset: RED — no longer exists in ENTITY_PRESETS', () => {
    const matgraphPreset = getPreset('MatGraph');
    expect(matgraphPreset).toBeUndefined();
  });
});