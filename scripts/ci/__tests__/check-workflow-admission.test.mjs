import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.doesNotMatch(text, /pr-head\/(?:scripts|package\.json|node_modules)/);
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
  if (text.includes('scripts/ci/hydrate-engine-artifact.mjs')) {
    const start = text.indexOf('  prerequisite-release:');
    const end = text.indexOf('\n  docs-policy:', start);
    assert.ok(start >= 0, 'CI must declare the prerequisite producer');
    assert.ok(end > start, 'producer block must end before docs-policy');
    const block = text.slice(start, end);
    assert.match(block, /Hydrate Engine core artifact for the exact submodule SHA/);
    assert.match(block, /scripts\/ci\/hydrate-engine-artifact\.mjs/);
    assert.match(block, /ENGINE_REPOSITORY:\s+ForgeaX-Games\/forgeax-engine/);
    assert.match(block, /Checkout direct submodules \(Engine assets are not needed by this producer\)/);
    assert.match(block, /submodules:\s+true/);
    assert.doesNotMatch(block, /submodules:\s+recursive/);
    assert.doesNotMatch(block, /Setup Rust|wasm-pack|Setup pnpm|Build wgpu-wasm|Build engine library|fetch-wasm/);
    assert.doesNotMatch(block, /install --frozen-lockfile/);
    return;
  }
  const start = text.indexOf('name: Setup wasm-pack (self-hosted Linux)');
  const end = text.indexOf('name: Setup pnpm', start);
  assert.ok(start >= 0, 'CI must provision wasm-pack for the pre-artifact producer');
  assert.ok(end > start, 'wasm-pack setup must precede pnpm setup');
  const block = text.slice(start, end);
  assert.match(block, /CI_TRUSTED_WASM_PACK_PATH/);
  assert.match(block, /wasm-pack \$CI_WASM_PACK_VERSION/);
  assert.match(block, /cp -- "\$trusted_wasm_pack_path" "\$dir\/wasm-pack"/);
  assert.match(block, /curl --fail --location --retry 3/);
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

