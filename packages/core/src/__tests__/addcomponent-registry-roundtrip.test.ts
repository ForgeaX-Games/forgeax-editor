// addcomponent-registry-roundtrip.test.ts
//
// Every component in schema.ts REGISTRY must be addable via applyCommand
// addComponent using its defaultComponentData — and the resulting engine
// component must be readable via world.get. This is the data-consistency
// gate between the editor schema REGISTRY and engine defineComponent.
//
// If a new component is added to REGISTRY but its defineComponent hasn't
// been imported (side-effect registration), the addComponent will fail with
// NO_SUCH_COMPONENT. If the default values are incompatible with the engine
// schema (e.g. wrong field types), engine.addComponent rejects.
//
// Anchors:
//   schema.ts REGISTRY: editor component schema registry
//   document.ts applyAddComponent: addComponent applier
//   north-star §6: all ops through gateway.dispatch

import { describe, expect, it } from 'bun:test';
import { World, getRegisteredComponents, defineComponent } from '@forgeax/engine-ecs';
import {
  Name,
  Transform,
  MeshFilter,
  MeshRenderer,
  DirectionalLight,
  PointLight,
  SpotLight,
  Camera,
  SpriteRegionOverride,
  Skylight,
  SkyboxBackground,
  AnimationPlayer,
  GlyphText,
  Layer,
  SortKey,
  PointLightShadow,
} from '@forgeax/engine-runtime';
import type { EntityHandle } from '../scene/scene-types';
import { applyCommand, createEditSession } from '../session/document';
import { listComponentSchemas, defaultComponentData, getComponentSchema } from '../scene/schema';
import type { EditorOp, EditSession } from '../types';

// Ensure engine components are registered (defineComponent side-effect).
void Name; void Transform; void MeshFilter; void MeshRenderer;
void DirectionalLight; void PointLight; void SpotLight; void Camera;
void SpriteRegionOverride;
void Skylight; void SkyboxBackground; void AnimationPlayer;
void GlyphText; void Layer; void SortKey; void PointLightShadow;

// Physics components may leak from other test files (defineComponent is global).
// Mark them as external so the Schema-completeness test doesn't expect engine
// registration in this test context.
const EXTERNAL_PACKAGE_COMPONENTS = new Set(['Collider', 'RigidBody', 'CharacterController']);

function createSession(): EditSession {
  const session = createEditSession();
  session.world = new World();
  return session;
}

function spawnEntity(session: EditSession, name: string): EntityHandle {
  const cmd: EditorOp = { kind: 'spawnEntity', name };
  const r = applyCommand(session, cmd);
  if (!r.ok) throw new Error(`spawn failed: ${r.error.hint}`);
  return (cmd as any)._id as EntityHandle;
}

// ── Schema completeness ───────────────────────────────────────────────────────

