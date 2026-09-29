import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { listGameTemplates, resolveLaunchableGameTemplate } from '../template-catalog';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'forgeax-template-catalog-'));
  temporaryRoots.push(root);
  return root;
}

function writeTemplate(root: string, slug: string, manifest: Record<string, unknown>, files: string[] = []): void {
  const directory = resolve(root, slug);
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'forge.json'), JSON.stringify(manifest));
  for (const file of files) {
    mkdirSync(resolve(directory, file, '..'), { recursive: true });
    writeFileSync(resolve(directory, file), 'export default {};\n');
  }
}

describe('editor-owned game template catalog', () => {
  test('reads valid projects from engine/templates', async () => {
    const templates = await listGameTemplates(resolve(import.meta.dir, '../../../packages/engine/templates'));

    expect(templates).toEqual(expect.arrayContaining([
      { slug: 'game-3d', name: 'Game 3D' },
      { slug: 'empty', name: '最小工程' },
    ]));
    expect(templates.map((template) => template.slug)).toEqual(
      [...templates.map((template) => template.slug)].sort(),
    );
  });

  test('uses one launchability contract for legacy and plugin templates', async () => {
    const root = fixtureRoot();
    writeTemplate(root, 'legacy', { name: 'Legacy', entry: 'src/main.ts' }, ['src/main.ts']);
    writeTemplate(root, 'plugin-game', {
      id: 'plugin-game',
      name: 'Plugin Game',
      defaultScene: 'scene-guid',
      plugins: [{ name: '@forgeax/engine/physics/rapier3d' }, { name: './assets/plugin.ts' }],
    }, ['assets/plugin.ts']);
    writeTemplate(root, 'broken-plugin', {
      id: 'broken-plugin',
      name: 'Broken Plugin',
      plugins: [{ name: './assets/missing.ts' }],
    });

    expect(resolveLaunchableGameTemplate(root, 'legacy')?.name).toBe('Legacy');
    expect(resolveLaunchableGameTemplate(root, 'plugin-game')?.name).toBe('Plugin Game');
    expect(resolveLaunchableGameTemplate(root, 'broken-plugin')).toBeNull();
    expect(await listGameTemplates(root)).toEqual([
      { slug: 'legacy', name: 'Legacy' },
      { slug: 'plugin-game', name: 'Plugin Game' },
    ]);
  });

  test('rejects malformed and non-launchable templates', async () => {
    const root = fixtureRoot();
    // Invalid slug (uppercase rejected by GAME_TEMPLATE_SLUG_RE).
    expect(resolveLaunchableGameTemplate(root, 'Game-3D')).toBeNull();
    // Slug resolves to a file, not a directory.
    writeFileSync(resolve(root, 'afile'), 'x');
    expect(resolveLaunchableGameTemplate(root, 'afile')).toBeNull();
    // forge.json missing -> readFileSync throws -> catch -> null.
    mkdirSync(resolve(root, 'nojson'), { recursive: true });
    expect(resolveLaunchableGameTemplate(root, 'nojson')).toBeNull();
    // manifest is JSON null (not an object).
    mkdirSync(resolve(root, 'nulljson'), { recursive: true });
    writeFileSync(resolve(root, 'nulljson', 'forge.json'), 'null');
    expect(resolveLaunchableGameTemplate(root, 'nulljson')).toBeNull();
    // Empty/whitespace name.
    writeTemplate(root, 'noname', { name: '   ' });
    expect(resolveLaunchableGameTemplate(root, 'noname')).toBeNull();
    // Plugin entry is not an object.
    writeTemplate(root, 'badplugin', { id: 'badplugin', name: 'Bad', plugins: ['oops'] });
    expect(resolveLaunchableGameTemplate(root, 'badplugin')).toBeNull();
    // Plugin name is empty/whitespace.
    writeTemplate(root, 'emptyname', { id: 'emptyname', name: 'Empty', plugins: [{ name: '   ' }] });
    expect(resolveLaunchableGameTemplate(root, 'emptyname')).toBeNull();
  });

  test('confinedFile rejects unsafe and non-file entry/plugin paths', async () => {
    const root = fixtureRoot();
    // Empty entry path.
    writeTemplate(root, 'empty-entry', { name: 'Empty', entry: '' });
    expect(resolveLaunchableGameTemplate(root, 'empty-entry')).toBeNull();
    // Entry with surrounding whitespace (path !== path.trim()).
    writeTemplate(root, 'ws-entry', { name: 'Ws', entry: ' src/main.ts ' }, ['src/main.ts']);
    expect(resolveLaunchableGameTemplate(root, 'ws-entry')).toBeNull();
    // Absolute entry path escapes the template dir.
    writeTemplate(root, 'abs-entry', { name: 'Abs', entry: '/etc/passwd' });
    expect(resolveLaunchableGameTemplate(root, 'abs-entry')).toBeNull();
    // Relative entry path escapes the template dir via '..'.
    writeTemplate(root, 'escape-entry', { name: 'Escape', entry: '../escape.ts' });
    expect(resolveLaunchableGameTemplate(root, 'escape-entry')).toBeNull();
    // Entry path resolves to a directory, not a file.
    writeTemplate(root, 'dir-entry', { name: 'Dir', entry: 'subdir' }, ['subdir/inner.ts']);
    expect(resolveLaunchableGameTemplate(root, 'dir-entry')).toBeNull();
  });
});
