import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getImportFormat, IMPORT_FORMATS } from '../scan/ext-importer-map';
import { validateSource } from '../scan/validate-source';

const CORE_ROOT = resolve(import.meta.dir, '..', '..');
const CONTENT_BROWSER_ROOT = resolve(CORE_ROOT, '..', 'content-browser');

const TS_IMPORT_REGISTRY_CONSUMERS = [
  [CORE_ROOT, 'src/scan/ext-importer-map.ts'],
  [CORE_ROOT, 'src/scan/index.ts'],
  [CORE_ROOT, 'src/index.ts'],
  [CORE_ROOT, 'src/__tests__/import-matrix.test.ts'],
  [CONTENT_BROWSER_ROOT, 'src/import-registry.ts'],
  [CONTENT_BROWSER_ROOT, 'src/import-registry-parity.test.ts'],
  [CONTENT_BROWSER_ROOT, 'src/import-pipeline.ts'],
  [CONTENT_BROWSER_ROOT, 'src/import-debug.ts'],
  [CONTENT_BROWSER_ROOT, 'src/ContentBrowser.tsx'],
  [CONTENT_BROWSER_ROOT, 'src/CBToolbar.tsx'],
  [CONTENT_BROWSER_ROOT, 'src/ui-asset-support.test.ts'],
] as const;

function readConsumer(root: string, relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function filesWithSuffix(root: string, suffixes: readonly string[]): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...filesWithSuffix(path, suffixes));
    } else if (suffixes.some((suffix) => entry.name.endsWith(suffix))) {
      result.push(path);
    }
  }
  return result;
}

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

  it('enumerates one core owner and every TypeScript registry consumer', () => {
    expect(readFileSync(resolve(CORE_ROOT, 'src/scan/ext-importer-map.ts'), 'utf8'))
      .toMatch(/export const IMPORT_FORMATS/);
    expect(readFileSync(resolve(CONTENT_BROWSER_ROOT, 'src/import-registry.ts'), 'utf8'))
      .not.toMatch(/export const IMPORT_FORMATS/);
    for (const [root, relativePath] of TS_IMPORT_REGISTRY_CONSUMERS) {
      expect(readConsumer(root, relativePath), relativePath).toMatch(
        /IMPORT_FORMATS|import-registry|@forgeax\/editor-core/,
      );
    }
  });

  it('keeps type-erased and JSON channels out of the registry contract', () => {
    const sourceRoots = [resolve(CORE_ROOT, 'src'), resolve(CONTENT_BROWSER_ROOT, 'src')];
    for (const path of filesWithSuffix(sourceRoots[0]!, ['.mjs', '.cjs'])) {
      expect(readFileSync(path, 'utf8'), path).not.toMatch(/IMPORT_FORMATS|import-registry|particle-effect/);
    }
    for (const path of filesWithSuffix(sourceRoots[1]!, ['.mjs', '.cjs'])) {
      expect(readFileSync(path, 'utf8'), path).not.toMatch(/IMPORT_FORMATS|import-registry|particle-effect/);
    }
    for (const path of filesWithSuffix(CORE_ROOT, ['.pack.json', '.meta.json', '.config.json'])) {
      expect(readFileSync(path, 'utf8'), path).not.toMatch(/importer|subAssetKind|particle-effect/);
    }
    for (const path of filesWithSuffix(CONTENT_BROWSER_ROOT, ['.pack.json', '.meta.json', '.config.json'])) {
      expect(readFileSync(path, 'utf8'), path).not.toMatch(/importer|subAssetKind|particle-effect/);
    }
  });

  it('recognizes the checked-in FBX sample before the optional WASM cook boundary', async () => {
    const bytes = await fixture('../../../engine/forgeax-engine-assets/vendor/fbx-test/humanoid.fbx');
    const diagnostics = validateSource('assets/humanoid.fbx', new Uint8Array(bytes.slice(0, 64)), bytes.byteLength);
    expect(diagnostics.filter((diagnostic) => diagnostic.code === 'invalid-fbx-header')).toEqual([]);
  });

});
