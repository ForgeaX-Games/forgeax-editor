import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(resolve(scriptsDir, '../../.github/workflows/ci.yml'), 'utf8');
const pinGate = readFileSync(resolve(scriptsDir, '../check-submodule-pins.mjs'), 'utf8');

describe('fresh CI Engine closure', () => {
  it('builds the exact pinned Engine source through its canonical producer', () => {
    const producerStart = workflow.indexOf('  prerequisite-release:');
    const producerEnd = workflow.indexOf('\n  docs-policy:', producerStart);
    const producer = workflow.slice(producerStart, producerEnd);
    expect(producer).toContain('./packages/engine/.github/actions/editor-prerequisite-build');
    expect(producer).toContain('engine-sha: ${{ steps.engine_identity.outputs.sha }}');
    expect(producer).toContain('payload-classes: engine-dist,wgpu-wasm,fbx-wasm');
    expect(producer).toContain('output: ${{ runner.temp }}/forgeax-engine-prerequisite-build');
    expect(producer).toContain('submodules: recursive');
    expect(producer).not.toContain('actions: write');
    expect(producer).not.toContain('GH_TOKEN:');
    expect(producer).not.toContain('ENGINE_REPOSITORY');
    expect(producer).not.toContain('ENGINE_WORKFLOW_PATH');
    expect(producer).not.toContain('hydrate-engine-artifact.mjs');
    expect(producer).not.toContain('pnpm -r --filter');
    expect(producer).not.toContain('tsc -b');
    expect(producer).not.toContain('Build wgpu-wasm');
  });

  it('keeps the Editor prerequisite payload and consumer typecheck boundary intact', () => {
    expect(workflow).toContain('payload/engine-dist');
    expect(workflow).toContain('payload/wgpu-wasm');
    expect(workflow).toContain('Typecheck (all editor packages)');
    expect(workflow).toContain('run typecheck');
    expect(workflow).toContain('prerequisite built from the exact `packages/engine` gitlink SHA');
    expect(workflow).not.toContain('Engine core-build artifact');
  });

  it('fetches the shallow Engine main history before checking its baseline', () => {
    const fetchIndex = pinGate.indexOf("const fetchArgs = ['fetch', '--no-tags', '--no-recurse-submodules'];");
    const baselineIndex = pinGate.indexOf("run('git', ['cat-file', '-e', `${ENGINE_MINIMUM_BASELINE}^{commit}`]");
    expect(fetchIndex).toBeGreaterThanOrEqual(0);
    expect(baselineIndex).toBeGreaterThan(fetchIndex);
  });
});
