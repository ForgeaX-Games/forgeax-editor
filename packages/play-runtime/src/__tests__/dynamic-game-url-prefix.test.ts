import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const configSource = readFileSync(resolve(import.meta.dir, '../../vite.config.ts'), 'utf8');
const runtimeSource = readFileSync(resolve(import.meta.dir, '../main.ts'), 'utf8');

describe('dynamic active-game URL prefix', () => {
  test('keeps browser entry URLs on the host-games mount before the first bind', () => {
    expect(configSource).toContain('const GAMES_URL_PREFIX = HOST_GAMES_FARM;');
    expect(configSource).not.toContain("INITIAL_GAME_DIR ? HOST_GAMES_FARM : ''");
    expect(runtimeSource).toContain('`${base}/${__FORGEAX_GAMES_URL_PREFIX__}/${id}`');
  });
});