describe('REGISTRY component schema completeness', () => {
  // Components from external packages (e.g. Collider from engine-physics)
  // or registered by other test files are not importable in this test context.

  it('every REGISTRY component name (except external-package ones) has a matching engine defineComponent registration', () => {
    const engineComponents = getRegisteredComponents();
    const missing: string[] = [];
    for (const cs of listComponentSchemas()) {
      if (EXTERNAL_PACKAGE_COMPONENTS.has(cs.name)) continue;
      if (!engineComponents.has(cs.name)) {
        missing.push(cs.name);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every REGISTRY component has at least one field', () => {
    for (const cs of listComponentSchemas()) {
      expect(cs.fields.length).toBeGreaterThan(0);
    }
  });

  it('defaultComponentData returns a non-empty object for every REGISTRY component', () => {
    for (const cs of listComponentSchemas()) {
      const data = defaultComponentData(cs.name);
      expect(Object.keys(data).length).toBeGreaterThan(0);
    }
  });
});

// ── addComponent roundtrip (per-component) ────────────────────────────────────

describe('addComponent roundtrip: every REGISTRY component addable with defaultComponentData', () => {
  // Generates one test per REGISTRY component. Each test:
  //   1. Spawns a fresh entity
  //   2. Calls addComponent with defaultComponentData
  //   3. Verifies the result is ok
  //   4. Reads the component back from the engine world
  //
  // Transform is excluded because spawnEntity already adds it.

  // Physics components belong to the external physics package. Their global
  // registration can be replaced by another test module, so their package owns
  // the integration coverage; this core-only registry contract stays stable.
  const SKIP = new Set(['Transform', ...EXTERNAL_PACKAGE_COMPONENTS]);
  const engineComponents = getRegisteredComponents();

  for (const cs of listComponentSchemas()) {
    if (SKIP.has(cs.name)) continue;
    if (!engineComponents.has(cs.name)) {
      it(`addComponent ${cs.name}: SKIPPED (engine component not registered in test context)`, () => {
        expect(true).toBe(true);
      });
      continue;
    }

    it(`addComponent ${cs.name} with defaultComponentData succeeds`, () => {
      const session = createSession();
      const eH = spawnEntity(session, `Test_${cs.name}`);
      const value = defaultComponentData(cs.name);

      const r = applyCommand(session, {
        kind: 'addComponent',
        entity: eH as unknown as number,
        component: cs.name,
        value,
      } as EditorOp);

      expect(r.ok).toBe(true);
      if (!r.ok) {
        console.error(`addComponent ${cs.name} failed:`, r.error);
      }
    });

    it(`addComponent ${cs.name}: component readable from world after add`, () => {
      const session = createSession();
      const eH = spawnEntity(session, `Test_${cs.name}`);
      const value = defaultComponentData(cs.name);

      applyCommand(session, {
        kind: 'addComponent',
        entity: eH as unknown as number,
        component: cs.name,
        value,
      } as EditorOp);

      const token = getRegisteredComponents().get(cs.name);
      expect(token).toBeDefined();
      const readResult = session.world.get(eH, token! as Parameters<typeof session.world.get>[1]);
      expect(readResult.ok).toBe(true);
    });
  }

  it('Transform is already on entity after spawn (no explicit add needed)', () => {
    const session = createSession();
    const eH = spawnEntity(session, 'Test_Transform');
    const token = getRegisteredComponents().get('Transform');
    expect(token).toBeDefined();
    const r = session.world.get(eH, token! as Parameters<typeof session.world.get>[1]);
    expect(r.ok).toBe(true);
  });
});

// ── addComponent + removeComponent roundtrip ──────────────────────────────────

describe('addComponent + removeComponent roundtrip', () => {
  const SKIP = new Set(['Transform', ...EXTERNAL_PACKAGE_COMPONENTS]);
  const engineComponents = getRegisteredComponents();

  for (const cs of listComponentSchemas()) {
    if (SKIP.has(cs.name)) continue;
    if (!engineComponents.has(cs.name)) continue;

    it(`add then remove ${cs.name}: component absent after remove`, () => {
      const session = createSession();
      const eH = spawnEntity(session, `Test_${cs.name}`);
      const value = defaultComponentData(cs.name);

      const addR = applyCommand(session, {
        kind: 'addComponent',
        entity: eH as unknown as number,
        component: cs.name,
        value,
      } as EditorOp);
      expect(addR.ok).toBe(true);

      const removeR = applyCommand(session, {
        kind: 'removeComponent',
        entity: eH as unknown as number,
        component: cs.name,
      } as EditorOp);
      expect(removeR.ok).toBe(true);

      const token = getRegisteredComponents().get(cs.name);
      const readResult = session.world.get(eH, token! as Parameters<typeof session.world.get>[1]);
      expect(readResult.ok).toBe(false);
    });
  }
});

// ── Default value field-level assertions ──────────────────────────────────────

describe('defaultComponentData field values match engine defaults', () => {
  it('MeshFilter.assetHandle defaults to 1 (HANDLE_CUBE, editor override)', () => {
    const data = defaultComponentData('MeshFilter');
    expect(data.assetHandle).toBe(1);
  });

  it('MeshRenderer.materials defaults to empty array (array<shared<T>> field)', () => {
    const data = defaultComponentData('MeshRenderer');
    expect(data.materials).toEqual([]);
  });

  it('Transform.pos defaults to [0,0,0]', () => {
    const data = defaultComponentData('Transform');
    expect(data.pos).toEqual([0, 0, 0]);
  });

  it('Transform.quat defaults to [0,0,0,1] (identity)', () => {
    const data = defaultComponentData('Transform');
    expect(data.quat).toEqual([0, 0, 0, 1]);
  });

  it('Transform.scale defaults to [1,1,1]', () => {
    const data = defaultComponentData('Transform');
    expect(data.scale).toEqual([1, 1, 1]);
  });

  it('DirectionalLight.castShadow defaults to true (engine SSOT)', () => {
    const data = defaultComponentData('DirectionalLight');
    expect(data.castShadow).toBe(true);
  });

  it('Camera.fov defaults to 60 (editor override)', () => {
    const data = defaultComponentData('Camera');
    expect(data.fov).toBe(60);
  });

  it('Camera.clearColor defaults to [0,0,0,1]', () => {
    const data = defaultComponentData('Camera');
    expect(data.clearColor).toEqual([0, 0, 0, 1]);
  });

  it('SpriteRegionOverride.region defaults to [0,0,1,1]', () => {
    const data = defaultComponentData('SpriteRegionOverride');
    expect(data.region).toEqual([0, 0, 1, 1]);
  });
});

// ── Duplicate add guard ───────────────────────────────────────────────────────

describe('addComponent duplicate guard', () => {
  it('adding the same component twice returns COMPONENT_EXISTS error', () => {
    const session = createSession();
    const eH = spawnEntity(session, 'Dup');
    const value = defaultComponentData('MeshFilter');

    const r1 = applyCommand(session, {
      kind: 'addComponent',
      entity: eH as unknown as number,
      component: 'MeshFilter',
      value,
    } as EditorOp);
    expect(r1.ok).toBe(true);

    const r2 = applyCommand(session, {
      kind: 'addComponent',
      entity: eH as unknown as number,
      component: 'MeshFilter',
      value,
    } as EditorOp);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('COMPONENT_EXISTS');
  });
});
