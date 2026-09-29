import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { parse as parseYaml } from 'yaml';
import {ALL_SMOKE_SHARDS, SMOKE_PLAY_BUNDLES} from '../smoke-play-bundles.mjs';

const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
const parsedWorkflow = parseYaml(workflow);

test('PR and main-push CI share the complete profile', () => {
  assert.match(workflow, /CI_PROFILE: \$\{\{ inputs\.profile \|\| 'complete' \}\}/);
  assert.doesNotMatch(workflow, /github\.event_name == 'pull_request'[^\n]*inputs\.profile/);
});

test('only an explicit fast workflow dispatch skips the browser gate', () => {
  assert.match(
    workflow,
    /github\.event_name != 'workflow_dispatch' \|\| inputs\.profile != 'fast'/,
  );
});

test('PR and main-push browser gates share the same bundle graph and heavy contract', () => {
  assert.match(workflow, /bundle: \[core, breadth, editor\]/);
  assert.match(
    workflow,
    /runs-on: \$\{\{ fromJSON\('\["self-hosted", "Linux", "X64", "heavy"\]'\) \}\}/,
  );
  assert.match(workflow, /uses: \.\/\.github\/actions\/smoke-play-environment/);
  assert.equal((workflow.match(/github\.event_name != 'workflow_dispatch' \|\| inputs\.profile != 'fast'/g) ?? []).length, 2);
  assert.doesNotMatch(workflow, /matrix\.shard == 'broad'\b/);
});

test('PR admission does not require its base to be the current main revision', () => {
  const pinStart = workflow.indexOf('  submodule-pin:');
  const nextJobStart = workflow.indexOf('\n  b2-self-boot:', pinStart);
  assert.ok(pinStart >= 0, 'submodule-pin must remain the shared admission gate');
  assert.ok(nextJobStart > pinStart, 'submodule-pin block must be bounded');
  const pinBlock = workflow.slice(pinStart, nextJobStart);
  assert.doesNotMatch(pinBlock, /name: Require PR base to be current main/);
  assert.doesNotMatch(pinBlock, /CI_PR_BASE_SHA|CI_REMOTE_MAIN_SHA/);
  assert.doesNotMatch(pinBlock, /git ls-remote origin refs\/heads\/main/);
  assert.doesNotMatch(pinBlock, /check-pr-base-freshness\.mjs/);
});

test('PR and main-push preserve the exact nine-shard runtime contract inside three bundles', () => {
  const smokeShard = parsedWorkflow.jobs['smoke-play-shard'];
  assert.ok(smokeShard, 'smoke-play shard must be present');
  assert.deepEqual(smokeShard.strategy.matrix.bundle, ['core', 'breadth', 'editor']);
  assert.equal(smokeShard.strategy['fail-fast'], true);
  assert.equal(
    smokeShard.strategy['max-parallel'],
    smokeShard.strategy.matrix.bundle.length,
    'every smoke bundle must be independently schedulable without a deterministic third-wave tail',
  );
  assert.deepEqual(smokeShard.needs, ['prerequisite-release']);

  const expected = {
    scriptable: ['15890,15880,15881,15873', 'scriptable-pack-scene-workflow.spec.ts'],
    'broad-core': ['15390,15380,15381,15373', 'smoke-boot-play.spec.ts', 'version-control-generation.spec.ts'],
    template: ['15990,15980,15981,15973', 'new-game-template-journey.spec.ts'],
    'broad-play': ['15590,15580,15581,15573', 'play-real-game-safety-net.spec.ts', 'gameplay-viewport-capture.spec.ts'],
    'broad-assets': ['15690,15680,15681,15673', 'gltf-mesh-default-material.spec.ts', 'asset-source-workflow-fixture.test.ts'],
    vfx: ['15990,15980,15981,15973', 'vfx-particle-runtime.spec.ts'],
    editor: ['15590,15580,15581,15573,15690,15680,15681,15673,15790,15780,15781,15773', 'game-default sample gameplay-gate', 'editor-browser-smoke.spec.ts'],
    create: ['15790,15580,15781,15773', 'create-game-browser-smoke.spec.ts', 'FORGEAX_SMOKE_EDIT_PORT=15580'],
    repro: ['15490,15481,15480,15473,15474,15496', 'repro-default-scene-import-404.mjs'],
  };
  const bundleSteps = smokeShard.steps.filter((candidate) => typeof candidate.if === 'string' && candidate.if.includes('matrix.bundle'));
  assert.equal(bundleSteps.length, 3);
  const combinedRun = bundleSteps.map((step) => step.run ?? '').join('\n');
  for (const [shard, [ports, ...tokens]] of Object.entries(expected)) {
    assert.match(combinedRun, new RegExp(`--shard\\s+${shard}`));
    assert.match(combinedRun, new RegExp(`--ports\\s+${ports}`));
    for (const token of tokens) assert.match(combinedRun, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.deepEqual(ALL_SMOKE_SHARDS, Object.values(SMOKE_PLAY_BUNDLES).flat());
});

test('smoke commands keep headed WebGPU settings and serial Playwright execution', () => {
  assert.match(workflow, /FORGEAX_BROWSER_HEADLESS:\s*['"]?0/);
  const config = readFileSync(resolve('playwright.smoke.config.ts'), 'utf8');
  assert.match(config, /retries:\s*0/);
  assert.match(config, /workers:\s*1/);
  assert.match(config, /headless:\s*process\.env\.FORGEAX_BROWSER_HEADLESS !== '0'/);
  assert.match(config, /--enable-unsafe-webgpu/);
  assert.match(config, /--enable-features=Vulkan,UseSkiaRenderer,SharedArrayBuffer/);
  assert.match(config, /--use-vulkan=swiftshader/);
  assert.match(config, /gracefulShutdown:\s*\{\s*signal:\s*'SIGTERM',\s*timeout:\s*5_000\s*\}/);
});
