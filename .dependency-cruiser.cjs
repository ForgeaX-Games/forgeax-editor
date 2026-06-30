/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: '5-package acyclic DAG: engine ← core ← shared ← panels ← edit-runtime / play-runtime',
      from: {
        path: '^packages/editor-',
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
    includeOnly: '^packages/editor-',
    tsPreCompilationDeps: false,
  },
};