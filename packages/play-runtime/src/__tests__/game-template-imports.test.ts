import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveGameEngineEntry } from '../../vite.config';

const PLAY_RUNTIME = resolve(import.meta.dir, '..', '..');
const GAME_TEMPLATE = resolve(PLAY_RUNTIME, '..', 'engine', 'templates', 'game-default');

function gameTemplateEngineImports(dir: string): string[] {
  const imports = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') {
        for (const specifier of gameTemplateEngineImports(path)) imports.add(specifier);
      }
      continue;
    }
    if (!entry.isFile() || !/\.[cm]?[jt]sx?$/.test(entry.name) || /\.(test|spec)\./.test(entry.name)) continue;
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/\bfrom\s*['\"](@forgeax\/[^'\"]+)['\"]|\bimport\s*\(\s*['\"](@forgeax\/[^'\"]+)['\"]\s*\)/g)) {
      imports.add(match[1] ?? match[2]!);
    }
  }
  return [...imports].sort();
}

describe('new-game template Play imports', () => {
  test('resolve from the standalone Play Runtime dependency graph', () => {
    const unresolved = gameTemplateEngineImports(GAME_TEMPLATE)
      .filter((specifier) => resolveGameEngineEntry(specifier) === null);
    expect(unresolved).toEqual([]);
  });
});
