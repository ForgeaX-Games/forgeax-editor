import { defineConfig } from 'tsup';
import { baseTsupConfig } from '../../tsup.base';

export default defineConfig({
  ...baseTsupConfig,
  entry: ['src/index.ts', 'src/errors.ts', 'src/adapter.ts', 'src/inspector.ts'],
  external: [
    '@forgeax/engine-rhi',
    '@forgeax/engine-types',
    '@webgpu/types',
    'pngjs',
    // Node.js builtins imported by recorder / tape-format (disk I/O + crypto hash).
    // These are unavailable in browser/neutral platform builds; the inspector
    // module is imported separately by Node.js consumers.
    'node:fs',
    'node:path',
    'node:crypto',
  ],
});