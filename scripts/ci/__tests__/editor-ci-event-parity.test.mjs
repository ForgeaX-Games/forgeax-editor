import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');

test('PR and main-push CI share the complete profile', () => {
  assert.match(workflow, /CI_PROFILE: \$\{\{ inputs\.profile \|\| 'complete' \}\}/);
  assert.doesNotMatch(workflow, /github\.event_name == 'pull_request'.*'fast'/s);
});

test('only an explicit fast workflow dispatch skips the browser gate', () => {
  assert.match(
    workflow,
    /github\.event_name != 'workflow_dispatch' \|\| inputs\.profile != 'fast'/,
  );
});
