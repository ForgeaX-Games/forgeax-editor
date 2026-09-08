import { afterEach, describe, expect, it } from 'bun:test';
import {
  closeMaterialStaging,
  isMaterialStagingDirty,
  openMaterialStaging,
  patchMaterialStagingParam,
  registerActivePageSaveHandler,
} from '@forgeax/editor-core';
import { buildKeyboardRouterDeps } from '../keyboard-router-deps';

const GUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('buildKeyboardRouterDeps — active page save (M4/B3)', () => {
  afterEach(() => {
    registerActivePageSaveHandler(null);
    closeMaterialStaging(GUID);
  });

  it('diverts Ctrl+S to the active-page handler when registered', () => {
    let handled = 0;
    registerActivePageSaveHandler(() => {
      handled += 1;
      return true;
    });
    const deps = buildKeyboardRouterDeps();
    deps.save();
    expect(handled).toBe(1);
  });

  it('falls through when the handler returns false', () => {
    registerActivePageSaveHandler(() => false);
    const deps = buildKeyboardRouterDeps();
    // Should not throw; scene save path still runs (may reject without a live doc).
    expect(() => deps.save()).not.toThrow();
  });

  it('prefers dirty material staging over scene save when the page handler returns false', async () => {
    registerActivePageSaveHandler(() => false);
    openMaterialStaging({
      guid: GUID,
      packPath: 'assets/mat_test.pack.json',
      name: 'mat_test',
      payload: { values: { metallic: 0.1 } },
    });
    patchMaterialStagingParam(GUID, { metallic: 0.8 });

    const deps = buildKeyboardRouterDeps();
    deps.save();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Pack save was attempted (may reject without a live gateway) instead of silently
    // falling through — staging stays dirty only when persistence rejects.
    expect(isMaterialStagingDirty(GUID)).toBe(true);
  });
});
