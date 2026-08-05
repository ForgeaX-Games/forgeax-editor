import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const configPath = resolve(import.meta.dir, '..', 'vite.config.ts');
const source = readFileSync(configPath, 'utf8');

describe('independent Play particle importer registration', () => {
  test('registers the stock particle importer at the build composition root', () => {
    expect(source).toContain("from '@forgeax/engine-vfx-compiler'");
    expect(source).toContain('particleEffectImporter(createStockParticleOperatorRegistry())');
    expect(source).toContain('importers: [');
  });

  test('keeps the compiler out of Play runtime source imports', () => {
    const runtimeSource = readFileSync(resolve(import.meta.dir, 'main.ts'), 'utf8');
    expect(runtimeSource).not.toContain('@forgeax/engine-vfx-compiler');
  });
});
