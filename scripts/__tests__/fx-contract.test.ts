import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { BUN_EXECUTABLE } from '../ci/bun-runtime.mjs';

const root = resolve(import.meta.dir, '../..');
const reportFixture = await Bun.file('scripts/ci/fixtures/fx-contract-report.json').json();

function runFx(args: string[]) {
  return spawnSync(BUN_EXECUTABLE, ['scripts/fx.ts', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('contract discovery is read-only and exposes selectable homes and recovery fields', () => {
  const result = runFx(['ci', 'contract', '--json']);
  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout);
  expect(payload.schemaVersion).toBe('forgeax-editor-ci-contract/v1');
  expect(payload.checks.map((check: { checkId: string }) => check.checkId)).toEqual([
    'b2-self-boot',
    'typecheck',
    'r0-hierarchy-ui-editability',
    'r0-sample-vfx-skill',
    'r0-engine-dogfood-diagnostics',
    'submodule-pin',
    'smoke-play',
  ]);
  expect(payload.profiles['local-fast']).toEqual([
    'b2-self-boot',
    'typecheck',
    'r0-hierarchy-ui-editability',
    'r0-sample-vfx-skill',
    'r0-engine-dogfood-diagnostics',
  ]);
  expect(payload.profiles['local-full']).toEqual([
    'b2-self-boot',
    'typecheck',
    'r0-hierarchy-ui-editability',
    'r0-sample-vfx-skill',
    'r0-engine-dogfood-diagnostics',
    'submodule-pin',
    'smoke-play',
  ]);
  expect(payload.recovery).toEqual(reportFixture.discoveryRecovery);
});

test('dirty checkout is admitted before execution and writes only the requested report', async () => {
  const marker = join(root, 'scripts/ci/.fx-contract-admission-marker');
  const reportDir = mkdtempSync(join(tmpdir(), 'forgeax-fx-contract-report-'));
  const reportPath = join(reportDir, 'report.json');
  writeFileSync(marker, 'temporary dirty state\n');
  try {
    const result = runFx(['ci', '--fast', '--report', reportPath]);
    expect(result.status).not.toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(reportPath)).toBe(true);
    const report = await Bun.file(reportPath).json();
    for (const field of reportFixture.envelopeFields) expect(report).toHaveProperty(field);
    expect(report.$schema).toBe('forgeax-editor-ci-report/v1');
    expect(report.contractVersion).toBe('forgeax-editor-ci-contract/v1');
    expect(report.schemaVersion).toBeUndefined();
    expect(report.status).toBeUndefined();
    expect(report.profile).toBe('fast');
    expect(report.executionHome).toBe('local-fast');
    expect(report.terminalStatus).toBe('failure');
    expect(report.failureClass).toBe('admission');
    expect(report.code).toBe('dirty-worktree');
    expect(report.attempts).toHaveLength(1);
  } finally {
    rmSync(marker, { force: true });
    rmSync(reportDir, { recursive: true, force: true });
  }
});

test('local profiles expose the shared prerequisite vocabulary without cloud provenance', async () => {
  const contractResult = runFx(['ci', 'contract', '--json']);
  expect(contractResult.status).toBe(0);
  const contract = JSON.parse(contractResult.stdout);
  expect(contract.prerequisiteRelease.schemaVersion).toBe('forgeax-prerequisite-release/v1');
  expect(contract.prerequisiteRelease.consumers['b2-self-boot']).toEqual([
    'engine-dist',
    'wgpu-wasm',
    'bun-install-facts',
  ]);
  expect(contract.prerequisiteRelease.consumers['smoke-play']).toEqual([
    'engine-dist',
    'wgpu-wasm',
    'fbx-wasm',
    'bun-install-facts',
  ]);
  expect(contract.requiredContexts.map((entry: { context: string }) => entry.context)).toEqual([
    'b2-self-boot',
    'typecheck',
    'submodule-pin',
    'smoke-play',
  ]);

  for (const profile of ['fast', 'full'] as const) {
    const marker = join(root, `scripts/ci/.fx-contract-${profile}-marker`);
    const reportDir = mkdtempSync(join(tmpdir(), `forgeax-fx-${profile}-parity-`));
    const reportPath = join(reportDir, 'report.json');
    writeFileSync(marker, 'temporary dirty state\n');
    try {
      const result = runFx(['ci', `--${profile}`, '--report', reportPath]);
      expect(result.status).not.toBe(0);
      const report = await Bun.file(reportPath).json();
      expect(report.executionHome).toBe(`local-${profile}`);
      expect(report.provenance).toMatchObject({kind: 'local', timingDomain: 'local-execution'});
      expect(report).toHaveProperty('prerequisiteRelease');
      expect(report.prerequisiteRelease).toBeNull();
    } finally {
      rmSync(marker, {force: true});
      rmSync(reportDir, {recursive: true, force: true});
    }
  }
});
