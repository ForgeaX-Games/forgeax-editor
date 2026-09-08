import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const featureDir = resolve('.forgeax-harness/forgeax-loop/feat-20260815-ci-cost-critical-path-evidence');
const planPath = resolve(featureDir, 'plan-tasks.json');
const implementPath = resolve(featureDir, 'implement.json');
const workflowPaths = [
  resolve('.github/workflows/ci.yml'),
  resolve('.github/workflows/runner-pool-contract.yml'),
  resolve('.github/workflows/browser-release-measurement.yml'),
  resolve('.github/workflows/post-merge-ci-monitor.yml'),
];

function loadPlan() {
  return JSON.parse(readFileSync(planPath, 'utf8'));
}

function loadImplement() {
  return JSON.parse(readFileSync(implementPath, 'utf8'));
}

function extractRunLiterals(text) {
  const lines = text.split('\n');
  const literals = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)run:\s*(.*)$/);
    if (!match) continue;

    const parentIndent = match[1].length;
    const marker = match[2];
    if (marker === '|' || marker === '>-') {
      const body = [];
      for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
        const line = lines[bodyIndex];
        const contentIndent = line.search(/\S/);
        if (contentIndent >= 0 && contentIndent <= parentIndent) break;
        body.push(line);
      }
      const firstContent = body.find((line) => line.trim().length > 0);
      const bodyIndent = firstContent ? firstContent.search(/\S/) : parentIndent + 2;
      literals.push(body.map((line) => line.slice(Math.min(line.length, bodyIndent))).join('\n').replace(/\n+$/, ''));
      index += body.length;
      continue;
    }

    const value = marker.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
    literals.push(value);
  }

  return literals;
}

function containsExactLiteral(literals, rawLiteral) {
  return literals.some((literal) => {
    if (literal === rawLiteral) return true;
    if (rawLiteral.includes('\n')) return false;
    return literal.split('\n').some((line) => line === rawLiteral || line.includes(rawLiteral));
  });
}

function containsWorkflowProjection(literals, record) {
  if (record.id !== 'WPC-04') return containsExactLiteral(literals, record.rawLiteral);

  // WPC-04 is the deferred 13-spec browser contract. The workflow now splits
  // that historical single invocation by resource boundary, so its exact
  // multi-line command cannot remain contiguous. Derive the required coverage
  // from the Harness record instead of duplicating the spec list here: the
  // wrapper and every original path must still be present in the live workflow.
  const [wrapper, ...specs] = record.rawLiteral.split('\n');
  return containsExactLiteral(literals, wrapper) && specs.every((spec) =>
    literals.some((literal) => literal.split('\n').some((line) => line === spec)),
  );
}

test('M4 C projection preserves every implement ledger record', () => {
  const plan = loadPlan();
  const ledgerById = new Map(plan.implementLedger.map((entry) => [entry.id, entry]));
  const records = plan.milestoneCISweepRecords.M4;
  const sweepIds = plan.milestoneCISweep.M4;

  assert.equal(records.length, 33);
  assert.equal(records.length, ledgerById.size);

  for (const record of records) {
    const ledger = ledgerById.get(record.id);
    assert.ok(ledger, `missing ledger record ${record.id}`);
    assert.equal(record.rawLiteral, ledger.rawLiteral, record.id);
    assert.equal(record.status, ledger.status, record.id);
    assert.deepEqual(record.result, ledger.result, record.id);
  }

  assert.deepEqual(sweepIds, records.slice(0, sweepIds.length).map((record) => record.rawLiteral));
});

