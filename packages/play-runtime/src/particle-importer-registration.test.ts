import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const configPath = resolve(import.meta.dir, '..', 'vite.config.ts');
const source = readFileSync(configPath, 'utf8');
const preset = readFileSync(resolve(import.meta.dir, '../../../engine-vite-preset.ts'), 'utf8');

describe('independent Play particle Pack registration', () => {
  test('registers only the native particle cooker at the build composition root', () => {
    expect(source).toContain('engineVitePreset');
    expect(preset).toContain("from '@forgeax/engine-vfx-compiler'");
    expect(preset).not.toContain('particleEffectImporter');
    expect(preset).toContain('createParticleEffectNativeCooker(createStockParticleOperatorRegistry())');
    expect(preset).toContain('importers: [');
    expect(preset).toContain('cookers: [');
  });

  test('keeps the compiler out of Play runtime source imports', () => {
    const runtimeSource = readFileSync(resolve(import.meta.dir, 'main.ts'), 'utf8');
    expect(runtimeSource).not.toContain('@forgeax/engine-vfx-compiler');
  });
});
