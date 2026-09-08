import { statSync } from 'node:fs';
import { join } from 'node:path';

export const ENGINE_CRITICAL_PACKAGES = [
  'geometry',
  'import',
  'vite-plugin-shader',
  'app',
  'runtime',
  'ecs',
  'types',
  'shader',
  'gltf',
  'npc',
] as const;

export const ENGINE_DECLARATION_ARTIFACTS = ['index.d.ts', 'index.d.ts.map'] as const;

export type EngineDeclarationTrustInput = {
  readonly engineDir: string;
  readonly currentHead: string;
  readonly builtFor: string;
  readonly sourceStatus: string;
};

/**
 * Generated declarations are reusable only when their source and output
 * provenance are both trustworthy. Keep this predicate pure at the boundary
 * so setup can exercise the same cold/warm policy without running the whole
 * wasm and package bootstrap in a unit test.
 */
export function hasTrustedEngineDeclarations(input: EngineDeclarationTrustInput): boolean {
  if (!input.currentHead || input.sourceStatus || input.builtFor !== input.currentHead) return false;

  return ENGINE_CRITICAL_PACKAGES.every((pkg) =>
    ENGINE_DECLARATION_ARTIFACTS.every((artifact) => {
      try {
        const stat = statSync(join(input.engineDir, 'packages', pkg, 'dist', artifact));
        return stat.isFile() && stat.size > 0;
      } catch {
        return false;
      }
    }),
  );
}
