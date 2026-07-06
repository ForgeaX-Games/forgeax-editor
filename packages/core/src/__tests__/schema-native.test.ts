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
  // ── Transform: quatX/Y/Z/W, posX/Y/Z, scaleX/Y/Z; NO rotX/rotY/rotZ ─────────
  it('Transform schema has quatX/Y/Z/W + posX/Y/Z + scaleX/Y/Z, no rotX/Y/Z', () => {
    const schema = getComponentSchema('Transform');
    expect(schema).toBeDefined();
    const keys = schema!.fields.map((f) => f.key);

    // Must have quaternion SSOT fields
    expect(keys).toContain('quatX');
    expect(keys).toContain('quatY');
    expect(keys).toContain('quatZ');
    expect(keys).toContain('quatW');

    // Must have position fields
    expect(keys).toContain('posX');
    expect(keys).toContain('posY');
    expect(keys).toContain('posZ');

    // Must have scale fields
    expect(keys).toContain('scaleX');
    expect(keys).toContain('scaleY');
    expect(keys).toContain('scaleZ');

    // Must NOT have editor-authored euler fields
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
  it('AC-22: Transform fields match engine defineComponent verbatim', () => {
    const schema = getComponentSchema('Transform');
    expect(schema).toBeDefined();
    const keys = new Set(schema!.fields.map((f) => f.key));
    // Engine Transform defineComponent fields (verbatim from transform.ts:72-81)
    // posX posY posZ quatX quatY quatZ quatW scaleX scaleY scaleZ world
    // (world is engine-derived — excluded from editor schema per plan D-2)
    expect(keys.has('posX')).toBe(true);
    expect(keys.has('quatX')).toBe(true);
    expect(keys.has('quatY')).toBe(true);
    expect(keys.has('quatZ')).toBe(true);
    expect(keys.has('quatW')).toBe(true);
    expect(keys.has('scaleX')).toBe(true);
  });
});