import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { BUN_EXECUTABLE } from '../ci/bun-runtime.mjs';

const root = resolve(import.meta.dir, '../..');
const statusFixture = JSON.parse(
  readFileSync(join(root, 'scripts/fixtures/ddc-status-cases.json'), 'utf8'),
) as {
  project: {
    scopeId: string;
    generation: number;
    currentKey: string;
    lastKnownGoodKey: string;
    lease: string;
  };
  legacy: readonly {
    relativePath: string;
    classification: string;
    owner: string;
    reason: string;
  }[];
};

function runDdc(args: readonly string[]) {
  return spawnSync(BUN_EXECUTABLE, ['scripts/fx.ts', 'ddc', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function createFixtureGame(): string {
  const game = mkdtempSync(join(tmpdir(), 'forgeax-ddc-cli-'));
  writeFileSync(join(game, 'forge.json'), '{"name":"ddc-cli-fixture"}\n');
  mkdirSync(join(game, '.forgeax', 'ddc', 'v2', 'heads'), { recursive: true });
  writeFileSync(
    join(game, '.forgeax', 'ddc', 'v2', 'heads', 'entity.json'),
    JSON.stringify({
      guid: 'entity',
      desiredKey: statusFixture.project.currentKey,
      currentKey: statusFixture.project.currentKey,
      lastKnownGoodKey: statusFixture.project.lastKnownGoodKey,
      generation: statusFixture.project.generation,
      revision: 8,
      active: {
        attempt: statusFixture.project.lease,
        instanceId: 'fixture-instance',
        expiresAt: Date.now() + 60_000,
      },
    }),
  );
  mkdirSync(join(game, '.forgeax', 'ddc', 'v2', 'entries', statusFixture.project.currentKey), { recursive: true });
  writeFileSync(
    join(game, '.forgeax', 'ddc', 'v2', 'entries', statusFixture.project.currentKey, 'receipt.json'),
    JSON.stringify({ key: statusFixture.project.currentKey, protected: true }),
  );
  const verified = join(game, statusFixture.legacy[0]!.relativePath);
  mkdirSync(verified, { recursive: true });
  writeFileSync(join(verified, 'receipt.json'), JSON.stringify({ kind: 'pure-build-object', schemaVersion: 'v2' }));
  writeFileSync(join(verified, 'integrity.json'), JSON.stringify({ digest: 'fixture-digest' }));
  const unknown = join(game, statusFixture.legacy[1]!.relativePath);
  mkdirSync(unknown, { recursive: true });
  writeFileSync(join(unknown, 'payload.bin'), 'unknown legacy state');
  return game;
}

test('ddc help exposes discovery, read-only status, recovery, and explicit prune', () => {
  const result = runDdc(['--help']);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('status --game DIR --json');
  expect(result.stdout).toContain('rebuild --game DIR --json');
  expect(result.stdout).toContain('prune --game DIR --dry-run --json');
  expect(result.stdout).toContain('does not delete by default');
});

test('status reports project and legacy layers with machine-readable recovery facts', () => {
  const game = createFixtureGame();
  try {
    const result = runDdc(['status', '--game', game, '--json']);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      schemaVersion: 'forgeax-ddc-status/v2',
      gameDir: realpathSync(game),
      projectDdcRoot: resolve(realpathSync(game), '.forgeax/ddc/v2'),
    });
    expect(payload.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'project', owner: 'engine-ddc', current: 'current-key', lastKnownGood: 'lkg-key' }),
      expect.objectContaining({ kind: 'build', owner: 'engine-ddc' }),
    ]));
    expect(payload.legacy.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ classification: 'migratable', owner: 'engine-ddc' }),
      expect.objectContaining({ classification: 'unavailable', owner: 'unknown' }),
    ]));
    expect(payload.legacy.entries.every((entry: { exactTarget?: string; reason?: string }) => entry.exactTarget && entry.reason)).toBe(true);
    expect(payload.recoveryActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'inspect', executable: true }),
      expect.objectContaining({ kind: 'cold-rebuild', executable: true }),
    ]));
  } finally {
    rmSync(game, { recursive: true, force: true });
  }
});

