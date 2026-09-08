import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {
  admitWorkflowTopology,
  buildWorkflowGraph,
  extractRequiredContexts,
} from '../ci-baseline.mjs';
import {
  CAPACITY_PHASES,
  collectCapacityAdmission,
  deriveCapacityTimeline,
} from '../collect-ci-capacity-admission.mjs';

const SOURCE_SHA = 'a'.repeat(40);

function runner(id, name, pool) {
  return {
    runner_id: id,
    runner_name: name,
    labels: [
      {name: 'self-hosted'},
      {name: 'Linux'},
      {name: 'X64'},
      {name: pool},
    ],
  };
}

function job(id, name, pool, createdAt, startedAt, completedAt, steps, overrides = {}) {
  return {
    id,
    name,
    status: 'completed',
    conclusion: 'success',
    run_id: 42,
    run_attempt: 1,
    created_at: createdAt,
    started_at: startedAt,
    completed_at: completedAt,
    ...runner(id + 1000, `${pool}-runner-${id}`, pool),
    steps,
    ...overrides,
  };
}

function step(name, startedAt, completedAt) {
  return {name, status: 'completed', conclusion: 'success', started_at: startedAt, completed_at: completedAt};
}

function topologyFixture() {
  const text = `
name: Capacity fixture
jobs:
  prerequisite-release:
    name: prerequisite-release
    timeout-minutes: 45
    runs-on: [self-hosted, Linux, X64, standard]
  smoke-play-shard:
    name: smoke-play shard (\${{ matrix.shard }})
    needs: [prerequisite-release]
    timeout-minutes: 20
    strategy:
      max-parallel: 2
      matrix:
        shard: [a, b, c]
    runs-on: [self-hosted, Linux, X64, heavy]
  smoke-play:
    name: smoke-play
    needs: [prerequisite-release, smoke-play-shard]
    timeout-minutes: 20
    runs-on: [self-hosted, Linux, X64, heavy]
`;
  const requiredContexts = [{context: 'smoke-play', integrationId: 1}];
  const graph = buildWorkflowGraph([{file: 'ci.yml', text}], requiredContexts);
  const topology = admitWorkflowTopology(graph, {
    requiredContexts,
    observedJobNames: [
      'prerequisite-release',
      'smoke-play shard (a)',
      'smoke-play shard (b)',
      'smoke-play shard (c)',
      'smoke-play',
    ],
    expandMatrix: true,
    workflowFile: 'ci.yml',
  });
  return {graph, requiredContexts, topology};
}

function fixtureRun() {
  return {
    id: 42,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    head_sha: SOURCE_SHA,
    created_at: '2026-08-20T00:00:00Z',
    run_started_at: '2026-08-20T00:00:02Z',
    updated_at: '2026-08-20T00:01:02Z',
  };
}

function fixtureJobs() {
  return [
    job(
      1,
      'prerequisite-release',
      'standard',
      '2026-08-20T00:00:05Z',
      '2026-08-20T00:00:10Z',
      '2026-08-20T00:00:20Z',
      [
        step('Establish environment', '2026-08-20T00:00:10Z', '2026-08-20T00:00:12Z'),
        step('Produce smoke prerequisite', '2026-08-20T00:00:12Z', '2026-08-20T00:00:20Z'),
      ],
    ),
    job(
      2,
      'smoke-play shard (a)',
      'heavy',
      '2026-08-20T00:00:21Z',
      '2026-08-20T00:00:22Z',
      '2026-08-20T00:00:40Z',
      [
        step('Prepare isolated environment', '2026-08-20T00:00:22Z', '2026-08-20T00:00:24Z'),
        step('Broad matrix smoke', '2026-08-20T00:00:24Z', '2026-08-20T00:00:40Z'),
      ],
    ),
    job(
      3,
      'smoke-play shard (b)',
      'heavy',
      '2026-08-20T00:00:21Z',
      '2026-08-20T00:00:22Z',
      '2026-08-20T00:00:45Z',
      [
        step('Prepare isolated environment', '2026-08-20T00:00:22Z', '2026-08-20T00:00:24Z'),
        step('Broad matrix smoke', '2026-08-20T00:00:24Z', '2026-08-20T00:00:45Z'),
      ],
    ),
    job(
      4,
      'smoke-play shard (c)',
      'heavy',
      '2026-08-20T00:00:41Z',
      '2026-08-20T00:00:46Z',
      '2026-08-20T00:00:55Z',
      [
        step('Prepare isolated environment', '2026-08-20T00:00:46Z', '2026-08-20T00:00:47Z'),
        step('Broad matrix smoke', '2026-08-20T00:00:47Z', '2026-08-20T00:00:55Z'),
      ],
    ),
    job(
      5,
      'smoke-play',
      'heavy',
      '2026-08-20T00:00:56Z',
      '2026-08-20T00:00:57Z',
      '2026-08-20T00:01:00Z',
      [
        step('Establish aggregate environment', '2026-08-20T00:00:57Z', '2026-08-20T00:00:58Z'),
        step('Smoke aggregate', '2026-08-20T00:00:58Z', '2026-08-20T00:01:00Z'),
      ],
    ),
  ];
}

