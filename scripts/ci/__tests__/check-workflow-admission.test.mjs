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

const workflowRoot = resolve('.github/workflows');
const carrierPath = resolve('.github/workflows/runner-pool-contract.yml');
const ciWorkflowPath = resolve('.github/workflows/ci.yml');
const malformedFixture = resolve('scripts/ci/fixtures/malformed-actions.yml');
const admissionFixture = resolve('scripts/ci/fixtures/workflow-admission-contract.yml');
const measurementWorkflowPath = resolve('.github/workflows/browser-release-measurement.yml');

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

test('self-hosted wasm-pack provisioning accepts only an exact host version before downloading', () => {
  const text = readFileSync(ciWorkflowPath, 'utf8');
  const start = text.indexOf('name: Setup wasm-pack (self-hosted Linux)');
  const end = text.indexOf('name: Setup pnpm', start);
  assert.ok(start >= 0, 'CI must provision wasm-pack for self-hosted Linux');
  assert.ok(end > start, 'wasm-pack setup must precede pnpm setup');
  const block = text.slice(start, end);
  assert.match(block, /CI_TRUSTED_WASM_PACK_PATH/);
  assert.match(block, /wasm-pack \$CI_WASM_PACK_VERSION/);
  assert.match(block, /cp -- "\$trusted_wasm_pack_path" "\$dir\/wasm-pack"/);
  assert.match(block, /curl --fail --location --retry 3/);
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

  for (const jobId of ['b2-self-boot', 'typecheck', 'smoke-play']) {
    const block = blockFor(jobId);
    assert.match(block, /needs:/, `${jobId} must wait for producer publication`);
    assert.match(block, /always\(\)/, `${jobId} must inspect producer failure explicitly`);
    assert.match(block, /download-artifact@v5/, `${jobId} must consume the immutable release`);
  }
});

test('request-scoped release validation precedes every consumer body', () => {
  const text = readFileSync(ciWorkflowPath, 'utf8');
  const consumers = [
    ['b2-self-boot', 'Self-boot B2 (read + write, no studio server)'],
    ['typecheck', 'Run script and contract tests'],
    ['smoke-play', 'Boot + Play + Content Browser + Save + Mesh Preview smoke (games/sample)'],
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
