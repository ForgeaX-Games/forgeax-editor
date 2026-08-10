import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { projectEditorCiReport, validateEditorCiReport } from './editor-ci-report.mjs';

const fixturePath = resolve('scripts/ci/fixtures/editor-ci-report.json');

test('report projection keeps stable keys and first failure before attempts', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const report = projectEditorCiReport(fixture.report);
  const validation = validateEditorCiReport(report);

  assert.equal(validation.ok, true);
  for (const key of fixture.requiredKeys) assert.ok(Object.hasOwn(report, key), key);
  assert.equal(report.firstFailure.attempt, 1);
  assert.equal(report.attempts[0].attempt, 1);
  assert.equal(report.sloClaim, null);
  assert.equal(report.provenance.timingDomain, 'post-merge-workflow');
});

test('report exposes an executable hint without requiring log parsing', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const report = projectEditorCiReport(fixture.report);
  assert.equal(report.hint, 'retry once after transport recovery');
  assert.equal(report.observed, 'GitHub API connection reset');
});

test('navigation fixtures require the same contract vocabulary in both README entries', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const english = readFileSync(resolve('README.md'), 'utf8');
  const chinese = readFileSync(resolve('README.zh-CN.md'), 'utf8');
  for (const token of fixture.navigationTokens) {
    assert.ok(english.toLowerCase().includes(token.toLowerCase()), `README.md: ${token}`);
    assert.ok(chinese.toLowerCase().includes(token.toLowerCase()), `README.zh-CN.md: ${token}`);
  }
});

test('report validation rejects missing recovery or first-failure fields', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  for (const field of ['hint', 'firstFailure']) {
    const report = projectEditorCiReport(fixture.report);
    delete report[field];
    const validation = validateEditorCiReport(report);
    assert.equal(validation.ok, false, field);
    assert.equal(validation.error.code, 'report-field-missing', field);
  }
});
