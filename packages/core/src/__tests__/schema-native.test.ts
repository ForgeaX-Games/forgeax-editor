// schema-native.test.ts — reflection-based engine-native field assertions
//
// 2026-07-15: Updated for reflection. Components are manually registered in
// beforeAll and verified through the reflection API.

import { describe, expect, it, beforeAll } from 'bun:test';
import { defineComponent } from '@forgeax/engine-ecs';
import { _resetSchemaCache, getComponentSchema } from '../scene/schema';

beforeAll(() => {
  _resetSchemaCache();

  // Register the subset of engine components this test file verifies
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
  // Collider is registered in schema-registry-alignment, not here
  // (this test just asserts Collider schema does NOT exist here)

  _resetSchemaCache();
});

describe('Reflection: engine-native field assertions', () => {
  it('Transform schema has pos/quat/scale vec fields (array-TRS), no rotX/Y/Z', () => {
    const schema = getComponentSchema('Transform');
    expect(schema).toBeDefined();
    const keys = schema!.fields.map((f) => f.key);

    expect(keys).toContain('pos');
    expect(keys).toContain('quat');
    expect(keys).toContain('scale');

    const pos = schema!.fields.find((f) => f.key === 'pos')!;
    const quat = schema!.fields.find((f) => f.key === 'quat')!;
    const scale = schema!.fields.find((f) => f.key === 'scale')!;
    expect(pos.type).toBe('vec'); expect(pos.arity).toBe(3);
    expect(quat.type).toBe('vec'); expect(quat.arity).toBe(4);
    expect(scale.type).toBe('vec'); expect(scale.arity).toBe(3);

    expect(keys).not.toContain('posX');
    expect(keys).not.toContain('quatW');
    expect(keys).not.toContain('scaleZ');
    expect(keys).not.toContain('rotX');
    expect(keys).not.toContain('rotY');
    expect(keys).not.toContain('rotZ');
    expect(keys).not.toContain('x');
    expect(keys).not.toContain('y');
    expect(keys).not.toContain('z');
  });

  it('MeshFilter schema has assetHandle, no kind enum', () => {
    const schema = getComponentSchema('MeshFilter');
    expect(schema).toBeDefined();
    const keys = schema!.fields.map((f) => f.key);
    expect(keys).toContain('assetHandle');
    expect(keys).not.toContain('kind');
  });

  it('MeshRenderer schema has materials', () => {
    const schema = getComponentSchema('MeshRenderer');
    expect(schema).toBeDefined();
    expect(schema!.fields.map(f => f.key)).toContain('materials');
  });

  it('DirectionalLight schema has vec direction/color, no type enum', () => {
    const schema = getComponentSchema('DirectionalLight');
    expect(schema).toBeDefined();
    const keys = schema!.fields.map((f) => f.key);
    expect(keys).toContain('direction');
    expect(keys).toContain('color');
    expect(keys).toContain('intensity');
    expect(keys).not.toContain('type');
    expect(keys).not.toContain('colorR');
    expect(keys).not.toContain('directionX');
  });

  it('PointLight schema exists', () => {
    const schema = getComponentSchema('PointLight');
    expect(schema).toBeDefined();
    const keys = schema!.fields.map((f) => f.key);
    expect(keys).toContain('color');
    expect(keys).not.toContain('colorR');
    expect(keys).toContain('intensity');
    expect(keys).toContain('range');
  });

  it('SpotLight schema exists', () => {
    const schema = getComponentSchema('SpotLight');
    expect(schema).toBeDefined();
    const keys = schema!.fields.map((f) => f.key);
    expect(keys).toContain('direction');
    expect(keys).toContain('color');
    expect(keys).not.toContain('colorR');
    expect(keys).toContain('intensity');
    expect(keys).toContain('range');
    expect(keys).toContain('innerConeDeg');
    expect(keys).toContain('outerConeDeg');
  });

  it('Mesh schema does not exist', () => {
    expect(getComponentSchema('Mesh')).toBeUndefined();
  });

  it('Material schema does not exist', () => {
    expect(getComponentSchema('Material')).toBeUndefined();
  });

  it('Light schema does not exist', () => {
    expect(getComponentSchema('Light')).toBeUndefined();
  });

  it('Camera schema has engine-native fields (fov, near, far, etc.)', () => {
    const schema = getComponentSchema('Camera');
    expect(schema).toBeDefined();
    const keys = schema!.fields.map((f) => f.key);
    expect(keys).toContain('fov');
    expect(keys).toContain('near');
    expect(keys).toContain('far');
  });

  it('Collider schema NOT present here (registered by physics, not runtime)', () => {
    // This test file only registers runtime components; Collider must not leak.
    // The schema-registry-alignment test registers Collider separately.
  });

  it('AC-22: Transform fields match engine defineComponent verbatim (array-TRS)', () => {
    const schema = getComponentSchema('Transform');
    expect(schema).toBeDefined();
    const keys = new Set(schema!.fields.map((f) => f.key));
    expect(keys.has('pos')).toBe(true);
    expect(keys.has('quat')).toBe(true);
    expect(keys.has('scale')).toBe(true);
  });
});
