/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'acyclic DAG: engine ← core ← content-browser ← panels ← edit-runtime / play-runtime',
      from: {
        path: '^packages/(core|content-browser|panels|edit-runtime|play-runtime)/',
      },
      to: {
        circular: true,
      },
    },
    {
      name: 'no-upward-import-from-core',
      severity: 'error',
      comment: 'core must not depend on content-browser / panels / edit-runtime / play-runtime',
      from: { path: '^packages/core/' },
      to: { path: '^packages/(content-browser|panels|edit-runtime|play-runtime)/' },
    },
    {
      name: 'no-upward-import-from-content-browser',
      severity: 'error',
      comment: 'content-browser must not depend on panels / edit-runtime / play-runtime',
      from: { path: '^packages/content-browser/' },
      to: { path: '^packages/(panels|edit-runtime|play-runtime)/' },
    },
    {
      name: 'no-upward-import-from-panels',
      severity: 'error',
      comment: 'panels must not depend on edit-runtime / play-runtime',
      from: { path: '^packages/panels/' },
      to: { path: '^packages/(edit-runtime|play-runtime)/' },
    },
  ],
  options: {
    doNotFollow: {
      path: ['node_modules', 'dist', '.vite'],
    },
    includeOnly: '^packages/(core|content-browser|panels|edit-runtime|play-runtime)/',
    tsPreCompilationDeps: false,
  },
};