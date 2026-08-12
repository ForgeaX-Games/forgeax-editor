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

for (const [name, expectedCode] of Object.entries(fixture.expectedErrors)) {
  test(`workflow binding rejects ${name}`, () => {
    const options = name === 'doc-only' ? { docOnly: true } : {};
    const result = validateWorkflowBinding(contract, graphFor(name), options);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, expectedCode);
  });
}