test('dry-run produces no deletion and explicit execution preserves protected/unknown targets', () => {
  const game = createFixtureGame();
  try {
    const dryRun = runDdc(['prune', '--game', game, '--dry-run', '--json']);
    expect(dryRun.status).toBe(0);
    const report = JSON.parse(dryRun.stdout);
    expect(report.dryRun).toBe(true);
    expect(report.deleted).toEqual([]);
    expect(report.reclaimedBytes).toBe(0);
    expect(report.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ classification: 'migratable', exactTarget: expect.any(String) }),
      expect.objectContaining({ classification: 'unavailable', exactTarget: expect.any(String) }),
    ]));
    const verified = join(realpathSync(game), statusFixture.legacy[0]!.relativePath);
    expect(readFileSync(join(verified, 'receipt.json'), 'utf8')).toContain('pure-build-object');

    const applied = runDdc(['prune', '--game', game, '--execute', '--json']);
    expect(applied.status).toBe(0);
    const appliedReport = JSON.parse(applied.stdout);
    expect(appliedReport.dryRun).toBe(false);
    expect(appliedReport.deleted).toContain(verified);
    expect(readFileSync(join(realpathSync(game), statusFixture.legacy[1]!.relativePath, 'payload.bin'), 'utf8')).toContain('unknown legacy state');
  } finally {
    rmSync(game, { recursive: true, force: true });
  }
});

test('rebuild reports a structured recovery action without claiming unavailable producer work', () => {
  const game = createFixtureGame();
  try {
    const result = runDdc(['rebuild', '--game', game, '--json']);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      operation: 'cold-rebuild',
      status: 'unavailable',
      error: { code: 'ddc-cold-rebuild-unavailable' },
    });
    expect(payload.error.recoveryActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'cold-rebuild', executable: false }),
    ]));
  } finally {
    rmSync(game, { recursive: true, force: true });
  }
});

test('disposable game recovery re-verifies protection and retains unavailable legacy state', () => {
  const game = createFixtureGame();
  try {
    const before = runDdc(['status', '--game', game, '--json']);
    expect(before.status).toBe(0);
    const beforePayload = JSON.parse(before.stdout);
    expect(beforePayload.layers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'project',
        current: 'current-key',
        lastKnownGood: 'lkg-key',
        lease: 'lease-editor-a',
      }),
    ]));

    const dryRun = runDdc(['prune', '--game', game, '--dry-run', '--json']);
    expect(dryRun.status).toBe(0);
    expect(JSON.parse(dryRun.stdout)).toMatchObject({ dryRun: true, deleted: [], reclaimedBytes: 0 });

    const applied = runDdc(['prune', '--game', game, '--execute', '--json']);
    expect(applied.status).toBe(0);
    const appliedPayload = JSON.parse(applied.stdout);
    expect(appliedPayload.reverified).toBe(true);
    expect(appliedPayload.deleted).toHaveLength(1);
    expect(readFileSync(join(realpathSync(game), '.forgeax', 'ddc', 'v2', 'entries', 'current-key', 'receipt.json'), 'utf8')).toContain('protected');

    const after = runDdc(['status', '--game', game, '--json']);
    expect(after.status).toBe(0);
    const afterPayload = JSON.parse(after.stdout);
    expect(afterPayload.legacy.entries).toEqual([
      expect.objectContaining({
        classification: 'unavailable',
        owner: 'unknown',
        reason: expect.stringContaining('no provable'),
      }),
    ]);
    expect(afterPayload.legacy.reclaimableBytes).toBe(0);
    expect(afterPayload.recoveryActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'cold-rebuild', executable: true }),
    ]));
  } finally {
    rmSync(game, { recursive: true, force: true });
  }
});

test('status rejects a missing or outside game root with a structured boundary error', () => {
  const game = createFixtureGame();
  try {
    const missing = runDdc(['status', '--game', join(game, '..', 'not-a-game'), '--json']);
    expect(missing.status).not.toBe(0);
    expect(JSON.parse(missing.stdout).error).toMatchObject({
      code: 'ddc-game-root-invalid',
      recoveryActions: [expect.objectContaining({ kind: 'inspect', executable: true })],
    });
  } finally {
    rmSync(game, { recursive: true, force: true });
  }
});
