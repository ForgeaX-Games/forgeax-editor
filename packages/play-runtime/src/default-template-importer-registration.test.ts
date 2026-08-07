import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(import.meta.dir, '..', 'vite.config.ts'), 'utf8');
const presetSource = readFileSync(resolve(import.meta.dir, '../../../engine-vite-preset.ts'), 'utf8');

describe('Play catalog producer registration', () => {
  test('registers the default target profile importer', () => {
    expect(presetSource).toContain('targetProfileImporter()');
  });

  test('binds one exact game realm and has no per-game projection escape hatch', () => {
    expect(source).toContain('singleGamePackRoots');
    expect(source).toContain('createRuntimeScopeController');
    expect(source).not.toContain('catalogForRoots');
    expect(source).not.toContain('forgeaxPerGamePackIndex');
    expect(source).not.toContain('FORGEAX_PREVIEW_GAMES_DIR');
    expect(source).not.toContain('FORGEAX_PREVIEW_GAME_SLUGS');
  });
});
