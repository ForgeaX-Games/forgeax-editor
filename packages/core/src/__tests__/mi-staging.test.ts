import { afterEach, describe, expect, it } from 'bun:test';
import {
  closeMiStaging,
  commitMiStaging,
  discardMiStaging,
  getMiStaging,
  isMiStagingDirty,
  openMiStaging,
  updateMiStaging,
} from '../assets/mi-staging';
import { createDefaultMaterialInstancePayload } from '../assets/material-instance-schema';

const PARENT = '11111111-1111-4111-8111-111111111111';
const GUID = '22222222-2222-4222-8222-222222222222';

afterEach(() => {
  closeMiStaging(GUID);
});

describe('mi-staging', () => {
  it('opens clean and becomes dirty after patch', () => {
    const payload = createDefaultMaterialInstancePayload(PARENT);
    openMiStaging({ guid: GUID, packPath: 'assets/m.pack.json', name: 'MI_A', payload });
    expect(isMiStagingDirty(GUID)).toBe(false);

    updateMiStaging(GUID, (staging) => ({
      ...staging,
      overrides: { ...staging.overrides, metallic: { enabled: true, value: 0.8 } },
    }));
    expect(isMiStagingDirty(GUID)).toBe(true);
  });

  it('commit clears dirty; discard restores saved', () => {
    const payload = createDefaultMaterialInstancePayload(PARENT);
    openMiStaging({ guid: GUID, packPath: 'assets/m.pack.json', name: 'MI_A', payload });
    updateMiStaging(GUID, (staging) => ({
      ...staging,
      lightmass: { ...staging.lightmass, emissiveBoost: 2 },
    }));
    expect(isMiStagingDirty(GUID)).toBe(true);
    commitMiStaging(GUID);
    expect(isMiStagingDirty(GUID)).toBe(false);

    updateMiStaging(GUID, (staging) => ({
      ...staging,
      lightmass: { ...staging.lightmass, emissiveBoost: 3 },
    }));
    discardMiStaging(GUID);
    expect(isMiStagingDirty(GUID)).toBe(false);
  });

  it('keeps dirty staging when reopening the same guid', () => {
    const payload = createDefaultMaterialInstancePayload(PARENT);
    openMiStaging({ guid: GUID, packPath: 'assets/m.pack.json', name: 'MI_A', payload });
    updateMiStaging(GUID, (staging) => ({
      ...staging,
      overrides: { roughness: { enabled: true, value: 0.2 } },
    }));
    openMiStaging({
      guid: GUID,
      packPath: 'assets/m.pack.json',
      name: 'MI_A',
      payload: createDefaultMaterialInstancePayload(PARENT, {
        overrides: { roughness: { enabled: true, value: 0.9 } },
      }),
    });
    expect(isMiStagingDirty(GUID)).toBe(true);
    expect(getMiStaging(GUID)?.staging.overrides.roughness?.value).toBe(0.2);
  });
});
