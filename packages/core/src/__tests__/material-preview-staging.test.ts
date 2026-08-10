// material-preview-staging.test.ts — the transient drag channel between the
// Material properties panel and the preview world (chrome-only: no ledger, no
// disk). Locks set/clear/notify semantics so a staged drag value can never
// leak past its commit.

import { describe, expect, it } from 'bun:test';
import {
  clearMaterialPreviewParams,
  getMaterialPreviewParams,
  setMaterialPreviewParam,
  subscribeMaterialPreviewParams,
} from '../assets/material-preview-staging';

const GUID = 'aaaaaaaa-0000-4000-8000-000000000001';

describe('material-preview-staging', () => {
  it('publishes and reads a staged value (guid case-insensitive)', () => {
    setMaterialPreviewParam(GUID.toUpperCase(), 'roughness', 0.1);
    expect(getMaterialPreviewParams(GUID)).toEqual({ roughness: 0.1 });
    clearMaterialPreviewParams(GUID);
  });

  it('clears a single key and drops the entry when the last key goes', () => {
    setMaterialPreviewParam(GUID, 'metallic', 0.9);
    setMaterialPreviewParam(GUID, 'roughness', 0.2);

    clearMaterialPreviewParams(GUID, ['metallic']);
    expect(getMaterialPreviewParams(GUID)).toEqual({ roughness: 0.2 });

    clearMaterialPreviewParams(GUID, ['roughness']);
    expect(getMaterialPreviewParams(GUID)).toEqual({});
  });

  it('clear without keys drops the whole material entry', () => {
    setMaterialPreviewParam(GUID, 'metallic', 1);
    clearMaterialPreviewParams(GUID);
    expect(getMaterialPreviewParams(GUID)).toEqual({});
  });

  it('notifies subscribers with the lowercased guid on set and clear', () => {
    const seen: string[] = [];
    const off = subscribeMaterialPreviewParams((guid) => seen.push(guid));

    setMaterialPreviewParam(GUID.toUpperCase(), 'metallic', 0.5);
    clearMaterialPreviewParams(GUID, ['metallic']);

    off();
    setMaterialPreviewParam(GUID, 'metallic', 0.6);
    clearMaterialPreviewParams(GUID);

    expect(seen).toEqual([GUID, GUID]);
  });

  it('isolates staging per material guid', () => {
    const other = 'bbbbbbbb-0000-4000-8000-000000000002';
    setMaterialPreviewParam(GUID, 'metallic', 0.3);
    setMaterialPreviewParam(other, 'metallic', 0.7);

    expect(getMaterialPreviewParams(GUID)).toEqual({ metallic: 0.3 });
    expect(getMaterialPreviewParams(other)).toEqual({ metallic: 0.7 });

    clearMaterialPreviewParams(GUID);
    clearMaterialPreviewParams(other);
  });
});
