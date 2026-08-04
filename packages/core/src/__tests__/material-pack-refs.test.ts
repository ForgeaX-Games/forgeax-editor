import { describe, expect, it } from 'bun:test';
import {
  encodeMaterialPackRefs,
  normalizeMaterialPackEntries,
} from '../io/material-pack-refs';

const TEXTURE_GUID = '019fc6c4-b507-7a87-a87c-a803faf8baa7';
const SAMPLER_GUID = '029fc6c4-b507-7a87-a87c-a803faf8baa7';
const OTHER_GUID = '039fc6c4-b507-7a87-a87c-a803faf8baa7';

describe('material pack refs encoder', () => {
  it('encodes a runtime texture GUID into refs[] and keeps numeric material fields numeric', () => {
    const source = {
      kind: 'material',
      values: {
        baseColor: [1, 1, 1, 1],
        metallic: 0,
        baseColorTexture: TEXTURE_GUID,
      },
    };

    const encoded = encodeMaterialPackRefs(source);

    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.refs).toEqual([TEXTURE_GUID]);
    expect(encoded.payload.values).toEqual({
      baseColor: [1, 1, 1, 1],
      metallic: 0,
      baseColorTexture: 0,
    });
    expect(source.values.baseColorTexture).toBe(TEXTURE_GUID);
  });

  it('encodes structured texture and sampler references and converges on a second pass', () => {
    const first = encodeMaterialPackRefs({
      kind: 'material',
      values: {
        baseColorTexture: {
          texture: TEXTURE_GUID,
          sampler: SAMPLER_GUID,
          coordinates: { set: 1 },
        },
      },
    });

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.refs).toEqual([TEXTURE_GUID, SAMPLER_GUID]);
    expect((first.payload.values as Record<string, unknown>).baseColorTexture).toEqual({
      texture: 0,
      sampler: 1,
      coordinates: { set: 1 },
    });

    const second = encodeMaterialPackRefs(first.payload, first.refs);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.changed).toBe(false);
  });

  it('migrates the legacy GUID-in-metallic shape instead of writing it back', () => {
    const encoded = encodeMaterialPackRefs({
      kind: 'material',
      values: {
        metallic: TEXTURE_GUID,
        roughness: 0.5,
        baseColorTexture: TEXTURE_GUID,
      },
    });

    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.changed).toBe(true);
    expect(encoded.refs).toEqual([TEXTURE_GUID]);
    const values = encoded.payload.values as Record<string, unknown>;
    expect(values.metallic).toBe(0);
    expect(values.baseColorTexture).toBe(0);
  });

  it('returns a structured error for an unsafe numeric-field migration', () => {
    const encoded = encodeMaterialPackRefs({
      kind: 'material',
      values: {
        metallic: OTHER_GUID,
        baseColorTexture: TEXTURE_GUID,
      },
    });

    expect(encoded.ok).toBe(false);
    if (encoded.ok) return;
    expect(encoded.error.code).toBe('MATERIAL_PACK_MIGRATION_UNSAFE');
    expect(encoded.error.field).toBe('values.metallic');
  });
});

describe('normalizeMaterialPackEntries', () => {
  it('normalizes material entries in place and reports changed entries', () => {
    const pack: Record<string, unknown> = {
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [
        {
          guid: 'mat-1',
          kind: 'material',
          payload: {
            kind: 'material',
            values: {
              metallic: TEXTURE_GUID,
              baseColorTexture: TEXTURE_GUID,
            },
          },
          refs: [],
        },
      ],
    };

    const result = normalizeMaterialPackEntries(pack);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.changedEntries).toHaveLength(1);
    const entry = (pack.assets as Array<Record<string, unknown>>)[0]!;
    expect(entry.refs).toEqual([TEXTURE_GUID]);
    expect((entry.payload as { values: Record<string, unknown> }).values).toMatchObject({
      metallic: 0,
      baseColorTexture: 0,
    });
  });
});
