// m2-test-spawn-red — spawn native component assertions (RED stage)
//
// feat-20260701-editor-world-container-doc-ecs-collapse M2 / AC-06:
// Tests that spawnEntity via session.world produces correct engine native
// component fields. RED because:
//   (a) MeshRenderer is currently NOT auto-added when MeshFilter is present
//       (spawnComponentData only resolves tokens, doesn't add companion components).
//   (b) PointLight/DirectionalLight/SpotLight may already be GREEN because
//       spawnComponentData resolves engine component names via resolveToken (M1).
//
// Each test uses a real World, dispatches spawnEntity with engine component
// names, and asserts world.get(e, C) field values.
//
// Float assertions use toBeCloseTo(v, 5) — engine stores f32 which may round.
//
// Anchors:
//   plan-tasks.json m2-test-spawn-red: spawn + 3 lights world assertions
//   requirements AC-06: spawn no resolver seam, engine components
//   requirements AC-17: three independent lights
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
  Materials,
} from '@forgeax/engine-runtime';
import { applyCommand, createEditSession } from '../session/document';
import type { EditorOp, EditSession } from '../types';

// ── Test helpers ──────────────────────────────────────────────────────────────

// M7 / AC-15: sessions built via createEditSession + injected world; legacy ID
// → engine handle read via entHandle (doc.entities deleted).
function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

/** Dispatch spawnEntity with native engine component data and extract the engine
 *  entity handle via entHandle (world SSOT). */
function spawnNative(
  session: EditSession,
  name: string,
  components: Record<string, unknown>,
): EntityHandle {
  const cmd: EditorOp = { kind: 'spawnEntity', name, components };
  const r = applyCommand(session, cmd);
  if (!r.ok) throw new Error(`spawnCmd ${name} failed: ${r.error.hint}`);
  if ((cmd as any)._id === undefined) throw new Error('spawnCmd did not set ._id');
  // M3 (I1): handle IS identity — cmd._id is the real engine handle.
  return (cmd as any)._id as EntityHandle;
}

// ── Cube spawn ────────────────────────────────────────────────────────────────

describe('spawn entity — cube', () => {
  it('spawnMeshFilter cube: world has MeshFilter with assetHandle=HANDLE_CUBE', () => {
    const s = createSession();
    const eH = spawnNative(s, 'Cube', {
      MeshFilter: { assetHandle: HANDLE_CUBE },
    });
    const mf = s.world.get(eH, MeshFilter);
    expect(mf.ok).toBe(true);
    if (mf.ok) {
      expect(mf.value.assetHandle).toBe(HANDLE_CUBE);
    }
  });

  it('spawnMeshFilter cube: auto-adds an EMPTY MeshRenderer (engine default-material fallback)', () => {
    // A MeshFilter-only entity is archetype-absent in the engine's render walk
    // (`with: [MeshRenderer]`) and never drawn, so spawnComponentData must attach
    // a MeshRenderer. But it attaches an EMPTY `materials: []` — NOT a synthetic
    // MaterialAsset handle: an uncataloged handle makes save's `_guidForAsset`
    // return undefined -> SceneCollectAssetGuidUnresolvedError -> the whole write
    // aborts. Empty materials route through the engine's own default-material
    // fallback (defaultMaterialSnapshot mid-grey) and serialize with zero handles
    // to resolve, so save succeeds.
    const s = createSession();
    const eH = spawnNative(s, 'Cube', {
      MeshFilter: { assetHandle: HANDLE_CUBE },
    });
    const mr = s.world.get(eH, MeshRenderer);
    expect(mr.ok).toBe(true);
    if (mr.ok) {
      const mats = mr.value.materials as ReadonlyArray<unknown>;
      expect(mats.length).toBe(0);
    }
  });
});

// ── Cylinder spawn ────────────────────────────────────────────────────────────

describe('spawn entity — cylinder', () => {
  it('spawnMeshFilter cylinder: world has MeshFilter with assetHandle=HANDLE_CYLINDER', () => {
    const s = createSession();
    const eH = spawnNative(s, 'Cylinder', {
      MeshFilter: { assetHandle: HANDLE_CYLINDER },
    });
    const mf = s.world.get(eH, MeshFilter);
    expect(mf.ok).toBe(true);
    if (mf.ok) {
      expect(mf.value.assetHandle).toBe(HANDLE_CYLINDER);
    }
  });
});

// ── PointLight spawn ──────────────────────────────────────────────────────────

