import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(scriptsDir, '..', 'fx.ts'), 'utf8');
const declarationStart = source.indexOf('function buildEngineDeclarations(): void {');
const declarationEnd = source.indexOf('\n}\n\nasync function install(): Promise<void>', declarationStart);
const declarationBuild = source.slice(declarationStart, declarationEnd);

describe('editor declaration setup gate', () => {
  it('runs the Engine root project-reference graph after bundling', () => {
    const buildIndex = source.indexOf("sh('pnpm', ['-r', '--filter', './packages/*', 'build', '--silent']");
    const typecheckIndex = source.indexOf('buildEngineDeclarations();', buildIndex);
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(typecheckIndex).toBeGreaterThan(buildIndex);
    expect(declarationBuild).toContain("'node', engineTypeScriptBin(), '-b'");
    expect(declarationBuild).not.toContain("'-r'");
    expect(declarationBuild).not.toContain('workspace-concurrency');
    expect(declarationBuild).not.toContain("'--force'");
  });

  it('uses a conditional clean for cold builds without a compatibility producer', () => {
    expect(declarationBuild).toContain('engineDeclarationsAreTrusted()');
    expect(declarationBuild).toContain("'--clean'");
    expect(source).toContain("'index.d.ts'");
    expect(source).toContain("'index.d.ts.map'");
    for (const producer of ['render-graph', 'vfx-render', 'vfx-compiler']) {
      expect(declarationBuild).not.toContain(producer);
    }
    expect(declarationBuild).not.toContain('implicit');
    expect(declarationBuild).not.toContain('retry');
  });

  it('requires pin, clean source, and non-empty declaration outputs before reuse', () => {
    expect(source).toContain("'-C', ENGINE_DIR, 'rev-parse', 'HEAD'");
    expect(source).toContain("'status', '--porcelain', '--untracked-files=all'");
    expect(source).toContain('ENGINE_DIST_SHA_FILE');
    expect(source).toContain('statSync');
    expect(source).toContain('ENGINE_DECLARATION_ARTIFACTS');
    expect(source).toContain('stat.isFile() && stat.size > 0');
  });
});
