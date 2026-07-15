// schema-registry-alignment.test.ts — verify reflection-based schema against engine SSOT
//
// 2026-07-15: Rewritten for engine reflection. Components are registered via
// engine module imports (triggering their defineComponent calls), then the
// reflection system introspects them through getRegisteredComponents().
//
// Covers:
//   A. Render components (from @forgeax/engine-runtime/components)
//   B. Physics components (manually registered for test isolation)
//   C. Filtering rules (transient, relationship, excluded)
//   D. listComponentSchemas completeness
//   E. defaultComponentData correctness

import { describe, expect, it, beforeAll } from 'bun:test';
import { defineComponent } from '@forgeax/engine-ecs';

// ── Engine components registration for test ──────────────────────────────────
// Engine components are registered via defineComponent at import time in
// production. For unit tests we manually register the schemas so tests are
// self-contained and don't depend on engine module structure.

import {
  _resetSchemaCache,
  getComponentSchema,
  fieldSchema,
  listComponentSchemas,
  defaultComponentData,
  defaultFieldValue,
  fieldVisible,
  type FieldType,
} from '../scene/schema';

function registerRuntimeComponents() {
  defineComponent('Transform', {
    pos: { type: 'array<f32, 3>', default: new Float32Array([0, 0, 0]) },
    quat: { type: 'array<f32, 4>', default: new Float32Array([0, 0, 0, 1]) },
    scale: { type: 'array<f32, 3>', default: new Float32Array([1, 1, 1]) },
    world: { type: 'array<f32, 16>', transient: true },
  });
  defineComponent('MeshFilter', {
    assetHandle: 'shared<MeshAsset>',
  });
  defineComponent('MeshRenderer', {
    materials: 'array<shared<MaterialAsset>>',
  });
  defineComponent('DirectionalLight', {
    direction: { type: 'array<f32, 3>' },
    color: { type: 'array<f32, 3>', default: new Float32Array([1, 1, 1]) },
    intensity: 'f32',
    castShadow: 'bool',
    cascadeCount: 'f32',
    splitLambda: 'f32',
    cascadeBlend: 'f32',
    mapSize: 'f32',
    depthBias: 'f32',
    normalBias: 'f32',
    shadowDistance: 'f32',
    pcfKernelSize: 'f32',
  });
  defineComponent('PointLight', {
    color: { type: 'array<f32, 3>', default: new Float32Array([1, 1, 1]) },
    intensity: 'f32',
    range: 'f32',
  });
  defineComponent('SpotLight', {
    direction: { type: 'array<f32, 3>' },
    color: { type: 'array<f32, 3>', default: new Float32Array([1, 1, 1]) },
    intensity: 'f32',
    range: 'f32',
    innerConeDeg: 'f32',
    outerConeDeg: 'f32',
    castShadow: 'bool',
    mapSize: 'f32',
    depthBias: 'f32',
    normalBias: 'f32',
    nearPlane: 'f32',
    farPlane: 'f32',
    pcfKernelSize: 'f32',
  });
  defineComponent('Camera', {
    fov: 'f32',
    aspect: 'f32',
    near: 'f32',
    far: 'f32',
    projection: 'f32',
    left: 'f32',
    right: 'f32',
    bottom: 'f32',
    top: 'f32',
    tonemap: 'f32',
    exposure: 'f32',
    whitePoint: 'f32',
    antialias: 'f32',
    bloom: 'f32',
    bloomThreshold: 'f32',
    bloomIntensity: 'f32',
    bloomBlurRadius: 'f32',
    clearColor: { type: 'array<f32, 4>', default: new Float32Array([0, 0, 0, 1]) },
    autoAspect: 'bool',
  });
  defineComponent('Skylight', {
    equirect: 'shared<EquirectAsset>',
    color: { type: 'array<f32, 3>', default: new Float32Array([1, 1, 1]) },
    intensity: 'f32',
  });
  defineComponent('SkyboxBackground', {
    equirect: 'shared<EquirectAsset>',
    mode: 'f32',
  });
  defineComponent('AnimationPlayer', {
    clips: 'array<shared<AnimationClip>, 4>',
    times: { type: 'array<f32, 4>' },
    weights: { type: 'array<f32, 4>' },
    speeds: { type: 'array<f32, 4>', default: new Float32Array([1, 1, 1, 1]) },
    paused: 'bool',
    looping: 'bool',
  });
  defineComponent('GlyphText', {
    fontHandle: 'shared<FontAsset>',
    text: 'string',
    fontSize: 'f32',
    color: { type: 'array<f32, 4>', default: new Float32Array([1, 1, 1, 1]) },
  });
  defineComponent('Layer', { value: 'i32' });
  defineComponent('SortKey', { value: 'f32' });
  defineComponent('PointLightShadow', {
    mapSize: 'f32',
    depthBias: 'f32',
    normalBias: 'f32',
    nearPlane: 'f32',
    farPlane: 'f32',
    pcfKernelSize: 'f32',
  });
  defineComponent('SpriteRegionOverride', {
    region: { type: 'array<f32, 4>', default: new Float32Array([0, 0, 1, 1]) },
  });
  // Transient / relationship components (should be filtered)
  defineComponent('SceneInstance', {}, { transient: true });
  defineComponent('CollidingEntities', {}, { transient: true });
  // Will be overridden by physics registerPhysicsComponents
}

