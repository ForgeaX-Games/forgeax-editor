import { afterEach, describe, expect, test } from 'bun:test';
import { build as viteBuild } from 'vite';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createStandaloneRuntimeAssetBinding } from '@forgeax/engine-types';
import {
  discoverMaterialPackages,
  discoverForgeaxWorkspacePackages,
  discoverParticleCodeModules,
  engineVitePreset,
  resolveBrowserPackageExportPath,
  resolveEngineDdcOptions,
  resolveEngineProjectDdcRoot,
  resolveGameEngineEntry,
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

describe('authored material package discovery', () => {
  test('returns only single-material Pack contracts from the active roots', () => {
    const root = tempRoot();
    const assets = join(root, 'assets');
    mkdirSync(assets);
    const materialPath = join(assets, 'pulse.pack.json');
    writeFileSync(
      materialPath,
      JSON.stringify({
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [{ kind: 'material', sourceKey: 'pulse.wgsl' }],
      }),
    );
    writeFileSync(
      join(assets, 'scene.pack.json'),
      JSON.stringify({
        schemaVersion: '2.0.0',
        kind: 'internal-text-package',
        assets: [{ kind: 'scene', sourceKey: 'scene.pack.json' }, { kind: 'scene', sourceKey: 'other' },
        ],
      }),
    );

    expect(discoverMaterialPackages([assets])).toEqual([materialPath]);
  });
});

describe('shared engine Vite preset', () => {
  test('discovers packaged dependencies from resources without a source checkout layout', () => {
    const resources = tempRoot();
    for (const name of ['engine-app', 'engine-render', 'packaged-fixture']) {
      mkdirSync(join(resources, 'engine/node_modules/@forgeax', name), { recursive: true,
      });
    }
    const entry = resolve(import.meta.dir, '../vite/engine-vite-preset.ts');
    const result = spawnSync(process.execPath, ['-e', `import {discoverForgeaxWorkspacePackages} from ${JSON.stringify(entry)}; console.log(JSON.stringify(discoverForgeaxWorkspacePackages()));`,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          FORGEAX_STARTUP_PROFILE: 'desktop-prod',
          FORGEAX_RESOURCE_ROOT: resources,
        },
      },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).sort()).toEqual([
      '@forgeax/engine-app',
      '@forgeax/engine-render',
      '@forgeax/packaged-fixture',
      '@forgeax/scene',
    ]);
  });

  test('discovers workspace exclusions from the Windows hoisted fallback', () => {
    const root = tempRoot();
    const incompleteLocalScope = join(root, 'packages', 'edit-runtime', 'node_modules', '@forgeax');
    const hoistedScope = join(root, 'node_modules', '@forgeax');
    mkdirSync(join(incompleteLocalScope, 'engine-app'), { recursive: true });
    mkdirSync(join(hoistedScope, 'engine-app'), { recursive: true });
    mkdirSync(join(hoistedScope, 'engine-render'), { recursive: true });
    mkdirSync(join(hoistedScope, 'editor-core'), { recursive: true });

    expect(discoverForgeaxWorkspacePackages([incompleteLocalScope, hoistedScope])).toEqual(
      expect.arrayContaining(['@forgeax/scene', '@forgeax/engine-render', '@forgeax/editor-core']),
    );
  });

  test('fails before optimizeDeps when no workspace package graph is materialized', () => {
    const root = tempRoot();
    expect(() =>
      discoverForgeaxWorkspacePackages([
        join(root, 'missing-local-scope'),
        join(root, 'missing-hoisted-scope'),
      ]),
    ).toThrow('run the workspace dependency setup before starting');
  });

  test('keeps the host-facing config-time facade on the same implementation', () => {
    expect(publicEngineVitePreset).toBe(engineVitePreset);
  });

  test('loads the public preset through an external Vite config loader', async () => {
    const root = tempRoot();
    const packageDir = join(root, 'node_modules', '@forgeax');
    mkdirSync(packageDir, { recursive: true });
    symlinkSync(resolve(import.meta.dir, '../..'), join(packageDir, 'editor'), 'dir');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    const configPath = join(root, 'vite.config.ts');
    writeFileSync(
      configPath,
      [
        "import { engineVitePreset } from '@forgeax/editor/vite-preset';",
        "export default engineVitePreset({ base: '/', gameDirAbs: null });",
        '',
      ].join('\n'),
    );
    const loaderPath = join(root, 'extensionless-ts-loader.mjs');
    writeFileSync(
      loaderPath,
      [
        'export async function resolve(specifier, context, nextResolve) {',
        '  try { return await nextResolve(specifier, context); }',
        '  catch (error) {',
        "    if (error?.code === 'ERR_MODULE_NOT_FOUND' && context.parentURL?.endsWith('/target-profile-importer.ts') && specifier === './target-profile-asset') return nextResolve('./target-profile-asset.ts', context);",
        '    throw error;',
        '  }',
        '}',
      ].join('\n'),
    );

    const result = spawnSync(
      'node',
      [
        '--experimental-strip-types',
        '--experimental-loader',
        loaderPath,
        '--input-type=module',
        '-e',
        [
          "import { loadConfigFromFile } from 'vite';",
          `const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, ${JSON.stringify(configPath)}, ${JSON.stringify(root)}, 'silent', undefined, 'bundle');`,
          `if (!loaded || loaded.path !== ${JSON.stringify(configPath)} || !loaded.config.plugins) throw new Error('public Vite preset config was not loaded');`,
        ].join('\n'),
      ],
      { cwd: resolve(import.meta.dir, '../..'), encoding: 'utf8' },
    );

    if (result.status !== 0) {
      throw new Error(
        `external Vite config loader failed for ${configPath}:\n${result.stdout}\n${result.stderr}`,
      );
    }
    expect(readFileSync(resolve(import.meta.dir, '../../engine-vite-preset.ts'), 'utf8')).toContain(
      "export * from './scripts/vite/engine-vite-preset.ts';",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('ERR_MODULE_NOT_FOUND');
  });

  test('keeps forgeaxShader as the sole shader registration owner', () => {
    const preset = engineVitePreset({ base: '/', gameDirAbs: null });
    const shaderPlugins = preset.plugins
      .filter(
        (plugin): plugin is { name: string } =>
          typeof plugin === 'object' &&
          plugin !== null &&
          'name' in plugin &&
          typeof plugin.name === 'string',
      )
      .filter((plugin) => plugin.name === 'forgeax:shader');

    expect(shaderPlugins).toHaveLength(1);
  });

  test('pre-bundles late physics imports while leaving Noble subpaths native', () => {
    const preset = engineVitePreset({ base: '/', gameDirAbs: null });

    expect(preset.optimizeDeps.include).toHaveLength(1);
    expect(preset.optimizeDeps.include[0]).toEndWith('node_modules/@dimforge/rapier3d-compat');
    expect(preset.optimizeDeps.include.some((entry) => entry.includes('@noble/'))).toBe(false);
  });

  test('keeps dynamic Rapier compat imports on native ESM resolution', () => {
    const preset = engineVitePreset({ base: '/', gameDirAbs: null });

    expect(preset.optimizeDeps.exclude).toEqual(
      expect.arrayContaining(['@dimforge/rapier2d-compat', '@dimforge/rapier3d-compat']),
    );
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

  test('dedupes Play dependencies from this checkout hoisted graph', () => {
    const playNodeModules = resolve(import.meta.dir, '../../node_modules');
    const preset = engineVitePreset({
      base: '/preview/',
      gameDirAbs: null,
      gameSource: { packageRoots: [playNodeModules] },
    });

    // Direct Play dependencies resolve from the hoisted checkout graph;
    // retain the existing native-resolution policy for engine-plugin.
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

describe('browser package export resolution', () => {
  test('prefers browser over Node import for dual-export packages', () => {
    expect(
      resolveBrowserPackageExportPath({
        browser: './dist/browser.mjs',
        import: './dist/index.mjs',
      }),
    ).toBe('./dist/browser.mjs');
    expect(resolveBrowserPackageExportPath({ import: './dist/index.mjs' })).toBe(
      './dist/index.mjs',
    );
    expect(resolveBrowserPackageExportPath('./dist/flat.mjs')).toBe('./dist/flat.mjs');
    expect(resolveBrowserPackageExportPath(undefined)).toBeUndefined();
  });

  test('resolveGameEngineEntry maps dual-export engine packages to the browser file', () => {
    const hostRoot = tempRoot();
    const packageDir = resolve(hostRoot, 'packages/engine-dual-export');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: '@forgeax/engine-dual-export',
        exports: {
          '.': {
            types: './dist/index.d.ts',
            browser: './dist/browser.mjs',
            import: './dist/index.mjs',
          },
        },
      }),
    );
    expect(
      resolveGameEngineEntry('@forgeax/engine-dual-export', {
        packageRoots: [hostRoot],
      }),
    ).toBe(resolve(packageDir, 'dist/browser.mjs'));
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
    const findings = Object.fromEntries(
      tsConsumers.map((relativePath) => [relativePath, ddcRootLiteral.test(source(relativePath))]),
    );

    expect(findings).toEqual({
      'scripts/vite/engine-vite-preset.ts': true,
      'packages/play-runtime/vite.config.ts': true,
      'packages/play-runtime/src/runtime-scope-controller.ts': true,
      'scripts/fx.ts': false,
    });
    expect(source('scripts/fx.ts')).toContain('FORGEAX_RUNTIME_GENERATION');
    expect(source('packages/play-runtime/vite.config.ts')).toContain(
      'createRuntimeScopeController',
    );
  });

  test('keeps mjs/cjs script and JSON/pack fixture channels free of host roots', () => {
    const scriptFiles = filesWithExtension(resolve(repoRoot, 'scripts'), ['.mjs', '.cjs']);
    const fixtureRoots = [
      resolve(repoRoot, 'packages/play-runtime'),
      resolve(repoRoot, 'apps/standalone'),
    ];
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

test('shared preset produces UI payloads for template assets', async () => {
  const root = tempRoot();
  const assets = join(root, 'assets');
  mkdirSync(assets);
  const guid = '019e3969-1d48-7c3b-ac24-6d68f457065f';
  writeFileSync(join(root, 'main.js'), 'export default 1;');
  writeFileSync(join(assets, 'hud.ui.html'), '<div class="hud">HUD</div>');
  writeFileSync(join(assets, 'hud.ui.css'), '.hud { color: white; }');
  writeFileSync(
    join(assets, 'hud.ui.html.meta.json'),
    JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'ui',
      source: 'hud.ui.html',
      importSettings: {},
      subAssets: [{ guid, sourceIndex: 0, kind: 'ui' }],
    }),
  );
  const preset = engineVitePreset({ base: '/', gameDirAbs: root });
  const dist = join(root, 'dist');
  await viteBuild({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [preset.pack],
    build: { outDir: dist, rollupOptions: { input: join(root, 'main.js') } },
  });
  const files = readdirSync(dist, { recursive: true }) as string[];
  const payloadFile = files.find((file) => file.includes(guid));
  expect(payloadFile).toBeDefined();
  if (!payloadFile) throw new Error('UI payload was not produced');
  const payload = JSON.parse(readFileSync(join(dist, payloadFile), 'utf8'));
  expect(payload.assets[0].payload.html).toContain('HUD');
  expect(payload.assets[0].payload.css).toContain('.hud');
}, 30_000);

test('standalone host resolves Engine browser entrypoints without exposing Node build APIs', () => {
  const configPath = resolve(import.meta.dir, '../../vite.config.ts');
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
    import config from ${JSON.stringify(configPath)};
    const plugin = config.plugins.flat(Infinity).find(p => p?.name === 'forgeax:standalone-engine-worktree-resolve');
    console.log(JSON.stringify({
      importer: plugin.resolveId('@forgeax/engine-import'),
      build: plugin.resolveId('@forgeax/engine-pack/build'),
    }));
  `,
    ],
    { cwd: resolve(import.meta.dir, '../..'), encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  const resolved = JSON.parse(result.stdout.trim());
  expect(resolved.importer).toEndWith('/import/dist/browser.mjs');
  expect(resolved.build).toBeNull();
});
