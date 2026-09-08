import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  BaselineContractError,
  admitWorkflowTopology,
  assertSameAttemptProvenance,
  assertStableRoster,
  buildWorkflowGraph,
  createAttemptProvenance,
  deriveCriticalPath,
  deriveTimings,
  extractRequiredContexts,
  normalizeAttemptJobPacket,
  normalizeAttemptPacket,
  toStructuredError,
  validateAttemptProvenance,
  validateWorkflowGraph,
  successfulExactStableRosterPopulation,
  validateBudgetClaim,
} from '../ci-baseline.mjs';
import * as baselineOwner from '../ci-baseline.mjs';
import {collectRunAttempt, deriveAttemptEvidence, projectBaselineEvidence} from '../collect-ci-baseline.mjs';

const deriveCostFacts = (...args) => baselineOwner.deriveCostFacts(...args);
const deriveReadiness = (...args) => baselineOwner.deriveReadiness(...args);
import {
  ENGINE_TECHNIQUE_MIGRATION,
  validateEngineTechniqueMigration,
} from '../engine-technique-migration.mjs';

const topologyFixture = JSON.parse(
  readFileSync(resolve('scripts/ci/fixtures/ci-baseline-topology-cases.json'), 'utf8'),
);
const provenanceFixture = JSON.parse(
  readFileSync(resolve('scripts/ci/fixtures/ci-baseline-provenance-cases.json'), 'utf8'),
);
const errorFixture = JSON.parse(
  readFileSync(resolve('scripts/ci/fixtures/ci-baseline-error-cases.json'), 'utf8'),
);
const packetFixture = JSON.parse(
  readFileSync(resolve('scripts/ci/fixtures/ci-baseline-packet-cases.json'), 'utf8'),
);
const timingFixture = JSON.parse(
  readFileSync(resolve('scripts/ci/fixtures/ci-baseline-timing-cases.json'), 'utf8'),
);
const artifactCacheFixture = JSON.parse(
  readFileSync(resolve('scripts/ci/fixtures/ci-baseline-artifact-cache-cases.json'), 'utf8'),
);
const readinessFixture = JSON.parse(
  readFileSync(resolve('scripts/ci/fixtures/ci-baseline-readiness-cases.json'), 'utf8'),
);
const budgetFixture = JSON.parse(
  readFileSync(resolve('scripts/ci/fixtures/ci-baseline-budget-cases.json'), 'utf8'),
);

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

function structuredError(fn) {
  try {
    fn();
  } catch (error) {
    return toStructuredError(error);
  }
  assert.fail('expected a structured contract error');
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

function budgetSamples(caseFixture, count = caseFixture.sampleIds.length) {
  return caseFixture.sampleIds.slice(0, count).map((sampleId, index) => ({
    ...structuredClone(caseFixture.sampleTemplate),
    runId: 1000 + index,
    runAttempt: 1,
    run: {
      ...structuredClone(caseFixture.sampleTemplate.run),
      id: 1000 + index,
    },
    attemptProvenance: {
      ...structuredClone(caseFixture.sampleTemplate.attemptProvenance),
      runId: 1000 + index,
      runAttempt: 1,
    },
    sampleId,
    facts: {timing: {activeSeconds: 30 + index}, cache: {status: 'unknown'}},
  }));
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
    'smoke-play-shard',
    'smoke-play',
    'editor-portability',
    'editor-portability-aggregate',
  ]);
  assert.deepEqual(
    Object.fromEntries(jobs.map((job) => [job.id, job.runner.pool ?? job.runner.kind])),
    {
      'prerequisite-release': 'standard',
      'docs-policy': 'standard',
      'submodule-pin': 'standard',
      'b2-self-boot': 'standard',
      typecheck: 'standard',
      'smoke-play-shard': 'heavy',
      'smoke-play': 'heavy',
      'editor-portability': 'github-hosted',
      'editor-portability-aggregate': 'github-hosted',
    },
  );
  assert.equal(jobs.find((job) => job.id === 'smoke-play').timeoutMinutes, 20);
  assert.deepEqual(graph.requiredContexts.map((context) => context.jobId), [
    'b2-self-boot',
    'typecheck',
    'submodule-pin',
    'smoke-play',
  ]);
  assert.deepEqual(
    graph.needsEdges.filter((edge) => edge.to === 'submodule-pin').map((edge) => edge.from),
    ['docs-policy', 'b2-self-boot', 'typecheck', 'smoke-play'],
  );
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

