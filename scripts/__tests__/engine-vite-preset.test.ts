import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import {
  discoverForgeaxWorkspacePackages,
  discoverGameMaterialPackages,
  discoverParticleCodeModules,
  engineVitePreset,
  resolveEngineDdcOptions,
  resolveEngineProjectDdcRoot,
} from '../vite/engine-vite-preset';
import { engineVitePreset as publicEngineVitePreset } from '../../engine-vite-preset';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-vfx-modules-'));
  tempRoots.push(root);
  return root;
}

describe('particle code module discovery', () => {
  test('refreshes when a dynamic host replaces the roots returned by its provider', () => {
    const root = tempRoot();
    const modulePath = join(root, 'charge.vfx.wgsl');
    let roots: readonly string[] = [];
    const modules = discoverParticleCodeModules(() => roots);

    expect(modules['charge.vfx.wgsl']).toBeUndefined();
    writeFileSync(modulePath, 'fn vfx_spawn() {}');
    roots = [root];
    expect(modules['charge.vfx.wgsl']?.entry).toBe('fn vfx_spawn() {}');
  });

  test('refreshes changed and removed WGSL when a watched pack is recooked', () => {
    const root = tempRoot();
    const modulePath = join(root, 'pulse.vfx.wgsl');
    writeFileSync(modulePath, 'fn vfx_spawn() {}');
    const modules = discoverParticleCodeModules([root]);

    expect(modules['pulse.vfx.wgsl']?.entry).toBe('fn vfx_spawn() {}');
    writeFileSync(modulePath, 'fn vfx_spawn() { let changed = true; }');
    expect(modules['pulse.vfx.wgsl']?.entry).toBe('fn vfx_spawn() { let changed = true; }');
    unlinkSync(modulePath);
    expect(modules['pulse.vfx.wgsl']).toBeUndefined();
  });

  test('fails fast when two roots claim the same module identity', () => {
    const root = tempRoot();
    const nested = join(root, 'nested');
    mkdirSync(nested);
    writeFileSync(join(root, 'pulse.vfx.wgsl'), 'fn vfx_spawn() {}');
    writeFileSync(join(nested, 'pulse.vfx.wgsl'), 'fn vfx_spawn() { let duplicate = true; }');

    expect(() => discoverParticleCodeModules([root])).toThrow(
      'duplicate VFX module identity pulse.vfx.wgsl',
    );
  });
});

