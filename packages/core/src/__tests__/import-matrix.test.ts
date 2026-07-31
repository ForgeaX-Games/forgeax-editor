import { describe, expect, it } from 'bun:test';
import { getImportFormat, IMPORT_FORMATS } from '../scan/ext-importer-map';
import { validateSource } from '../scan/validate-source';

async function fixture(path: string): Promise<ArrayBuffer> {
  return Bun.file(new URL(path, import.meta.url)).arrayBuffer();
}

describe('R0-04H importer matrix', () => {
  it('keeps every representative extension mapped to a producer and sub-asset shape', () => {
    const expected = new Map([
      ['.glb', ['gltf', ['scene']]],
      ['.fbx', ['fbx', ['scene']]],
      ['.png', ['image', ['texture']]],
      ['.wav', ['audio', ['audio']]],
      ['.ttf', ['font', ['texture', 'sampler', 'font']]],
      ['.ui.html', ['ui', ['ui']]],
    ] as const);
    for (const [extension, [importer, kinds]] of expected) {
      const format = getImportFormat(extension);
      expect(format?.importer).toBe(importer);
      expect(format?.subAssetKinds).toEqual([...kinds]);
    }
    expect(IMPORT_FORMATS.map((format) => format.importer)).toEqual(
      expect.arrayContaining(['gltf', 'fbx', 'image', 'audio', 'font', 'ui']),
    );
  });

  it('recognizes the checked-in FBX sample before the optional WASM cook boundary', async () => {
    const bytes = await fixture('../../../engine/forgeax-engine-assets/vendor/fbx-test/humanoid.fbx');
    const diagnostics = validateSource('assets/humanoid.fbx', new Uint8Array(bytes.slice(0, 64)), bytes.byteLength);
    expect(diagnostics.filter((diagnostic) => diagnostic.code === 'invalid-fbx-header')).toEqual([]);
  });

});
