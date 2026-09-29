import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  bunVersion: '1.4.0',
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

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
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

test('source-first producer consumes the Engine action staging tree', async () => {
  const root = makeOutputDir('engine-staging');
  const staged = join(root, 'engine');
  const outputDir = join(root, 'release');
  const previous = process.env.FORGEAX_ENGINE_PREREQUISITE_OUTPUT;
  const previousSha = process.env.FORGEAX_ENGINE_PREREQUISITE_SHA;
  try {
    const payloads = {
      'engine-dist/runtime/dist/index.mjs': 'engine dist\n',
      'wgpu-wasm/wgpu_wasm.js': 'wgpu\n',
      'fbx-wasm/fbx-wasm.wasm': 'fbx\n',
    };
    for (const [path, content] of Object.entries(payloads)) {
      const file = join(staged, 'payload', path);
      mkdirSync(join(file, '..'), {recursive: true});
      writeFileSync(file, content);
    }
    const engineInventory = Object.entries(payloads).map(([path, content]) => {
      const [payloadClass] = path.split('/');
      return {
        payloadClass,
        path: `payload/${path}`,
        bytes: Buffer.byteLength(content),
        sha256: sha256(content),
      };
    });
    writeFileSync(
      join(staged, 'engine-prerequisite-build-manifest.json'),
      `${JSON.stringify({
        schemaVersion: 'forgeax-engine-editor-prerequisite-build/v1',
        sourceOnly: true,
        status: 'success',
        productionMode: 'source-build',
        os: 'linux',
        architecture: 'x64',
        engineSha: 'c'.repeat(40),
        recursivePins: [],
        payloadClasses: ['engine-dist', 'fbx-wasm', 'wgpu-wasm'],
        inputDigest: 'd'.repeat(64),
        outputDigest: sha256(JSON.stringify(canonicalize(engineInventory))),
        inventory: engineInventory,
        recipeInputs: [],
        toolchain: { node: '22.22.3', pnpm: '11.7.0' },
        stageTimingsMs: { install: 1, staging: 1 },
        durationMs: 2,
      }, null, 2)}\n`,
    );
    process.env.FORGEAX_ENGINE_PREREQUISITE_OUTPUT = staged;
    process.env.FORGEAX_ENGINE_PREREQUISITE_SHA = 'c'.repeat(40);
    const release = await producePrerequisiteRelease({
      outputDir,
      profile: 'PR',
      sourceSha,
      producerRunId: '102',
      producerAttempt: 1,
      recursivePins,
      environment,
      producerEnvironmentFingerprint: 'linux-x64-standard',
      enginePrerequisiteOutput: staged,
    });
    assert.equal(release.ok, true);
    assert.equal(readFileSync(join(outputDir, 'payload', 'engine-dist', 'runtime', 'dist', 'index.mjs'), 'utf8'), 'engine dist\n');
    assert.equal(readFileSync(join(outputDir, 'payload', 'wgpu-wasm', 'wgpu_wasm.js'), 'utf8'), 'wgpu\n');
    assert.equal(readFileSync(join(outputDir, 'payload', 'fbx-wasm', 'fbx-wasm.wasm'), 'utf8'), 'fbx\n');
    assert.equal(release.manifest.enginePrerequisite.engineSha, 'c'.repeat(40));
    assert.equal(release.manifest.enginePrerequisite.productionMode, 'source-build');
    assert.equal(release.manifest.enginePrerequisite.outputDigest, sha256(JSON.stringify(canonicalize(engineInventory))));

    writeFileSync(join(staged, 'payload', 'wgpu-wasm', 'wgpu_wasm.js'), 'tampered\n');
    const tampered = await producePrerequisiteRelease({
      outputDir: join(root, 'tampered-release'),
      profile: 'PR',
      sourceSha,
      producerRunId: '103',
      producerAttempt: 1,
      recursivePins,
      environment,
      producerEnvironmentFingerprint: 'linux-x64-standard',
      enginePrerequisiteOutput: staged,
    });
    assert.equal(tampered.ok, false);
    assert.equal(tampered.error.code, 'producer-failure');
    assert.match(tampered.error.observed, /Engine source-build payload mismatch/);
  } finally {
    if (previous === undefined) delete process.env.FORGEAX_ENGINE_PREREQUISITE_OUTPUT;
    else process.env.FORGEAX_ENGINE_PREREQUISITE_OUTPUT = previous;
    if (previousSha === undefined) delete process.env.FORGEAX_ENGINE_PREREQUISITE_SHA;
    else process.env.FORGEAX_ENGINE_PREREQUISITE_SHA = previousSha;
    rmSync(root, {recursive: true, force: true});
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
