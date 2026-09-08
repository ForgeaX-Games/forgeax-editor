import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  comparePackagingModes,
  DEFAULT_PACKAGING_MODES,
  finalOutputManifest,
  inventoryReleaseEntries,
  PACKAGING_PARITY_SCHEMA_VERSION,
  validatePackagingParityReport,
} from '../ddc-packaging-parity.mjs';

const fixture = JSON.parse(
  readFileSync(resolve('scripts/fixtures/ddc-packaging-cases.json'), 'utf8'),
);

function output(overrides = {}) {
  return {
    pack: [{path: 'assets/scene.pack.json', digest: 'pack-digest', bytes: 12}],
    artifacts: [{path: 'assets/scene.pack', digest: 'artifact-digest', bytes: 24}],
    packIndex: {schemaVersion: 'pack-index/v2', entries: ['scene'], generatedAt: 'run-specific'},
    files: [
      {path: 'assets/scene.pack.json', digest: 'pack-digest', bytes: 12},
      {path: 'assets/scene.pack', digest: 'artifact-digest', bytes: 24},
      {path: 'index.html', digest: 'html-digest', bytes: 10},
    ],
    ...overrides,
  };
}

function report(overrides = {}) {
  const outputs = Object.fromEntries(DEFAULT_PACKAGING_MODES.map((mode) => [mode, output()]));
  return {
    schemaVersion: PACKAGING_PARITY_SCHEMA_VERSION,
    sourceRevision: '0123456789abcdef0123456789abcdef01234567',
    allowedNondeterministicFields: fixture.allowedNondeterministicFields,
    modes: DEFAULT_PACKAGING_MODES.map((mode) => ({
      mode,
      status: 'pass',
      fallback: mode === 'shared-disabled' || mode === 'cache-unwritable' ? 'cold' : 'none',
    })),
    parity: comparePackagingModes(outputs, {
      modes: DEFAULT_PACKAGING_MODES,
      allowedNondeterministicFields: fixture.allowedNondeterministicFields,
    }),
    archive: inventoryReleaseEntries(Object.values(outputs).flatMap(({files}) => files.map(({path}) => path))),
    observation: {noClaim: true},
    ...overrides,
  };
}

test('fixture declares the four packaging modes and their expected cold or warm path', () => {
  assert.deepEqual(
    fixture.cases.map(({mode}) => mode),
    ['cold', 'warm', 'shared-disabled', 'cache-unwritable'],
  );
  assert.deepEqual(DEFAULT_PACKAGING_MODES, fixture.cases.map(({mode}) => mode));
  assert.equal(fixture.cases.find(({mode}) => mode === 'cache-unwritable').expectedPath, 'cold');
});

test('packaging parity accepts declared nondeterministic fields only', () => {
  const result = validatePackagingParityReport(report());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.errors, []);
});

test('packaging parity rejects an undeclared output difference', () => {
  const candidate = report();
  const outputs = Object.fromEntries(DEFAULT_PACKAGING_MODES.map((mode) => [mode, output()]));
  outputs.warm = output({
    artifacts: [{path: 'assets/scene.pack', digest: 'different-digest', bytes: 24}],
  });
  candidate.parity = comparePackagingModes(outputs, {
    modes: DEFAULT_PACKAGING_MODES,
    allowedNondeterministicFields: fixture.allowedNondeterministicFields,
  });
  const result = validatePackagingParityReport(candidate);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'packaging-parity-failed');
  assert.equal(candidate.parity.differences[0].code, 'packaging-output-mismatch');
});

test('JSON manifest byte metadata uses the canonical comparison body', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-ddc-parity-json-'));
  try {
    const outputs = {};
    for (const mode of DEFAULT_PACKAGING_MODES) {
      const directory = join(root, mode);
      const generatedAt = mode === 'cold' ? 'a' : `${mode}-${'x'.repeat(128)}`;
      const path = join(directory, 'assets', 'scene.pack.json');
      mkdirSync(resolve(path, '..'), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({ schemaVersion: '2.0.0', kind: 'internal-text-package', generatedAt }),
      );
      outputs[mode] = finalOutputManifest(directory, ['generatedAt']);
    }

    const result = comparePackagingModes(outputs, {
      modes: DEFAULT_PACKAGING_MODES,
      allowedNondeterministicFields: ['generatedAt'],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(outputs.cold.files[0].bytes, outputs.warm.files[0].bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packaging parity rejects DDC, lease, staging, and migration entries in an archive', () => {
  const candidate = report();
  candidate.archive = inventoryReleaseEntries([
    '.forgeax/ddc/v2/dev/heads/scene.json',
    'release/staging/attempt-1/asset.pack',
    'release/migration-report.json',
  ]);
  const result = validatePackagingParityReport(candidate);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'release-ddc-inventory-nonempty');
  assert.deepEqual(result.errors[0].observed.entries, candidate.archive.entries);
});

test('cache-unwritable must be reported as a cold fail-open path', () => {
  const candidate = report();
  candidate.modes = candidate.modes.map((entry) => (
    entry.mode === 'cache-unwritable' ? {...entry, status: 'failure', fallback: 'none'} : entry
  ));
  const result = validatePackagingParityReport(candidate);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'cache-unwritable-not-fail-open');
});
