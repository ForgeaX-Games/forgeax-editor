import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..', '..', '..', '..');
const adapterSource = readFileSync(resolve(root, 'packages/play-runtime/src/product-runtime-adapter.ts'), 'utf8');
const carrierSource = readFileSync(resolve(root, 'packages/product/src/transport/stdio-carrier.ts'), 'utf8');

test('Play product adapter consumes only the typed core protocol boundary', () => {
  expect(adapterSource).toContain("from '@forgeax/editor-core/protocol'");
  expect(adapterSource).not.toContain("from '@forgeax/editor-core'");
  expect(adapterSource).toContain('onVagMessage');
  expect(adapterSource).toContain('createPlayProductRuntimeAdapter');
});

test('production carriers do not expose raw evaluation or hidden browser transport', () => {
  const productionSources = [adapterSource, carrierSource];
  for (const source of productionSources) {
    expect(source).not.toMatch(/\beval\s*\(/);
    expect(source).not.toMatch(/chrom(e|ium)|playwright/i);
  }
});


test('Play entry consumes the browser-only gameplay input subpath without the Editor UI barrel', async () => {
  const entrySource = readFileSync(resolve(root, 'packages/play-runtime/src/main.ts'), 'utf8');
  expect(entrySource).not.toMatch(/from ['"]@forgeax\/editor-core['"]/);
  expect(entrySource).toContain("from '@forgeax/editor-core/gameplay-input'");
  const entry = Bun.resolveSync('@forgeax/editor-core/gameplay-input', resolve(root, 'packages/play-runtime'));
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    write: false,
  });
  expect(result.success).toBe(true);
  const bundled = await result.outputs[0]!.text();
  expect(bundled).not.toMatch(/from ["']react(?:-dom|\/jsx-runtime)?["']/);
  expect(bundled).not.toContain('store/selection');
  expect(bundled).toContain('createGameplayInputSurface');
});