describe('shared engine Vite preset', () => {
  test('discovers workspace exclusions from the Windows hoisted fallback', () => {
    const root = tempRoot();
    const incompleteLocalScope = join(root, 'packages', 'edit-runtime', 'node_modules', '@forgeax');
    const hoistedScope = join(root, 'node_modules', '@forgeax');
    mkdirSync(join(incompleteLocalScope, 'engine-app'), { recursive: true });
    mkdirSync(join(hoistedScope, 'engine-app'), { recursive: true });
    mkdirSync(join(hoistedScope, 'engine-render'), { recursive: true });
    mkdirSync(join(hoistedScope, 'editor-core'), { recursive: true });

    expect(discoverForgeaxWorkspacePackages([
      incompleteLocalScope,
      hoistedScope,
    ])).toEqual(expect.arrayContaining([
      '@forgeax/scene',
      '@forgeax/engine-render',
      '@forgeax/editor-core',
    ]));
  });

  test('discovers the packaged engine resource scope a desktop host declares', () => {
    const root = tempRoot();
    const packagedScope = join(root, 'engine', 'node_modules', '@forgeax');
    mkdirSync(join(packagedScope, 'engine-app'), { recursive: true });
    mkdirSync(join(packagedScope, 'engine-render'), { recursive: true });
    mkdirSync(join(packagedScope, 'editor-core'), { recursive: true });
    const previous = process.env.FORGEAX_ENGINE_RESOURCE_ROOT;
    process.env.FORGEAX_ENGINE_RESOURCE_ROOT = join(root, 'engine');
    try {
      expect(discoverForgeaxWorkspacePackages()).toEqual(expect.arrayContaining([
        '@forgeax/scene',
        '@forgeax/engine-render',
        '@forgeax/editor-core',
      ]));
    } finally {
      if (previous === undefined) delete process.env.FORGEAX_ENGINE_RESOURCE_ROOT;
      else process.env.FORGEAX_ENGINE_RESOURCE_ROOT = previous;
    }
  });

  test('fails before optimizeDeps when no workspace package graph is materialized', () => {
    const root = tempRoot();
    expect(() => discoverForgeaxWorkspacePackages([
      join(root, 'missing-local-scope'),
      join(root, 'missing-hoisted-scope'),
    ])).toThrow('run the workspace dependency setup before starting');
  });

  test('registers only source-backed material packages with the shader plugin', () => {
    const root = tempRoot();
    const authoredPath = join(root, 'hit-flash-material.pack.json');
    const runtimeOnlyPath = join(root, 'base-material.pack.json');
    writeFileSync(authoredPath, JSON.stringify({
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [{
        guid: '019e7535-5e5e-45fe-a328-0b08e3a72747',
        kind: 'material',
        sourceKey: 'shaders/hit-flash.wgsl',
        payload: { kind: 'material', passes: [] },
        refs: [],
      }],
    }));
    writeFileSync(runtimeOnlyPath, JSON.stringify({
      schemaVersion: '2.0.0',
      kind: 'internal-text-package',
      assets: [{
        guid: 'eb5bf6e6-2e47-4d9a-99fd-81843228c9b3',
        kind: 'material',
        payload: { kind: 'material', passes: [] },
        refs: [],
      }],
    }));

    expect(discoverGameMaterialPackages([root])).toEqual([authoredPath]);
    const source = readFileSync(resolve(import.meta.dir, '../vite/engine-vite-preset.ts'), 'utf8');
    expect(source).toContain('materialPackagesProvider');
    expect(source).toContain('discoverGameMaterialPackages(packRootsProvider)');
  });

  test('keeps the host-facing config-time facade on the same implementation', () => {
    expect(publicEngineVitePreset).toBe(engineVitePreset);
  });

  test('pre-bundles late physics imports while leaving Noble subpaths native', () => {
    const preset = engineVitePreset({ base: '/', gameDirAbs: null });

    expect(preset.optimizeDeps.include).toHaveLength(1);
    expect(preset.optimizeDeps.include[0]).toEndWith(
      'packages/engine/packages/physics-rapier3d/node_modules/@dimforge/rapier3d-compat',
    );
    expect(preset.optimizeDeps.include.some((entry) => entry.includes('@noble/'))).toBe(false);
  });

  test('keeps dynamic Rapier compat imports on native ESM resolution', () => {
    const preset = engineVitePreset({ base: '/', gameDirAbs: null });

    expect(preset.optimizeDeps.exclude).toEqual(expect.arrayContaining([
      '@dimforge/rapier2d-compat',
      '@dimforge/rapier3d-compat',
    ]));
  });

  test('keeps project publication under the game and build cache under the host', () => {
    const gameDir = '/tmp/forgeax-game';
    expect(resolveEngineProjectDdcRoot(gameDir)).toBe('/tmp/forgeax-game/.forgeax/ddc/v2');
    expect(resolveEngineDdcOptions(gameDir)).toEqual({
      buildCacheRoot: resolve(import.meta.dir, '../../.forgeax/ddc/build-cache'),
      projectDdcRoot: '/tmp/forgeax-game/.forgeax/ddc/v2',
    });
    expect(resolveEngineDdcOptions(null).projectDdcRoot).toBe(
      resolve(import.meta.dir, '../../.forgeax/ddc/v2'),
    );
  });

  test('honors process-scoped DDC roots for the in-process standalone host', () => {
    const previousProjectRoot = process.env.FORGEAX_DDC_PROJECT_ROOT;
    const previousBuildRoot = process.env.FORGEAX_DDC_BUILD_CACHE_ROOT;
    try {
      process.env.FORGEAX_DDC_PROJECT_ROOT = '/tmp/forgeax-ddc/engine-a/standalone-host';
      process.env.FORGEAX_DDC_BUILD_CACHE_ROOT = '/tmp/forgeax-ddc/engine-a/build';
      expect(resolveEngineDdcOptions('/tmp/forgeax-game')).toEqual({
        buildCacheRoot: '/tmp/forgeax-ddc/engine-a/build',
        projectDdcRoot: '/tmp/forgeax-ddc/engine-a/standalone-host',
      });
    } finally {
      if (previousProjectRoot === undefined) delete process.env.FORGEAX_DDC_PROJECT_ROOT;
      else process.env.FORGEAX_DDC_PROJECT_ROOT = previousProjectRoot;
      if (previousBuildRoot === undefined) delete process.env.FORGEAX_DDC_BUILD_CACHE_ROOT;
      else process.env.FORGEAX_DDC_BUILD_CACHE_ROOT = previousBuildRoot;
    }
  });

  test('does not let a nested Play host dedupe through the parent checkout', () => {
    const playNodeModules = resolve(import.meta.dir, '../../packages/play-runtime/node_modules');
    const preset = engineVitePreset({
      base: '/preview/',
      gameDirAbs: null,
      gameSource: { packageRoots: [playNodeModules] },
    });

    // engine-plugin is intentionally transitive in Play. Dedupe would anchor
    // it at Play's root, walk out of a nested worktree, and select the primary
    // checkout's incompatible package. engine-app is a direct Play dependency
    // and remains deduped at the host root.
    expect(preset.resolve.dedupe).not.toContain('@forgeax/engine-plugin');
    expect(preset.resolve.dedupe).toContain('@forgeax/engine-app');
  });

  test('keeps a dynamic self-hosting Pack bindable before game selection', async () => {
    const root = tempRoot();
    const assets = join(root, 'assets');
    const projectDdcRoot = join(root, '.forgeax', 'ddc', 'v2');
    mkdirSync(assets);
    const preset = engineVitePreset({
      base: '/preview/',
      gameDirAbs: null,
      ddc: {
        buildCacheRoot: join(root, 'build-cache'),
        projectDdcRoot: join(root, '.forgeax', 'ddc', 'unbound'),
      },
      pack: { roots: [assets] },
    });
    const pack = preset.pack;
    expect(pack).not.toBeNull();
    pack!.configureServer({
      middlewares: { use() {} },
      ws: { send() {} },
    } as never);

    try {
      const binding = {
        ...createStandaloneRuntimeAssetBinding('game-a', 'scope-a'),
        generation: 1,
      };
      await expect(pack!.rebind(binding, [assets], projectDdcRoot)).resolves.toMatchObject({
        gameId: 'game-a',
        generation: 1,
        status: 'ready',
      });
    } finally {
      await pack!.closeBundle();
    }
  });
});

