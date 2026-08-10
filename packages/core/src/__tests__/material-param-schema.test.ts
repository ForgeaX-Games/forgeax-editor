// material-param-schema.test.ts — schema-driven parameter model for the
// Material properties panel (the "display is not comprehensive" fix).
//
// Locks the resolution chain the panel depends on:
//   pass module → manifest paramSchema (aliases applied) → built-in standard
//   fallback → material `parameters` overlay → values-only inferred rows.
// The old panel hard-coded baseColor/metallic/roughness + 3 texture slots;
// these tests pin the full standard PBR surface (emissive / clearcoat /
// specularTint / specularTintTexture …) coming out of the schema instead.

import { describe, expect, it } from 'bun:test';
import { DEFAULT_STANDARD_PBR_PARAM_SCHEMA } from '@forgeax/engine-shader';
import {
  deriveMaterialParamRows,
  parseShaderParamSchemaIndex,
  resolveMaterialParamSchema,
  resolveTextureRefGuid,
} from '../assets/material-param-schema';

const STANDARD_PAYLOAD: Record<string, unknown> = {
  kind: 'material',
  passes: [
    { name: 'Forward', program: { module: 'forgeax::default-standard-pbr' } },
    { name: 'ShadowCaster', program: { module: 'forgeax::default-shadow-caster' } },
  ],
  values: { baseColor: [0.5, 0.6, 0.7, 1], metallic: 0, roughness: 0.95 },
};

describe('parseShaderParamSchemaIndex', () => {
  it('parses materialShaders[] paramSchema JSON strings into an identifier index', () => {
    const index = parseShaderParamSchemaIndex({
      materialShaders: [
        { identifier: 'forgeax::default-standard-pbr', paramSchema: JSON.stringify(DEFAULT_STANDARD_PBR_PARAM_SCHEMA) },
        { identifier: 'custom::waves', paramSchema: '[{"name":"waveAmp","type":"f32","default":1}]' },
      ],
    });
    expect(index.get('forgeax::default-standard-pbr')).toHaveLength(DEFAULT_STANDARD_PBR_PARAM_SCHEMA.length);
    expect(index.get('custom::waves')).toEqual([{ name: 'waveAmp', type: 'f32', default: 1 }]);
  });

  it('skips malformed entries instead of failing the whole manifest', () => {
    const index = parseShaderParamSchemaIndex({
      materialShaders: [
        { identifier: 'good::one', paramSchema: '[{"name":"a","type":"f32"}]' },
        { identifier: 'bad::json', paramSchema: '{not json' },
        // Parses but filters to empty — legitimately "shader with no params"
        // (the shadow-caster ships exactly this), so the identifier stays.
        { identifier: 'bad::shape', paramSchema: '[{"name":""}]' },
        { paramSchema: '[]' },
        'garbage',
      ],
    });
    expect([...index.keys()]).toEqual(['good::one', 'bad::shape']);
    expect(index.get('bad::shape')).toEqual([]);
  });

  it('returns an empty index for a non-manifest input', () => {
    expect(parseShaderParamSchemaIndex(undefined).size).toBe(0);
    expect(parseShaderParamSchemaIndex({}).size).toBe(0);
  });
});

describe('resolveMaterialParamSchema', () => {
  it('resolves the standard PBR schema from the manifest by pass module', () => {
    const index = parseShaderParamSchemaIndex({
      materialShaders: [{ identifier: 'forgeax::default-standard-pbr', paramSchema: JSON.stringify(DEFAULT_STANDARD_PBR_PARAM_SCHEMA) }],
    });
    const { descriptors } = resolveMaterialParamSchema(STANDARD_PAYLOAD, index);
    const names = descriptors.map((d) => d.name);
    for (const expected of ['baseColor', 'metallic', 'roughness', 'emissive', 'emissiveIntensity', 'clearcoat', 'specularTint', 'specularTintTexture']) {
      expect(names).toContain(expected);
    }
  });

  it('maps factory module aliases (forgeax_material::standard) onto the manifest identifier', () => {
    const index = parseShaderParamSchemaIndex({
      materialShaders: [{ identifier: 'forgeax::default-standard-pbr', paramSchema: JSON.stringify(DEFAULT_STANDARD_PBR_PARAM_SCHEMA) }],
    });
    const payload = { ...STANDARD_PAYLOAD, passes: [{ name: 'Forward', program: { module: 'forgeax_material::standard' } }] };
    const { descriptors } = resolveMaterialParamSchema(payload, index);
    expect(descriptors.length).toBe(DEFAULT_STANDARD_PBR_PARAM_SCHEMA.length);
  });

  it('falls back to the built-in standard schema when no manifest is reachable', () => {
    const { descriptors } = resolveMaterialParamSchema(STANDARD_PAYLOAD, undefined);
    expect(descriptors.length).toBe(DEFAULT_STANDARD_PBR_PARAM_SCHEMA.length);
  });

  it('overlays the material\'s own parameters declarations by name', () => {
    const payload = {
      kind: 'material',
      passes: [{ name: 'Forward', program: { module: 'custom::waves' } }],
      parameters: [
        { name: 'waveAmp', type: 'f32', default: 2 },
        { name: 'tint', type: 'color', default: [1, 0, 0, 1] },
      ],
      values: {},
    };
    const { descriptors, declaredNames } = resolveMaterialParamSchema(payload, undefined);
    expect(descriptors.map((d) => d.name)).toEqual(['waveAmp', 'tint']);
    expect(declaredNames.has('waveAmp')).toBe(true);
  });

  it('declared parameters win over the shader schema on name conflicts', () => {
    const payload = {
      ...STANDARD_PAYLOAD,
      parameters: [{ name: 'roughness', type: 'f32', default: 0.75 }],
    };
    const { descriptors } = resolveMaterialParamSchema(payload, undefined);
    expect(descriptors.find((d) => d.name === 'roughness')?.default).toBe(0.75);
  });
});

