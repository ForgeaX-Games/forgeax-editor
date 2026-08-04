import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'bun:test';

const here = dirname(fileURLToPath(import.meta.url));
const skillPath = join(here, '..', 'SKILL.md');

async function skillText() {
  return readFile(skillPath, 'utf8');
}

test('Gateway skill indexes the asset source workflow in executable order', async () => {
  const text = await skillText();
  const headings = [
    '## Asset source workflow (M5)',
    '## Connect and discover',
    '## Execute safely',
  ];
  for (const heading of headings) assert.notEqual(text.indexOf(heading), -1, `missing heading: ${heading}`);
  const order = [
    'gateway.listOps()',
    'previewAssetSourceMutation',
    'saveAssetSourceOverride',
    'reimportAsset',
    'discardSourceOverridesAndReimport',
    'waitOperationRun',
    'catalog.reconcile',
  ].map((needle) => text.indexOf(needle));
  assert.ok(order.every((position) => position >= 0), 'workflow index is missing a canonical operation or recovery action');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'workflow steps are not documented in discovery-to-recovery order');
});

test('Gateway skill indexes schema, terminal, and structured error facts', async () => {
  const text = await skillText();
  for (const field of ['guid', 'scope.sourceKey', 'expectedRevision', 'requestId', 'confirmationToken', 'error.code', 'retryable', 'recoveryActions']) {
    assert.notEqual(text.indexOf(field), -1, `missing public field: ${field}`);
  }
  for (const status of ['accepted', 'running', 'succeeded', 'failed', 'cancelled']) {
    assert.notEqual(text.indexOf(status), -1, `missing run status: ${status}`);
  }
  for (const action of ['asset.preflight', 'run.get', 'run.wait', 'run.retry', 'catalog.reconcile']) {
    assert.notEqual(text.indexOf(action), -1, `missing recovery action: ${action}`);
  }
  assert.match(text, /never parse.*hint|do not parse.*hint/i);
});
