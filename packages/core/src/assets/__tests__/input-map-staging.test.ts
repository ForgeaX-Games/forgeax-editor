import { afterEach, describe, expect, it } from 'bun:test';
import {
  closeInputMapStaging,
  commitInputMapStaging,
  discardInputMapStaging,
  getInputMapStaging,
  hasInputMapExternalChange,
  isInputMapStagingDirty,
  keepInputMapStaging,
  openInputMapStaging,
  renameInputMapStaging,
  refreshInputMapStaging,
  reloadInputMapStaging,
  setInputMapSaveStatus,
  updateInputMapStaging,
} from '../input-map-staging';
import { createDefaultInputMapPayload } from '../input-map-schema';

const GUID = '22222222-2222-4222-8222-222222222222';
const PACK_PATH = 'assets/IM_Test.pack.json';

afterEach(() => {
  closeInputMapStaging(GUID);
});

describe('input-map-staging pack hydration', () => {
  it('replaces a clean persisted-tab snapshot with the pack payload', () => {
    openInputMapStaging({
      guid: GUID,
      packPath: PACK_PATH,
      name: 'IM_Test',
      payload: createDefaultInputMapPayload(),
    });

    refreshInputMapStaging({
      guid: GUID,
      packPath: PACK_PATH,
      name: 'IM_Test',
      payload: createDefaultInputMapPayload([{
        action: 'jump',
        bindings: [{ type: 'key', key: ' ' }],
      }]),
    });

    expect(getInputMapStaging(GUID)?.staging.actions).toHaveLength(1);
    expect(getInputMapStaging(GUID)?.staging.actions[0]?.action).toBe('jump');
    expect(isInputMapStagingDirty(GUID)).toBe(false);
    expect(hasInputMapExternalChange(GUID)).toBe(false);
  });

  it('does not replace an edit made while the pack read is in flight', () => {
    openInputMapStaging({
      guid: GUID,
      packPath: PACK_PATH,
      name: 'IM_Test',
      payload: createDefaultInputMapPayload(),
    });
    updateInputMapStaging(GUID, () => createDefaultInputMapPayload([{
      action: 'local-edit',
      bindings: [{ type: 'key', key: 'e' }],
    }]));

    refreshInputMapStaging({
      guid: GUID,
      packPath: PACK_PATH,
      name: 'IM_Test',
      payload: createDefaultInputMapPayload([{
        action: 'disk',
        bindings: [{ type: 'key', key: 'd' }],
      }]),
    });

    expect(getInputMapStaging(GUID)?.staging.actions[0]?.action).toBe('local-edit');
    expect(isInputMapStagingDirty(GUID)).toBe(true);
    expect(getInputMapStaging(GUID)?.external?.payload.actions[0]?.action).toBe('disk');
    expect(hasInputMapExternalChange(GUID)).toBe(true);
  });

  it('does not report drift when disk still matches the saved baseline', () => {
    const saved = createDefaultInputMapPayload([{
      action: 'saved',
      bindings: [{ type: 'key', key: 's' }],
    }]);
    openInputMapStaging({
      guid: GUID,
      packPath: PACK_PATH,
      name: 'IM_Test',
      payload: saved,
    });
    updateInputMapStaging(GUID, () => createDefaultInputMapPayload([{
      action: 'local-edit',
      bindings: [{ type: 'key', key: 'e' }],
    }]));

    refreshInputMapStaging({
      guid: GUID,
      packPath: PACK_PATH,
      name: 'IM_Test',
      payload: saved,
    });

    expect(hasInputMapExternalChange(GUID)).toBe(false);
    expect(getInputMapStaging(GUID)?.staging.actions[0]?.action).toBe('local-edit');
  });

  it('renames metadata without replacing dirty edits or an external conflict', () => {
    openInputMapStaging({
      guid: GUID,
      packPath: PACK_PATH,
      name: 'IM_Test',
      payload: createDefaultInputMapPayload(),
    });
    updateInputMapStaging(GUID, () => createDefaultInputMapPayload([{
      action: 'local-edit',
      bindings: [{ type: 'key', key: 'e' }],
    }]));
    refreshInputMapStaging({
      guid: GUID,
      packPath: PACK_PATH,
      name: 'IM_External',
      payload: createDefaultInputMapPayload([{
        action: 'disk',
        bindings: [{ type: 'key', key: 'd' }],
      }]),
    });

    expect(renameInputMapStaging(GUID, 'IM_Player')).toBe(true);
    expect(getInputMapStaging(GUID)?.name).toBe('IM_Player');
    expect(getInputMapStaging(GUID)?.staging.actions[0]?.action).toBe('local-edit');
    expect(getInputMapStaging(GUID)?.external?.payload.actions[0]?.action).toBe('disk');
    expect(isInputMapStagingDirty(GUID)).toBe(true);
  });

  it('publishes saving status without changing dirty payload state', () => {
    openInputMapStaging({
      guid: GUID,
      packPath: PACK_PATH,
      name: 'IM_Test',
      payload: createDefaultInputMapPayload(),
    });

    expect(setInputMapSaveStatus(GUID, 'saving')).toBe(true);
    expect(getInputMapStaging(GUID)?.saveStatus).toBe('saving');
    expect(isInputMapStagingDirty(GUID)).toBe(false);
    expect(setInputMapSaveStatus(GUID, 'idle')).toBe(true);
  });

  it('becomes clean when an external writer converges to the local edit', () => {
    openInputMapStaging({
      guid: GUID,
      packPath: PACK_PATH,
      name: 'IM_Test',
      payload: createDefaultInputMapPayload(),
    });
    const local = createDefaultInputMapPayload([{
      action: 'same-result',
      bindings: [{ type: 'key', key: 'e' }],
    }]);
    updateInputMapStaging(GUID, () => local);

    refreshInputMapStaging({
      guid: GUID,
      packPath: PACK_PATH,
      name: 'IM_Test',
      payload: local,
    });

    expect(isInputMapStagingDirty(GUID)).toBe(false);
    expect(hasInputMapExternalChange(GUID)).toBe(false);
  });

  it('reloads external content and discards local edits', () => {
    openInputMapStaging({
      guid: GUID,
      packPath: PACK_PATH,
      name: 'IM_Test',
      payload: createDefaultInputMapPayload(),
    });
    updateInputMapStaging(GUID, () => createDefaultInputMapPayload([{
      action: 'local-edit',
      bindings: [{ type: 'key', key: 'e' }],
    }]));
    refreshInputMapStaging({
      guid: GUID,
      packPath: PACK_PATH,
      name: 'IM_External',
      payload: createDefaultInputMapPayload([{
        action: 'disk',
        bindings: [{ type: 'key', key: 'd' }],
      }]),
    });

    reloadInputMapStaging(GUID);

    expect(getInputMapStaging(GUID)?.name).toBe('IM_External');
    expect(getInputMapStaging(GUID)?.staging.actions[0]?.action).toBe('disk');
    expect(isInputMapStagingDirty(GUID)).toBe(false);
    expect(hasInputMapExternalChange(GUID)).toBe(false);
  });

  it('keeps local edits while adopting external content as the save baseline', () => {
    openInputMapStaging({
      guid: GUID,
      packPath: PACK_PATH,
      name: 'IM_Test',
      payload: createDefaultInputMapPayload(),
    });
    updateInputMapStaging(GUID, () => createDefaultInputMapPayload([{
      action: 'local-edit',
      bindings: [{ type: 'key', key: 'e' }],
    }]));
    const disk = createDefaultInputMapPayload([{
      action: 'disk',
      bindings: [{ type: 'key', key: 'd' }],
    }]);
    refreshInputMapStaging({
      guid: GUID,
      packPath: PACK_PATH,
      name: 'IM_Test',
      payload: disk,
    });

    keepInputMapStaging(GUID);

    expect(getInputMapStaging(GUID)?.saved).toEqual(disk);
    expect(getInputMapStaging(GUID)?.staging.actions[0]?.action).toBe('local-edit');
    expect(isInputMapStagingDirty(GUID)).toBe(true);
    expect(hasInputMapExternalChange(GUID)).toBe(false);
  });

  it('clears external conflict on commit and discard', () => {
    const observeConflict = () => {
      refreshInputMapStaging({
        guid: GUID,
        packPath: PACK_PATH,
        name: 'IM_Test',
        payload: createDefaultInputMapPayload([{
          action: 'disk',
          bindings: [{ type: 'key', key: 'd' }],
        }]),
      });
      expect(hasInputMapExternalChange(GUID)).toBe(true);
    };
    openInputMapStaging({
      guid: GUID,
      packPath: PACK_PATH,
      name: 'IM_Test',
      payload: createDefaultInputMapPayload(),
    });
    updateInputMapStaging(GUID, () => createDefaultInputMapPayload([{
      action: 'local-edit',
      bindings: [{ type: 'key', key: 'e' }],
    }]));

    observeConflict();
    commitInputMapStaging(GUID);
    expect(hasInputMapExternalChange(GUID)).toBe(false);

    updateInputMapStaging(GUID, () => createDefaultInputMapPayload([{
      action: 'second-local-edit',
      bindings: [{ type: 'key', key: 'f' }],
    }]));
    observeConflict();
    discardInputMapStaging(GUID);
    expect(hasInputMapExternalChange(GUID)).toBe(false);
  });
});
