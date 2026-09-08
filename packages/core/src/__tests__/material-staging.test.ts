import { afterEach, describe, expect, it } from 'bun:test';
import {
  closeMaterialStaging,
  commitMaterialStaging,
  discardMaterialStaging,
  getMaterialStaging,
  isMaterialStagingDirty,
  openMaterialStaging,
  patchMaterialStagingParam,
  resetMaterialStagingParam,
  updateMaterialStaging,
} from '../assets/material-staging';

const GUID = '33333333-3333-4333-8333-333333333333';

afterEach(() => {
  closeMaterialStaging(GUID);
});

describe('material-staging', () => {
  it('opens clean and becomes dirty after parameter patch', () => {
    openMaterialStaging({
      guid: GUID,
      packPath: 'assets/m.pack.json',
      name: 'Mat_A',
      payload: { values: { baseColor: [1, 1, 1, 1], metallic: 0.2 } },
    });
    expect(isMaterialStagingDirty(GUID)).toBe(false);

    patchMaterialStagingParam(GUID, { metallic: 0.9 });
    expect(isMaterialStagingDirty(GUID)).toBe(true);
    expect(getMaterialStaging(GUID)?.staging.values.metallic).toBe(0.9);
  });

  it('handles textureGuids patch and dirty detection', () => {
    openMaterialStaging({
      guid: GUID,
      packPath: 'assets/m.pack.json',
      name: 'Mat_A',
      payload: { values: { baseColor: [1, 1, 1, 1] } },
    });
    expect(isMaterialStagingDirty(GUID)).toBe(false);

    patchMaterialStagingParam(GUID, {}, { baseColorTexture: 'tex-guid-1' });
    expect(isMaterialStagingDirty(GUID)).toBe(true);
    expect(getMaterialStaging(GUID)?.staging.textureGuids.baseColorTexture).toBe('tex-guid-1');

    commitMaterialStaging(GUID);
    expect(isMaterialStagingDirty(GUID)).toBe(false);

    patchMaterialStagingParam(GUID, {}, { baseColorTexture: null });
    expect(isMaterialStagingDirty(GUID)).toBe(true);
    expect(getMaterialStaging(GUID)?.staging.textureGuids.baseColorTexture).toBeUndefined();
  });

  it('resetMaterialStagingParam restores saved or default value', () => {
    openMaterialStaging({
      guid: GUID,
      packPath: 'assets/m.pack.json',
      name: 'Mat_A',
      payload: { values: { roughness: 0.4 } },
    });
    patchMaterialStagingParam(GUID, { roughness: 0.85 });
    expect(isMaterialStagingDirty(GUID)).toBe(true);

    resetMaterialStagingParam(GUID, 'roughness', 0.5);
    expect(getMaterialStaging(GUID)?.staging.values.roughness).toBe(0.4);
    expect(isMaterialStagingDirty(GUID)).toBe(false);

    // Reset a parameter not in saved
    patchMaterialStagingParam(GUID, { emissiveIntensity: 3.0 });
    expect(isMaterialStagingDirty(GUID)).toBe(true);
    resetMaterialStagingParam(GUID, 'emissiveIntensity', 1.0);
    expect(getMaterialStaging(GUID)?.staging.values.emissiveIntensity).toBe(1.0);
  });

  it('commit clears dirty; discard restores saved', () => {
    openMaterialStaging({
      guid: GUID,
      packPath: 'assets/m.pack.json',
      name: 'Mat_A',
      payload: { values: { metallic: 0.1 } },
    });
    patchMaterialStagingParam(GUID, { metallic: 0.5 });
    expect(isMaterialStagingDirty(GUID)).toBe(true);

    commitMaterialStaging(GUID);
    expect(isMaterialStagingDirty(GUID)).toBe(false);
    expect(getMaterialStaging(GUID)?.saved.values.metallic).toBe(0.5);

    patchMaterialStagingParam(GUID, { metallic: 0.9 });
    expect(isMaterialStagingDirty(GUID)).toBe(true);

    discardMaterialStaging(GUID);
    expect(isMaterialStagingDirty(GUID)).toBe(false);
    expect(getMaterialStaging(GUID)?.staging.values.metallic).toBe(0.5);
  });

  it('hydrates a clean existing entry when a richer payload arrives later', () => {
    openMaterialStaging({
      guid: GUID,
      packPath: 'assets/m.pack.json',
      name: 'Mat_A',
      payload: {},
    });
    expect(getMaterialStaging(GUID)?.staging.values.metallic).toBeUndefined();

    openMaterialStaging({
      guid: GUID,
      packPath: 'assets/m.pack.json',
      name: 'Mat_A',
      payload: { values: { metallic: 0.2, roughness: 0.4 } },
    });
    expect(getMaterialStaging(GUID)?.staging.values.metallic).toBe(0.2);
    expect(getMaterialStaging(GUID)?.staging.values.roughness).toBe(0.4);
  });
});
