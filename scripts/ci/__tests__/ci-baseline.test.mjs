import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  BaselineContractError,
  assertStableRoster,
  buildWorkflowGraph,
  deriveTimings,
  normalizeAttemptJobPacket,
  validateWorkflowGraph,
} from '../ci-baseline.mjs';
import {
  ENGINE_TECHNIQUE_MIGRATION,
  validateEngineTechniqueMigration,
} from '../engine-technique-migration.mjs';

const LIVE_CONTEXTS = [
  { context: 'b2-self-boot', integrationId: 15368 },
  { context: 'typecheck', integrationId: 15368 },
  { context: 'submodule-pin', integrationId: 15368 },
  { context: 'smoke-play', integrationId: 15368 },
];

function errorCode(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BaselineContractError);
    return error.code;
  }
  assert.fail('expected a BaselineContractError');
}

function fixtureJob(id, name, overrides = {}) {
  return {
    id,
    name,
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-08-07T08:00:00Z',
    started_at: '2026-08-07T08:00:05Z',
    completed_at: '2026-08-07T08:00:25Z',
    runner_name: `runner-${name}`,
    labels: [
      { name: 'self-hosted' },
      { name: 'Linux' },
      { name: 'X64' },
      { name: name === 'smoke-play' ? 'heavy' : 'standard' },
    ],
    run_id: 42,
    run_attempt: 2,
    ...overrides,
  };
}

function fixtureRun() {
  return {
    id: 42,
    run_attempt: 2,
    event: 'push',
    head_branch: 'main',
    status: 'completed',
    conclusion: 'success',
    head_sha: 'a'.repeat(40),
    created_at: '2026-08-07T07:59:50Z',
    run_started_at: '2026-08-07T08:00:00Z',
    updated_at: '2026-08-07T08:00:25Z',
    html_url: 'https://github.com/ForgeaX-Games/forgeax-editor/actions/runs/42',
  };
}

function fixturePages(jobs) {
  const midpoint = Math.max(1, Math.floor(jobs.length / 2));
  return [
    { total_count: jobs.length, jobs: jobs.slice(0, midpoint) },
    { total_count: jobs.length, jobs: jobs.slice(midpoint) },
  ];
}

test('the admitted editor workflow emits live job, needs, runner, timeout, and context graph', () => {
  const text = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  const graph = buildWorkflowGraph([{ file: '.github/workflows/ci.yml', text }], LIVE_CONTEXTS);
  const jobs = graph.workflows[0].jobs;
  assert.deepEqual(jobs.map((job) => job.id), [
    'prerequisite-release',
    'docs-policy',
    'submodule-pin',
    'b2-self-boot',
    'typecheck',
    'smoke-play',
  ]);
  assert.deepEqual(
    Object.fromEntries(jobs.map((job) => [job.id, job.runner.pool ?? job.runner.kind])),
    {
      'prerequisite-release': 'standard',
      'docs-policy': 'standard',
      'submodule-pin': 'standard',
      'b2-self-boot': 'standard',
      typecheck: 'standard',
      'smoke-play': 'heavy',
    },
  );
  assert.equal(jobs.find((job) => job.id === 'smoke-play').timeoutMinutes, 20);
  assert.deepEqual(graph.requiredContexts.map((context) => context.jobId), [
    'b2-self-boot',
    'typecheck',
    'submodule-pin',
    'smoke-play',
  ]);
  assert.ok(!graph.needsEdges.some((edge) => edge.from === 'docs-policy'));
});

test('graph contract rejects an omitted live job and an omitted live context', () => {
  const incomplete = `name: CI\njobs:\n  typecheck:\n    runs-on: [self-hosted, Linux, X64, standard]\n    timeout-minutes: 5\n`;
  assert.equal(
    errorCode(() => buildWorkflowGraph([{ file: 'ci.yml', text: incomplete }], LIVE_CONTEXTS)),
    'live-context-job-missing',
  );

  const text = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  const graph = buildWorkflowGraph([{ file: 'ci.yml', text }], LIVE_CONTEXTS);
  const omitted = {
    ...graph,
    requiredContexts: graph.requiredContexts.filter((context) => context.context !== 'smoke-play'),
  };
  assert.equal(errorCode(() => validateWorkflowGraph(omitted, LIVE_CONTEXTS)), 'live-context-missing');
});

