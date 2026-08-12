import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const presetPath = resolve(import.meta.dir, '../../../../../scripts/vite/engine-vite-preset.ts');
const source = readFileSync(presetPath, 'utf8');

describe('Edit particle Pack registration', () => {
  test('registers only the native particle cooker at the build composition root', () => {
    expect(source).toContain("from '@forgeax/engine-vfx-compiler'");
    expect(source).not.toContain('particleEffectImporter');
    expect(source).toContain('discoverParticleCodeModules(opts.pack?.rootsProvider ?? (() => packRoots))');
    expect(source).toContain('importers: [');
    expect(source).toContain('cookers: [');
  });

  test('keeps the compiler out of Edit runtime source imports', () => {
    const runtimeSource = readFileSync(resolve(import.meta.dir, '..', '..', 'index.ts'), 'utf8');
    expect(runtimeSource).not.toContain('@forgeax/engine-vfx-compiler');
  });
});