test('accepted topology keeps required contexts separate from the complete needs graph', () => {
  const fixture = topologyFixture.cases.find((candidate) => candidate.name === 'accepted topology');
  const result = admitWorkflowTopology(fixture.graph, {
    requiredContexts: fixture.requiredContexts,
    observedJobNames: fixture.observedJobNames,
  });

  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.acceptedJobNames, ['prepare', 'build', 'smoke']);
  assert.deepEqual(result.needsEdges, [
    { workflow: 'ci.yml', from: 'prepare', to: 'build' },
    { workflow: 'ci.yml', from: 'build', to: 'smoke' },
  ]);
  assert.deepEqual(result.requiredContexts.contexts, ['smoke']);
  assert.notDeepEqual(result.requiredContexts.contexts, result.acceptedJobNames);
  assert.deepEqual(result.inventory.map((job) => job.id), ['disabled']);
});

test('current workflow admission accepts always guards and inventories disabled portability jobs', () => {
  const workflowText = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  const ruleset = JSON.parse(readFileSync(resolve('scripts/ci/fixtures/ruleset.json'), 'utf8'));
  const requiredContexts = extractRequiredContexts(ruleset);
  const graph = buildWorkflowGraph([{file: '.github/workflows/ci.yml', text: workflowText}], requiredContexts);
  const admission = admitWorkflowTopology(graph, {
    requiredContexts,
    observedJobNames: [
      'prerequisite-release',
      'docs-policy',
      'submodule-pin',
      'b2-self-boot',
      'typecheck',
      'smoke-play shard (${{ matrix.shard }})',
      'smoke-play',
    ],
  });

  assert.equal(admission.status, 'accepted');
  assert.deepEqual(admission.acceptedJobNames, [
    'prerequisite-release',
    'docs-policy',
    'submodule-pin',
    'b2-self-boot',
    'typecheck',
    'smoke-play shard (${{ matrix.shard }})',
    'smoke-play',
  ]);
  assert.deepEqual(admission.inventory.map((job) => job.name), [
    'editor-portability (${{ matrix.platform }})',
    'editor-portability aggregate',
  ]);
});

test('topology admission fails closed for missing targets, cycles, and unadmitted jobs', () => {
  for (const fixture of topologyFixture.cases.filter((candidate) => candidate.expectedCode)) {
    assert.equal(
      errorCode(() => admitWorkflowTopology(fixture.graph, {
        requiredContexts: fixture.requiredContexts,
        observedJobNames: fixture.observedJobNames,
      })),
      fixture.expectedCode,
      fixture.name,
    );
  }
});

test('critical path uses accepted needs edges, includes member timing, and fails closed when timing is missing', () => {
  const fixture = topologyFixture.cases.find((candidate) => candidate.name === 'accepted topology');
  const topology = admitWorkflowTopology(fixture.graph, {
    requiredContexts: fixture.requiredContexts,
    observedJobNames: fixture.observedJobNames,
  });
  const path = deriveCriticalPath(topology, { jobTimings: fixture.jobTimings });

  assert.equal(path.status, 'observed');
  assert.deepEqual(path.members, fixture.expectedPath);
  assert.deepEqual(path.edges, [
    { workflow: 'ci.yml', from: 'prepare', to: 'build' },
    { workflow: 'ci.yml', from: 'build', to: 'smoke' },
  ]);
  assert.deepEqual(path.timing, [
    { name: 'prepare', activeSeconds: 10 },
    { name: 'build', activeSeconds: 20 },
    { name: 'smoke', activeSeconds: 30 },
  ]);
  assert.equal(path.totalSeconds, 60);
  assert.deepEqual(path.requiredContexts, topology.requiredContexts);

  const missing = deriveCriticalPath(topology, { jobTimings: { prepare: { activeSeconds: 10 } } });
  assert.equal(missing.status, 'no-claim');
  assert.equal(missing.noClaim.code, 'critical-path-timing-missing');
  assert.equal(missing.totalSeconds, null);
});

test('reviewer critical-path falsifier does not turn an empty or unadmitted topology into zero seconds', () => {
  for (const topology of [
    {status: 'no-claim', acceptedJobNames: [], needsEdges: [], requiredContexts: []},
    {status: 'accepted', acceptedJobNames: [], needsEdges: [], requiredContexts: []},
  ]) {
    const result = deriveCriticalPath(topology, {jobTimings: {}});
    assert.equal(result.status, 'no-claim');
    assert.equal(result.totalSeconds, null);
    assert.notEqual(result.totalSeconds, 0);
  }
});

