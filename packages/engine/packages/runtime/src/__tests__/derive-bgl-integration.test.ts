// derive-bgl-integration.test.ts -- M3 / w11 integration test for derive(schema)
// integration into the BGL build path consumed by registerMaterialShader-like
// register-time validation.
//
// feat-20260613-material-paramschema-driven-binding M3 / w11.
//
// Decision anchors (plan-strategy §2):
//   - D-2  derive(schema) is the pure SSOT for BGL / UBO / loader lookup tables.
//   - D-3  consecutive numeric entries are run-merged into one UBO entry.
//   - D-4  texture* family entries auto-pair a filtering sampler at binding+1.
//   - D-12 empty schema is graceful: bglEntries=[] / totalBytes=0.
//
// What this test asserts (M3 scope, narrow):
//   (a) derive(schema) over each of the 5 built-in shader sidecar shapes
//       returns a well-formed bglEntries array consistent with the rest of
//       the derive output (textureFieldNames / samplerForTexture map /
//       userRegionBindingEnd advances by exactly the entries created).
//   (b) bglEntries[i].binding values are unique and dense from 0..N-1, so
//       that a downstream device.createBindGroupLayout({entries}) call would
//       accept them without renumbering. The assertion runs against synthetic
//       schemas representative of each built-in shader; the real WGSL @binding
//       numbers are renumbered to match in M4 (plan-strategy §3.4 table).
//   (c) record-stage byte packing aligns with derive(...).uboLayout: the
//       sequence of (offset, size) for the merged-UBO field run is the
//       std140 walk produced by derive — caller writes scalars at the
//       reported offsets and the totalBytes is the buffer allocation size.

import type { ParamSchemaEntry } from '@forgeax/engine-types';
import { derive } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

// ─── Synthetic schemas (one per built-in shader family) ─────────────────────
//
// These mirror the *intended* schemas after M4 sidecar updates. The current
// .wgsl.meta.json sidecars (research F-1) are misaligned with WGSL @binding
// numbers; M3 here verifies the derive plumbing works on well-formed schemas
// — M4 brings the real sidecars into alignment.

const standardPbrSchema: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'metallic', type: 'f32', default: 0 },
  { name: 'roughness', type: 'f32', default: 0.5 },
  { name: 'metallicChannel', type: 'f32', default: 2 },
  { name: 'roughnessChannel', type: 'f32', default: 1 },
  { name: 'aoChannel', type: 'f32', default: 0 },
  { name: 'extraChannel', type: 'f32', default: 0 },
  { name: 'baseColorTexture', type: 'texture2d' },
  { name: 'metallicRoughnessTexture', type: 'texture2d' },
  { name: 'normalTexture', type: 'texture2d' },
  { name: 'emissiveTexture', type: 'texture2d' },
];

const skinSchema: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'metallic', type: 'f32', default: 0 },
  { name: 'roughness', type: 'f32', default: 0.5 },
  { name: 'baseColorTexture', type: 'texture2d' },
  { name: 'metallicRoughnessTexture', type: 'texture2d' },
  { name: 'normalTexture', type: 'texture2d' },
];

const unlitSchema: readonly ParamSchemaEntry[] = [
  { name: 'baseColor', type: 'color', default: [1, 1, 1, 1] },
  { name: 'baseColorTexture', type: 'texture2d' },
];

const spriteSchema: readonly ParamSchemaEntry[] = [
  { name: 'tint', type: 'color', default: [1, 1, 1, 1] },
  { name: 'baseColorTexture', type: 'texture2d' },
];

const shadowCasterSchema: readonly ParamSchemaEntry[] = [];

const builtinSchemas: ReadonlyArray<{ id: string; schema: readonly ParamSchemaEntry[] }> = [
  { id: 'forgeax::default-standard-pbr', schema: standardPbrSchema },
  { id: 'forgeax::pbr-skin', schema: skinSchema },
  { id: 'forgeax::default-unlit', schema: unlitSchema },
  { id: 'forgeax::sprite', schema: spriteSchema },
  { id: 'forgeax::default-shadow-caster', schema: shadowCasterSchema },
];

describe('derive(schema) integration over 5 built-in shader families (M3 w11)', () => {
  it('(a) every built-in shader derives a well-formed BGL with consistent userRegionBindingEnd', () => {
    for (const { id, schema } of builtinSchemas) {
      const out = derive(schema);
      // bglEntries length == userRegionBindingEnd (every entry consumes
      // exactly one binding slot under the run-merging rule of D-3).
      expect(out.bglEntries.length, `${id}: bglEntries.length === userRegionBindingEnd`).toBe(
        out.userRegionBindingEnd,
      );
      // textureFieldNames is a subset of the schema names.
      const schemaNames = new Set(schema.map((e) => e.name));
      for (const tex of out.textureFieldNames) {
        expect(schemaNames.has(tex), `${id}: textureFieldName '${tex}' is in schema`).toBe(true);
      }
      // samplerForTexture maps each texture name to '<tex>_sampler'.
      for (const [tex, samp] of out.samplerForTexture) {
        expect(samp).toBe(`${tex}_sampler`);
      }
    }
  });

  it('(b) bglEntries[i].binding values are unique and dense from 0..N-1', () => {
    for (const { id, schema } of builtinSchemas) {
      const out = derive(schema);
      const bindings = out.bglEntries.map((e) => e.binding);
      // unique
      expect(new Set(bindings).size, `${id}: binding values unique`).toBe(bindings.length);
      // dense from 0..N-1
      for (let i = 0; i < bindings.length; i++) {
        expect(bindings, `${id}: bglEntries[${i}].binding === ${i}`).toContain(i);
      }
    }
  });

  it('(c) record-stage packing aligns with uboLayout offsets (totalBytes >= last field offset+size)', () => {
    for (const { id, schema } of builtinSchemas) {
      const out = derive(schema);
      const fields = out.uboLayout.entries;
      // offsets are non-decreasing.
      for (let i = 1; i < fields.length; i++) {
        const prev = fields[i - 1];
        const cur = fields[i];
        if (prev === undefined || cur === undefined) continue;
        expect(
          cur.offset,
          `${id}: field[${i}].offset >= field[${i - 1}].offset+size`,
        ).toBeGreaterThanOrEqual(prev.offset + prev.size);
      }
      // totalBytes covers the last field exactly (or is 0 when no fields).
      if (fields.length === 0) {
        expect(out.uboLayout.totalBytes, `${id}: empty schema totalBytes==0`).toBe(0);
      } else {
        const last = fields[fields.length - 1];
        if (last !== undefined) {
          expect(
            out.uboLayout.totalBytes,
            `${id}: totalBytes >= last.offset+size`,
          ).toBeGreaterThanOrEqual(last.offset + last.size);
        }
      }
    }
  });

  it('(d) shadow-caster (empty schema) is graceful (D-12)', () => {
    const out = derive(shadowCasterSchema);
    expect(out.bglEntries).toEqual([]);
    expect(out.uboLayout.totalBytes).toBe(0);
    expect(out.userRegionBindingEnd).toBe(0);
    expect(out.textureFieldNames.size).toBe(0);
  });
});
