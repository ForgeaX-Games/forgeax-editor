import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const source = readFileSync(resolve('scripts/selfcheck-standalone-b2.mjs'), 'utf8');
const runtimeSource = readFileSync(resolve('scripts/ci/bun-runtime.mjs'), 'utf8');

test('B2 starts all child processes with the verified Bun executable', () => {
  assert.match(source, /import \{ BUN_EXECUTABLE \} from '\.\/ci\/bun-runtime\.mjs'/);
  assert.match(runtimeSource, /process\.env\.CI_BUN_PATH \|\| process\.execPath/);
  assert.match(source, /spawn\(BUN_EXECUTABLE, \['apps\/standalone\/game-backend\.ts'\]/);
  assert.match(source, /spawn\(BUN_EXECUTABLE, \['run', 'dev'\]/);
  assert.doesNotMatch(source, /spawn\(['"]bun['"]/);
});
