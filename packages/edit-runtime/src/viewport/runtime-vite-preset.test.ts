import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  engineRhiDebugPlugins,
  isEditorBuildOnlyPackPath,
  resolveGameEngineEntry,
} from '../../../../engine-vite-preset';

const EDIT_RUNTIME = resolve(import.meta.dir, '..', '..');
const GAME_TEMPLATE = resolve(EDIT_RUNTIME, '..', 'engine', 'templates', 'game-default');

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

describe('resolveGameEngineEntry', () => {
  test('maps public root and subpath imports through Edit Runtime exports', () => {
    expect(resolveGameEngineEntry('@forgeax/engine-assets-runtime')).toBe(
      resolve(EDIT_RUNTIME, 'node_modules/@forgeax/engine-assets-runtime/dist/index.mjs'),
    );
    expect(resolveGameEngineEntry('@forgeax/engine-pack/guid')).toBe(
      resolve(EDIT_RUNTIME, 'node_modules/@forgeax/engine-pack/dist/guid.mjs'),
    );
    expect(resolveGameEngineEntry('@forgeax/npc-client')).toBeNull();

    const hostRoot = mkdtempSync(join(tmpdir(), 'forgeax-editor-host-'));
    try {
      const packageDir = resolve(hostRoot, 'packages/npc-client');
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        resolve(packageDir, 'package.json'),
        JSON.stringify({
          name: '@forgeax/npc-client',
          exports: { '.': { import: './dist/index.js' } },
        }),
      );
      expect(resolveGameEngineEntry('@forgeax/npc-client', { packageRoots: [hostRoot] })).toBe(
        resolve(packageDir, 'dist/index.js'),
      );
    } finally {
      rmSync(hostRoot, { recursive: true, force: true });
    }
  });

  test('leaves unavailable package exports unresolved', () => {
    expect(resolveGameEngineEntry('@forgeax/not-an-engine-package')).toBeNull();
    expect(resolveGameEngineEntry('@forgeax/engine-assets-runtime/not-exported')).toBeNull();
  });

  test('resolves every engine import used by the new-game template', () => {
    const unresolved = gameTemplateEngineImports(GAME_TEMPLATE)
      .filter((specifier) => resolveGameEngineEntry(specifier) === null);
    expect(unresolved).toEqual([]);
  });
});

describe('engineRhiDebugPlugins', () => {
  test('gates the capture middleware on the shared start flag', () => {
    expect(engineRhiDebugPlugins({})).toEqual([]);
    expect(engineRhiDebugPlugins({ FORGEAX_ENGINE_RHI_DEBUG: '0' })).toEqual([]);
    expect(engineRhiDebugPlugins({ FORGEAX_ENGINE_RHI_DEBUG: '1' })).toMatchObject([
      { name: 'forgeax:rhi-debug' },
    ]);
  });
});

describe('isEditorBuildOnlyPackPath', () => {
  test('filters shader metadata sidecars without hiding runtime assets', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-pack-path-'));
    try {
      const shaderMeta = join(root, 'animated-target.wgsl.meta.json');
      const imageMeta = join(root, 'sky.hdr.meta.json');
      const malformedShaderMeta = join(root, 'broken.wgsl.meta.json');
      writeFileSync(shaderMeta, JSON.stringify({ importer: 'shader' }));
      writeFileSync(imageMeta, JSON.stringify({ importer: 'equirect' }));
      writeFileSync(malformedShaderMeta, '{');

      expect(isEditorBuildOnlyPackPath(shaderMeta)).toBe(true);
      expect(isEditorBuildOnlyPackPath(imageMeta)).toBe(false);
      expect(isEditorBuildOnlyPackPath(malformedShaderMeta)).toBe(true);
      expect(isEditorBuildOnlyPackPath(join(root, 'animated-target.wgsl'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
