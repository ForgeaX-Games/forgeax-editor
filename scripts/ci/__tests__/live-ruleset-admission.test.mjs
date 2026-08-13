import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  discoverLiveRulesetSync,
  selectActiveDefaultBranchRuleset,
} from '../live-ruleset-admission.mjs';
import { validateRuntimeProjection } from '../editor-ci-contract.mjs';

const rulesetFixture = {
  id: 18438292,
  name: 'basic',
  enforcement: 'active',
  target: 'branch',
  conditions: {ref_name: {include: ['~DEFAULT_BRANCH']}},
  rules: [{
    type: 'required_status_checks',
    parameters: {
      required_status_checks: [
        {context: 'b2-self-boot', integration_id: 15368},
        {context: 'typecheck', integration_id: 15368},
        {context: 'submodule-pin', integration_id: 15368},
        {context: 'smoke-play', integration_id: 15368},
      ],
    },
  }],
};

const listFixture = [{id: 18438292, name: 'basic', enforcement: 'active', target: 'branch', conditions: null}];

function validWorkflow({smokeRunner = 'heavy', smokePermissions = 'contents: read'} = {}) {
  return `name: CI
on: push
permissions:
  contents: read
jobs:
  b2-self-boot:
    name: b2-self-boot
    runs-on: [self-hosted, Linux, X64, standard]
    timeout-minutes: 5
  typecheck:
    name: typecheck
    runs-on: [self-hosted, Linux, X64, standard]
    timeout-minutes: 5
  submodule-pin:
    name: submodule-pin
    runs-on: [self-hosted, Linux, X64, standard]
    timeout-minutes: 5
  smoke-play:
    name: smoke-play
    runs-on: [self-hosted, Linux, X64, ${smokeRunner}]
    timeout-minutes: 5
    permissions:
      ${smokePermissions}
`;
}

function contract() {
  return JSON.parse(JSON.stringify(requireContract));
}

const requireContract = JSON.parse(readFileSync(new URL('../editor-ci-contract.json', import.meta.url), 'utf8'));

function projection({workflow = validWorkflow(), ruleset = rulesetFixture} = {}) {
  const root = mkdtempSync(join('/tmp', 'forgeax-live-admission-'));
  const workflowsDir = join(root, '.github', 'workflows');
  mkdirSync(workflowsDir, {recursive: true});
  writeFileSync(join(workflowsDir, 'ci.yml'), workflow);
  return validateRuntimeProjection(contract(), workflowsDir, ruleset, {includePortfolio: false});
}

test('list/detail discovery accepts list entries whose conditions are omitted', () => {
  const result = selectActiveDefaultBranchRuleset({
    candidates: listFixture,
    details: [{id: 18438292, detail: rulesetFixture}],
    defaultBranch: 'main',
  });
  assert.equal(result.ok, true);
  assert.equal(result.selection.selectedId, '18438292');
});

test('discovery rejects duplicate active default-branch details', () => {
  const result = selectActiveDefaultBranchRuleset({
    candidates: [
      ...listFixture,
      {id: 18438293, name: 'second', enforcement: 'active', target: 'branch', conditions: null},
    ],
    details: [
      {id: 18438292, detail: rulesetFixture},
      {id: 18438293, detail: {...rulesetFixture, id: 18438293, name: 'second'}},
    ],
    defaultBranch: 'main',
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'live-ruleset-ambiguous');
});

test('discovery rejects an unreadable candidate detail instead of skipping it', () => {
  const result = selectActiveDefaultBranchRuleset({
    candidates: [
      ...listFixture,
      {id: 18438293, name: 'unknown', enforcement: 'active', target: 'branch', conditions: null},
    ],
    details: [{id: 18438292, detail: rulesetFixture}, {id: '18438293', error: new Error('403')}],
    defaultBranch: 'main',
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'live-ruleset-detail-unavailable');
});

test('discovery rejects a policy that does not explicitly scope the default branch', () => {
  const result = selectActiveDefaultBranchRuleset({
    candidates: listFixture,
    details: [{id: 18438292, detail: {...rulesetFixture, conditions: {ref_name: {include: ['refs/heads/release']}}}}],
    defaultBranch: 'main',
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'live-ruleset-default-branch-missing');
});

test('API transport failure is a structured fail-closed result', () => {
  const result = discoverLiveRulesetSync({
    readRepository: () => { throw new Error('offline'); },
    readRulesets: () => listFixture,
    readDetail: () => rulesetFixture,
  });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'live-ruleset-unavailable');
});

test('valid projection binds every live context exactly once', () => {
  const result = projection();
  assert.equal(result.ok, true);
  assert.deepEqual(result.binding.bindings.map((binding) => binding.jobId), [
    'b2-self-boot',
    'typecheck',
    'submodule-pin',
    'smoke-play',
  ]);
});

for (const [name, mutate, expectedCode] of [
  ['missing context', (ruleset) => ({...ruleset, rules: [{...ruleset.rules[0], parameters: {required_status_checks: ruleset.rules[0].parameters.required_status_checks.slice(1)}}]}), 'required-context-drift'],
  ['extra context', (ruleset) => ({...ruleset, rules: [{...ruleset.rules[0], parameters: {required_status_checks: [...ruleset.rules[0].parameters.required_status_checks, {context: 'shadow-check'}]}}]}), 'required-context-drift'],
  ['renamed context', (ruleset) => ({...ruleset, rules: [{...ruleset.rules[0], parameters: {required_status_checks: ruleset.rules[0].parameters.required_status_checks.map((entry) => entry.context === 'typecheck' ? {...entry, context: 'typecheck-renamed'} : entry)}}]}), 'required-context-drift'],
  ['shadowed context', (ruleset) => ({...ruleset, rules: [{...ruleset.rules[0], parameters: {required_status_checks: [...ruleset.rules[0].parameters.required_status_checks, {context: 'typecheck'}]}}]}), 'required-context-shadowed'],
]) {
  test(`live projection rejects ${name}`, () => {
    const result = projection({ruleset: mutate(rulesetFixture)});
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, expectedCode);
  });
}

test('live projection rejects zero workflow jobs', () => {
  const result = projection({workflow: 'name: CI\non: push\njobs: {}\n'});
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'zero-job');
});

test('live projection rejects runner capability drift', () => {
  const result = projection({workflow: validWorkflow({smokeRunner: 'standard'})});
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'runner-capability-drift');
});

test('live projection rejects least-privilege drift', () => {
  const result = projection({workflow: validWorkflow({smokePermissions: 'contents: read\n      actions: read'})});
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'least-privilege-drift');
});
