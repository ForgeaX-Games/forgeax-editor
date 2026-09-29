import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dir, '../..');
const app = resolve(root, 'apps/standalone');
const manifest = (directory) => JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));

describe('standalone package boundary', () => {
  test('runs DOM-owning suites together without leaking their global registration', () => {
    // Seed 42 runs the keyboard suite before the runtime suite, as Linux CI did.
    const result = spawnSync(process.execPath, [
      'test', './__tests__/editor-command-lifecycle.test.ts', './__tests__/runtime-owner.test.tsx',
      '--max-concurrency=1', '--randomize', '--seed=42',
    ], { cwd: app, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
    expect({ status: result.status, failure: result.status === 0 ? null : result.stderr }).toEqual({
      status: 0, failure: null,
    });
  }, 15_000);

  test('keeps the private application in the repository workspace, never a root dependency', () => {
    const editor = manifest(root);
    expect(editor.workspaces).toContain('apps/standalone');
    expect(existsSync(resolve(app, 'package.json'))).toBe(true);
    const standalone = manifest(app);
    expect(standalone.name).toBe('@forgeax/editor-standalone');
    expect(standalone.private).toBe(true);
    expect(standalone.dependencies['@forgeax/editor']).toBe('file:../..');
    expect(standalone.dependencies['@forgeax/interface']).toBe('0.9.5');
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      expect(editor[field]?.[standalone.name]).toBeUndefined();
      expect(editor[field]?.['@forgeax/interface']).toBeUndefined();
    }
    expect(standalone.scripts).toMatchObject({
      dev: 'bun ../../scripts/dev-standalone.ts',
      'dev:host': 'vite --config ../../vite.config.ts',
      build: 'vite build --config ../../vite.config.ts',
      test: 'bun test ./__tests__ --path-ignore-patterns=**/repro-console.test.mjs',
    });
    expect(standalone.scripts.publish).toBeUndefined();
    expect(standalone.scripts.prepublishOnly).toBeUndefined();
  });

  test('allows only library source, required tooling and configuration in the Editor tarball', () => {
    const editor = manifest(root);
    expect(editor.files).toBeArray();
    const packed = spawnSync(process.execPath, ['pm', 'pack', '--dry-run', '--ignore-scripts'], {
      cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
    });
    expect(packed.status).toBe(0);
    const files = [...packed.stdout.matchAll(/^packed \S+ (.+)$/gm)].map((match) => match[1]);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((path) => path.startsWith('apps/standalone/') || path.includes('/node_modules/'))).toEqual([]);
    for (const target of Object.values(editor.exports)) {
      expect(existsSync(resolve(root, target))).toBe(true);
      expect(target).not.toContain('standalone');
      expect(files).toContain(target.replace(/^\.\//, ''));
    }
  }, 15_000);

  test('resolves the local Editor facade and published Interface from the application', () => {
    const editorEntry = Bun.resolveSync('@forgeax/editor/app-kit', app);
    expect(realpathSync(editorEntry)).toBe(realpathSync(resolve(root, manifest(root).exports['./app-kit'])));
    expect(Bun.resolveSync('@forgeax/interface/application', app)).toContain('@forgeax');
  });

  test('gives copied browser fixtures the repository hoisted dependency graph', () => {
    for (const config of ['playwright.config.ts', 'playwright.smoke.config.ts']) {
      const source = readFileSync(resolve(root, config), 'utf8');
      expect(source).not.toContain("'packages/play-runtime/node_modules'");
    }
    expect(Bun.resolveSync('@forgeax/engine-pack/source', root)).toContain('/packages/engine/packages/pack/');
  });
});
