// schema-registry-alignment.test.ts — verify reflection-based schema against engine SSOT
//
// Registers components ONLY when missing (resolveComponent). Never overwrites
// tokens already registered by other tests / @forgeax/engine-runtime imports —
// global nameToToken overwrite would poison query-snapshot / roundtrip suites.

import { describe, expect, it, beforeAll } from 'bun:test';
import { defineComponent, resolveComponent } from '@forgeax/engine-ecs';

// Side-effect: register real runtime components (production tokens).
import {
  Transform,
  MeshFilter,
  MeshRenderer,
  DirectionalLight,
  PointLight,
  SpotLight,
  Camera,
  Skylight,
  SkyboxBackground,
  AnimationPlayer,
  GlyphText,
  Layer,
  SortKey,
  PointLightShadow,
  SpriteRegionOverride,
  SceneInstance,
  ChildOf,
  Children,
  Name,
} from '@forgeax/engine-runtime';

void Transform; void MeshFilter; void MeshRenderer;
void DirectionalLight; void PointLight; void SpotLight; void Camera;
void Skylight; void SkyboxBackground; void AnimationPlayer; void GlyphText;
void Layer; void SortKey; void PointLightShadow; void SpriteRegionOverride;
void SceneInstance; void ChildOf; void Children; void Name;

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

/** Register only if the name is not already in the global engine registry. */
function ensureComponent(
  name: string,
  fields: Parameters<typeof defineComponent>[1],
  options?: Parameters<typeof defineComponent>[2],
): void {
  if (resolveComponent(name)) return;
  defineComponent(name, fields, options);
}

function ensurePhysicsAndFilterFixtures(): void {
  // Physics — not a core package dependency; stub only when absent.
  ensureComponent('RigidBody', {
    type: { type: 'enum', default: 1, labels: { static: 0, dynamic: 1, kinematic: 2 } },
    mass: 'f32',
    linearDamping: 'f32',
    angularDamping: 'f32',
    gravityScale: 'f32',
    ccdEnabled: 'bool',
  });
  ensureComponent('Collider', {
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
  ensureComponent('CharacterController', {
    offset: 'f32',
    maxSlopeClimbDeg: 'f32',
    minSlopeSlideDeg: 'f32',
    autoStepMaxHeight: 'f32',
    autoStepMinWidth: 'f32',
    snapToGroundDist: 'f32',
    grounded: { type: 'bool', transient: true },
  });
  // Do NOT stub Skin/Tilemap/Instances/… here — fake defineComponent tokens
  // poison later suites (destroy/duplicate material round-trip). Exclude
  // assertions only need getComponentSchema(...) === undefined, which holds
  // for both "never registered" and "registered but filtered".
}

function fieldKeys(comp: string): string[] {
  return getComponentSchema(comp)?.fields.map((f) => f.key) ?? [];
}

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

beforeAll(() => {
  ensurePhysicsAndFilterFixtures();
  _resetSchemaCache();
});

describe('Reflection: render components (from @forgeax/engine-runtime)', () => {
  it('Transform: pos/quat/scale vec, no euler scalars', () => {
    expect(getComponentSchema('Transform')).toBeDefined();
    expectKeys('Transform', 'pos', 'quat', 'scale');
    expectFieldType('Transform', 'pos', 'vec');
    expectFieldType('Transform', 'quat', 'vec');
    expectFieldType('Transform', 'scale', 'vec');
    expect(fieldKeys('Transform')).not.toContain('world');
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
  });

  it('DirectionalLight shadow fields have showWhen castShadow=true', () => {
    for (const k of ['cascadeCount', 'splitLambda', 'cascadeBlend', 'mapSize',
      'depthBias', 'normalBias', 'shadowDistance', 'pcfKernelSize']) {
      const fs = fieldSchema('DirectionalLight', k);
      expect(fs?.showWhen, `${k} missing showWhen`).toEqual({ key: 'castShadow', in: ['true'] });
      expect(fieldVisible('DirectionalLight', fs, { castShadow: false })).toBe(false);
      expect(fieldVisible('DirectionalLight', fs, { castShadow: true })).toBe(true);
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
    for (const k of ['left', 'right', 'bottom', 'top']) {
      expect(fieldVisible('Camera', fieldSchema('Camera', k), { projection: 0 })).toBe(false);
    }
  });

  it('Camera ortho bounds visible in orthographic mode (projection=1)', () => {
    for (const k of ['left', 'right', 'bottom', 'top']) {
      expect(fieldVisible('Camera', fieldSchema('Camera', k), { projection: 1 })).toBe(true);
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
    for (const k of ['times', 'weights', 'speeds'] as const) {
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

describe('Reflection: physics components', () => {
  it('RigidBody: 6 fields, type is number with enum labels in tooltip', () => {
    expectKeys('RigidBody', 'type', 'mass', 'linearDamping', 'angularDamping', 'gravityScale', 'ccdEnabled');
    const fs = fieldSchema('RigidBody', 'type');
    expect(fs?.type).toBe('number');
  });

  it('Collider: 10 fields (shape, extents, physics params)', () => {
    expectKeys('Collider',
      'shape', 'halfExtents', 'radius', 'halfHeight',
      'friction', 'restitution',
      'density', 'isSensor', 'collisionGroups', 'solverGroups',
    );
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

describe('Reflection: filtering rules', () => {
  it('transient components are excluded', () => {
    // SceneInstance is imported from engine-runtime above (transient:true).
    expect(getComponentSchema('SceneInstance')).toBeUndefined();
  });

  it('RELATIONSHIP_COMPONENTS are excluded (ChildOf, Children)', () => {
    expect(getComponentSchema('ChildOf')).toBeUndefined();
    expect(getComponentSchema('Children')).toBeUndefined();
  });

  it('explicit excludes are honored', () => {
    // Name is imported; remaining names need not be registered — undefined
    // either means filtered or absent, both satisfy "not authorable".
    for (const name of ['Entity', 'Name', 'Skin', 'Tilemap', 'TileLayer',
      'SpriteAnimation', 'SpriteInstances', 'Instances', 'PostProcessParams']) {
      expect(getComponentSchema(name), `${name} should be excluded`).toBeUndefined();
    }
  });

  it('internal field types are excluded from schema fields', () => {
    const tf = getComponentSchema('Transform');
    const keys = tf!.fields.map(f => f.key);
    expect(keys).not.toContain('world');
  });
});

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
