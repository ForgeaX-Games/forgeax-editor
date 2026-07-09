// schema-native.test.ts — engine-native field assertions for getComponentSchema
//
// feat-20260701-editor-world-container-doc-ecs-collapse M3 / m3-test-schema-red
//
// AC-22: getComponentSchema(comp).fields must return engine-verbatim field names.
// These tests are RED now — current schema.ts REGISTRY has editor-authored fields
// (rotX/Y/Z, Mesh.kind, Material, Light.type etc.) that do NOT match engine
// defineComponent fields. They turn GREEN after m3-impl-inspector-euler rewrites
// the REGISTRY to engine-native component schemas.
//
// plan-strategy §2 D-2, D-3 / requirements AC-22

import { describe, expect, it } from 'bun:test';
import { getComponentSchema } from '../scene/schema';

describe('m3-test-schema-red: schema engine-native field assertions', () => {
  // ── Transform: pos[3]/quat[4]/scale[3] vec fields; NO rotX/rotY/rotZ ─────────
  it('Transform schema has pos/quat/scale vec fields (array-TRS), no rotX/Y/Z', () => {
    const schema = getComponentSchema('Transform');
    expect(schema).toBeDefined();
    const keys = schema!.fields.map((f) => f.key);

    // Array-TRS: three engine array columns collapsed into three vec fields.
    expect(keys).toContain('pos');
    expect(keys).toContain('quat');
    expect(keys).toContain('scale');

    // Each is a 'vec' field with the engine array arity.
    const pos = schema!.fields.find((f) => f.key === 'pos')!;
    const quat = schema!.fields.find((f) => f.key === 'quat')!;
    const scale = schema!.fields.find((f) => f.key === 'scale')!;
    expect(pos.type).toBe('vec');
    expect(quat.type).toBe('vec');
    expect(scale.type).toBe('vec');
    expect(pos.arity).toBe(3);
    expect(quat.arity).toBe(4);
    expect(scale.arity).toBe(3);

    // Must NOT have the old per-axis scalar keys …
    expect(keys).not.toContain('posX');
    expect(keys).not.toContain('quatW');
    expect(keys).not.toContain('scaleZ');
    // … nor editor-authored euler fields (euler is Inspector overlay only).
    expect(keys).not.toContain('rotX');
    expect(keys).not.toContain('rotY');
    expect(keys).not.toContain('rotZ');
    expect(keys).not.toContain('x');
    expect(keys).not.toContain('y');
    expect(keys).not.toContain('z');
  });

  // ── MeshFilter: assetHandle, no kind enum ───────────────────────────────────
  it('MeshFilter schema has assetHandle, no kind enum', () => {
    const schema = getComponentSchema('MeshFilter');
    expect(schema).toBeDefined();
    const keys = schema!.fields.map((f) => f.key);
    expect(keys).toContain('assetHandle');
    expect(keys).not.toContain('kind');
  });

  // ── MeshRenderer: materials array ──────────────────────────────────────────
  it('MeshRenderer schema has materials', () => {
    const schema = getComponentSchema('MeshRenderer');
    expect(schema).toBeDefined();
    const keys = schema!.fields.map((f) => f.key);
    expect(keys).toContain('materials');
  });

  // ── DirectionalLight: per-channel scalar fields, no type enum ──────────────
  it('DirectionalLight schema has per-channel scalars, no type enum', () => {
    const schema = getComponentSchema('DirectionalLight');
    expect(schema).toBeDefined();
    const keys = schema!.fields.map((f) => f.key);

    // Per-channel color scalars (verbatim engine field names)
    expect(keys).toContain('colorR');
    expect(keys).toContain('colorG');
    expect(keys).toContain('colorB');
    expect(keys).toContain('intensity');

    // Must NOT have editor-authored unified fields
    expect(keys).not.toContain('type');
    expect(keys).not.toContain('color'); // packed color, not per-channel
  });

  // ── PointLight exists ──────────────────────────────────────────────────────
  it('PointLight schema exists', () => {
    const schema = getComponentSchema('PointLight');
    expect(schema).toBeDefined();
    const keys = schema!.fields.map((f) => f.key);
    expect(keys).toContain('colorR');
    expect(keys).toContain('colorG');
    expect(keys).toContain('colorB');
    expect(keys).toContain('intensity');
    expect(keys).toContain('range');
  });

  // ── SpotLight exists ───────────────────────────────────────────────────────
  it('SpotLight schema exists', () => {
    const schema = getComponentSchema('SpotLight');
    expect(schema).toBeDefined();
    const keys = schema!.fields.map((f) => f.key);
    expect(keys).toContain('colorR');
    expect(keys).toContain('colorG');
    expect(keys).toContain('colorB');
    expect(keys).toContain('intensity');
    expect(keys).toContain('range');
    expect(keys).toContain('innerConeDeg');
    expect(keys).toContain('outerConeDeg');
  });

  // ── Old editor-authored schemas should NOT exist ───────────────────────────
  it('Mesh schema does not exist', () => {
    expect(getComponentSchema('Mesh')).toBeUndefined();
  });

  it('Material schema does not exist', () => {
    expect(getComponentSchema('Material')).toBeUndefined();
  });

  it('Light schema does not exist', () => {
    expect(getComponentSchema('Light')).toBeUndefined();
  });

  // ── Camera exists with engine-native field names ────────────────────────────
  it('Camera schema has engine-native fields (fov, near, far, etc.)', () => {
    const schema = getComponentSchema('Camera');
    expect(schema).toBeDefined();
    const keys = schema!.fields.map((f) => f.key);
    expect(keys).toContain('fov');
    expect(keys).toContain('near');
    expect(keys).toContain('far');
  });

  // ── Collider exists with engine-native field names ──────────────────────────
  it('Collider schema exists with engine-native fields', () => {
    const schema = getComponentSchema('Collider');
    expect(schema).toBeDefined();
    const keys = schema!.fields.map((f) => f.key);
    expect(keys).toContain('shape');
  });

  // ── AC-22: field names match engine defineComponent verbatim ────────────────
  it('AC-22: Transform fields match engine defineComponent verbatim (array-TRS)', () => {
    const schema = getComponentSchema('Transform');
    expect(schema).toBeDefined();
    const keys = new Set(schema!.fields.map((f) => f.key));
    // Engine Transform defineComponent columns (feat-20260709 array-TRS):
    // pos (array<f32,3>) quat (array<f32,4>) scale (array<f32,3>) world
    // (world is engine-derived — excluded from editor schema per plan D-2)
    expect(keys.has('pos')).toBe(true);
    expect(keys.has('quat')).toBe(true);
    expect(keys.has('scale')).toBe(true);
  });
});