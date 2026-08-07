import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dir, '..', 'vite.config.ts'), 'utf8');

describe('Play catalog producer registration', () => {
  test('registers the default target profile importer', () => {
    expect(source).toContain('targetProfileImporter()');
  });

  test('projects per-game catalogs through the same Pack producer', () => {
    expect(source).toContain('const playPackPlugin = pluginPack({');
    expect(source).toContain('pack.catalogForRoots(roots)');
    expect(source).toContain("pack.catalogForRoots(roots, { target: 'build' })");
    expect(source).not.toContain('buildPerGameCatalog');
    expect(source).toContain('forgeaxPerGamePackIndex(playPackPlugin)');
    expect(source.indexOf('playPackPlugin as never,')).toBeLessThan(
      source.indexOf('forgeaxPerGamePackIndex(playPackPlugin) as never,'),
    );
  });
});
