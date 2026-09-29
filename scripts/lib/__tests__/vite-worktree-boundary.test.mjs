import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8');

test('standalone Vite keeps editor worktrees on their vendored contracts owner', () => {
  expect(source).toContain('const HAS_STUDIO_LAYER = existsSync(STUDIO_MANIFEST);');
  expect(source).toContain('if (HAS_STUDIO_LAYER && existsSync(TYPES_SRC))');
  expect(source).toContain("import { resolveViteFsAllowRoots } from './scripts/vite/vite-fs-allow';");
  expect(source).toMatch(/allow:\s*resolveViteFsAllowRoots\(\{\s*packageDir: PACKAGE_DIR,\s*gameDir: GAME_DIR,\s*extra: HAS_STUDIO_LAYER \? \[STUDIO_ROOT\] : \[\],\s*\}\)/);
  expect(source).not.toContain("existsSync(resolve(STUDIO_ROOT, 'package.json'))");
});

test('standalone Vite pre-bundles the CommonJS source-map parser under no-discovery', () => {
  expect(source).toContain("const SOURCE_MAP_JS_DIR = realpathSync(resolve(CSS_TREE_DIR, '../source-map-js'));");
  expect(source).toContain("'source-map-js/lib/source-map-generator.js',");
  expect(source).toContain("'source-map-js': SOURCE_MAP_JS_DIR,");
});
