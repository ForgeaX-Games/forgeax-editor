import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isTargetNativePackage,
  normalizePortableFileModes,
  PACKAGED_VITE_HELPERS,
  rewritePackagedViteConfig,
  stageEditorDesktopEngineRuntime,
} from '../stage-desktop-engine-runtime';

describe('desktop Engine runtime producer', () => {
  test('loads the source Play Vite config under Node without externalizing TypeScript helpers', () => {
    const result = spawnSync('node', ['--input-type=module', '-e',
      `import { loadConfigFromFile } from 'vite';
       const config = await loadConfigFromFile({ command: 'serve', mode: 'development' }, 'packages/play-runtime/vite.config.ts');
       if (!config) throw new Error('Play config was not loaded');`,
    ], { cwd: resolve(import.meta.dir, '../..'), encoding: 'utf8', timeout: 30_000 });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  }, 35_000);

  test('separates native packages and binary-bearing packages from common files', () => {
    const root = mkdtempSync(join(tmpdir(), 'editor-engine-native-'));
    mkdirSync(join(root, 'prebuilds/darwin-arm64'), { recursive: true });
    writeFileSync(join(root, 'prebuilds/darwin-arm64/addon.node'), 'native');
    expect(isTargetNativePackage('@esbuild/darwin-arm64', root)).toBe(true);
    expect(isTargetNativePackage('custom-addon', root)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test('rewrites Editor-private Vite paths for the packaged runtime', () => {
    const source = PACKAGED_VITE_HELPERS
      .map((helper) => `import { helper } from '${helper.importPath}';`)
      .join('\n');
    const rewritten = rewritePackagedViteConfig(source);
    for (const helper of PACKAGED_VITE_HELPERS) expect(rewritten).toContain(`from './${helper.output}'`);
  });

  test('rewrites mapped helpers across static, side-effect, and dynamic imports only', () => {
    const helper = PACKAGED_VITE_HELPERS[0];
    const source = [
      `import { helper } from '${helper.importPath}';`,
      `import '${helper.importPath}';`,
      `const dynamic = import("${helper.importPath}");`,
      `// import '${helper.importPath}';`,
      `const text = "from '${helper.importPath}'";`,
    ].join('\n');

    const rewritten = rewritePackagedViteConfig(source);
    expect(rewritten).toContain("import { helper } from './engine-vite-preset.mjs';");
    expect(rewritten).toContain("import './engine-vite-preset.mjs';");
    expect(rewritten).toContain('import("./engine-vite-preset.mjs")');
    expect(rewritten).toContain(`// import '${helper.importPath}';`);
    expect(rewritten).toContain(`const text = "from '${helper.importPath}'";`);
  });

  test('fails closed when a new Editor-private Vite helper is not in the mapping', () => {
    for (const source of [
      "import { futureHelper } from '../../scripts/vite/future-helper.ts';",
      "import '../../scripts/vite/future-helper.ts';",
      "const futureHelper = import('../../scripts/vite/future-helper.ts');",
    ]) {
      expect(() => rewritePackagedViteConfig(source)).toThrow('Editor-private helper import');
    }
  });

  test('does not reject private-looking paths in comments or ordinary strings', () => {
    const source = [
      "// import { futureHelper } from '../../scripts/vite/future-helper.ts';",
      "const text = \"from '../../scripts/vite/future-helper.ts'\";",
      "const template = `import '../../scripts/vite/future-helper.ts'`;",
    ].join('\n');
    expect(() => rewritePackagedViteConfig(source)).not.toThrow();
  });

  test('generates a common artifact whose packaged Vite config resolves every bundled helper', () => {
    const root = mkdtempSync(join(tmpdir(), 'editor-engine-common-artifact-'));
    const output = join(root, 'common');
    try {
      stageEditorDesktopEngineRuntime(output, 'common');

      for (const file of ['DejaVuSansMono.ttf', 'DejaVuSansMono.ttf.meta.json', 'DejaVuSansMono.atlas.png', 'DejaVuSansMono.font.pack.json']) {
        expect(existsSync(join(output, 'engine/forgeax-engine-assets/dejavu-fonts', file))).toBe(true);
      }
      const config = join(output, 'engine/vite.config.ts');
      const configSource = readFileSync(config, 'utf8');
      // Inspect the actual product config, not only the known helper list.
      for (const { path } of new Bun.Transpiler({ loader: 'ts' }).scanImports(configSource)) {
        if (path.startsWith('.')) expect(resolve(dirname(config), path).startsWith(`${dirname(config)}/`)).toBe(true);
        if (!path.startsWith('node:')) expect(() => Bun.resolveSync(path, dirname(config))).not.toThrow();
      }
      for (const helper of PACKAGED_VITE_HELPERS) {
        const helperImport = `./${helper.output}`;
        expect(configSource).toContain(`from '${helperImport}'`);
        const helperPath = resolve(dirname(config), helperImport);
        expect(existsSync(helperPath)).toBe(true);
        expect(realpathSync(helperPath)).toBe(realpathSync(join(output, 'engine', helper.output)));
        // Bundled helpers must not retain source-tree imports that only resolve
        // in the Editor checkout, especially Play's host-side route handlers.
        const helperSource = readFileSync(helperPath, 'utf8');
        for (const { path } of new Bun.Transpiler({ loader: 'js' }).scanImports(helperSource)) {
          if (path.startsWith('.')) expect(() => Bun.resolveSync(path, dirname(helperPath))).not.toThrow();
        }
      }
      const modules = join(output, 'engine/node_modules');
      for (const name of ['@types/node', 'typescript', 'vitest']) {
        expect(existsSync(join(modules, name, 'package.json'))).toBe(true);
      }
      expect(JSON.parse(readFileSync(join(modules, 'typescript/package.json'), 'utf8')).version).toBe('6.0.3');
      const visit = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (lstatSync(path).isSymbolicLink()) throw new Error(`packaged dependency remains a symlink: ${path}`);
          if (entry.isDirectory()) visit(path);
        }
      };
      visit(modules);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test('normalizes transported common artifact files to portable non-executable modes', () => {
    const root = mkdtempSync(join(tmpdir(), 'editor-engine-common-modes-'));
    const files = ['node_modules/example/bin.js', 'node_modules/example/nested/module.wasm'];
    for (const file of files) {
      const path = join(root, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file);
      chmodSync(path, 0o755);
    }

    normalizePortableFileModes(root);

    for (const file of files) expect(statSync(join(root, file)).mode & 0o777).toBe(0o644);
    rmSync(root, { recursive: true, force: true });
  });
});
