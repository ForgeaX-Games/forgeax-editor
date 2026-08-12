import { describe, expect, it } from 'bun:test';
import { writeFileDragData } from '../CBFileItem';

describe('Content Browser file placement boundary', () => {
  it('keeps a GLB file drag file-only even when it has cooked sub-assets', () => {
    const payloads = new Map<string, string>();
    const transfer = {
      effectAllowed: 'none',
      setData: (type: string, data: string) => { payloads.set(type, data); },
    };

    writeFileDragData({
      path: 'assets/bed.glb',
      diskPath: 'spin-cube/assets/bed.glb',
      name: 'bed.glb',
      family: 'model',
    }, transfer);

    expect(payloads.has('application/x-forgeax-file')).toBe(true);
    expect(payloads.has('application/x-forgeax-asset')).toBe(false);
    expect(transfer.effectAllowed).toBe('copy');
  });
});
