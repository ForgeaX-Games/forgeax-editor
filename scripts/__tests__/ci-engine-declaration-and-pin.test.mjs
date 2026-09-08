import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(resolve(scriptsDir, '../../.github/workflows/ci.yml'), 'utf8');
const pinGate = readFileSync(resolve(scriptsDir, '../check-submodule-pins.mjs'), 'utf8');

describe('fresh CI Engine closure', () => {
  it('delegates Engine package build and correctness to the exact-SHA Engine CI artifact', () => {
    const producerStart = workflow.indexOf('  prerequisite-release:');
    const producerEnd = workflow.indexOf('\n  docs-policy:', producerStart);
    const producer = workflow.slice(producerStart, producerEnd);
    expect(producer).toContain('scripts/ci/hydrate-engine-artifact.mjs');
    expect(producer).toContain('ENGINE_WORKFLOW_PATH: .github/workflows/ci.yml');
    expect(producer).toContain('submodules: true');
    expect(producer).not.toContain('pnpm -r --filter');
    expect(producer).not.toContain('tsc -b');
    expect(producer).not.toContain('Build wgpu-wasm');
  });

  it('keeps the Editor prerequisite payload and consumer typecheck boundary intact', () => {
    expect(workflow).toContain('payload/engine-dist');
    expect(workflow).toContain('payload/wgpu-wasm');
    expect(workflow).toContain('Typecheck (all editor packages)');
    expect(workflow).toContain('run typecheck');
    expect(workflow).toContain('core-build artifact selected by the exact `packages/engine` gitlink SHA');
  });

  it('fetches the shallow Engine main history before checking its baseline', () => {
    const fetchIndex = pinGate.indexOf("const fetchArgs = ['fetch', '--no-tags', '--no-recurse-submodules'];");
    const baselineIndex = pinGate.indexOf("run('git', ['cat-file', '-e', `${ENGINE_MINIMUM_BASELINE}^{commit}`]");
    expect(fetchIndex).toBeGreaterThanOrEqual(0);
    expect(baselineIndex).toBeGreaterThan(fetchIndex);
  });
});