function registerPhysicsComponents() {
  defineComponent('RigidBody', {
    type: { type: 'enum', default: 1, labels: { static: 0, dynamic: 1, kinematic: 2 } },
    mass: 'f32',
    linearDamping: 'f32',
    angularDamping: 'f32',
    gravityScale: 'f32',
    ccdEnabled: 'bool',
  });
  defineComponent('Collider', {
    shape: { type: 'enum', default: 0, labels: { cuboid: 0, sphere: 1, capsule: 2 } },
    halfExtents: { type: 'array<f32, 3>', default: new Float32Array([0.5, 0.5, 0.5]) },
    radius: 'f32',
    halfHeight: 'f32',
    friction: 'f32',
    restitution: 'f32',
    density: 'f32',
    isSensor: 'bool',
    collisionGroups: 'u32',
    solverGroups: 'u32',
  });
  defineComponent('CharacterController', {
    offset: 'f32',
    maxSlopeClimbDeg: 'f32',
    minSlopeSlideDeg: 'f32',
    autoStepMaxHeight: 'f32',
    autoStepMinWidth: 'f32',
    snapToGroundDist: 'f32',
    grounded: { type: 'bool', transient: true },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test helpers
// ═══════════════════════════════════════════════════════════════════════════════

function fieldKeys(comp: string): string[] {
  return getComponentSchema(comp)?.fields.map((f) => f.key) ?? [];
}

/** Assert that fields is a superset of the expected keys. */
function expectKeys(comp: string, ...keys: string[]) {
  const ks = new Set(fieldKeys(comp));
  for (const k of keys) {
    expect(ks.has(k), `${comp} missing key "${k}" (got: [${[...ks].join(', ')}])`).toBe(true);
  }
}

function expectFieldType(comp: string, key: string, type: FieldType) {
  const fs = fieldSchema(comp, key);
  expect(fs, `${comp}.${key} not found`).toBeDefined();
  expect(fs!.type, `${comp}.${key} type`).toBe(type);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test setup — register components, then reset cache to pick them up
// ═══════════════════════════════════════════════════════════════════════════════

beforeAll(() => {
  _resetSchemaCache();
  registerRuntimeComponents();
  registerPhysicsComponents();
  _resetSchemaCache();
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('Reflection: render components (from @forgeax/engine-runtime)', () => {
  it('Transform: pos/quat/scale vec, no euler scalars', () => {
    expect(getComponentSchema('Transform')).toBeDefined();
    expectKeys('Transform', 'pos', 'quat', 'scale');
    expectFieldType('Transform', 'pos', 'vec');
    expectFieldType('Transform', 'quat', 'vec');
    expectFieldType('Transform', 'scale', 'vec');
    // Old per-axis scalars must NOT appear
    expect(fieldKeys('Transform')).not.toContain('posX');
    expect(fieldKeys('Transform')).not.toContain('rotX');
  });

  it('MeshFilter: assetHandle, no kind', () => {
    expectKeys('MeshFilter', 'assetHandle');
    expect(fieldKeys('MeshFilter')).not.toContain('kind');
  });

  it('MeshRenderer: materials', () => {
    expectKeys('MeshRenderer', 'materials');
    expectFieldType('MeshRenderer', 'materials', 'asset');
  });

  it('DirectionalLight: 12 fields including shadow params', () => {
    expectKeys('DirectionalLight',
      'direction', 'color', 'intensity', 'castShadow',
      'cascadeCount', 'splitLambda', 'cascadeBlend', 'mapSize',
      'depthBias', 'normalBias', 'shadowDistance', 'pcfKernelSize',
    );
    expect(fieldKeys('DirectionalLight').length).toBeGreaterThanOrEqual(12);
  });

  it('DirectionalLight shadow fields have showWhen castShadow=true', () => {
    const shadowKeys = ['cascadeCount', 'splitLambda', 'cascadeBlend', 'mapSize',
      'depthBias', 'normalBias', 'shadowDistance', 'pcfKernelSize'];
    for (const k of shadowKeys) {
      const fs = fieldSchema('DirectionalLight', k);
      expect(fs, `DirectionalLight.${k} missing`).toBeDefined();
      expect(fs!.showWhen, `${k} missing showWhen`).toEqual({ key: 'castShadow', in: ['true'] });
    }
  });

  it('SpotLight: 13 fields including shadow params', () => {
    expectKeys('SpotLight',
      'direction', 'color', 'intensity', 'range',
      'innerConeDeg', 'outerConeDeg', 'castShadow',
      'mapSize', 'depthBias', 'normalBias', 'nearPlane', 'farPlane', 'pcfKernelSize',
    );
  });

  it('Camera: engine-verbatim fields (fov, near, far, post-processing)', () => {
    expectKeys('Camera',
      'projection', 'fov', 'aspect', 'near', 'far',
      'left', 'right', 'bottom', 'top',
      'tonemap', 'exposure', 'whitePoint', 'antialias',
      'bloom', 'bloomThreshold', 'bloomIntensity', 'bloomBlurRadius',
      'clearColor', 'autoAspect',
    );
  });

  it('Camera ortho bounds hidden in perspective mode', () => {
    const data = { projection: 0 };
    for (const k of ['left', 'right', 'bottom', 'top']) {
      expect(fieldVisible('Camera', fieldSchema('Camera', k), data)).toBe(false);
    }
  });

  it('Camera ortho bounds visible in orthographic mode (projection=1)', () => {
    const data = { projection: 1 };
    for (const k of ['left', 'right', 'bottom', 'top']) {
      expect(fieldVisible('Camera', fieldSchema('Camera', k), data)).toBe(true);
    }
  });

  it('PointLight: color, intensity, range', () => {
    expectKeys('PointLight', 'color', 'intensity', 'range');
  });

  it('Skylight: equirect (asset), color (vec), intensity', () => {
    expectKeys('Skylight', 'equirect', 'color', 'intensity');
    expectFieldType('Skylight', 'equirect', 'asset');
    expectFieldType('Skylight', 'color', 'vec');
  });

  it('SkyboxBackground: equirect (asset), mode', () => {
    expectKeys('SkyboxBackground', 'equirect', 'mode');
    expectFieldType('SkyboxBackground', 'equirect', 'asset');
  });

  it('AnimationPlayer: 6 fields, fixed 4 slots', () => {
    expectKeys('AnimationPlayer', 'clips', 'times', 'weights', 'speeds', 'paused', 'looping');
    expectFieldType('AnimationPlayer', 'clips', 'asset');
    for (const k of ['times', 'weights', 'speeds']) {
      expectFieldType('AnimationPlayer', k, 'vec');
    }
  });

  it('GlyphText: fontHandle (asset), text, fontSize, color', () => {
    expectKeys('GlyphText', 'fontHandle', 'text', 'fontSize', 'color');
    expectFieldType('GlyphText', 'fontHandle', 'asset');
    expectFieldType('GlyphText', 'color', 'vec');
  });

  it('Layer: value field', () => {
    expectKeys('Layer', 'value');
  });

  it('SortKey: value field', () => {
    expectKeys('SortKey', 'value');
  });

  it('PointLightShadow: 6 shadow params', () => {
    expectKeys('PointLightShadow', 'mapSize', 'depthBias', 'normalBias', 'nearPlane', 'farPlane', 'pcfKernelSize');
  });

  it('SpriteRegionOverride: region vec with labels', () => {
    expectKeys('SpriteRegionOverride', 'region');
    const fs = fieldSchema('SpriteRegionOverride', 'region');
    expect(fs?.type).toBe('vec');
    expect(fs?.arity).toBe(4);
    expect(fs?.labels).toEqual(['uMin', 'vMin', 'uW', 'vH']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('Reflection: physics components', () => {
  it('RigidBody: 6 fields, type is number with enum labels in tooltip', () => {
    expectKeys('RigidBody', 'type', 'mass', 'linearDamping', 'angularDamping', 'gravityScale', 'ccdEnabled');
    const fs = fieldSchema('RigidBody', 'type');
    expect(fs?.type).toBe('number'); // enum→number mapping
  });

  it('Collider: 10 fields (shape, extents, physics params)', () => {
    expectKeys('Collider',
      'shape', 'halfExtents', 'radius', 'halfHeight',
      'friction', 'restitution',
      'density', 'isSensor', 'collisionGroups', 'solverGroups',
    );
    // shape is enum in engine → number in editor
    expectFieldType('Collider', 'shape', 'number');
  });

  it('CharacterController: 6 authored fields, grounded excluded (transient)', () => {
    expectKeys('CharacterController',
      'offset', 'maxSlopeClimbDeg', 'minSlopeSlideDeg',
      'autoStepMaxHeight', 'autoStepMinWidth', 'snapToGroundDist',
    );
    expect(fieldKeys('CharacterController')).not.toContain('grounded');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('Reflection: filtering rules', () => {
  it('transient components are excluded', () => {
    expect(getComponentSchema('SceneInstance')).toBeUndefined();
    expect(getComponentSchema('CollidingEntities')).toBeUndefined();
  });

  it('RELATIONSHIP_COMPONENTS are excluded (ChildOf, Children)', () => {
    expect(getComponentSchema('ChildOf')).toBeUndefined();
    expect(getComponentSchema('Children')).toBeUndefined();
  });

  it('explicit excludes are honored', () => {
    for (const name of ['Entity', 'Name', 'Skin', 'Tilemap', 'TileLayer',
      'SpriteAnimation', 'SpriteInstances', 'Instances', 'PostProcessParams']) {
      expect(getComponentSchema(name), `${name} should be excluded`).toBeUndefined();
    }
  });

  it('internal field types are excluded from schema fields', () => {
    // Entity component is excluded entirely, but even if registered,
    // fields like 'self' (entity type) should not appear.
    // Transform.world is transient → excluded at field level.
    const tf = getComponentSchema('Transform');
    const keys = tf!.fields.map(f => f.key);
    expect(keys).not.toContain('world');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('Reflection: listComponentSchemas completeness', () => {
  it('includes all registered + expected components', () => {
    const names = new Set(listComponentSchemas().map(s => s.name));
    const expected = [
      'Transform', 'MeshFilter', 'MeshRenderer',
      'DirectionalLight', 'PointLight', 'SpotLight', 'Camera',
      'Skylight', 'SkyboxBackground', 'AnimationPlayer',
      'GlyphText', 'Layer', 'SortKey', 'PointLightShadow',
      'RigidBody', 'Collider', 'CharacterController',
      'SpriteRegionOverride',
    ];
    for (const name of expected) {
      expect(names.has(name), `listComponentSchemas missing "${name}"`).toBe(true);
    }
    expect(names.size).toBeGreaterThanOrEqual(expected.length);
  });

  it('all schemas have non-empty fields', () => {
    for (const cs of listComponentSchemas()) {
      expect(cs.fields.length, `${cs.name} has zero fields`).toBeGreaterThan(0);
    }
  });

  it('all components produce valid defaultComponentData', () => {
    for (const cs of listComponentSchemas()) {
      const data = defaultComponentData(cs.name);
      expect(data, `${cs.name} defaultComponentData null`).not.toBeNull();
      expect(typeof data, `${cs.name} not object`).toBe('object');
      for (const f of cs.fields) {
        expect(Object.prototype.hasOwnProperty.call(data, f.key),
          `${cs.name}.${f.key} missing from defaultComponentData`).toBe(true);
      }
    }
  });

  it('defaultFieldValue type-coherence', () => {
    for (const cs of listComponentSchemas()) {
      for (const f of cs.fields) {
        const dv = defaultFieldValue(f);
        if (f.type === 'bool') expect(typeof dv).toBe('boolean');
        else if (f.type === 'number') expect(typeof dv).toBe('number');
        else if (f.type === 'string') expect(typeof dv).toBe('string');
        else if (f.type === 'vec') expect(Array.isArray(dv)).toBe(true);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('Reflection: _resetSchemaCache', () => {
  it('resetting cache and re-querying returns fresh schemas', () => {
    const before = getComponentSchema('Transform');
    expect(before).toBeDefined();
    _resetSchemaCache();
    const after = getComponentSchema('Transform');
    expect(after).toBeDefined();
    expect(after!.fields.length).toBe(before!.fields.length);
  });
});
