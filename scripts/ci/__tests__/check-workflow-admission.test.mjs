import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import {
  ACTIONLINT_ARGS,
  enumerateWorkflowFiles,
  runActionlint,
} from '../check-workflow-admission.mjs';

const workflowRoot = resolve(process.env.FORGEAX_WORKFLOW_ROOT ?? '.github/workflows');
const actionRoot = resolve(process.env.FORGEAX_ACTION_ROOT ?? '.github/actions');
const carrierPath = join(workflowRoot, 'runner-pool-contract.yml');
const ciWorkflowPath = join(workflowRoot, 'ci.yml');
const smokePlayEnvironmentPath = join(actionRoot, 'smoke-play-environment/action.yml');
const malformedFixture = resolve('scripts/ci/fixtures/malformed-actions.yml');
const admissionFixture = resolve('scripts/ci/fixtures/workflow-admission-contract.yml');
const measurementWorkflowPath = join(workflowRoot, 'browser-release-measurement.yml');

function assertSafePrHeadScriptReferences(text) {
  assert.doesNotMatch(text, /pr-head\/(?:package\.json|node_modules)/);
  assert.doesNotMatch(text, /working-directory:\s*pr-head/);
  assert.doesNotMatch(text, /pr-head\/scripts\//);
}

test('enumerates every supported workflow suffix in stable order', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-workflow-enumeration-'));
  try {
    writeFileSync(join(root, 'z.yml'), 'name: z\n');
    writeFileSync(join(root, 'a.yaml'), 'name: a\n');
    writeFileSync(join(root, 'README.md'), 'not a workflow\n');
    assert.deepEqual(enumerateWorkflowFiles(root).map((file) => basename(file)), ['a.yaml', 'z.yml']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trusted carrier retrieves only the fork head workflow directory from its immutable head SHA', () => {
  const text = readFileSync(carrierPath, 'utf8');
  assert.match(text, /pull_request_target:/);
  assert.match(text, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  const trustedBaseCheckout = text.slice(
    text.indexOf('name: Checkout trusted base revision'),
    text.indexOf('name: Checkout PR-head workflow definitions'),
  );
  assert.match(trustedBaseCheckout, /submodules:\s*recursive/);
  assert.match(trustedBaseCheckout, /token:\s*\$\{\{ secrets\.GHA \}\}/);
  assert.match(trustedBaseCheckout, /persist-credentials:\s*false/);
  assert.match(text, /repository: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name \}\}/);
  assert.match(text, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(text, /path: pr-head/);
  assert.match(text, /sparse-checkout:\s*\|\s*\n\s+\.github\/workflows/);
  assert.equal((text.match(/persist-credentials:\s*false/g) ?? []).length, 2);
  assert.match(text, /permissions:\s*\n\s+contents:\s+read/);
  assertSafePrHeadScriptReferences(text);
  assert.match(text, /actionlint_1\.7\.12_linux_amd64\.tar\.gz/);
  assert.ok(
    text.indexOf('Validate PR-head workflow definitions') <
      text.indexOf('Validate self-hosted runner pool labels'),
  );
  assert.match(text, /check-workflow-admission\.mjs --workflows-dir pr-head\/\.github\/workflows/);
  assert.match(text, /Stage PR-head workflow definitions for contract tests/);
  assert.match(text, /Admit live default-branch required-check policy/);
  assert.match(text, /editor-ci-contract\.mjs --live-ruleset --skip-portfolio --workflows-dir pr-head\/\.github\/workflows/);
  assert.ok(
    text.indexOf('Admit live default-branch required-check policy') <
      text.indexOf('Validate PR-head contract bindings'),
  );
});

test('workflow YAML staging retains the trusted-base optional-file contract', () => {
  const text = readFileSync(carrierPath, 'utf8');
  const start = text.indexOf('name: Stage PR-head workflow definitions for contract tests');
  const end = text.indexOf('name: Setup Node.js', start);
  assert.ok(start >= 0, 'runner-pool-contract must stage PR-head contract files');
  assert.ok(end > start, 'staging step must end before setup');
  const staging = text.slice(start, end);
  assert.match(staging, /for script in/);
  assert.match(staging, /rm -f -- "\$script"/);
  assert.match(staging, /if test -f "pr-head\/\$script"; then/);
  assert.match(staging, /cp -- "pr-head\/\$script" "\$script"/);
  assert.doesNotMatch(staging, /cp pr-head\/scripts\/ci\//);
});

function withStagingFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-workflow-staging-'));
  try {
    for (const directory of [
      '.github/workflows', 'pr-head/.github/workflows',
      'scripts/ci/__tests__', 'pr-head/scripts/ci/__tests__',
      '.github/actions/probe', 'pr-head/.github/actions/probe',
      'node_modules', 'pr-head/node_modules', 'outside',
    ]) mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, '.github/workflows/removed.yml'), 'trusted old workflow\n');
    writeFileSync(join(root, 'pr-head/.github/workflows/added.yaml'), 'name: added\n');
    for (const file of [
      'scripts/ci/__tests__/check-workflow-admission.test.mjs',
      '.github/actions/probe/action.yml', 'node_modules/trusted.mjs', 'package.json',
    ]) {
      writeFileSync(join(root, file), 'trusted base\n');
      writeFileSync(join(root, 'pr-head', file), 'untrusted PR payload\n');
    }
    const workflow = parseYaml(readFileSync(carrierPath, 'utf8'));
    const staging = workflow.jobs['runner-pool-contract'].steps.find(
      (step) => step.name === 'Stage PR-head workflow definitions for contract tests',
    );
    assert.equal(typeof staging?.run, 'string');
    run(root, () => spawnSync('bash', ['-c', staging.run], {
      cwd: root, encoding: 'utf8', timeout: 5_000,
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('staging synchronizes direct YAML additions/deletions without changing trusted executable inputs', () => {
  withStagingFixture((root, stage) => {
    const literalName = 'space $(touch escaped).yml';
    writeFileSync(join(root, 'pr-head/.github/workflows', literalName), 'name: literal\n');
    writeFileSync(join(root, 'pr-head/.github/workflows/.hidden.yaml'), 'name: hidden\n');
    writeFileSync(join(root, '.github/workflows/keep.txt'), 'trusted non-workflow\n');
    writeFileSync(join(root, 'pr-head/.github/workflows/executable.mjs'), 'throw new Error("untrusted")\n');
    mkdirSync(join(root, 'pr-head/.github/workflows/nested'));
    writeFileSync(join(root, 'pr-head/.github/workflows/nested/ignored.yml'), 'name: nested\n');
    const result = stage();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(join(root, '.github/workflows')).sort(), [
      '.hidden.yaml', 'added.yaml', 'keep.txt', literalName,
    ].sort());
    assert.equal(readFileSync(join(root, '.github/workflows', literalName), 'utf8'), 'name: literal\n');
    assert.equal(existsSync(join(root, 'escaped')), false);
    for (const file of [
      'scripts/ci/__tests__/check-workflow-admission.test.mjs',
      '.github/actions/probe/action.yml', 'node_modules/trusted.mjs', 'package.json',
    ]) assert.equal(readFileSync(join(root, file), 'utf8'), 'trusted base\n', file);
  });
});

test('staging removes deleted workflows when the incoming workflow set is empty', () => {
  withStagingFixture((root, stage) => {
    rmSync(join(root, 'pr-head/.github/workflows/added.yaml'));
    const result = stage();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(join(root, '.github/workflows')), []);
  });
});

for (const parent of ['.github', '.github/workflows', 'pr-head', 'pr-head/.github', 'pr-head/.github/workflows']) {
  test(`staging rejects a symlinked ${parent} directory before changing external files`, () => {
    withStagingFixture((root, stage) => {
      const external = join(root, 'outside');
      writeFileSync(join(external, 'sentinel.yml'), 'outside must remain unchanged\n');
      rmSync(join(root, parent), { recursive: true, force: true });
      symlinkSync(external, join(root, parent), 'dir');
      const result = stage();
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(join(external, 'sentinel.yml'), 'utf8'), 'outside must remain unchanged\n');
      assert.deepEqual(readdirSync(external), ['sentinel.yml']);
    });
  });
}

for (const directory of ['.github/workflows', 'pr-head/.github/workflows']) {
  for (const kind of ['symlink', 'dangling symlink', 'directory', 'fifo']) {
    test(`staging rejects a ${kind} YAML entry in ${directory} before synchronizing`, () => {
      withStagingFixture((root, stage) => {
        const external = join(root, 'outside/sentinel.yml');
        writeFileSync(external, 'outside must remain unchanged\n');
        const entry = join(root, directory, 'hostile.yml');
        if (kind === 'directory') mkdirSync(entry);
        else if (kind === 'fifo') {
          const fifo = spawnSync('mkfifo', [entry], { encoding: 'utf8' });
          assert.equal(fifo.status, 0, fifo.stderr);
        } else symlinkSync(kind === 'symlink' ? external : join(root, 'outside/missing'), entry);
        const result = stage();
        assert.notEqual(result.status, 0);
        assert.equal(readFileSync(external, 'utf8'), 'outside must remain unchanged\n');
        assert.equal(readFileSync(join(root, '.github/workflows/removed.yml'), 'utf8'), 'trusted old workflow\n');
        assert.equal(existsSync(join(root, '.github/workflows/added.yaml')), false);
      });
    });
  }
}

test('parser invocation passes the complete derived file list and pinned options', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-workflow-parser-'));
  try {
    writeFileSync(join(root, 'b.yml'), 'name: b\n');
    writeFileSync(join(root, 'a.yaml'), 'name: a\n');
    const parser = join(root, 'fake-actionlint.mjs');
    writeFileSync(
      parser,
      '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    );
    chmodSync(parser, 0o755);
    const result = runActionlint({ workflowsDir: root, actionlintBin: parser, cwd: root });
    assert.equal(result.status, 0);
    assert.deepEqual(result.files.map((file) => basename(file)), ['a.yaml', 'b.yml']);
    assert.deepEqual(JSON.parse(result.stdout), [...ACTIONLINT_ARGS, ...result.files]);
    assert.deepEqual(ACTIONLINT_ARGS.slice(0, 2), ['-config-file', '.github/actionlint.yaml']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('trusted-base actionlint config is passed when validating a sparse PR-head directory', () => {
  const configIndex = ACTIONLINT_ARGS.indexOf('-config-file');
  assert.notEqual(configIndex, -1);
  assert.equal(ACTIONLINT_ARGS[configIndex + 1], '.github/actionlint.yaml');
});

test('generic lint provisions the pinned parser before its admission tests run', () => {
  const text = readFileSync(ciWorkflowPath, 'utf8');
  const installIndex = text.indexOf('name: Install pinned actionlint');
  const lintIndex = text.indexOf('name: Lint (sync-channel + engine-shim + gateway seams)');
  assert.ok(installIndex >= 0, 'generic CI must install actionlint');
  assert.ok(installIndex < lintIndex, 'actionlint must be installed before bun run lint');
  assert.match(text, /actionlint_1\.7\.12_linux_amd64\.tar\.gz/);
  assert.match(text, /actionlint_dir\/actionlint\" -version/);
  assert.match(text, /echo \"\$actionlint_dir\" >> \"\$GITHUB_PATH\"/);
});

test('prerequisite producer keeps an explicit Engine build contract', () => {
  const text = readFileSync(ciWorkflowPath, 'utf8');
  const start = text.indexOf('  prerequisite-release:');
  const end = text.indexOf('\n  docs-policy:', start);
  assert.ok(start >= 0, 'CI must declare the prerequisite producer');
  assert.ok(end > start, 'producer block must end before docs-policy');
  const block = text.slice(start, end);
  assert.match(block, /Build Engine prerequisite from the exact pinned source/);
  assert.match(block, /Resolve exact Engine gitlink/);
  assert.match(block, /uses:\s+\.\/packages\/engine\/\.github\/actions\/editor-prerequisite-build/);
  assert.match(block, /engine-sha:\s+\$\{\{ steps\.engine_identity\.outputs\.sha \}\}/);
  assert.match(block, /payload-classes:\s+engine-dist,wgpu-wasm,fbx-wasm/);
  assert.match(block, /output:\s+\$\{\{ runner\.temp \}\}\/forgeax-engine-prerequisite-build/);
  assert.match(block, /submodules:\s+recursive/);
  assert.doesNotMatch(block, /hydrate-engine-artifact|ENGINE_REPOSITORY|ENGINE_WORKFLOW_PATH/);
  assert.doesNotMatch(block, /actions:\s+write/);
  assert.doesNotMatch(block, /gh\s+(api|run)/);
  assert.doesNotMatch(block, /pnpm\s+-r|tsc\s+-b|wasm-pack\s+build|emcc\b|build-editor-prerequisite\.mjs/);
});

test('CI concurrency cancels superseded pull-request runs only', () => {
  const workflow = parseYaml(readFileSync(ciWorkflowPath, 'utf8'));
  const cancelInProgress = workflow.concurrency['cancel-in-progress'];
  assert.equal(cancelInProgress, "${{ github.event_name == 'pull_request' }}");
});

test('main push, schedule, and manual dispatch remain non-cancelling events', () => {
  const workflow = parseYaml(readFileSync(ciWorkflowPath, 'utf8'));
  const cancelInProgress = workflow.concurrency['cancel-in-progress'];
  assert.equal(cancelInProgress, "${{ github.event_name == 'pull_request' }}");

  const expectedCancellation = {
    push: false,
    schedule: false,
    workflow_dispatch: false,
    pull_request: true,
  };
  for (const [eventName, expected] of Object.entries(expectedCancellation)) {
    assert.equal(
      cancelInProgress === "${{ github.event_name == 'pull_request' }}" && eventName === 'pull_request',
      expected,
      `${eventName} concurrency cancellation policy`,
    );
  }
});

test('submodule pin waits for every Editor validation job', () => {
  const workflow = parseYaml(readFileSync(ciWorkflowPath, 'utf8'));
  const pin = workflow.jobs['submodule-pin'];
  assert.ok(pin, 'submodule-pin must be present');
  assert.deepEqual(pin.needs, ['docs-policy', 'b2-self-boot', 'typecheck', 'smoke-play']);
  assert.equal(pin.if, '${{ always() && !cancelled() }}');
  for (const jobId of pin.needs) {
    assert.ok(!workflow.jobs[jobId].needs?.includes('submodule-pin'), `${jobId} must not wait for submodule-pin`);
  }
});

test('submodule pin does not require a current PR base', () => {
  const workflow = parseYaml(readFileSync(ciWorkflowPath, 'utf8'));
  const pin = workflow.jobs['submodule-pin'];
  assert.ok(pin, 'submodule-pin must be present');
  const pinBlock = JSON.stringify(pin);
  assert.doesNotMatch(pinBlock, /Require PR base to be current main/);
  assert.doesNotMatch(pinBlock, /CI_PR_BASE_SHA|CI_REMOTE_MAIN_SHA/);
  assert.doesNotMatch(pinBlock, /check-pr-base-freshness\.mjs/);
  assert.doesNotMatch(pinBlock, /git ls-remote origin refs\/heads\/main/);
});

test('the admission gate uses the pinned actionlint executable, not a skipped parser path', () => {
  const actionlintBin = process.env.ACTIONLINT_BIN ?? 'actionlint';
  const result = spawnSync(actionlintBin, ['-version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /1\.7\.12/);
});

test('Actions-specific malformed fixture parses as YAML but fails the pinned parser', () => {
  const text = readFileSync(malformedFixture, 'utf8');
  assert.doesNotThrow(() => parseYaml(text));
  const result = runActionlint({
    workflowsDir: dirname(malformedFixture),
    actionlintBin: process.env.ACTIONLINT_BIN ?? 'actionlint',
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /needs.*missing-job|job-needs/);
});

test('base workflow inventory is non-empty and has no unvalidated suffix', () => {
  const files = enumerateWorkflowFiles(workflowRoot);
  assert.ok(files.length >= 2);
  assert.ok(files.every((file) => /\.ya?ml$/.test(file)));
});

test('cloud producer and requesting consumers use an always-run producer edge', () => {
  const text = readFileSync(ciWorkflowPath, 'utf8');
  const blockFor = (jobId) => {
    const start = text.indexOf(`  ${jobId}:`);
    assert.ok(start >= 0, `ci workflow must declare ${jobId}`);
    const remainder = text.slice(start + 3);
    const nextJob = remainder.search(/\n  [A-Za-z0-9_.-]+:\s*\n/);
    return remainder.slice(0, nextJob < 0 ? remainder.length : nextJob);
  };
  const producerBlock = blockFor('prerequisite-release');
  assert.match(producerBlock, /name:\s+prerequisite-release/);
  assert.match(producerBlock, /ci:prerequisite\s+--\s+produce/);
  assert.match(producerBlock, /actions\/upload-artifact@v4/);
  assert.match(producerBlock, /include-hidden-files:\s*true/);

  for (const jobId of ['b2-self-boot', 'typecheck']) {
    const block = blockFor(jobId);
    assert.match(block, /needs:/, `${jobId} must wait for producer publication`);
    assert.match(block, /always\(\)/, `${jobId} must inspect producer failure explicitly`);
    assert.match(block, /download-artifact@v5/, `${jobId} must consume the immutable release`);
  }
  const smokeShard = blockFor('smoke-play-shard');
  assert.match(smokeShard, /needs:\s*\[prerequisite-release\]/, 'smoke-play bundles must start as soon as the producer publishes');
  assert.doesNotMatch(smokeShard, /needs\.(typecheck|b2-self-boot)/, 'browser work must overlap independent standard gates');
  assert.match(smokeShard, /fail-fast:\s*true/, 'smoke-play bundles must cancel siblings on first failure');
  const smokeEnvironment = readFileSync(smokePlayEnvironmentPath, 'utf8');
  assert.match(smokeEnvironment, /actions\/download-artifact@v5/, 'smoke-play must consume the immutable release');
  const smokeAggregate = blockFor('smoke-play');
  assert.match(smokeAggregate, /needs:\s*\[prerequisite-release,\s*smoke-play-shard\]/);
  assert.match(smokeAggregate, /always\(\)/);
  assert.match(smokeAggregate, /Require every smoke bundle to pass/);
});

test('browser-smoke reuses only immutable downloads with content-addressed cache keys', () => {
  const action = parseYaml(readFileSync(smokePlayEnvironmentPath, 'utf8'));
  const steps = action.runs.steps;
  const dependencyRestore = steps.find((step) => step.name === 'Restore dependency download caches');
  const browserRestore = steps.find((step) => step.name === 'Restore Playwright browser cache');
  const dependencySave = steps.find((step) => step.name === 'Save dependency download caches');
  const browserSave = steps.find((step) => step.name === 'Save Playwright browser cache');
  const report = steps.find((step) => step.name === 'Report browser-smoke environment preparation');

  assert.equal(dependencyRestore?.uses, 'actions/cache/restore@v4');
  assert.match(dependencyRestore?.with?.path ?? '', /BUN_INSTALL_CACHE_DIR/);
  assert.match(dependencyRestore?.with?.path ?? '', /pnpm_config_store_dir/);
  assert.doesNotMatch(dependencyRestore?.with?.path ?? '', /node_modules|GITHUB_WORKSPACE|HOME/);
  assert.match(dependencyRestore?.with?.key ?? '', /forgeax-editor-smoke-deps-v1/);
  assert.match(dependencyRestore?.with?.key ?? '', /inputs\.bun-version/);
  assert.match(dependencyRestore?.with?.key ?? '', /env\.CI_PNPM_VERSION/);
  assert.match(
    dependencyRestore?.with?.key ?? '',
    /hashFiles\('bun\.lock', 'packages\/engine\/pnpm-lock\.yaml'\)/,
  );

  assert.equal(browserRestore?.uses, 'actions/cache/restore@v4');
  assert.match(browserRestore?.with?.path ?? '', /PLAYWRIGHT_BROWSERS_PATH/);
  assert.doesNotMatch(browserRestore?.with?.path ?? '', /node_modules|GITHUB_WORKSPACE|HOME/);
  assert.match(browserRestore?.with?.key ?? '', /forgeax-editor-smoke-playwright-v1/);
  assert.match(browserRestore?.with?.key ?? '', /hashFiles\('bun\.lock'\)/);

  for (const [save, restoreId] of [
    [dependencySave, 'dependency_cache'],
    [browserSave, 'browser_cache'],
  ]) {
    assert.equal(save?.uses, 'actions/cache/save@v4');
    assert.match(save?.if ?? '', /inputs\.isolation-key == 'core'/);
    assert.match(save?.if ?? '', /github\.event_name == 'push'/);
    assert.match(save?.if ?? '', /github\.ref == 'refs\/heads\/main'/);
    assert.match(save?.if ?? '', new RegExp(`steps\\.${restoreId}\\.outputs\\.cache-hit != 'true'`));
    assert.match(save?.with?.key ?? '', new RegExp(`steps\\.${restoreId}\\.outputs\\.cache-primary-key`));
  }

  assert.equal(action.outputs?.['dependency-cache-hit']?.value, '${{ steps.dependency_cache.outputs.cache-hit }}');
  assert.equal(action.outputs?.['browser-cache-hit']?.value, '${{ steps.browser_cache.outputs.cache-hit }}');
  assert.match(action.outputs?.['prepare-seconds']?.value ?? '', /steps\.preparation_report\.outputs\.seconds/);
  assert.match(report?.if ?? '', /always\(\)/);
  assert.match(report?.run ?? '', /GITHUB_STEP_SUMMARY/);
  assert.match(report?.run ?? '', /dependency_cache/);
  assert.match(report?.run ?? '', /browser_cache/);
});

test('browser-smoke validates persistent system tools before provisioning them again', () => {
  const action = parseYaml(readFileSync(smokePlayEnvironmentPath, 'utf8'));
  const steps = action.runs.steps;
  const chromiumInstallIndex = steps.findIndex((step) => step.name === 'Install Playwright chromium');
  const dependencyIndex = steps.findIndex(
    (step) => step.name === 'Ensure Playwright Chromium system dependencies',
  );
  const dependencyStep = steps[dependencyIndex];
  const chromeBetaStep = steps.find((step) => step.name === 'Ensure Playwright Chrome Beta');

  assert.ok(chromiumInstallIndex >= 0, 'Playwright chromium must be materialized');
  assert.ok(dependencyIndex > chromiumInstallIndex, 'the installed or restored browser must be inspected before apt provisioning');
  assert.match(dependencyStep?.run ?? '', /ldd/);
  assert.match(dependencyStep?.run ?? '', /not found/);
  assert.match(dependencyStep?.run ?? '', /system dependencies already resolve/);
  assert.match(dependencyStep?.run ?? '', /playwright install-deps chromium/);
  assert.match(chromeBetaStep?.run ?? '', /if \[ -x \/opt\/google\/chrome-beta\/chrome \]/);
  assert.match(chromeBetaStep?.run ?? '', /Chrome Beta already present/);
  assert.match(chromeBetaStep?.run ?? '', /playwright install chrome-beta/);
});

test('prerequisite consumers use the producer artifact identity across failed-job reruns', () => {
  const workflow = parseYaml(readFileSync(ciWorkflowPath, 'utf8'));
  const producer = workflow.jobs['prerequisite-release'];
  assert.ok(producer, 'prerequisite producer must be present');
  assert.ok(producer.outputs, 'prerequisite producer must publish rerun-stable outputs');
  assert.equal(
    producer.outputs.artifact_id,
    "${{ steps.upload_prerequisite.outputs['artifact-id'] }}",
    'producer must publish the immutable artifact ID rather than making consumers reconstruct a name',
  );
  assert.equal(
    producer.outputs.producer_attempt,
    '${{ steps.producer_identity.outputs.attempt }}',
    'producer must publish the attempt that created the artifact',
  );

  const producerSteps = producer.steps;
  const identityStep = producerSteps.find((step) => step.id === 'producer_identity');
  assert.ok(identityStep, 'producer must record its attempt as a job output');
  assert.match(identityStep.run, /GITHUB_RUN_ATTEMPT/);
  assert.match(identityStep.run, /GITHUB_OUTPUT/);
  const uploadStep = producerSteps.find((step) => step.id === 'upload_prerequisite');
  assert.ok(uploadStep, 'upload step must expose its artifact ID');
  assert.equal(uploadStep.uses, 'actions/upload-artifact@v4');

  for (const jobId of ['b2-self-boot', 'typecheck']) {
    const job = workflow.jobs[jobId];
    assert.ok(job, `${jobId} must be present`);
    const downloadStep = job.steps.find((step) => step.uses === 'actions/download-artifact@v5');
    assert.ok(downloadStep, `${jobId} must download the prerequisite artifact`);
    assert.equal(
      downloadStep.with['artifact-ids'],
      '${{ needs.prerequisite-release.outputs.artifact_id }}',
      `${jobId} must download the exact producer artifact ID on reruns`,
    );
    assert.equal(
      downloadStep.with.name,
      undefined,
      `${jobId} must not reconstruct an attempt-suffixed artifact name`,
    );
    const validationStep = job.steps.find((step) =>
      typeof step.run === 'string' && step.run.includes(`--consumer ${jobId}`),
    );
    assert.ok(validationStep, `${jobId} must validate its prerequisite release`);
    assert.match(
      validationStep.run,
      /--attempt\s+"\$\{\{\s*needs\.prerequisite-release\.outputs\.producer_attempt\s*\}\}"/,
      `${jobId} must validate the producer attempt, not the rerun attempt`,
    );
    assert.doesNotMatch(
      validationStep.run,
      /--attempt\s+"\$GITHUB_RUN_ATTEMPT"/,
      `${jobId} must not validate against the consumer rerun attempt`,
    );
  }
  const smokeShard = workflow.jobs['smoke-play-shard'];
  assert.ok(smokeShard, 'smoke-play shard must be present');
  const smokeEnvironmentStep = smokeShard.steps.find(
    (step) => step.uses === './.github/actions/smoke-play-environment',
  );
  assert.ok(smokeEnvironmentStep, 'smoke-play-shard must use the browser-smoke environment action');
  assert.equal(
    smokeEnvironmentStep.with['prerequisite-artifact-id'],
    '${{ needs.prerequisite-release.outputs.artifact_id }}',
  );
  assert.equal(
    smokeEnvironmentStep.with['producer-attempt'],
    '${{ needs.prerequisite-release.outputs.producer_attempt }}',
  );
  assert.equal(smokeEnvironmentStep.with.consumer, 'smoke-play');
  const smokeEnvironment = parseYaml(readFileSync(smokePlayEnvironmentPath, 'utf8'));
  const smokeDownloadStep = smokeEnvironment.runs.steps.find(
    (step) => step.uses === 'actions/download-artifact@v5',
  );
  assert.ok(smokeDownloadStep, 'smoke-play environment must download the prerequisite artifact');
  assert.equal(
    smokeDownloadStep.with['artifact-ids'],
    '${{ inputs.prerequisite-artifact-id }}',
    'smoke-play environment must use the caller-provided immutable artifact ID',
  );
  const smokeShardText = readFileSync(ciWorkflowPath, 'utf8').slice(
    readFileSync(ciWorkflowPath, 'utf8').indexOf('  smoke-play-shard:'),
  );
  assert.match(
    smokeShardText,
    /prerequisite-artifact-id:\s+\$\{\{\s*needs\.prerequisite-release\.outputs\.artifact_id\s*\}\}/,
    'smoke-play must pass the producer artifact identity to its environment action',
  );
  const smokeValidation = smokeEnvironment.runs.steps.find(
    (step) => typeof step.run === 'string' && step.run.includes('ci:prerequisite -- validate'),
  );
  assert.ok(smokeValidation, 'smoke-play environment must validate its prerequisite release');
  assert.match(smokeValidation.run, /--consumer\s+"\$CONSUMER"/);
  assert.match(smokeValidation.run, /--attempt\s+"\$PRODUCER_ATTEMPT"/);
  assert.match(smokeValidation.run, /if ! .*ci:prerequisite -- validate/s);
  assert.match(smokeValidation.run, /cat \"\$report_path\"/);

  const smokeShardJob = workflow.jobs['smoke-play-shard'];
  const smokeEnvironmentFailureStep = smokeShardJob.steps.find((step) => step.id === 'smoke_environment');
  assert.ok(smokeEnvironmentFailureStep, 'smoke-play environment must expose a failure step outcome');
  const evidenceStep = smokeShardJob.steps.find(
    (step) => step.name === 'Upload prerequisite admission evidence',
  );
  assert.ok(evidenceStep, 'smoke-play must retain the structured admission report on failure');
  assert.match(evidenceStep.if, /steps\.smoke_environment\.outcome == 'failure'/);
  assert.match(evidenceStep.with.path, /smoke-play-prerequisite-report\.json/);
});

test('portability admission remains declared but stopped until hosted lanes are approved', () => {
  const text = readFileSync(ciWorkflowPath, 'utf8');
  const jobStart = text.indexOf('  editor-portability:');
  assert.ok(jobStart >= 0, 'CI must retain the dormant portability contract entry');
  const job = text.slice(jobStart);
  assert.match(text, /push:\s*\n\s+branches:\s+\[main\]/);
  assert.match(text, /workflow_dispatch:/);
  assert.match(text, /schedule:/);
  assert.match(job, /if:\s*\$\{\{\s*false\s*\}\}/);
  assert.match(job, /matrix:/);
  assert.match(job, /platform:\s*\[linux, windows, macos\]/);
  assert.match(job, /editor-portability\.mjs\s+--platform\s+\$\{\{\s*matrix\.platform\s*\}\}/);
  assert.match(job, /GITHUB_SHA/);
  assert.match(job, /actions\/upload-artifact@v4/);
  assert.match(job, /editor-portability-aggregate:[\s\S]*?if:\s*\$\{\{\s*false\s*\}\}/);
});

test('portability admission keeps the existing required roster unchanged', () => {
  const contract = JSON.parse(readFileSync(resolve('scripts/ci/editor-ci-contract.json'), 'utf8'));
  assert.equal(contract.portability.required, false);
  assert.deepEqual(
    contract.requiredContexts.map(({ context }) => context),
    ['b2-self-boot', 'typecheck', 'submodule-pin', 'smoke-play'],
  );
  assert.equal(
    contract.requiredContexts.some(({ checkId }) => checkId === 'editor-portability'),
    false,
  );
});

test('request-scoped release validation precedes every consumer body', () => {
  const text = readFileSync(ciWorkflowPath, 'utf8');
  const consumers = [
    ['b2-self-boot', 'Self-boot B2 (read + write, no studio server)'],
    ['typecheck', 'Run script and contract tests'],
  ];
  for (const [consumer, bodyName] of consumers) {
    const blockStart = text.indexOf(`  ${consumer}:`);
    const bodyStart = text.indexOf(`name: ${bodyName}`, blockStart);
    const validationStart = text.indexOf(`--consumer ${consumer}`, blockStart);
    assert.ok(blockStart >= 0, `${consumer} job is present`);
    assert.ok(validationStart >= 0, `${consumer} validates its requested payloads`);
    assert.ok(bodyStart >= 0, `${consumer} check body is present`);
    assert.ok(validationStart < bodyStart, `${consumer} validates before its check body`);
    const beforeBody = text.slice(blockStart, bodyStart);
    assert.match(beforeBody, /ci:prerequisite\s+--\s+validate/);
    assert.match(beforeBody, /--manifest\s+\.ci\/prerequisite-release\/manifest\.json/);
    assert.doesNotMatch(beforeBody.slice(validationStart - blockStart), /Build wgpu-wasm|Build engine library|Ensure FBX wasm/);
  }
  const smokeBlockStart = text.indexOf('  smoke-play-shard:');
  const smokeActionStart = text.indexOf(
    'uses: ./.github/actions/smoke-play-environment',
    smokeBlockStart,
  );
  const smokeBodyStarts = [
    'name: Smoke bundle (core)',
    'name: Smoke bundle (breadth)',
    'name: Smoke bundle (editor)',
  ].map((name) => text.indexOf(name, smokeBlockStart));
  assert.ok(smokeBlockStart >= 0, 'smoke-play-shard job is present');
  assert.ok(smokeActionStart >= 0, 'smoke-play-shard uses the browser-smoke environment action');
  assert.match(
    text.slice(smokeBlockStart, smokeActionStart),
    /submodules:\s+recursive/,
    'smoke-play must recursively materialize nested pins before admission',
  );
  assert.ok(smokeBodyStarts.every((start) => start >= 0), 'every smoke bundle body is present');
  assert.ok(
    smokeBodyStarts.every((start) => smokeActionStart < start),
    'smoke-play environment setup precedes every bundle check body',
  );

  const smokeActionText = readFileSync(smokePlayEnvironmentPath, 'utf8');
  const smokeNodeSetupStart = smokeActionText.indexOf('Setup Node (for engine pnpm build)');
  const smokeValidationStart = smokeActionText.indexOf('ci:prerequisite -- validate');
  assert.ok(smokeNodeSetupStart >= 0, 'smoke-play environment must install Node for prerequisite scripts');
  assert.ok(smokeValidationStart >= 0, 'smoke-play environment validates its requested payloads');
  assert.ok(
    smokeNodeSetupStart < smokeValidationStart,
    'smoke-play must install Node before prerequisite validation',
  );
  assert.match(smokeActionText, /--manifest\s+\.ci\/prerequisite-release\/manifest\.json/);
  assert.match(smokeActionText, /Establish smoke runtime evidence root/);
  assert.match(smokeActionText, /\.ci\/smoke-shard-runtime/);

  const smokeAggregateStart = text.indexOf('  smoke-play:');
  const smokeAggregateEnd = text.indexOf('  editor-portability:', smokeAggregateStart);
  assert.ok(smokeAggregateStart >= 0, 'smoke-play aggregate job is present');
  assert.ok(smokeAggregateEnd >= 0, 'smoke-play aggregate job is bounded');
  const smokeAggregateBlock = text.slice(smokeAggregateStart, smokeAggregateEnd);
  const aggregateValidationStart = smokeAggregateBlock.indexOf('Validate smoke-play prerequisite release');
  const aggregateNodeSetupStart = smokeAggregateBlock.indexOf('Setup Node');
  assert.ok(aggregateValidationStart >= 0, 'smoke-play aggregate validates its requested payloads');
  assert.ok(aggregateNodeSetupStart >= 0, 'smoke-play aggregate must install Node for prerequisite scripts');
  assert.ok(
    aggregateNodeSetupStart < aggregateValidationStart,
    'smoke-play aggregate must install Node before prerequisite validation',
  );
});

test('contract fixture is a workflow-only sparse input with no executable PR payload', () => {
  const text = readFileSync(admissionFixture, 'utf8');
  assert.doesNotThrow(() => parseYaml(text));
  assert.match(text, /name:\s+workflow-admission-contract/);
  assert.match(text, /runs-on:\s+\[self-hosted, Linux, X64, standard\]/);
  assert.doesNotMatch(text, /node\s+scripts\//);
  assert.doesNotMatch(text, /bun\s+(install|run|test)/);
});

test('trusted admission assertions reject an unsafe PR-head execution boundary', () => {
  const text = readFileSync(carrierPath, 'utf8');
  assert.match(text, /Checkout trusted base revision/);
  assert.match(text, /Checkout PR-head workflow definitions/);
  assert.match(text, /sparse-checkout:\s*\|\s*\n\s+\.github\/workflows/);
  assertSafePrHeadScriptReferences(text);
});

test('measurement workflow binds every shell variable before invoking the CLI', () => {
  const text = readFileSync(measurementWorkflowPath, 'utf8');
  assert.match(text, /Require trusted immutable admission[\s\S]*admission\.json[\s\S]*measurement-admission-missing/);
  assert.match(text, /Upload immutable admission snapshot/);
  assert.equal((text.match(/token:\s*\$\{\{ secrets\.GHA \}\}/g) ?? []).length, 4);
  assert.equal((text.match(/git config --global --unset-all 'http\.https:\/\/github\.com\/.extraheader'/g) ?? []).length, 4);
  const firstMeasure = text.slice(text.indexOf('name: Measure one dynamic canonical unit'), text.indexOf('name: Upload raw terminal evidence'));
  const comparablePlan = text.slice(text.indexOf('name: Select comparable sample'), text.indexOf('comparable-measure:'));
  const secondMeasure = text.slice(text.indexOf('name: Measure comparable second sample, not a retry'), text.indexOf('name: Upload comparable raw evidence'));
  assert.match(firstMeasure, /run: \|[\s\S]*set -euo pipefail[\s\S]*unit='\$\{\{ matrix\.unit \}\}'[\s\S]*raw="[^"]*\$\{unit\}[^"]*"[\s\S]*--unit "\$\{unit\}"[\s\S]*--output "\$\{raw\}"/);
  assert.match(firstMeasure, /--admission admission\.json/);
  assert.match(comparablePlan, /run: \|[\s\S]*set -euo pipefail[\s\S]*raw_dir='browser-release-measurements'[\s\S]*--input "\$\{raw_dir\}"/);
  assert.match(comparablePlan, /--admission admission\.json/);
  assert.match(secondMeasure, /run: \|[\s\S]*set -euo pipefail[\s\S]*unit='\$\{\{ matrix\.unit\.unitId \}\}'[\s\S]*digest='\$\{\{ matrix\.unit\.sample1Digest \}\}'[\s\S]*raw="[^"]*\$\{unit\}[^"]*"[\s\S]*--unit "\$\{unit\}"[\s\S]*--comparable-to "\$\{digest\}"[\s\S]*--output "\$\{raw\}"/);
  assert.match(secondMeasure, /--admission admission\.json/);
});

test('every heavy smoke bundle shares one environment and binds all shard commands to the runtime wrapper', () => {
  const workflow = parseYaml(readFileSync(ciWorkflowPath, 'utf8'));
  const smokeShard = workflow.jobs['smoke-play-shard'];
  assert.ok(smokeShard, 'smoke-play shard job must be present');
  assert.deepEqual(smokeShard.needs, ['prerequisite-release']);
  assert.deepEqual(smokeShard.strategy.matrix.bundle, ['core', 'breadth', 'editor']);
  assert.equal(smokeShard.strategy['fail-fast'], true);
  assert.equal(
    smokeShard.strategy['max-parallel'],
    smokeShard.strategy.matrix.bundle.length,
    'every isolated smoke bundle must be independently schedulable',
  );

  const environmentStep = smokeShard.steps.find(
    (step) => step.uses === './.github/actions/smoke-play-environment',
  );
  assert.ok(environmentStep, 'smoke-play must prepare the shared environment');
  assert.equal(
    environmentStep.with?.['isolation-key'],
    '${{ matrix.bundle }}',
    'each matrix member must pass its bundle identity explicitly',
  );

  const bundleSteps = smokeShard.steps.filter(
    (step) => typeof step.if === 'string' && step.if.includes('matrix.bundle'),
  );
  assert.equal(bundleSteps.length, 3, 'each bundle must have one command step');
  const combinedRuns = bundleSteps.map((step) => step.run ?? '').join('\n');
  const shardMatches = [...combinedRuns.matchAll(/--shard\s+([a-z-]+)/g)].map((match) => match[1]);
  assert.deepEqual(shardMatches, [
    'scriptable',
    'broad-core',
    'template',
    'broad-play',
    'broad-assets',
    'vfx',
    'editor',
    'create',
    'repro',
  ]);
  for (const step of bundleSteps) {
    assert.match(
      step.run ?? '',
      /smoke-shard-runtime\.mjs/,
      `${step.name ?? 'unnamed bundle step'} must invoke the runtime wrapper`,
    );
    assert.match(step.run ?? '', /--ports\s+[0-9,]+/, `${step.name ?? 'unnamed bundle step'} must declare ports`);
    assert.match(step.run ?? '', /--\s+/, `${step.name ?? 'unnamed bundle step'} must pass the original command after the wrapper boundary`);
  }

  const runtimeEvidence = smokeShard.steps.find((step) => step.name === 'Upload runtime evidence');
  assert.ok(runtimeEvidence, 'smoke-play must upload runtime evidence');
  assert.match(runtimeEvidence.if, /always\(\)/);
  assert.match(runtimeEvidence.with.path, /smoke-shard-runtime/);
  assert.equal(runtimeEvidence.with['if-no-files-found'], 'error');
  const runtimeRequired = smokeShard.steps.find((step) => step.name === 'Require runtime evidence files');
  assert.ok(runtimeRequired, 'smoke-play must validate runtime.json before upload');
  assert.match(runtimeRequired.if, /always\(\)/);
  assert.match(runtimeRequired.run, /smoke-bundle-run\.mjs/);
  assert.match(runtimeRequired.run, /--require-runtime-evidence/);
  const lifecycleRequired = smokeShard.steps.find((step) => step.name === 'Require lifecycle evidence after failed bundle shard');
  assert.ok(lifecycleRequired, 'failed smoke-play bundles must validate lifecycle.jsonl independently');
  assert.match(lifecycleRequired.if, /failure\(\)/);
  assert.match(lifecycleRequired.run, /lifecycle_path=.*lifecycle\.jsonl/);
  assert.match(lifecycleRequired.run, /-s \"\$lifecycle_path\"/);
  const testResultsRequired = smokeShard.steps.find((step) => step.name === 'Require Playwright test-results after failed shard');
  assert.ok(testResultsRequired, 'failed smoke-play bundles must validate Playwright test-results independently');
  assert.match(testResultsRequired.if, /failure\(\)/);
  assert.match(testResultsRequired.run, /-d test-results/);
  assert.match(testResultsRequired.run, /find test-results -type f/);
  assert.ok(
    smokeShard.steps.indexOf(runtimeRequired) < smokeShard.steps.indexOf(runtimeEvidence),
    'runtime.json validation must precede its upload',
  );
  const failureEvidence = smokeShard.steps.find((step) => step.name === 'Upload smoke failure diagnostics');
  assert.ok(failureEvidence, 'smoke-play must upload failure diagnostics');
  assert.match(failureEvidence.if, /failure\(\)/);
  assert.match(failureEvidence.with.path, /smoke-shard-runtime/);
  assert.match(failureEvidence.with.path, /test-results/);
  assert.equal(failureEvidence.with['if-no-files-found'], 'error');
  assert.ok(
    smokeShard.steps.indexOf(lifecycleRequired) < smokeShard.steps.indexOf(failureEvidence),
    'lifecycle.jsonl validation must precede failure diagnostics upload',
  );
  assert.ok(
    smokeShard.steps.indexOf(testResultsRequired) < smokeShard.steps.indexOf(failureEvidence),
    'test-results validation must precede failure diagnostics upload',
  );
});
