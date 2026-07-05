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
  ],
  options: {
    doNotFollow: {
      path: ['node_modules', 'dist', '.vite'],
    },
    includeOnly: '^packages/(core|content-browser|panels|edit-runtime|play-runtime)/',
    tsPreCompilationDeps: false,
  },
};