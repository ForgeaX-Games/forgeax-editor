import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  buildDedupComment,
  buildEvidenceComment,
  buildFailureIssue,
  extractIssueMergeSha,
  findMatchingOpenIssues,
  findTrackedOpenIssues,
  POST_MERGE_LABELS,
  POST_MERGE_MARKER,
} from './fixtures/post-merge-monitor-issue-helpers.mjs';

const workflowPath = resolve('.github/workflows/post-merge-ci-monitor.yml');

const workflowRun = (overrides = {}) => ({
  id: 42,
  head_sha: 'a'.repeat(40),
  html_url: 'https://github.com/ForgeaX-Games/forgeax-editor/actions/runs/42',
  conclusion: 'failure',
  ...overrides,
});

test('post-merge workflow grants issue write and retries external issue API calls', () => {
  const workflow = readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /permissions:[\s\S]*issues:\s*write/);
  assert.match(workflow, /issues\.create/);
  assert.match(workflow, /issues\.createComment/);
  assert.match(workflow, /issues\.update/);
  assert.equal((workflow.match(/retries:\s*3/g) ?? []).length, 3);
  assert.equal((workflow.match(/retry-exempt-status-codes:\s*400,401,403,404,422/g) ?? []).length, 3);
  assert.match(workflow, /report\?\.terminalStatus === 'failure'/);
  assert.match(workflow, /id: upload_report/);
  assert.match(workflow, /id: download-prerequisite-current/);
  assert.match(workflow, /id: download-prerequisite-first/);
  assert.match(workflow, /forgeax-prerequisite-release-\$\{\{ github\.event\.workflow_run\.id \}\}-1/);
  assert.match(workflow, /Select immutable producer release manifest/);
  assert.match(workflow, /Preserve post-merge monitor status after issue bookkeeping/);
  assert.doesNotMatch(workflow, /post-merge classifier reported a non-pass result/);
});

test('red same-SHA delivery deduplicates by the body sentinel', () => {
  const run = workflowRun();
  const open = [
    { number: 7, labels: ['post-merge'], body: `failure\n**merge sha**: \`${run.head_sha}\`` },
    { number: 8, labels: ['post-merge'], body: '**merge sha**: `other`' },
  ];
  const tracked = findTrackedOpenIssues(open);
  const matching = findMatchingOpenIssues(run.head_sha, tracked);

  assert.deepEqual(matching.map((issue) => issue.number), [7]);
  assert.equal(buildDedupComment(run, 'repository-source-failure').includes(run.html_url), true);
  assert.equal(buildDedupComment(run, 'repository-source-failure').includes(run.head_sha), true);
  assert.equal(POST_MERGE_LABELS.join(','), 'post-merge,ci-failure,sla-24h');
});

test('red delivery with no matching issue creates a marker, SHA, and engine-compatible labels', () => {
  const run = workflowRun({ head_sha: 'b'.repeat(40) });
  const issue = buildFailureIssue(
    run,
    'https://github.com/ForgeaX-Games/forgeax-editor/actions/runs/900',
    { classification: 'repository-source-failure', code: 'workflow-run-nonpass', failureClass: 'source' },
  );

  assert.equal(issue.body.includes(POST_MERGE_MARKER), true);
  assert.equal(issue.body.includes(`**merge sha**: \`${run.head_sha}\``), true);
  assert.deepEqual(issue.labels, ['post-merge', 'ci-failure', 'sla-24h']);
});

test('green evidence closes only machine-tracked issues and records both close scenarios', () => {
  const current = workflowRun({ conclusion: 'success' });
  const issues = [
    { number: 1, labels: ['post-merge'], body: `**merge sha**: \`${current.head_sha}\`` },
    { number: 2, labels: [
      { name: 'post-merge' },
    ], body: '**merge sha**: `older`' },
    { number: 3, labels: ['post-merge'], body: 'human-owned issue without sentinel' },
  ];
  const tracked = findTrackedOpenIssues(issues);
  assert.equal(tracked.length, 3);
  assert.equal(extractIssueMergeSha(tracked[0].body), current.head_sha);
  assert.equal(buildEvidenceComment(current, current.head_sha, '2026-08-19T00:00:00.000Z').scenario, 'sha-rerun-green');
  assert.equal(buildEvidenceComment(current, 'older', '2026-08-19T00:00:00.000Z').scenario, 'sha-progressed');
  assert.equal(extractIssueMergeSha(tracked[2].body), null);
});
