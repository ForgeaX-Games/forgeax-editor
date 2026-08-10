import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { discoverPackageCensus } from './package-census.mjs';

const fixturePath = resolve('scripts/ci/fixtures/package-census-workspaces.json');

function project(result) {
  return {
    status: result.status,
    surfaces: result.surfaces.map(({ path, kind, materialization }) => ({ path, kind, materialization })),
    admissions: result.admissions.map((entry) => entry.path),
  };
}

test('workspace census distinguishes package, gitlink, uninitialized, and empty surfaces', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  for (const mutation of fixture.cases) {
    const result = discoverPackageCensus(mutation.input);
    assert.deepEqual(project(result), mutation.expected, mutation.name);
  }
});

test('gitlink roots are admitted even when nested package observations are absent', () => {
  const result = discoverPackageCensus({
    workspacePatterns: ['packages/*', 'packages/engine/packages/*'],
    gitlinkRoots: ['packages/engine'],
    entries: [{ path: 'packages/engine', kind: 'gitlink', initialized: false }],
  });
  assert.equal(result.status, 'admission');
  assert.equal(result.surfaces[0].materialization, 'uninitialized');
  assert.equal(result.admissions[0].code, 'workspace-not-materialized');
  assert.equal(result.admissions[0].hint.includes('packages/engine'), true);
});