test('matrix admission expands actual GitHub names and preserves the declared cap', () => {
  const ruleset = JSON.parse(readFileSync('scripts/ci/fixtures/ruleset.json', 'utf8'));
  const graph = buildWorkflowGraph([
    {file: '.github/workflows/ci.yml', text: readFileSync('.github/workflows/ci.yml', 'utf8')},
  ], extractRequiredContexts(ruleset));
  const names = [
    'prerequisite-release',
    'docs-policy',
    'submodule-pin',
    'b2-self-boot',
    'typecheck',
    'smoke-play shard (scriptable)',
    'smoke-play shard (broad-core)',
    'smoke-play shard (template)',
    'smoke-play shard (broad-play)',
    'smoke-play shard (broad-assets)',
    'smoke-play shard (vfx)',
    'smoke-play shard (editor)',
    'smoke-play shard (create)',
    'smoke-play shard (repro)',
    'smoke-play',
  ];
  const admission = admitWorkflowTopology(graph, {
    requiredContexts: extractRequiredContexts(ruleset),
    observedJobNames: names,
    expandMatrix: true,
    workflowFile: '.github/workflows/ci.yml',
  });

  assert.deepEqual(admission.acceptedJobNames, names);
  assert.equal(admission.needsEdges.length, 25);
  assert.deepEqual(
    admission.acceptedJobs.filter((candidate) => candidate.sourceName === 'smoke-play shard (${{ matrix.shard }})')
      .map((candidate) => [candidate.name, candidate.matrixValues.shard, candidate.strategy.maxParallel]),
    [
      ['smoke-play shard (scriptable)', 'scriptable', 2],
      ['smoke-play shard (broad-core)', 'broad-core', 2],
      ['smoke-play shard (template)', 'template', 2],
      ['smoke-play shard (broad-play)', 'broad-play', 2],
      ['smoke-play shard (broad-assets)', 'broad-assets', 2],
      ['smoke-play shard (vfx)', 'vfx', 2],
      ['smoke-play shard (editor)', 'editor', 2],
      ['smoke-play shard (create)', 'create', 2],
      ['smoke-play shard (repro)', 'repro', 2],
    ],
  );

  const reordered = admitWorkflowTopology(graph, {
    requiredContexts: extractRequiredContexts(ruleset),
    observedJobNames: [...names].reverse(),
    expandMatrix: true,
    workflowFile: '.github/workflows/ci.yml',
  });
  assert.equal(reordered.graphDigest, admission.graphDigest);
  assert.equal(reordered.topologyId, admission.topologyId);
});

