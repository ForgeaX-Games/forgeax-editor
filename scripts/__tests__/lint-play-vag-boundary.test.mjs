import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');

test('play VAG boundary gate accepts the production source tree', () => {
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/lint-play-vag-boundary.mjs')], { cwd: root, encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
});
