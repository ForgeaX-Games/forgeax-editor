import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { validateWorkflowBinding } from '../editor-ci-workflow-binding.mjs';

const contract = JSON.parse(readFileSync(resolve('scripts/ci/editor-ci-contract.json'), 'utf8'));
const fixture = JSON.parse(
  readFileSync(resolve('scripts/ci/fixtures/editor-ci-workflow-binding.json'), 'utf8'),
);

function graphFor(name) {
  const graph = structuredClone(fixture.graph);
  const operation = fixture.mutations[name];
  if (operation === 'missing-binding') graph.requiredContexts = graph.requiredContexts.slice(1);
  if (operation === 'one-to-many') {
    graph.workflows[0].jobs.push(structuredClone(graph.workflows[0].jobs[0]));
    graph.requiredContexts[0].matches.push({ workflow: 'ci.yml', jobId: 'b2-self-boot-copy', jobName: 'b2-self-boot' });
  }
  if (operation === 'zero-job') graph.workflows = [{ file: 'ci.yml', jobs: [] }];
  if (operation === 'doc-only') graph.docOnlyEvidence = false;
  if (operation === 'context-drift') graph.requiredContexts[1].context = 'typecheck-renamed';
  if (operation === 'runner-capacity') graph.workflows[0].jobs[0].runner.pool = 'heavy';
  return graph;
}

function producerGraph() {
  const graph = structuredClone(fixture.graph);
  const workflow = graph.workflows[0];
  workflow.jobs.unshift({
    id: 'prerequisite-release',
    name: 'prerequisite-release',
    needs: [],
    condition: null,
    runner: { kind: 'self-hosted', pool: 'standard' },
  });
  for (const job of workflow.jobs) {
    if (['b2-self-boot', 'typecheck', 'smoke-play'].includes(job.id)) {
      job.needs = ['prerequisite-release'];
      job.condition = 'always()';
    }
  }
  return graph;
}

function producerContractMutation(name) {
  const mutated = structuredClone(contract);
  const graph = producerGraph();
  const jobs = graph.workflows[0].jobs;
  const producer = jobs.find((job) => job.id === 'prerequisite-release');
  const b2 = jobs.find((job) => job.id === 'b2-self-boot');

  if (name === 'missing-producer-dependency') b2.needs = [];
  if (name === 'needs-if-mismatch') b2.condition = null;
  if (name === 'required-context-added') {
    mutated.requiredContexts.push({ context: 'prerequisite-release', checkId: 'prerequisite-release' });
  }
  if (name === 'profile-payload-drift') {
    mutated.prerequisiteRelease.activeProfiles.PR = ['b2-self-boot', 'typecheck', 'submodule-pin'];
  }
  if (name === 'producer-runner-capacity') producer.runner.pool = 'heavy';
  return { mutated, graph };
}

test('baseline workflow graph binds every contract identity exactly once', () => {
  const result = validateWorkflowBinding(contract, fixture.graph);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.bindings.map((binding) => binding.context),
    ['b2-self-boot', 'typecheck', 'submodule-pin', 'smoke-play'],
  );
});

test('portfolio fixture keeps measurement outside the four required contexts', () => {
  const expected = fixture.portfolioAssertions;
  assert.equal(contract.browserReleasePortfolio?.requiredContextsRef, expected.requiredContextsRef);
  assert.deepEqual(contract.requiredContexts.map((entry) => entry.context), expected.requiredContexts);
  assert.equal(contract.browserReleasePortfolio?.parentCheckId, expected.parentCheckId);
  assert.equal(contract.browserReleasePortfolio?.measurement?.required, expected.measurementRequired);
});

test('supporting producer binds every requesting consumer without entering required contexts', () => {
  const result = validateWorkflowBinding(contract, producerGraph(), { profile: 'PR' });
  assert.equal(result.ok, true);
  assert.equal(result.producerBinding.jobId, 'prerequisite-release');
  assert.deepEqual(result.producerBinding.consumerIds, ['b2-self-boot', 'typecheck', 'smoke-play']);
  assert.deepEqual(
    result.bindings.map((binding) => binding.context),
    ['b2-self-boot', 'typecheck', 'submodule-pin', 'smoke-play'],
  );
  assert.equal(result.bindings.some((binding) => binding.context === 'prerequisite-release'), false);
});

const producerBindingErrors = {
  'missing-producer-dependency': 'producer-dependency-missing',
  'needs-if-mismatch': 'producer-condition-missing',
  'required-context-added': 'required-context-drift',
  'profile-payload-drift': 'producer-payload-binding-drift',
  'producer-runner-capacity': 'producer-runner-capacity-drift',
};

for (const [name, expectedCode] of Object.entries(producerBindingErrors)) {
  test(`producer workflow binding rejects ${name}`, () => {
    const { mutated, graph } = producerContractMutation(name);
    const result = validateWorkflowBinding(mutated, graph, { profile: 'PR' });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, expectedCode);
    assert.notEqual(result.errors[0].expected, undefined);
    assert.notEqual(result.errors[0].observed, undefined);
    assert.equal(typeof result.errors[0].hint, 'string');
  });
}

for (const [name, expectedCode] of Object.entries(fixture.expectedErrors)) {
  test(`workflow binding rejects ${name}`, () => {
    const options = name === 'doc-only' ? { docOnly: true } : {};
    const result = validateWorkflowBinding(contract, graphFor(name), options);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, expectedCode);
  });
}