test('capacity admission signs per-job phases, runner identity, cap occupancy, artifacts, and no-SLO wall facts', () => {
  const result = deriveCapacityTimeline({
    run: fixtureRun(),
    jobs: fixtureJobs(),
    artifacts: [
      {
        id: 501,
        name: 'forgeax-prerequisite-release-42-1',
        digest: 'sha256:prerequisite',
        created_at: '2026-08-20T00:00:19Z',
        workflow_run: {id: 42, run_attempt: 1},
      },
      {
        id: 502,
        name: 'forgeax-smoke-play-42-1',
        digest: 'sha256:smoke',
        created_at: '2026-08-20T00:01:01Z',
        workflow_run: {id: 42, run_attempt: 1},
      },
    ],
    topology: topologyFixture().topology,
    sourceSha: SOURCE_SHA,
    workflow: {file: 'ci.yml', name: 'Capacity fixture'},
    ruleset: {id: 7, digest: 'sha256:ruleset'},
  });

  assert.equal(result.status, 'admitted');
  assert.equal(result.admissible, true);
  assert.match(result.signature.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(result.phases, CAPACITY_PHASES);
  assert.equal(result.occupancy.maxHeavyConcurrency, 2);
  assert.deepEqual(result.jobs.find((candidate) => candidate.name === 'smoke-play shard (c)').runner, {
    id: 1004,
    name: 'heavy-runner-4',
    groupId: null,
    labels: ['Linux', 'X64', 'heavy', 'self-hosted'],
    pool: 'heavy',
  });
  const throttled = result.jobs.find((candidate) => candidate.name === 'smoke-play shard (c)').intervals
    .find((interval) => interval.kind === 'matrix-throttle');
  assert.equal(throttled.status, 'observed');
  assert.equal(throttled.classification, 'matrix-cap-saturated-upper-bound');
  assert.equal(throttled.runnerContentionUnseparated, true);
  assert.equal(result.artifactReady.length, 2);
  assert.equal(result.firstFailure.status, 'none');
  assert.equal(result.wallClock.createdToTerminalSeconds, 62);
  assert.match(result.wallClock.note, /not an SLO/);
  assert.equal(result.jobs.find((candidate) => candidate.name === 'smoke-play').intervals.some((interval) => interval.kind === 'aggregate'), true);
});

test('capacity admission preserves a mixed attempt as signed no-claim evidence', () => {
  const run = fixtureRun();
  run.run_started_at = '2026-08-20T00:00:30Z';
  const result = deriveCapacityTimeline({
    run,
    jobs: fixtureJobs(),
    topology: topologyFixture().topology,
    sourceSha: SOURCE_SHA,
  });

  assert.equal(result.status, 'no-claim');
  assert.equal(result.admissible, false);
  assert.match(result.signature.digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(result.noClaim.some((claim) => claim.code === 'job-before-attempt-start'));
  assert.equal(result.wallClock.createdToTerminalSeconds, 62);
  assert.match(result.wallClock.note, /not an SLO/);
});

test('baseline collector admission drops skipped conditional jobs but retains their raw page separately', () => {
  const fixture = topologyFixture();
  const result = collectCapacityAdmission({
    run: fixtureRun(),
    jobsPages: [{
      total_count: 6,
      jobs: [
        ...fixtureJobs(),
        {id: 99, name: 'disabled portability', status: 'completed', conclusion: 'skipped', run_id: 42, run_attempt: 1},
      ],
    }],
    artifactPages: [],
    graph: fixture.graph,
    requiredContexts: fixture.requiredContexts,
    workflowFile: 'ci.yml',
    workflowName: 'Capacity fixture',
    sourceSha: SOURCE_SHA,
    sourceFiles: [],
    ruleset: {id: 7},
  });

  assert.equal(result.status, 'admitted');
  assert.equal(result.jobs.length, 5);
  assert.equal(result.jobs.some((candidate) => candidate.name === 'disabled portability'), false);
});

test('capacity admission rejects artifact identity drift instead of folding another attempt', () => {
  const result = deriveCapacityTimeline({
    run: fixtureRun(),
    jobs: fixtureJobs(),
    artifacts: [{
      id: 999,
      name: 'forgeax-prerequisite-release-other-attempt',
      created_at: '2026-08-20T00:00:19Z',
      workflow_run: {id: 41, run_attempt: 1},
    }],
    topology: topologyFixture().topology,
    sourceSha: SOURCE_SHA,
  });

  assert.equal(result.status, 'no-claim');
  assert.equal(result.artifacts.length, 0);
  assert.ok(result.noClaim.some((claim) => claim.code === 'artifact-attempt-identity-mismatch'));
});