describe('resolveTextureRefGuid', () => {
  const refs = ['guid-tex-a', 'guid-tex-b'];
  it('resolves GUID strings, refs[] indices, and nested { texture } forms', () => {
    expect(resolveTextureRefGuid('guid-direct', refs)).toBe('guid-direct');
    expect(resolveTextureRefGuid(1, refs)).toBe('guid-tex-b');
    expect(resolveTextureRefGuid({ texture: 'guid-nested' }, refs)).toBe('guid-nested');
    expect(resolveTextureRefGuid({ texture: 0 }, refs)).toBe('guid-tex-a');
    expect(resolveTextureRefGuid(undefined, refs)).toBeNull();
    expect(resolveTextureRefGuid(9, refs)).toBeNull();
  });
});

describe('deriveMaterialParamRows', () => {
  const { descriptors, declaredNames } = resolveMaterialParamSchema(STANDARD_PAYLOAD, undefined);

  const rows = deriveMaterialParamRows({
    descriptors,
    declaredNames,
    ownValues: { baseColor: [0.5, 0.6, 0.7, 1], roughness: 0.95 },
    resolvedValues: { baseColor: [0.5, 0.6, 0.7, 1], roughness: 0.95, metallic: 0.25 },
    refs: [],
    colorSpace: 'srgb',
  });
  const byName = new Map(rows.map((row) => [row.name, row]));

  it('emits one row per schema entry in schema order, before values-only rows', () => {
    const schemaNames = DEFAULT_STANDARD_PBR_PARAM_SCHEMA.map((e) => e.name);
    expect(rows.slice(0, schemaNames.length).map((r) => r.name)).toEqual(schemaNames);
  });

  it('maps schema types to editor kinds (color / scalar+slider / texture)', () => {
    expect(byName.get('baseColor')?.kind).toBe('color');
    expect(byName.get('metallic')).toMatchObject({ kind: 'scalar', slider: true });
    expect(byName.get('roughness')).toMatchObject({ kind: 'scalar', slider: true });
    expect(byName.get('baseColorTexture')?.kind).toBe('texture');
    expect(byName.get('specularTintTexture')?.kind).toBe('texture');
  });

  it('treats vec3+colorSpace entries (emissive, specularTint) as color rows', () => {
    expect(byName.get('emissive')).toMatchObject({ kind: 'color', components: 3, colorSpace: 'srgb' });
    expect(byName.get('specularTint')).toMatchObject({ kind: 'color', components: 3 });
  });

  it('suppresses the 0..1 slider for channel selectors and intensity/cutoff scalars', () => {
    expect(byName.get('metallicChannel')?.slider).toBe(false);
    expect(byName.get('emissiveIntensity')?.slider).toBe(false);
    expect(byName.get('alphaCutoff')?.slider).toBe(false);
  });

  it('falls back to the schema default when neither own nor inherited value exists', () => {
    expect(byName.get('occlusionStrength')?.value).toBe(1);
    expect(byName.get('occlusionStrength')?.overridden).toBe(false);
  });

  it('marks own-values keys as overridden; inherited-only keys are not', () => {
    expect(byName.get('roughness')).toMatchObject({ value: 0.95, overridden: true });
    // metallic is inherited (resolved) but NOT in the material's own values.
    expect(byName.get('metallic')).toMatchObject({ value: 0.25, overridden: false });
  });

  it('infers rows for values-only keys not covered by the schema', () => {
    const inferred = deriveMaterialParamRows({
      descriptors,
      declaredNames,
      ownValues: { emissiveTexture: 'guid-em', customFlag: true, tiling: [2, 2], note: 'x' },
      resolvedValues: {
        baseColor: [1, 1, 1, 1],
        emissiveTexture: 'guid-em',
        customFlag: true,
        tiling: [2, 2],
        note: 'x',
      },
      refs: [],
      colorSpace: 'srgb',
    });
    const extra = new Map(inferred.filter((r) => r.source === 'value').map((r) => [r.name, r]));
    expect(extra.get('emissiveTexture')).toMatchObject({ kind: 'texture', textureGuid: 'guid-em' });
    expect(extra.get('customFlag')?.kind).toBe('bool');
    expect(extra.get('tiling')).toMatchObject({ kind: 'vector', components: 2 });
    expect(extra.get('note')?.kind).toBe('readonly');
  });
});
