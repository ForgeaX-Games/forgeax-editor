import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import {
  deriveRecursivePins,
  producePrerequisiteRelease,
  producerCliSummary,
  validate,
} from '../prerequisite-release.mjs';

const sourceSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const recursivePins = [
  { path: 'packages/engine', pin: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
];
const environment = {
  os: 'linux',
  architecture: 'x64',
  bunVersion: '1.3.14',
  nodeVersion: '22.13.0',
  pnpmVersion: '11.7.0',
  rustVersion: '1.93',
  wasmPackVersion: '0.14.0',
  capacityPool: 'standard',
};

function makeOutputDir(name) {
  return mkdtempSync(join(tmpdir(), `forgeax-${name}-`));
}

function materializerCalls(calls) {
  return ({ payloadClass }) => {
    calls.push(payloadClass);
    return {
      [`${payloadClass}.json`]: JSON.stringify({ payloadClass, sourceSha }),
    };
  };
}

function validationInput(release, consumer = 'typecheck') {
  return {
    ...release.validationInput,
    consumer,
    environment,
    onValidated: undefined,
  };
}

test('cold producer materializes the active profile once and publishes one release identity', async () => {
  const outputDir = makeOutputDir('cold-producer');
  const calls = [];
  try {
    const release = await producePrerequisiteRelease({
      outputDir,
      profile: 'PR',
      sourceSha,
      producerRunId: '100',
      producerAttempt: 1,
      recursivePins,
      environment,
      producerEnvironmentFingerprint: 'linux-x64-standard',
      materializePayload: materializerCalls(calls),
    });

    assert.equal(release.ok, true);
    assert.deepEqual(calls, ['engine-dist', 'wgpu-wasm', 'fbx-wasm', 'bun-install-facts']);
    assert.equal(release.manifest.production.physicalProductionCount, 1);
    assert.deepEqual(release.manifest.production.materializedPayloadClasses, calls);
    assert.equal(release.manifest.artifactId, 'prerequisite-release-100-1');
    assert.match(release.manifest.releaseDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(release.manifest.producerSuccess, true);
    assert.equal(readFileSync(join(outputDir, 'manifest.json'), 'utf8').length > 0, true);
    assert.equal(new Set([release.manifest.artifactId, release.manifest.releaseDigest]).size, 2);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('warm producer reuses eligible materialization but still validates the complete release', async () => {
  const coldDir = makeOutputDir('cold-source');
  const warmDir = makeOutputDir('warm-producer');
  const coldCalls = [];
  let warmCalls = 0;
  try {
    const cold = await producePrerequisiteRelease({
      outputDir: coldDir,
      profile: 'PR',
      sourceSha,
      producerRunId: '100',
      producerAttempt: 1,
      recursivePins,
      environment,
      producerEnvironmentFingerprint: 'linux-x64-standard',
      materializePayload: materializerCalls(coldCalls),
    });
    assert.equal(cold.ok, true);

    const warm = await producePrerequisiteRelease({
      outputDir: warmDir,
      profile: 'PR',
      sourceSha,
      producerRunId: '101',
      producerAttempt: 1,
      recursivePins,
      environment,
      producerEnvironmentFingerprint: 'linux-x64-standard',
      reuse: cold,
      materializePayload: () => {
        warmCalls += 1;
        throw new Error('warm reuse must not rematerialize eligible payloads');
      },
    });

    assert.equal(warm.ok, true);
    assert.equal(warmCalls, 0);
    assert.deepEqual(warm.manifest.production.materializedPayloadClasses, []);
    assert.deepEqual(
      warm.manifest.production.reusedPayloadClasses,
      ['engine-dist', 'wgpu-wasm', 'fbx-wasm', 'bun-install-facts'],
    );
    const validation = validate(validationInput(warm));
    assert.equal(validation.ok, true);
    assert.equal(validation.artifactId, warm.manifest.artifactId);
    assert.equal(validation.releaseDigest, warm.manifest.releaseDigest);
    assert.deepEqual(validation.payloadClasses, ['engine-dist', 'wgpu-wasm', 'bun-install-facts']);
    assert.equal(coldCalls.length, 4);
  } finally {
    rmSync(coldDir, { recursive: true, force: true });
    rmSync(warmDir, { recursive: true, force: true });
  }
});

test('CLI summary omits the materialized files map while retaining release identity', () => {
  const result = {
    ok: true,
    manifest: {
      artifactId: 'prerequisite-release-100-1',
      releaseDigest: 'sha256:release',
      production: {physicalProductionCount: 1},
      inventory: [{payloadClass: 'engine-dist', path: 'payload/engine-dist/index.js'}],
    },
    profile: 'PR',
    consumers: ['b2-self-boot'],
    payloadClasses: ['engine-dist'],
    materializedPayloadClasses: ['engine-dist'],
    reusedPayloadClasses: [],
    files: {hugePayload: Buffer.alloc(1024)},
    validationInput: {files: {hugePayload: Buffer.alloc(1024)}},
  };

  const summary = producerCliSummary(result);
  assert.equal(summary.artifactId, result.manifest.artifactId);
  assert.equal(summary.releaseDigest, result.manifest.releaseDigest);
  assert.equal(summary.inventoryCount, 1);
  assert.equal('files' in summary, false);
  assert.doesNotThrow(() => JSON.stringify(summary));
});

test('recursive pin derivation fails closed outside a git checkout', () => {
  const directory = makeOutputDir('recursive-pin-failure');
  try {
    assert.throws(
      () => deriveRecursivePins({cwd: directory}),
      (error) => error.code === 'recursive-pin-derivation-failure'
        && /unable to derive recursive submodule pins/.test(error.message),
    );
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
