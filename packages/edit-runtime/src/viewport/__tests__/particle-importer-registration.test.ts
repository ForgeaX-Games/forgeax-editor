import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const presetPath = resolve(import.meta.dir, '..', 'runtime-vite-preset.ts');
const source = readFileSync(presetPath, 'utf8');

describe('Edit particle importer registration', () => {
  test('registers the stock particle importer at the build composition root', () => {
    expect(source).toContain("from '@forgeax/engine-vfx-compiler'");
    expect(source).toContain('particleEffectImporter(createStockParticleOperatorRegistry())');
    expect(source).toContain('importers: [');
  });

  test('keeps the compiler out of Edit runtime source imports', () => {
    const runtimeSource = readFileSync(resolve(import.meta.dir, '..', '..', 'index.ts'), 'utf8');
    expect(runtimeSource).not.toContain('@forgeax/engine-vfx-compiler');
  });
});
