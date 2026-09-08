import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isTargetNativePackage,
  normalizePortableFileModes,
  PACKAGED_VITE_HELPERS,
  playRuntimeDesktopDependencyNames,
  rewritePackagedViteConfig,
} from '../stage-desktop-engine-runtime';

describe('desktop Engine runtime producer', () => {
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
    expect(helper).toBeDefined();
    if (helper === undefined) return;
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

  test('packaged engine Vite helper prefers the browser export over Node import', () => {
    const root = mkdtempSync(join(tmpdir(), 'editor-engine-browser-export-'));
    const outfile = join(root, 'engine-vite-preset.mjs');
    const source = resolve(import.meta.dir, '../vite/engine-vite-preset.ts');
    const built = Bun.spawnSync({
      cmd: [process.execPath, 'build', source, '--target=node', '--packages=external', '--outfile', outfile],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(new TextDecoder().decode(built.stderr)).toBe('');
    expect(built.exitCode).toBe(0);
    const bundled = readFileSync(outfile, 'utf8');
    expect(bundled).toContain('function resolveBrowserPackageExportPath');
    expect(bundled).toContain('entry?.browser');
    expect(bundled.indexOf('entry?.browser')).toBeLessThan(bundled.indexOf('entry?.import'));
    expect(bundled).toContain('resolveBrowserPackageExportPath(manifest.exports?.[exportKey])');
    rmSync(root, { recursive: true, force: true });
  });

  test('desktop Play closure declares the public engine umbrella so packaged node_modules receive it', () => {
    expect(playRuntimeDesktopDependencyNames()).toContain('@forgeax/engine');
    const staging = readFileSync(resolve(import.meta.dir, '../stage-desktop-engine-runtime.ts'), 'utf8');
    expect(staging).toContain('for (const name of Object.keys(play.dependencies ?? {})) visit(name, PLAY_ROOT, true)');
    expect(PACKAGED_VITE_HELPERS.map((helper) => helper.source)).toEqual([
      'scripts/vite/engine-vite-preset.ts',
      'scripts/vite/ddc-root-policy.ts',
    ]);
  });

  test('normalizes transported common artifact files to portable non-executable modes', () => {
    if (process.platform === 'win32') return;
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