test('invalid critical-path timing returns a complete no-claim envelope and keeps attempt provenance', () => {
  const fixture = packetFixture.cases.find((candidate) => candidate.name === 'complete attempt packet');
  const sample = normalizeAttemptPacket(fixture.packet, {expectedJobNames: fixture.expectedJobNames});
  for (const criticalPath of [
    {status: 'observed', members: ['build'], timing: [{name: 'build', activeSeconds: 10}], totalSeconds: -1},
    {status: 'observed', members: ['build'], timing: [{name: 'build', activeSeconds: 10}], totalSeconds: Number.NaN},
    {status: 'observed', members: [], timing: [], totalSeconds: 0},
  ]) {
    const facts = deriveCostFacts({...sample, attemptProvenance: sample.attemptProvenance}, {criticalPath, requiredContexts: []});
    const noClaim = facts.acceptedPathTiming.noClaim;
    assert.equal(noClaim.code, 'critical-path-timing-invalid');
    for (const field of ['code', 'expected', 'observed', 'hint', 'affectedProvenance']) assert.ok(Object.hasOwn(noClaim, field), field);
    assert.deepEqual(noClaim.affectedProvenance, sample.attemptProvenance);
    assert.deepEqual(facts.acceptedPathTiming.attemptProvenance, sample.attemptProvenance);
  }
});

test('attempt provenance is complete and shared by every derived block', () => {
  const fixture = provenanceFixture.cases.find((candidate) => candidate.name === 'complete envelope');
  const provenance = createAttemptProvenance(fixture.provenance);
  assert.deepEqual(provenance, fixture.provenance);
  assert.deepEqual(validateAttemptProvenance(provenance), fixture.provenance);

  const graph = { attemptProvenance: provenance };
  const path = { attemptProvenance: provenance };
  const facts = { attemptProvenance: provenance };
  assert.deepEqual(assertSameAttemptProvenance([graph, path, facts]), provenance);
});

test('attempt provenance rejects incomplete and mixed identity inputs without retry folding', () => {
  for (const fixture of provenanceFixture.cases.filter((candidate) => candidate.expectedCode)) {
    const values = fixture.provenances ?? [fixture.provenance];
    assert.equal(
      errorCode(() => {
        const provenances = values.map((value) => {
          const candidate = structuredClone(value);
          if (fixture.remove) delete candidate[fixture.remove];
          return createAttemptProvenance(candidate);
        });
        assertSameAttemptProvenance(provenances);
      }),
      fixture.expectedCode,
      fixture.name,
    );
  }
});