test('attempt-aware pagination rejects zero-job and mixed-attempt packets', () => {
  assert.equal(
    errorCode(() => normalizeAttemptJobPacket(fixtureRun(), [{ total_count: 0, jobs: [] }], {
      requiredContexts: [{ context: 'b2-self-boot', jobName: 'b2-self-boot' }],
    })),
    'zero-job-sample',
  );

  const jobs = [fixtureJob(1, 'b2-self-boot'), fixtureJob(2, 'typecheck')];
  const mixedAttempt = fixturePages([
    jobs[0],
    { ...jobs[1], run_attempt: 1 },
  ]);
  assert.equal(
    errorCode(() => normalizeAttemptJobPacket(fixtureRun(), mixedAttempt)),
    'job-attempt-mismatch',
  );
});

test('terminal comparable samples reject a mixed roster instead of merging it', () => {
  const requiredContexts = [
    { context: 'b2-self-boot', jobName: 'b2-self-boot' },
    { context: 'typecheck', jobName: 'typecheck' },
  ];
  const first = normalizeAttemptJobPacket(
    fixtureRun(),
    fixturePages([fixtureJob(1, 'b2-self-boot'), fixtureJob(2, 'typecheck')]),
    { requiredContexts },
  );
  const second = normalizeAttemptJobPacket(
    { ...fixtureRun(), id: 43 },
    fixturePages([
      fixtureJob(3, 'b2-self-boot', { run_id: 43 }),
      fixtureJob(4, 'typecheck', { run_id: 43 }),
      fixtureJob(5, 'extra-job', { run_id: 43 }),
    ]),
    { requiredContexts },
  );
  assert.equal(errorCode(() => assertStableRoster([first, second], { requiredContexts })), 'mixed-roster');
  assert.equal(
    errorCode(() => normalizeAttemptJobPacket(
      { ...fixtureRun(), id: 43 },
      fixturePages([
        fixtureJob(3, 'b2-self-boot', { run_id: 43 }),
        fixtureJob(4, 'typecheck', { run_id: 43 }),
        fixtureJob(5, 'extra-job', { run_id: 43 }),
      ]),
      { requiredContexts, expectedJobNames: ['b2-self-boot', 'typecheck'] },
    )),
    'roster-mismatch',
  );
});

test('timings keep admission, runner queue, active window, and first failure distinct', () => {
  const requiredContexts = [{ context: 'b2-self-boot', jobName: 'b2-self-boot' }];
  const run = fixtureRun();
  const sample = normalizeAttemptJobPacket(
    run,
    fixturePages([
      fixtureJob(1, 'b2-self-boot', {
        created_at: '2026-08-07T08:00:05Z',
        started_at: '2026-08-07T08:00:15Z',
        completed_at: '2026-08-07T08:00:35Z',
        conclusion: 'failure',
      }),
    ]),
    { requiredContexts },
  );
  const timing = deriveTimings(sample, { requiredContexts });
  assert.equal(timing.admissionSeconds, 10);
  assert.equal(timing.queueSeconds, 10);
  assert.equal(timing.activeSeconds, 20);
  assert.equal(timing.firstFailureSeconds, 35);
  assert.equal(timing.firstFailure.secondsFromRunCreated, 45);
});

test('engine migration matrix has a complete decision and falsifier on every row', () => {
  validateEngineTechniqueMigration();
  assert.deepEqual(new Set(ENGINE_TECHNIQUE_MIGRATION.map((row) => row.decision)), new Set([
    'reuse',
    'adapt',
    'reject',
    'defer',
  ]));
});