describe('spawn entity — PointLight', () => {
  it('spawn PointLight: world has PointLight with default fields', () => {
    const s = createSession();
    const eH = spawnNative(s, 'Point', {
      PointLight: {},
    });
    const pl = s.world.get(eH, PointLight);
    expect(pl.ok).toBe(true);
    if (pl.ok) {
      expect(pl.value.colorR).toBeCloseTo(1, 5);
      expect(pl.value.colorG).toBeCloseTo(1, 5);
      expect(pl.value.colorB).toBeCloseTo(1, 5);
      expect(pl.value.intensity).toBeCloseTo(1, 5);
      expect(pl.value.range).toBeCloseTo(10, 5);
    }
  });
});

// ── DirectionalLight spawn ────────────────────────────────────────────────────

describe('spawn entity — DirectionalLight', () => {
  it('spawn DirectionalLight: world has DirectionalLight with required+default fields', () => {
    const s = createSession();
    const eH = spawnNative(s, 'Sun', {
      DirectionalLight: {
        directionX: 0, directionY: -1, directionZ: 0.5,
      },
    });
    const dl = s.world.get(eH, DirectionalLight);
    expect(dl.ok).toBe(true);
    if (dl.ok) {
      expect(dl.value.directionX).toBeCloseTo(0, 5);
      expect(dl.value.directionY).toBeCloseTo(-1, 5);
      expect(dl.value.directionZ).toBeCloseTo(0.5, 5);
      expect(dl.value.colorR).toBeCloseTo(1, 5);
      expect(dl.value.colorG).toBeCloseTo(1, 5);
      expect(dl.value.colorB).toBeCloseTo(1, 5);
      expect(dl.value.intensity).toBeCloseTo(1, 5);
    }
  });
});

// ── SpotLight spawn ───────────────────────────────────────────────────────────

describe('spawn entity — SpotLight', () => {
  it('spawn SpotLight: world has SpotLight with required+default fields', () => {
    const s = createSession();
    const eH = spawnNative(s, 'Spot', {
      SpotLight: {
        directionX: 0, directionY: -1, directionZ: 0,
      },
    });
    const sl = s.world.get(eH, SpotLight);
    expect(sl.ok).toBe(true);
    if (sl.ok) {
      expect(sl.value.directionX).toBeCloseTo(0, 5);
      expect(sl.value.directionY).toBeCloseTo(-1, 5);
      expect(sl.value.directionZ).toBeCloseTo(0, 5);
      expect(sl.value.colorR).toBeCloseTo(1, 5);
      expect(sl.value.colorG).toBeCloseTo(1, 5);
      expect(sl.value.colorB).toBeCloseTo(1, 5);
      expect(sl.value.intensity).toBeCloseTo(1, 5);
      expect(sl.value.range).toBeCloseTo(10, 5);
    }
  });
});

// ── Transform verification ────────────────────────────────────────────────────

describe('spawn entity — Transform baseline', () => {
  it('spawnCube: entity has Transform with default quat identity', () => {
    const s = createSession();
    const eH = spawnNative(s, 'HasTransform', {
      MeshFilter: { assetHandle: HANDLE_CUBE },
    });
    const tr = s.world.get(eH, Transform);
    expect(tr.ok).toBe(true);
    if (tr.ok) {
      expect(tr.value.quatX).toBeCloseTo(0, 5);
      expect(tr.value.quatY).toBeCloseTo(0, 5);
      expect(tr.value.quatZ).toBeCloseTo(0, 5);
      expect(tr.value.quatW).toBeCloseTo(1, 5);
      expect(tr.value.posX).toBeCloseTo(0, 5);
      expect(tr.value.posY).toBeCloseTo(0, 5);
      expect(tr.value.posZ).toBeCloseTo(0, 5);
      expect(tr.value.scaleX).toBeCloseTo(1, 5);
      expect(tr.value.scaleY).toBeCloseTo(1, 5);
      expect(tr.value.scaleZ).toBeCloseTo(1, 5);
    }
  });
});

// ── Name verification ─────────────────────────────────────────────────────────

describe('spawn entity — Name baseline', () => {
  it('spawnCube: entity has Name=given name', () => {
    const s = createSession();
    const eH = spawnNative(s, 'MyNamedCube', {
      MeshFilter: { assetHandle: HANDLE_CUBE },
    });
    const nm = s.world.get(eH, Name);
    expect(nm.ok).toBe(true);
    if (nm.ok) {
      expect(nm.value.value).toBe('MyNamedCube');
    }
  });
});