import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {ALL_SMOKE_SHARDS, SMOKE_PLAY_BUNDLES, shardsForBundle} from '../smoke-play-bundles.mjs';

test('smoke-play bundles cover every shard exactly once', () => {
  assert.deepEqual(Object.keys(SMOKE_PLAY_BUNDLES), ['core', 'breadth', 'editor']);
  assert.deepEqual(ALL_SMOKE_SHARDS.length, 9);
  assert.equal(new Set(ALL_SMOKE_SHARDS).size, 9);
  assert.deepEqual(shardsForBundle('core'), ['scriptable', 'broad-core']);
});

test('smoke-bundle-run validates runtime evidence for a bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-smoke-bundle-'));
  for (const shard of shardsForBundle('core')) {
    const dir = join(root, '.ci', 'smoke-shard-runtime', shard);
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, 'runtime.json'), '{"status":"success"}\n');
  }
  const result = spawnSync(
    process.execPath,
    ['scripts/ci/smoke-bundle-run.mjs', '--bundle', 'core', '--require-runtime-evidence'],
    {cwd: root, encoding: 'utf8'},
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('smoke-bundle-run fails when runtime evidence is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-smoke-bundle-missing-'));
  const result = spawnSync(
    process.execPath,
    ['scripts/ci/smoke-bundle-run.mjs', '--bundle', 'editor', '--require-runtime-evidence'],
    {cwd: root, encoding: 'utf8'},
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing required smoke runtime evidence/);
});
