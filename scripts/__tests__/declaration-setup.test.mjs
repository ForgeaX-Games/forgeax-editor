import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(scriptsDir, '..', 'fx.ts'), 'utf8');

describe('editor declaration setup gate', () => {
  it('orchestrates bundling before the engine composite declaration build', () => {
    const buildIndex = source.indexOf("sh('pnpm', ['-r', '--filter', './packages/*', 'build']");
    const cleanIndex = source.indexOf("sh('pnpm', ['tsc', '-b', '--clean']");
    const typecheckIndex = source.indexOf("sh('pnpm', ['tsc', '-b']");
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(cleanIndex).toBeGreaterThan(buildIndex);
    expect(typecheckIndex).toBeGreaterThan(cleanIndex);
  });

  it('checks declaration pairs without introducing a shim producer', () => {
    expect(source).toContain("'index.d.ts'");
    expect(source).toContain("'index.d.ts.map'");
    expect(source).not.toContain('ambient shim');
    expect(source).not.toContain('tsup --dts');
  });
});
