import { describe, expect, it, mock } from 'bun:test';
import { createDefaultInputMapPayload } from '../input-map-schema';
import { applySaveInputMap } from '../../session/input-map-ops';

const GUID = '44444444-4444-4444-8444-444444444444';
const PACK_PATH = 'assets/IM_Diagnostics.pack.json';

function saveCommand(payload: ReturnType<typeof createDefaultInputMapPayload>) {
  return {
    kind: 'saveInputMap',
    packPath: PACK_PATH,
    guid: GUID,
    payload,
    _oldEntry: {
      guid: GUID,
      kind: 'input-map',
      name: 'IM_Diagnostics',
      payload: createDefaultInputMapPayload(),
      refs: [],
    },
  } as never;
}

describe('saveInputMap diagnostics gate', () => {
  it('rejects diagnostic errors before scheduling disk IO', () => {
    const writePackEntry = mock(async () => true);
    const payload = createDefaultInputMapPayload([
      { action: 'jump', bindings: [{ type: 'key', key: ' ' }] },
      { action: 'jump', bindings: [{ type: 'key', key: 'j' }] },
    ]);

    const result = applySaveInputMap({
      assetIO: {
        createAssetInPack: async () => ({ ok: true }),
        writePackEntry,
      },
    }, saveCommand(payload));

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.hint).toContain('diagnostic errors');
    expect(writePackEntry).not.toHaveBeenCalled();
  });

  it('allows warning-only payloads to schedule disk IO', () => {
    const writePackEntry = mock(async () => true);
    const payload = createDefaultInputMapPayload([
      { action: 'jump', bindings: [] },
    ]);

    const result = applySaveInputMap({
      assetIO: {
        createAssetInPack: async () => ({ ok: true }),
        writePackEntry,
      },
    }, saveCommand(payload));

    expect(result.ok).toBe(true);
    expect(writePackEntry).toHaveBeenCalledTimes(1);
  });
});
