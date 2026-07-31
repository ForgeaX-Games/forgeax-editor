import { describe, expect, it } from 'bun:test';
import { validateSource, validateSourceQuick } from './validate-source';

const validHeaders: ReadonlyArray<readonly [string, number[]]> = [
  ['assets/model.glb', [0x67, 0x6c, 0x54, 0x46]],
  ['assets/model.fbx', [0x4b, 0x61, 0x79, 0x64, 0x61, 0x72, 0x61, 0x20, 0x46, 0x42, 0x58, 0x20, 0x42, 0x69, 0x6e, 0x61, 0x72, 0x79, 0x20, 0x20]],
  ['assets/image.png', [0x89, 0x50, 0x4e, 0x47]],
  ['assets/image.jpg', [0xff, 0xd8, 0xff]],
  ['assets/sky.hdr', [0x23, 0x3f, 0x52, 0x41]],
];

describe('import matrix source validation', () => {
  it('accepts the representative source signatures used by each binary importer', () => {
    for (const [path, header] of validHeaders) {
      expect(validateSource(path, new Uint8Array(header), header.length)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ severity: 'error' })]),
      );
    }
  });

  it('rejects a non-empty truncated or mismatched signature', () => {
    expect(validateSource('assets/model.glb', new Uint8Array([0x67]), 1)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'invalid-glb-header', severity: 'error' })]),
    );
    expect(validateSource('assets/model.fbx', new Uint8Array([0, 1, 2]), 3)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'invalid-fbx-header', severity: 'error' })]),
    );
  });

  it('keeps path-only quick validation free of content-signature claims', () => {
    expect(validateSourceQuick('assets/model.glb', 4)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'invalid-glb-header' })]),
    );
  });

  it('keeps text-oriented matrix members importable without binary magic checks', () => {
    expect(validateSource('assets/font.ttf', new Uint8Array([1]), 1)).toEqual([]);
    expect(validateSource('assets/ui/hud.ui.html', new Uint8Array([60]), 1)).toEqual([]);
    expect(validateSource('assets/audio.wav', new Uint8Array([1]), 1)).toEqual([]);
  });
});
