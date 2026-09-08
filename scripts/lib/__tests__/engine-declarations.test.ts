import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ENGINE_CRITICAL_PACKAGES,
  ENGINE_DECLARATION_ARTIFACTS,
  hasTrustedEngineDeclarations,
} from '../engine-declarations.ts';

function makeEngineOutput(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-engine-declarations-'));
  for (const pkg of ENGINE_CRITICAL_PACKAGES) {
    const dist = join(root, 'packages', pkg, 'dist');
    mkdirSync(dist, { recursive: true });
    for (const artifact of ENGINE_DECLARATION_ARTIFACTS) {
      writeFileSync(join(dist, artifact), `export {} from '${pkg}';\n`);
    }
  }
  return root;
}

describe('Engine declaration provenance', () => {
  test('accepts a clean matching pin with non-empty critical declarations', () => {
    const engineDir = makeEngineOutput();
    try {
      expect(
        hasTrustedEngineDeclarations({
          engineDir,
          currentHead: 'engine-sha',
          builtFor: 'engine-sha',
          sourceStatus: '',
        }),
      ).toBe(true);
    } finally {
      rmSync(engineDir, { recursive: true, force: true });
    }
  });

  test.each([
    ['dirty Engine source', { sourceStatus: ' M packages/geometry/src/index.ts' }],
    ['stale Engine pin', { builtFor: 'old-engine-sha' }],
  ])('rejects %s', (_label, override) => {
    const engineDir = makeEngineOutput();
    try {
      expect(
        hasTrustedEngineDeclarations({
          engineDir,
          currentHead: 'engine-sha',
          builtFor: 'engine-sha',
          sourceStatus: '',
          ...override,
        }),
      ).toBe(false);
    } finally {
      rmSync(engineDir, { recursive: true, force: true });
    }
  });

  test('rejects a missing or zero-byte declaration on the import geometry edge', () => {
    const engineDir = makeEngineOutput();
    try {
      const geometryMap = join(
        engineDir,
        'packages',
        'geometry',
        'dist',
        'index.d.ts.map',
      );
      writeFileSync(geometryMap, '');
      expect(
        hasTrustedEngineDeclarations({
          engineDir,
          currentHead: 'engine-sha',
          builtFor: 'engine-sha',
          sourceStatus: '',
        }),
      ).toBe(false);

      rmSync(geometryMap);
      expect(
        hasTrustedEngineDeclarations({
          engineDir,
          currentHead: 'engine-sha',
          builtFor: 'engine-sha',
          sourceStatus: '',
        }),
      ).toBe(false);
    } finally {
      rmSync(engineDir, { recursive: true, force: true });
    }
  });
});