test('representative baseline failures use the stable structured error envelope', () => {
  for (const fixture of errorFixture.cases) {
    const error = structuredError(() => {
      if (fixture.operation === 'missing-needs') {
        admitWorkflowTopology(fixture.graph, { requiredContexts: [], observedJobNames: ['build'] });
      } else if (fixture.operation === 'cycle') {
        admitWorkflowTopology(fixture.graph, { requiredContexts: [], observedJobNames: ['a', 'b'] });
      } else if (fixture.operation === 'unadmitted-topology') {
        admitWorkflowTopology(fixture.graph, { requiredContexts: [], observedJobNames: ['conditional'] });
      } else {
        assertSameAttemptProvenance(fixture.provenances);
      }
    });
    assert.equal(error.code, fixture.expectedCode, fixture.name);
    for (const field of ['code', 'expected', 'observed', 'hint', 'affectedProvenance']) {
      assert.ok(Object.hasOwn(error, field), `${fixture.name} is missing ${field}`);
    }
    assert.equal(typeof error.code, 'string');
    assert.equal(typeof error.hint, 'string');
    assert.notEqual(error.hint.length, 0);
    assert.equal(Object.hasOwn(error, 'providerBilling'), false);
  }
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

test('reviewer packet falsifier rejects a roster provenance mismatch and keeps all raw page layers', () => {
  const fixture = packetFixture.cases.find((candidate) => candidate.name === 'complete attempt packet');
  const packet = structuredClone(fixture.packet);
  packet.attemptProvenance.rosterKey = 'wrong-roster';
  assert.equal(
    errorCode(() => normalizeAttemptPacket(packet, {expectedJobNames: fixture.expectedJobNames})),
    'packet-roster-mismatch',
  );
});

test('attempt packet keeps complete pages and runner identity inside one retry packet', () => {
  const fixture = packetFixture.cases.find((candidate) => candidate.name === 'complete attempt packet');
  const packet = normalizeAttemptPacket(fixture.packet, { expectedJobNames: fixture.expectedJobNames });

  assert.equal(packet.attemptProvenance.runId, 42);
  assert.equal(packet.attemptProvenance.runAttempt, 2);
  assert.equal(packet.rawPages.jobs.length, 2);
  assert.equal(packet.jobs.length, 2);
  assert.deepEqual(packet.runnerRoster, fixture.expectedRunnerRoster);
  assert.equal(packet.source.workflowFiles[0].sha256, fixture.packet.workflowFiles[0].sha256);
  assert.equal(packet.source.ruleset.sha256, fixture.packet.ruleset.sha256);
});

test('attempt packet fails closed for incomplete pages, zero jobs, identity mismatches, and missing source metadata', () => {
  for (const fixture of packetFixture.cases.filter((candidate) => candidate.expectedCode)) {
    assert.equal(
      errorCode(() => normalizeAttemptPacket(fixture.packet, { expectedJobNames: fixture.expectedJobNames })),
      fixture.expectedCode,
      fixture.name,
    );
  }
});

test('retry attempts remain independent packets and are never folded by workflow or artifact name', () => {
  const retries = packetFixture.cases.filter((candidate) => candidate.name.startsWith('retry packet'));
  const packets = retries.map((fixture) => normalizeAttemptPacket(fixture.packet, {
    expectedJobNames: fixture.expectedJobNames,
  }));

  assert.deepEqual(packets.map((packet) => [packet.attemptProvenance.runId, packet.attemptProvenance.runAttempt]), [
    [42, 1],
    [42, 2],
  ]);
  assert.notEqual(packets[0].attemptProvenance.runAttempt, packets[1].attemptProvenance.runAttempt);
  assert.equal(packets[0].artifacts[0].id, packets[1].artifacts[0].id);
});

test('cost facts keep accepted critical path timing separate from required context timing', () => {
  const fixture = timingFixture.cases.find((candidate) => candidate.name === 'complete timing facts');
  const facts = deriveCostFacts(fixture.packet, {
    criticalPath: fixture.criticalPath,
    requiredContexts: fixture.requiredContexts,
  });

  assert.equal(facts.timing.admissionSeconds, 10);
  assert.equal(facts.timing.queueSeconds, 5);
  assert.equal(facts.timing.activeSeconds, 40);
  assert.equal(facts.timing.wallClockSeconds, 40);
  assert.deepEqual(
    Object.fromEntries(['status', 'members', 'totalSeconds'].map((key) => [key, facts.acceptedPathTiming[key]])),
    fixture.expectedAcceptedPathTiming,
  );
  assert.deepEqual(
    Object.fromEntries(['status', 'members', 'totalSeconds'].map((key) => [key, facts.requiredContextTiming[key]])),
    fixture.expectedRequiredContextTiming,
  );
  assert.notDeepEqual(facts.acceptedPathTiming.members, facts.requiredContextTiming.members);
  assert.equal(facts.attemptProvenance.runAttempt, 2);
});

test('cost facts keep missing, negative, and invalid observations unknown without a zero claim', () => {
  for (const fixture of timingFixture.cases.filter((candidate) => candidate.expectedStatus)) {
    const facts = deriveCostFacts(fixture.packet, {
      criticalPath: fixture.criticalPath,
      requiredContexts: fixture.requiredContexts,
    });

    assert.equal(facts.timing.status, fixture.expectedStatus, fixture.name);
    assert.equal(facts.timing.wallClockSeconds, null, fixture.name);
    assert.equal(facts.timing.noClaim.code, fixture.expectedCode, fixture.name);
    assert.notEqual(facts.timing.wallClockSeconds, 0, fixture.name);
  }
});

test('cost facts preserve archive bytes, expanded bytes, and cache state as separate observations', () => {
  const fixture = artifactCacheFixture.cases.find((candidate) => candidate.name === 'archive and expanded observations');
  const facts = deriveCostFacts(fixture.packet, { criticalPath: null, requiredContexts: [] });

  assert.deepEqual(
    Object.fromEntries(['status', 'identity', 'archiveBytes', 'expandedInputBytes', 'expandedOutputBytes'].map((key) => [key, facts.artifact[key]])),
    fixture.expectedArtifact,
  );
  assert.deepEqual(
    Object.fromEntries(['status', 'key'].map((key) => [key, facts.cache[key]]).filter(([, value]) => value !== undefined)),
    fixture.expectedCache,
  );
  assert.equal(Object.hasOwn(facts, 'savings'), false);
  assert.equal(Object.hasOwn(facts, 'currency'), false);
  assert.equal(Object.hasOwn(facts, 'providerBilling'), false);
  assert.notEqual(facts.artifact.archiveBytes, facts.artifact.expandedInputBytes);
});

test('cost facts keep artifact and cache gaps unknown instead of inventing bytes or savings', () => {
  for (const fixture of artifactCacheFixture.cases.filter((candidate) => candidate.expectedArtifactStatus)) {
    const facts = deriveCostFacts(fixture.packet, { criticalPath: null, requiredContexts: [] });

    assert.equal(facts.artifact.status, fixture.expectedArtifactStatus, fixture.name);
    if (fixture.expectedArtifactStatus === 'unknown') {
      assert.equal(facts.artifact.archiveBytes, null, fixture.name);
    } else {
      assert.equal(facts.artifact.archiveBytes, 1200, fixture.name);
      assert.equal(facts.artifact.expandedInputBytes, null, fixture.name);
      assert.equal(facts.artifact.expandedOutputBytes, null, fixture.name);
    }
    assert.equal(facts.cache.status, fixture.expectedCacheStatus, fixture.name);
    assert.equal(Object.hasOwn(facts, 'savings'), false, fixture.name);
    assert.equal(Object.hasOwn(facts, 'currency'), false, fixture.name);
    assert.equal(Object.hasOwn(facts, 'providerBilling'), false, fixture.name);
  }
});

test('readiness joins producer and consumer observations by full identity and preserves each consumer', () => {
  const fixture = readinessFixture.cases.find((candidate) => candidate.name === 'same attempt with multiple consumers');
  const result = deriveReadiness(fixture.packet, fixture.observations);

  assert.equal(result.status, 'observed');
  assert.equal(result.observations.length, 2);
  assert.deepEqual(result.observations.map((observation) => observation.consumer.identity), [
    'consumer-a',
    'consumer-b',
  ]);
  assert.deepEqual(result.observations.map((observation) => observation.delaySeconds), [5, 12]);
  assert.equal(result.attemptProvenance.runAttempt, 2);
});

test('readiness returns structured no-claim for missing, reversed, mismatched, and same-name identities', () => {
  for (const fixture of readinessFixture.cases.filter((candidate) => candidate.expectedCode)) {
    const result = deriveReadiness(fixture.packet, fixture.observations);

    assert.equal(result.status, 'no-claim', fixture.name);
    assert.equal(result.noClaim.code, fixture.expectedCode, fixture.name);
    assert.ok(Array.isArray(result.observations), fixture.name);
    assert.equal(result.delaySeconds, null, fixture.name);
  }
});

test('reviewer readiness falsifier rejects empty consumer identity and missing observation kind', () => {
  const fixture = readinessFixture.cases.find((candidate) => candidate.name === 'same attempt with multiple consumers');
  const observations = structuredClone(fixture.observations);
  observations.consumers[0].consumerIdentity = '';
  delete observations.consumers[0].observationKind;
  const result = deriveReadiness(fixture.packet, observations);
  assert.equal(result.status, 'no-claim');
  assert.equal(result.noClaim.code, 'readiness-observation-invalid');
});

test('collector pipeline preserves derived facts and emits no-claim without external packets', () => {
  const fixture = packetFixture.cases.find((candidate) => candidate.name === 'complete attempt packet');
  const sample = normalizeAttemptPacket(fixture.packet, {expectedJobNames: fixture.expectedJobNames});
  sample.timing = deriveTimings(sample);
  const topology = {
    status: 'accepted',
    topologyId: sample.attemptProvenance.topologyId,
    graphDigest: sample.attemptProvenance.graphDigest,
    rosterKey: sample.attemptProvenance.rosterKey,
    workflow: sample.attemptProvenance.workflow,
    acceptedJobNames: ['build', 'smoke'],
    needsEdges: [{workflow: 'ci.yml', from: 'build', to: 'smoke'}],
    requiredContexts: {status: 'observed', contexts: ['smoke'], records: [{context: 'smoke', jobName: 'smoke'}]},
  };
  const evidence = deriveAttemptEvidence(sample, {topology, requiredContexts: [{context: 'smoke', jobName: 'smoke'}]});
  assert.equal(evidence.criticalPath.status, 'observed');
  assert.equal(evidence.costFacts.attemptProvenance.runAttempt, 2);
  assert.equal(evidence.readiness.status, 'no-claim');

  const baseline = projectBaselineEvidence({
    baselineCommit: sample.attemptProvenance.sourceSha,
    collectorCommit: 'collector',
    repo: 'ForgeaX-Games/forgeax-editor',
    workflow: 'ci.yml',
    source: {sourceSha: sample.attemptProvenance.sourceSha},
    liveRuleset: {id: 7},
    acceptedTopology: topology,
    samples: [sample],
    evidenceRecords: [evidence],
    packetRecords: [],
    limit: 1,
    runRoster: {},
  });
  assert.equal(baseline.schemaVersion, 'forgeax-ci-baseline/v2');
  assert.equal(baseline.facts.criticalPath.status, 'observed');
  assert.equal(baseline.population.successfulExactStableRosterCount, 0);
  assert.equal(baseline.budgetClaim, null);
  assert.deepEqual(baseline.rawPacket, evidence.rawPacket);
  assert.deepEqual(baseline.attempts[0].rawPacket, evidence.rawPacket);

  const missing = projectBaselineEvidence({
    baselineCommit: sample.attemptProvenance.sourceSha,
    collectorCommit: 'collector',
    repo: 'ForgeaX-Games/forgeax-editor',
    workflow: 'ci.yml',
    source: {sourceSha: sample.attemptProvenance.sourceSha},
    liveRuleset: {id: 7},
    acceptedTopology: topology,
    samples: [],
    evidenceRecords: [],
    packetRecords: [],
    limit: 1,
    runRoster: {},
  });
  assert.equal(missing.attemptProvenance, null);
  assert.equal(missing.noClaim[0].code, 'attempt-packet-missing');
});

test('collector packet rejection projects the same structured no-claim fact', () => {
  const rejection = {
    runId: 123,
    runAttempt: 2,
    status: 'rejected',
    noClaim: {
      code: 'packet-roster-mismatch',
      expected: '[build,smoke]',
      observed: '[build]',
      hint: 'Recollect the complete accepted roster for this attempt.',
      affectedProvenance: {runId: 123, runAttempt: 2, rosterKey: '[build]'},
    },
  };
  const baseline = projectBaselineEvidence({
    baselineCommit: 'a'.repeat(40),
    collectorCommit: 'collector',
    repo: 'ForgeaX-Games/forgeax-editor',
    workflow: 'ci.yml',
    source: {sourceSha: 'a'.repeat(40)},
    liveRuleset: {id: 7},
    acceptedTopology: {topologyId: 'topology', graphDigest: 'sha256:graph', rosterKey: '[build,smoke]', workflow: {file: 'ci.yml', name: 'CI'}},
    samples: [],
    evidenceRecords: [],
    packetRecords: [rejection],
    limit: 1,
    runRoster: {},
  });
  const noClaim = baseline.noClaim.find((claim) => claim.code === rejection.noClaim.code);
  assert.deepEqual(noClaim, rejection.noClaim);
});

test('collector catch projects a jobs API rejection with auditable attempt provenance', () => {
  const run = {id: 123, run_attempt: 2, head_sha: 'a'.repeat(40)};
  const acceptedTopology = {
    topologyId: 'topology',
    graphDigest: 'sha256:graph',
    rosterKey: '[build,smoke]',
    workflow: {file: '.github/workflows/ci.yml', name: 'Editor CI'},
  };
  let rejection;
  assert.throws(() => collectRunAttempt({
    run,
    repo: 'ForgeaX-Games/forgeax-editor',
    acceptedTopology,
    baselineCommit: run.head_sha,
    workflowFile: '.github/workflows/ci.yml',
    admittedWorkflow: acceptedTopology.workflow,
    readPages: () => { throw new Error('gh api returned 503'); },
  }), (error) => {
    rejection = toStructuredError(error);
    return true;
  });

  assert.equal(rejection.code, 'api-read-failed');
  assert.equal(rejection.expected.endpoint, 'repos/ForgeaX-Games/forgeax-editor/actions/runs/123/attempts/2/jobs?per_page=100');
  assert.equal(rejection.observed.runId, run.id);
  assert.equal(rejection.observed.runAttempt, run.run_attempt);
  assert.equal(rejection.affectedProvenance.endpoint, rejection.expected.endpoint);
  assert.deepEqual(rejection.affectedProvenance.run, {id: run.id, attempt: run.run_attempt});
  assert.equal(rejection.affectedProvenance.sourceSha, run.head_sha);
  assert.deepEqual(rejection.affectedProvenance.topology, acceptedTopology);

  const baseline = projectBaselineEvidence({
    baselineCommit: run.head_sha,
    collectorCommit: 'collector',
    repo: 'ForgeaX-Games/forgeax-editor',
    workflow: 'ci.yml',
    source: {sourceSha: run.head_sha},
    liveRuleset: {id: 7},
    acceptedTopology,
    samples: [],
    evidenceRecords: [],
    packetRecords: [{runId: run.id, runAttempt: run.run_attempt, status: 'rejected', noClaim: rejection}],
    limit: 1,
    runRoster: {},
  });
  assert.equal(baseline.noClaim[0].code, 'api-read-failed');
  assert.deepEqual(baseline.noClaim[0], rejection);
});

test('successful exact stable-roster population gates owner-bound budget claims at twenty samples', () => {
  const fixture = budgetFixture.cases.find((candidate) => candidate.name === 'success threshold');
  const nineteen = successfulExactStableRosterPopulation(budgetSamples(fixture, 19), {
    owner: fixture.owner,
    acceptedTopology: fixture.acceptedTopology,
    expectedJobNames: fixture.expectedJobNames,
    successCondition: fixture.successCondition,
  });
  assert.equal(nineteen.successfulExactStableRosterCount, 19);
  assert.equal(nineteen.budgetClaim, null);
  assert.equal(nineteen.noClaim.code, 'budget-population-insufficient');
  assert.equal(nineteen.facts.length, 19);

  const twenty = successfulExactStableRosterPopulation(budgetSamples(fixture), {
    owner: fixture.owner,
    acceptedTopology: fixture.acceptedTopology,
    expectedJobNames: fixture.expectedJobNames,
    successCondition: fixture.successCondition,
  });
  assert.equal(twenty.successfulExactStableRosterCount, 20);
  assert.equal(twenty.budgetClaim.owner, fixture.owner);
  assert.equal(twenty.budgetClaim.sampleCount, 20);
  assert.equal(twenty.budgetClaim.provenance.length, 20);
  assert.equal(twenty.budgetClaim.successCondition, fixture.successCondition.label);
  assert.equal(twenty.budgetClaim.topology.topologyId, fixture.acceptedTopology.topologyId);
  assert.deepEqual(twenty.budgetClaim.topology.rosterKey, fixture.acceptedTopology.rosterKey);
  assert.deepEqual(twenty.facts.map((fact) => fact.sampleId), fixture.sampleIds);
});

test('mixed budget populations preserve facts and return a structured no-claim', () => {
  const fixture = budgetFixture.cases.find((candidate) => candidate.name === 'success threshold');
  const base = budgetSamples(fixture);
  const expectedCodes = Object.fromEntries(
    fixture.mixedPopulationCases.map((candidate) => [candidate.name, candidate.expectedCode]),
  );
  const mutations = [
    {
      name: 'failure mixed',
      mutate(samples) {
        samples[0].run.conclusion = 'failure';
        samples[0].jobs[0].conclusion = 'failure';
      },
    },
    {
      name: 'roster mixed',
      mutate(samples) {
        samples[0].jobs.push({name: 'docs', status: 'completed', conclusion: 'success'});
        samples[0].rosterKey = '[build,docs,smoke]';
        samples[0].attemptProvenance.rosterKey = '[build,docs,smoke]';
      },
    },
    {
      name: 'topology mixed',
      mutate(samples) {
        samples[0].attemptProvenance.topologyId = 'topology-other';
        samples[0].attemptProvenance.graphDigest = 'sha256:graph-other';
      },
    },
    {
      name: 'retry folded',
      mutate(samples) {
        samples[1].runId = samples[0].runId;
        samples[1].run.id = samples[0].run.id;
        samples[1].attemptProvenance.runId = samples[0].attemptProvenance.runId;
      },
    },
    {
      name: 'source mixed',
      mutate(samples) {
        samples[0].run.headSha = 'b'.repeat(64);
        samples[0].attemptProvenance.sourceSha = 'b'.repeat(64);
      },
    },
  ];

  for (const mutation of mutations) {
    const samples = structuredClone(base);
    mutation.mutate(samples);
    const result = successfulExactStableRosterPopulation(samples, {
      owner: fixture.owner,
      acceptedTopology: fixture.acceptedTopology,
      expectedJobNames: fixture.expectedJobNames,
      expectedSourceSha: fixture.sampleTemplate.attemptProvenance.sourceSha,
      successCondition: fixture.successCondition,
    });
    assert.equal(result.budgetClaim, null, mutation.name);
    assert.equal(result.noClaim.code, expectedCodes[mutation.name], mutation.name);
    assert.equal(result.facts.length, 20, mutation.name);
    assert.equal(result.facts[0].sampleId, samples[0].sampleId, mutation.name);
    for (const field of ['code', 'expected', 'observed', 'hint', 'affectedProvenance']) {
      assert.ok(Object.hasOwn(result.noClaim, field), `${mutation.name} missing ${field}`);
    }
  }
});

test('budget claims are auditable by owner, count, condition, topology, and provenance', () => {
  const fixture = budgetFixture.cases.find((candidate) => candidate.name === 'success threshold');
  const samples = budgetSamples(fixture);
  const population = successfulExactStableRosterPopulation(samples, {
    owner: fixture.owner,
    acceptedTopology: fixture.acceptedTopology,
    expectedJobNames: fixture.expectedJobNames,
    expectedSourceSha: fixture.sampleTemplate.attemptProvenance.sourceSha,
    successCondition: fixture.successCondition,
  });
  const options = {
    owner: fixture.owner,
    acceptedTopology: fixture.acceptedTopology,
    successCondition: fixture.successCondition,
    provenanceSet: samples.map((sample) => sample.attemptProvenance),
  };
  const valid = validateBudgetClaim(population.budgetClaim, options);
  assert.equal(valid.ok, true);
  assert.equal(valid.claim.sampleCount, 20);

  for (const field of ['owner', 'sampleCount', 'successCondition', 'topology', 'provenance']) {
    const candidate = structuredClone(population.budgetClaim);
    delete candidate[field];
    const result = validateBudgetClaim(candidate, options);
    assert.equal(result.ok, false, `deleting ${field} must fail validation`);
    assert.equal(typeof result.error.code, 'string', `deleting ${field} needs a stable code`);
    assert.notEqual(result.error.expected, undefined, `deleting ${field} needs expected`);
    assert.notEqual(result.error.observed, undefined, `deleting ${field} needs observed`);
    assert.equal(typeof result.error.hint, 'string', `deleting ${field} needs hint`);
  }

  const untraceable = structuredClone(population.budgetClaim);
  untraceable.provenance[0].runId = 9999;
  const provenanceResult = validateBudgetClaim(untraceable, options);
  assert.equal(provenanceResult.ok, false);
  assert.equal(provenanceResult.error.code, 'budget-claim-provenance-mismatch');
});

test('baseline no-claim results expose one executable error envelope', () => {
  const assertEnvelope = (result, expectedCode, actionPattern, name) => {
    assert.ok(result.status === 'no-claim' || result.status === 'unknown', name);
    const noClaim = result.noClaim ?? result;
    assert.equal(noClaim.code, expectedCode, name);
    for (const field of ['code', 'expected', 'observed', 'hint', 'affectedProvenance']) {
      assert.ok(Object.hasOwn(noClaim, field), `${name} missing ${field}`);
    }
    assert.match(noClaim.hint, actionPattern, name);
    assert.ok(result.budgetClaim === null || result.budgetClaim === undefined, `${name} must not expose a budget claim`);
  };

  for (const fixture of readinessFixture.cases.filter((candidate) => candidate.expectedCode)) {
    const expected = errorFixture.m3Cases.find((candidate) => candidate.name === fixture.name);
    assertEnvelope(
      deriveReadiness(fixture.packet, fixture.observations),
      fixture.expectedCode,
      new RegExp(expected.hintPattern),
      fixture.name,
    );
  }

  const artifactFixture = artifactCacheFixture.cases.find((candidate) => candidate.name === 'artifact identity missing');
  const artifactFacts = deriveCostFacts(artifactFixture.packet, {criticalPath: null, requiredContexts: []});
  assertEnvelope(
    artifactFacts.artifact,
    'artifact-observation-unknown',
    /collect|observe/i,
    'artifact identity missing',
  );
  assert.equal(artifactFacts.artifact.archiveBytes, null);

  const cacheFacts = deriveCostFacts(artifactFixture.packet, {criticalPath: null, requiredContexts: []});
  assertEnvelope(cacheFacts.cache, 'cache-observation-unknown', /collect|observe/i, 'cache unknown');
  assert.equal(cacheFacts.cache.status, 'unknown');

  const budget = budgetFixture.cases.find((candidate) => candidate.name === 'success threshold');
  const population = successfulExactStableRosterPopulation(budgetSamples(budget, 19), {
    owner: budget.owner,
    acceptedTopology: budget.acceptedTopology,
    expectedJobNames: budget.expectedJobNames,
    expectedSourceSha: budget.sampleTemplate.attemptProvenance.sourceSha,
    successCondition: budget.successCondition,
  });
  assertEnvelope(population, 'budget-population-insufficient', /20|sample/i, 'population insufficient');
});

test('baseline budget projection keeps OOS facts and local report fields out of claims', () => {
  const fixture = budgetFixture.cases.find((candidate) => candidate.name === 'success threshold');
  const samples = budgetSamples(fixture);
  samples[0].facts.providerBilling = {amount: 12, currency: 'USD'};
  samples[0].facts.cacheSavings = 99;
  samples[0].facts.artifactName = 'editor-build';
  samples[0].facts.sloClaim = {status: 'pass'};
  const result = successfulExactStableRosterPopulation(samples, {
    owner: fixture.owner,
    acceptedTopology: fixture.acceptedTopology,
    expectedJobNames: fixture.expectedJobNames,
    expectedSourceSha: fixture.sampleTemplate.attemptProvenance.sourceSha,
    successCondition: fixture.successCondition,
  });

  assert.equal(result.budgetClaim.owner, fixture.owner);
  for (const field of ['providerBilling', 'currency', 'cacheSavings', 'savings', 'artifactName', 'sloClaim']) {
    assert.equal(Object.hasOwn(result.budgetClaim, field), false, `budget claim must omit ${field}`);
  }
  assert.deepEqual(result.facts[0].facts.providerBilling, {amount: 12, currency: 'USD'});
  assert.equal(result.facts[0].facts.cacheSavings, 99);
  assert.deepEqual(result.facts[0].facts.sloClaim, {status: 'pass'});

  const readinessCase = readinessFixture.cases.find((candidate) => candidate.name === 'same artifact name with different identity');
  const readiness = deriveReadiness(readinessCase.packet, readinessCase.observations);
  assert.equal(readiness.status, 'no-claim');
  assert.equal(readiness.noClaim.code, readinessCase.expectedCode);
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
