// schema-native.test.ts — reflection-based engine-native field assertions
//
// NEVER call defineComponent() for Transform/MeshFilter/MeshRenderer/… here.
// A second defineComponent(name, …) overwrites the canonical token in the
// shared global registry and corrupts every other test in the same process
// (sceneload-native.test.ts documents the same trap). Import runtime tokens.

import { describe, expect, it, beforeAll } from 'bun:test';
import {
  Transform,
  MeshFilter,
  MeshRenderer,
  DirectionalLight,
  PointLight,
  SpotLight,
  Camera,
} from '@forgeax/engine-runtime';
import { _resetSchemaCache, getComponentSchema } from '../scene/schema';

void Transform; void MeshFilter; void MeshRenderer;
void DirectionalLight; void PointLight; void SpotLight; void Camera;

beforeAll(() => {
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

  it('light color fields keep vec storage but request the color widget', () => {
    for (const comp of ['DirectionalLight', 'PointLight', 'SpotLight']) {
      const color = getComponentSchema(comp)!.fields.find((f) => f.key === 'color');
      expect(color, `${comp}.color`).toBeDefined();
      expect(color!.type, `${comp}.color type`).toBe('vec');
      expect(color!.arity, `${comp}.color arity`).toBe(3);
      expect(color!.widget, `${comp}.color widget`).toBe('color');
    }
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

  it('AC-22: Transform fields match engine defineComponent verbatim (array-TRS)', () => {
    const schema = getComponentSchema('Transform');
    expect(schema).toBeDefined();
    const keys = new Set(schema!.fields.map((f) => f.key));
    expect(keys.has('pos')).toBe(true);
    expect(keys.has('quat')).toBe(true);
    expect(keys.has('scale')).toBe(true);
  });
});
