/**
 * Package-boundary guard for @forgeax/interface.
 *
 * interface is the SHARED lower-layer UI shell, consumed by both the studio
 * superrepo and the standalone editor (same submodule). It must NOT statically
 * depend on studio-layer packages — those only exist in the studio monorepo
 * layout, so a reverse dependency breaks the standalone editor at load time
 * (a hardcoded `../../../../marketplace/...` import once blanked the whole page).
 *
 * Lower layers hold abstractions; the host (studio) injects concrete
 * implementations via the PanelRenderers context. These rules make a regression
 * fail CI instead of surfacing as a standalone runtime crash.
 *
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'interface-no-marketplace',
      severity: 'error',
      comment:
        'interface must not import marketplace plugins (upper layer). Inject the ' +
        'panel via PanelRenderers.workbenchPanels from the studio assembly root instead.',
      from: { path: '^src' },
      to: { path: 'marketplace' },
    },
    {
      name: 'interface-no-host-sdk-runtime',
      severity: 'error',
      comment:
        'interface must not import @forgeax/host-sdk at RUNTIME (studio-only package). ' +
        'Type-only imports are fine (erased at build); the runtime port factories are ' +
        'injected via PanelRenderers.createPluginPort / createWindowTransport.',
      from: { path: '^src' },
      to: {
        path: 'host-sdk',
        // Allow `import type ...` — those are erased and never reach a standalone bundle.
        dependencyTypesNot: ['type-only'],
      },
    },
  ],
  options: {
    doNotFollow: { path: ['node_modules', 'dist', '.vite'] },
    // Resolve @forgeax/* aliases the same way the app + tsc do, and surface
    // type-only imports so the host-sdk rule can exempt them.
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    },
  },
};