test('submodule pin rejects a PR tested against a stale main base', () => {
  const workflow = parseYaml(readFileSync(ciWorkflowPath, 'utf8'));
  const pin = workflow.jobs['submodule-pin'];
  const freshnessStep = pin.steps.find((step) => step.name === 'Require PR base to be current main');
  assert.ok(freshnessStep, 'submodule-pin must admit only a current PR base');
  assert.equal(freshnessStep.if, "${{ github.event_name == 'pull_request' }}");
  assert.equal(
    freshnessStep.env.CI_PR_BASE_SHA,
    '${{ github.event.pull_request.base.sha }}',
  );
  assert.match(freshnessStep.run, /git ls-remote origin refs\/heads\/main/);
  assert.match(freshnessStep.run, /check-pr-base-freshness\.mjs/);
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
  assert.match(smokeShard, /needs:\s+prerequisite-release/, 'smoke-play shards must wait for producer publication');
  assert.match(smokeShard, /always\(\)/, 'smoke-play shards must inspect producer failure explicitly');
  const smokeEnvironment = readFileSync(smokePlayEnvironmentPath, 'utf8');
  assert.match(smokeEnvironment, /actions\/download-artifact@v5/, 'smoke-play must consume the immutable release');
  const smokeAggregate = blockFor('smoke-play');
  assert.match(smokeAggregate, /needs:\s*\[prerequisite-release,\s*smoke-play-shard\]/);
  assert.match(smokeAggregate, /always\(\)/);
  assert.match(smokeAggregate, /Require every smoke shard to pass/);
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
    'name: Broad core smoke (games/sample)',
    'name: New-game template smoke (fresh canonical template)',
    'name: Broad Play runtime smoke (games/sample)',
    'name: Broad asset smoke (games/sample)',
  ].map((name) => text.indexOf(name, smokeBlockStart));
  assert.ok(smokeBlockStart >= 0, 'smoke-play-shard job is present');
  assert.ok(smokeActionStart >= 0, 'smoke-play-shard uses the browser-smoke environment action');
  assert.match(
    text.slice(smokeBlockStart, smokeActionStart),
    /submodules:\s+recursive/,
    'smoke-play must recursively materialize nested pins before admission',
  );
  assert.ok(smokeBodyStarts.every((start) => start >= 0), 'every broad smoke shard body is present');
  assert.ok(
    smokeBodyStarts.every((start) => smokeActionStart < start),
    'smoke-play environment setup precedes every broad check body',
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
  assert.match(smokeActionText, /FORGEAX_SMOKE_RUNTIME_REPORT/);
  assert.match(smokeActionText, /FORGEAX_DEV_STACK_EVENT_LOG/);

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
  assert.doesNotMatch(text, /working-directory:\s*pr-head/);
  assert.doesNotMatch(text, /working-directory:\s*pr-head|pr-head\/(?:scripts|package\.json|node_modules)/);
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

test('every heavy smoke shard binds its identity and command to one runtime wrapper', () => {
  const workflow = parseYaml(readFileSync(ciWorkflowPath, 'utf8'));
  const smokeShard = workflow.jobs['smoke-play-shard'];
  assert.ok(smokeShard, 'smoke-play shard job must be present');
  assert.equal(smokeShard.strategy?.matrix?.shard?.length, 9);
  assert.deepEqual(smokeShard.strategy.matrix.shard, [
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
  assert.equal(smokeShard.strategy['max-parallel'], 2);

  const environmentStep = smokeShard.steps.find(
    (step) => step.uses === './.github/actions/smoke-play-environment',
  );
  assert.ok(environmentStep, 'smoke-play must prepare the shared environment');
  assert.equal(
    environmentStep.with?.['isolation-key'],
    '${{ matrix.shard }}',
    'each matrix member must pass its shard identity explicitly',
  );

  const shardSteps = smokeShard.steps.filter(
    (step) => typeof step.if === 'string' && step.if.includes('matrix.shard'),
  );
  assert.equal(shardSteps.length, 9, 'each matrix member must have one command step');
  for (const step of shardSteps) {
    assert.match(
      step.run ?? '',
      /smoke-shard-runtime\.mjs/,
      `${step.name ?? 'unnamed shard step'} must invoke the runtime wrapper`,
    );
    assert.match(step.run ?? '', /--shard\s+[a-z-]+/, `${step.name ?? 'unnamed shard step'} must declare its shard identity`);
    assert.match(step.run ?? '', /--ports\s+[0-9,]+/, `${step.name ?? 'unnamed shard step'} must declare its ports`);
    assert.match(step.run ?? '', /--\s+/, `${step.name ?? 'unnamed shard step'} must pass the original command after the wrapper boundary`);
  }

  const runtimeEvidence = smokeShard.steps.find((step) => step.name === 'Upload runtime evidence');
  assert.ok(runtimeEvidence, 'smoke-play must upload runtime evidence');
  assert.match(runtimeEvidence.if, /always\(\)/);
  assert.match(runtimeEvidence.with.path, /smoke-shard-runtime/);
  assert.equal(runtimeEvidence.with['if-no-files-found'], 'error');
  const runtimeRequired = smokeShard.steps.find((step) => step.name === 'Require runtime evidence file');
  assert.ok(runtimeRequired, 'smoke-play must validate runtime.json before upload');
  assert.match(runtimeRequired.if, /always\(\)/);
  assert.match(runtimeRequired.run, /runtime_path=.*runtime\.json/);
  assert.match(runtimeRequired.run, /-s \"\$runtime_path\"/);
  const lifecycleRequired = smokeShard.steps.find((step) => step.name === 'Require lifecycle evidence after failed shard');
  assert.ok(lifecycleRequired, 'failed smoke-play shards must validate lifecycle.jsonl independently');
  assert.match(lifecycleRequired.if, /failure\(\)/);
  assert.match(lifecycleRequired.run, /lifecycle_path=.*lifecycle\.jsonl/);
  assert.match(lifecycleRequired.run, /-s \"\$lifecycle_path\"/);
  const testResultsRequired = smokeShard.steps.find((step) => step.name === 'Require Playwright test-results after failed shard');
  assert.ok(testResultsRequired, 'failed smoke-play shards must validate Playwright test-results independently');
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
  assert.match(failureEvidence.with.path, /lifecycle\.jsonl/);
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
