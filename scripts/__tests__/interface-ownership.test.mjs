import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const packageRoots = [
  'packages/content-browser/src',
  'packages/edit-runtime/src',
  'packages/panels/src',
];
const interfaceIndependentPackageRoots = packageRoots;
const interfaceIndependentPackageManifests = [
  'packages/core/package.json',
  'packages/content-browser/package.json',
  'packages/edit-runtime/package.json',
  'packages/game-plugins/package.json',
  'packages/panels/package.json',
  'packages/play-runtime/package.json',
];
const sourceExtensions = new Set(['.ts', '.tsx']);
function sourceFiles(directory, { includeTests = false } = {}) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' && !includeTests ? [] : sourceFiles(path, { includeTests });
    }
    return sourceExtensions.has(extname(entry.name)) ? [path] : [];
  });
}

describe('Editor package ownership', () => {
  test('consumes published Interface without a vendored source checkout', () => {
    const read = (path) => readFileSync(join(root, path), 'utf8');
    const manifest = JSON.parse(read('package.json'));
    expect(manifest.dependencies['@forgeax/interface']).toBeUndefined();
    expect(JSON.parse(read('apps/standalone/package.json')).dependencies['@forgeax/interface']).toBe('0.9.5');
    expect(manifest.dependencies['@forgeax/app-shell']).toBe('0.103.0');
    expect(manifest.dependencies['@forgeax/design']).toBeUndefined();
    expect(manifest.workspaces).not.toContain('packages/interface/packages/*');
    expect(read('.gitmodules')).not.toContain('packages/interface');
    expect(manifest.scripts['test:version-control']).not.toContain('-F @forgeax/interface');
    expect(read('.github/workflows/ci.yml')).not.toContain('-F @forgeax/interface');
    expect(read('scripts/bootstrap-worktree.mjs')).not.toContain('packages/interface');
    const vite = read('vite.config.ts');
    expect(vite).not.toContain('INTERFACE_DIR');
    expect(vite).not.toContain('DESIGN_DIR');
    expect(vite).not.toContain("'@/':");
    expect(vite).not.toMatch(/['"]@forgeax\/(?:interface|design)(?:\/[^'"]*)?['"]\s*:/);
    expect(vite).toContain("'@forgeax/interface/ApplicationShell'");
    expect(vite).toContain("'@forgeax/interface/application'");
    expect(vite).not.toContain('@forgeax/design');
    expect(existsSync(join(root, 'apps/standalone/__tests__/version-control-footer.test.ts'))).toBe(false);
    for (const spec of ['version-control.spec.ts', 'version-control-generation.spec.ts']) {
      expect(manifest.scripts['test:version-control']).toContain(`apps/standalone/e2e/__tests__/${spec}`);
      expect(existsSync(join(root, 'apps/standalone/e2e/__tests__', spec))).toBe(true);
    }
    const main = read('apps/standalone/main.tsx');
    expect(main).toContain("import '@forgeax/interface/styles/global.css'");
    expect(main).toContain("from '@forgeax/interface/ApplicationShell'");
    expect(main).toContain("from '@forgeax/interface/application'");
    expect(main).not.toContain('@forgeax/design');
  });

  test('owns its initial dark theme in HTML before application code loads', () => {
    const html = readFileSync(join(root, 'apps/standalone/index.html'), 'utf8');
    const main = readFileSync(join(root, 'apps/standalone/main.tsx'), 'utf8');
    const rootTag = html.match(/<html\b[^>]*>/)?.[0] ?? '';
    expect(rootTag).toContain('data-theme="dark"');
    expect(rootTag).toMatch(/class="[^"]*\bdark\b[^"]*"/);
    expect(html.indexOf(rootTag)).toBeLessThan(html.indexOf('src="./main.tsx"'));
    expect(main).not.toContain('applyTheme');
  });

  test('owns recovery translations and supplies locale through application startup', () => {
    const main = readFileSync(join(root, 'apps/standalone/main.tsx'), 'utf8');
    expect(main).not.toContain('@forgeax/interface/i18n');
    expect(main).toContain("from '@forgeax/editor-core/i18n'");
    expect(main).toContain('startInterfaceApplication(STANDALONE_OVERRIDES, { locale: requestedLocale })');
    expect(main.match(/<StandaloneRuntimeRoot>/g)?.length).toBe(2);
    expect(main).not.toContain('initI18n();');
    expect(main).not.toContain('changeLanguage(');
    expect(main).toContain("t('standaloneRecovery.title')");
  });

  test('delegates overlay observation to the public application boundary', () => {
    const main = readFileSync(join(root, 'apps/standalone/main.tsx'), 'utf8');
    const redirect = readFileSync(join(root, 'apps/standalone/settings-redirect.ts'), 'utf8');
    expect(main).toMatch(/import\s*\{[^}]*installApplicationOverlayRedirect[^}]*\}\s*from '@forgeax\/interface\/application'/s);
    expect(main).toMatch(/installSettingsPanelRedirect\(\s*installApplicationOverlayRedirect,/s);
    expect(redirect).not.toContain('activeOverlay');
    expect(redirect).not.toContain('closeOverlay');
    expect(redirect).not.toContain('.subscribe(');
    expect(main).toContain('configureStudioDomainClients(createStandaloneGameClient(');
  });

  test('injects domain clients through application and never touches the retired pinned store', () => {
    const main = readFileSync(join(root, 'apps/standalone/main.tsx'), 'utf8');
    expect(main).toMatch(/import\s*\{[^}]*configureStudioDomainClients[^}]*\}\s*from '@forgeax\/interface\/application'/s);
    expect(main).not.toContain('@forgeax/interface/store');
    expect(main).not.toContain('useShellStore');
    expect(main).not.toContain('setPinnedSlug');
    expect(main).not.toContain('forgeax.pinnedSlug');
    expect(main).toContain('configureStudioDomainClients(createStandaloneGameClient(');
    expect(main).toContain('satisfies Parameters<typeof configureStudioDomainClients>[0]');
    const startup = main.search(/\bstartInterfaceApplication\(/);
    expect(startup).toBeGreaterThan(-1);
    expect(main.indexOf('configureStudioDomainClients(createStandaloneGameClient('))
      .toBeLessThan(startup);
  });

  test('keeps production package roots free of direct Interface imports', () => {
    const violations = packageRoots.flatMap((packageRoot) => sourceFiles(join(root, packageRoot))).flatMap((path) => {
      const repositoryPath = relative(root, path);
      return [...readFileSync(path, 'utf8').matchAll(/from\s+['"](@forgeax\/interface[^'"]*)['"]/g)]
        .map((match) => match[1])
        .map((specifier) => `${repositoryPath}: ${specifier}`);
    });

    expect(violations).toEqual([]);
  });

  test('keeps package tests and manifests free of direct Interface dependencies', () => {
    const sourceViolations = interfaceIndependentPackageRoots
      .flatMap((packageRoot) => sourceFiles(join(root, packageRoot), { includeTests: true }))
      .flatMap((path) => {
        const repositoryPath = relative(root, path);
        return [...readFileSync(path, 'utf8').matchAll(/from\s+['"](@forgeax\/interface[^'"]*)['"]/g)]
          .map((match) => match[1])
          .map((specifier) => `${repositoryPath}: ${specifier}`);
      });
    const manifestViolations = interfaceIndependentPackageManifests.flatMap((manifestPath) => {
      const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8'));
      return Object.entries({
        ...manifest.dependencies,
        ...manifest.devDependencies,
      })
        .filter(([name]) => name === '@forgeax/interface')
        .map(([name, version]) => `${manifestPath}: ${name}@${version}`);
    });

    expect([...sourceViolations, ...manifestViolations]).toEqual([]);
  });

  test('uses App Shell for standalone application contracts', () => {
    const gameClientPath = 'apps/standalone/game-service-client.ts';
    const mainPath = 'apps/standalone/main.tsx';
    const gameClientSource = readFileSync(join(root, gameClientPath), 'utf8');
    const mainSource = readFileSync(join(root, mainPath), 'utf8');
    const contractViolations = [
      ...gameClientSource.matchAll(/from\s+['"](@forgeax\/interface[^'"]*)['"]/g),
    ].map((match) => `${gameClientPath}: ${match[1]}`);
    contractViolations.push(
      ...[...mainSource.matchAll(/from\s+['"](@forgeax\/interface\/core\/app-shell(?:\/types)?)['"]/g)]
        .map((match) => `${mainPath}: ${match[1]}`),
    );

    expect(contractViolations).toEqual([]);
  });

  test('uses the public Interface application runtime for detached-surface bootstrap', () => {
    const mainPath = 'apps/standalone/main.tsx';
    const mainSource = readFileSync(join(root, mainPath), 'utf8');

    expect(mainSource).not.toContain("from '@forgeax/interface/appHostBootstrap'");
    expect(mainSource).not.toContain('bootstrapAppHost(STANDALONE_OVERRIDES)');
    expect(mainSource).toMatch(
      /import\s*\{[^}]*startInterfaceApplication[^}]*\}\s*from '@forgeax\/interface\/application'/s,
    );
    expect(mainSource).toContain('startInterfaceApplication(STANDALONE_OVERRIDES, { locale: requestedLocale })');
  });

  test('contributes Editor keyboard ownership through the application extension lifecycle', () => {
    const mainPath = 'apps/standalone/main.tsx';
    const mainSource = readFileSync(join(root, mainPath), 'utf8');

    expect(mainSource).not.toContain("from '@forgeax/interface/lib/global-shortcuts'");
    expect(mainSource).not.toContain('configureInterfaceKeyboardRouter');
    expect(mainSource).toMatch(/import\s*\{[^}]*createEditorKeyboardExtension[^}]*type KeyboardRouterDepsShape[^}]*\}\s*from '@forgeax\/editor-edit-runtime\/keyboard-router-deps'/s);
    const assembly = mainSource.slice(mainSource.indexOf('const STANDALONE_OVERRIDES'), mainSource.indexOf('function startStandaloneApplication'));
    expect(assembly.match(/createEditorKeyboardExtension\(makeKeyboardRouterDeps\(\)\)/g)).toHaveLength(1);
    expect(mainSource).toContain('function makeKeyboardRouterDeps(): KeyboardRouterDepsShape');
    expect(mainSource).not.toContain('as KeyboardRouterDeps');
    const iframeSave = mainSource.slice(mainSource.indexOf('function makeKeyboardRouterDeps'), mainSource.indexOf('declare const __FORGEAX_GAME_SLUG__'));
    expect(iframeSave).toContain('if (trySaveActivePage()) return;');
    expect(iframeSave).toContain('save-human-${crypto.randomUUID()}');
    expect(iframeSave).toContain("{ source: 'human' }");
  });

  test('delegates detached shell composition while retaining product recovery and overlays', () => {
    const source = readFileSync(join(root, 'apps/standalone/main.tsx'), 'utf8');
    for (const entry of ['components/DetachedSurface', 'components/DockShell/panelRenderers', 'brand']) {
      expect(source).not.toContain(`from '@forgeax/interface/${entry}'`);
    }
    expect(source).toMatch(/import\s*\{[^}]*ApplicationDetachedShell[^}]*\}\s*from '@forgeax\/interface\/ApplicationShell'/s);
    const detachedBoot = source.slice(source.indexOf('function bootDetachedSurface'), source.indexOf('function StandaloneRuntimeRoot'));
    expect(detachedBoot).toContain('<StandaloneRuntimeRoot>');
    expect(detachedBoot).not.toContain('configureInterfaceKeyboardRouter');
    expect(detachedBoot).toContain('host={runtime.host}');
    expect(detachedBoot).toContain('SurfaceProvider={EditorOverlayProvider}');
    expect(detachedBoot).not.toContain('host.panels');
    expect(detachedBoot).not.toContain('<HostProvider');
  });

  test('uses App Shell directly for action registration and dispatch', () => {
    const mainPath = 'apps/standalone/main.tsx';
    const mainSource = readFileSync(join(root, mainPath), 'utf8');

    expect(mainSource).not.toContain("from '@forgeax/interface/lib/action-registry'");
    expect(mainSource).toMatch(
      /import\s*\{[^}]*dispatchAction[^}]*registerAction[^}]*\}\s*from '@forgeax\/app-shell\/application'/s,
    );
    const interfaceImports = [...mainSource.matchAll(
      /import\s*\{([^}]*)\}\s*from ['"]@forgeax\/interface\/application['"]/gs,
    )].map((match) => match[1]).join(',');
    expect(interfaceImports).not.toMatch(/\b(?:dispatchAction|registerAction|UiActionDef)\b/);
    expect(mainSource).toContain('projectViewportRuntimeOps(registerAction)');
    expect(mainSource).toContain("dispatchAction(\n        'saveDocToDisk'");
  });

  test('uses App Shell for standalone window decoding and root recovery', () => {
    const mainPath = 'apps/standalone/main.tsx';
    const mainSource = readFileSync(join(root, mainPath), 'utf8');
    const ownershipViolations = [
      ...mainSource.matchAll(/from\s+['"](@forgeax\/interface\/lib\/platform)['"]/g),
      ...mainSource.matchAll(/from\s+['"](@forgeax\/interface\/components\/ErrorBoundary)['"]/g),
    ].map((match) => `${mainPath}: ${match[1]}`);

    expect(ownershipViolations).toEqual([]);
    expect(mainSource).toContain("decodeSurfaceFromLocation } from '@forgeax/app-shell/window'");
    const ownerSource = readFileSync(join(root, 'apps/standalone/StandaloneRuntimeRoot.tsx'), 'utf8');
    expect(ownerSource).toContain("from '@forgeax/app-shell/react'");
    expect(ownerSource).toContain('<ApplicationRecoveryBoundary');
    expect(ownerSource).toContain('scope="standalone"');
    expect(mainSource).not.toContain("from '@forgeax/interface/lib/aegis'");
    expect(mainSource).not.toContain("onError={(error, info, scope) => reportError(error, info.componentStack, scope)}");
    expect(mainSource).toContain('__forgeaxBoot?.done()');
  });

  test('owns the standalone runtime root and public application policy', () => {
    const mainPath = 'apps/standalone/main.tsx';
    const mainSource = readFileSync(join(root, mainPath), 'utf8');

    expect(mainSource).not.toContain("from '@forgeax/interface/lib/storageKeys'");
    expect(mainSource).not.toContain('STORAGE_KEYS.onboarding');
    expect(mainSource).not.toContain("from '@forgeax/interface/App'");
    expect(readFileSync(join(root, 'apps/standalone/StandaloneRuntimeRoot.tsx'), 'utf8')).toMatch(
      /import\s+\{[^}]*\bApplicationRuntimeRoot\b[^}]*\}\s+from '@forgeax\/app-shell\/application'/,
    );
    expect(mainSource).toContain(
      "ApplicationShell } from '@forgeax/interface/ApplicationShell'",
    );
    expect(mainSource).toContain(
      '<StandaloneRuntimeRoot>',
    );
    expect(mainSource).toContain(
      '<ApplicationShell runtime={runtime} onboarding={{ enabled: false }} />',
    );
  });
});