test('implement artifact mirrors every WPC ledger record and raw command', () => {
  const plan = loadPlan();
  const implement = loadImplement();
  const planLedger = plan.implementLedger;
  const records = plan.milestoneCISweepRecords.M4;
  const artifactLedger = implement.implementLedger;
  const artifactById = new Map(artifactLedger.map((entry) => [entry.id, entry]));
  const recordById = new Map(records.map((entry) => [entry.id, entry]));

  assert.equal(artifactLedger.length, 33);
  assert.equal(new Set(artifactLedger.map((entry) => entry.id)).size, 33);
  assert.equal(implement.commandsRun.includes('bun test focused M4 suite (56 pass, 0 fail)'), true);

  for (const ledgerEntry of planLedger) {
    const artifactEntry = artifactById.get(ledgerEntry.id);
    const recordEntry = recordById.get(ledgerEntry.id);
    assert.ok(artifactEntry, `missing implement artifact ledger record ${ledgerEntry.id}`);
    assert.ok(recordEntry, `missing M4 record ${ledgerEntry.id}`);
    assert.deepEqual(
      {
        id: artifactEntry.id,
        rawLiteral: artifactEntry.rawLiteral,
        status: artifactEntry.status,
        result: artifactEntry.result,
      },
      {
        id: ledgerEntry.id,
        rawLiteral: ledgerEntry.rawLiteral,
        status: ledgerEntry.status,
        result: ledgerEntry.result,
      },
      ledgerEntry.id,
    );
    assert.deepEqual(
      {
        rawLiteral: artifactEntry.rawLiteral,
        status: artifactEntry.status,
        result: artifactEntry.result,
      },
      {
        rawLiteral: recordEntry.rawLiteral,
        status: recordEntry.status,
        result: recordEntry.result,
      },
      `${ledgerEntry.id} record projection`,
    );
    assert.ok(implement.commandsRun.includes(ledgerEntry.rawLiteral), `missing raw command ${ledgerEntry.id}`);
  }
});

test('implement mirror preserves the WPC-04 block and no-claim boundaries', () => {
  const plan = loadPlan();
  const implement = loadImplement();
  const byId = new Map(implement.implementLedger.map((entry) => [entry.id, entry]));
  const smoke = byId.get('WPC-04');

  assert.equal(smoke.rawLiteral.split('\n').length, 14);
  assert.deepEqual(smoke.rawLiteral.split('\n').slice(1), [
    'apps/standalone/e2e/__tests__/smoke-boot-play.spec.ts',
    'apps/standalone/e2e/__tests__/hierarchy-ui-layout.spec.ts',
    'apps/standalone/e2e/__tests__/new-game-template-journey.spec.ts',
    'apps/standalone/e2e/__tests__/smoke-content-browser.spec.ts',
    'apps/standalone/e2e/__tests__/std01-mesh-viewer.spec.ts',
    'apps/standalone/e2e/__tests__/save-operation-run.spec.ts',
    'apps/standalone/e2e/__tests__/play-real-game-safety-net.spec.ts',
    'apps/standalone/e2e/__tests__/vfx-particle-runtime.spec.ts',
    'apps/standalone/e2e/__tests__/gameplay-viewport-capture.spec.ts',
    'apps/standalone/e2e/__tests__/gltf-mesh-default-material.spec.ts',
    'apps/standalone/e2e/__tests__/asset-source-reimport.spec.ts',
    'apps/standalone/e2e/__tests__/asset-source-workflow-visual.spec.ts',
    'apps/standalone/e2e/__tests__/asset-source-workflow-fixture.test.ts',
  ]);
  assert.deepEqual(
    ['WPC-01', 'WPC-02', 'WPC-03', 'WPC-04', 'WPC-05'].map((id) => byId.get(id).status),
    ['deferred-to-PR', 'deferred-to-PR', 'deferred-to-PR', 'deferred-to-PR', 'deferred-to-merge'],
  );
  assert.deepEqual(
    ['WPC-29', 'WPC-30', 'WPC-31', 'WPC-32', 'WPC-33'].map((id) => byId.get(id).result),
    plan.implementLedger.slice(-5).map((entry) => entry.result),
  );
  assert.equal(byId.get('WPC-30').result.status, 'not-executed');
  assert.equal(byId.get('WPC-31').result.status, 'not-executed');
});

test('workflow source contains every exact M4 raw literal or coverage-preserving split projection', () => {
  const workflowLiterals = workflowPaths.flatMap((path) => extractRunLiterals(readFileSync(path, 'utf8')));
  const plan = loadPlan();

  for (const record of plan.milestoneCISweepRecords.M4) {
    assert.ok(containsWorkflowProjection(workflowLiterals, record), `missing workflow literal ${record.id}`);
  }
});

test('C keeps deferred states and preserves shell identity', () => {
  const plan = loadPlan();
  const records = plan.milestoneCISweepRecords.M4;

  assert.deepEqual(
    records.filter((record) => record.status.startsWith('deferred-')).map((record) => record.id),
    ['WPC-01', 'WPC-02', 'WPC-03', 'WPC-04', 'WPC-05', 'WPC-29', 'WPC-32', 'WPC-33'],
  );
  assert.ok(records.every((record) => !record.rawLiteral.includes('bun run test:e2e') || record.rawLiteral.includes('$CI_BUN_PATH')));
  assert.ok(records.every((record) => record.id.startsWith('WPC-')));
});