describe('DDC consumer census', () => {
  const repoRoot = resolve(import.meta.dir, '../..');
  const tsConsumers = [
    'scripts/vite/engine-vite-preset.ts',
    'packages/play-runtime/vite.config.ts',
    'packages/play-runtime/src/runtime-scope-controller.ts',
    'scripts/fx.ts',
  ];
  const ddcRootLiteral = /projectDdcRoot|buildCacheRoot/;

  function source(relativePath: string): string {
    return readFileSync(resolve(repoRoot, relativePath), 'utf8');
  }

  function filesWithExtension(root: string, extensions: readonly string[]): string[] {
    const result: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name === 'node_modules' || entry.name === 'dist')) continue;
      const path = resolve(root, entry.name);
      if (entry.isDirectory()) result.push(...filesWithExtension(path, extensions));
      else if (extensions.some((extension) => entry.name.endsWith(extension))) result.push(path);
    }
    return result;
  }

  test('records every TypeScript root/rebind consumer and the fixed generation seam', () => {
    const findings = Object.fromEntries(tsConsumers.map((relativePath) => [
      relativePath,
      ddcRootLiteral.test(source(relativePath)),
    ]));

    expect(findings).toEqual({
      'scripts/vite/engine-vite-preset.ts': true,
      'packages/play-runtime/vite.config.ts': true,
      'packages/play-runtime/src/runtime-scope-controller.ts': true,
      'scripts/fx.ts': false,
    });
    expect(source('scripts/fx.ts')).toContain('FORGEAX_RUNTIME_GENERATION');
    expect(source('packages/play-runtime/vite.config.ts')).toContain('createRuntimeScopeController');
  });

  test('keeps mjs/cjs script and JSON/pack fixture channels free of host roots', () => {
    const scriptFiles = filesWithExtension(resolve(repoRoot, 'scripts'), ['.mjs', '.cjs']);
    const fixtureRoots = [resolve(repoRoot, 'packages/play-runtime'), resolve(repoRoot, 'apps/standalone')];
    const fixtureFiles = fixtureRoots.flatMap((root) =>
      filesWithExtension(root, ['.json', '.pack.json']),
    );

    expect(scriptFiles.length).toBeGreaterThan(0);
    expect(fixtureFiles).toContain(resolve(repoRoot, 'packages/play-runtime/package.json'));
    for (const path of [...scriptFiles, ...fixtureFiles]) {
      expect(readFileSync(path, 'utf8')).not.toMatch(ddcRootLiteral);
    }
  });
});
