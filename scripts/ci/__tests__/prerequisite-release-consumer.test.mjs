import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { producePrerequisiteRelease, validate } from '../prerequisite-release.mjs';

const sourceSha = 'a'.repeat(40);
const recursivePins = [{path: 'packages/engine', pin: 'b'.repeat(40)}];
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

async function makeRelease(name = 'consumer') {
  const outputDir = makeOutputDir(name);
  const release = await producePrerequisiteRelease({
    outputDir,
    profile: 'PR',
    sourceSha,
    producerRunId: '100',
    producerAttempt: 1,
    recursivePins,
    environment,
    producerEnvironmentFingerprint: 'linux-x64-standard',
    materializePayload: ({payloadClass}) => ({
      [`${payloadClass}.json`]: JSON.stringify({payloadClass, sourceSha}),
    }),
  });
  assert.equal(release.ok, true);
  return {outputDir, release};
}

function validationInput(release, consumer) {
  return {
    ...release.validationInput,
    consumer,
    environment,
  };
}

test('each consumer receives only its declared payload classes', async () => {
  const {outputDir, release} = await makeRelease('scoped-selection');
  try {
    for (const [consumer, expected] of [
      ['b2-self-boot', ['engine-dist', 'wgpu-wasm', 'bun-install-facts']],
      ['typecheck', ['engine-dist', 'wgpu-wasm', 'bun-install-facts']],
      ['smoke-play', ['engine-dist', 'wgpu-wasm', 'fbx-wasm', 'bun-install-facts']],
    ]) {
      let entered = false;
      const result = validate({
        ...validationInput(release, consumer),
        onValidated() {
          entered = true;
        },
      });
      assert.equal(result.ok, true, consumer);
      assert.deepEqual(result.payloadClasses, expected, consumer);
      assert.equal(entered, true, consumer);
    }
  } finally {
    rmSync(outputDir, {recursive: true, force: true});
  }
});

test('an undeclared optional payload is rejected before the consumer callback', async () => {
  const {outputDir, release} = await makeRelease('undeclared-selection');
  try {
    let entered = false;
    const result = validate({
      ...validationInput(release, 'typecheck'),
      requestedPayloadClasses: ['engine-dist', 'fbx-wasm'],
      onValidated() {
        entered = true;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'undeclared-payload');
    assert.equal(result.error.payloadClass, 'fbx-wasm');
    assert.equal(result.error.affectedConsumer, 'typecheck');
    assert.equal(entered, false);
  } finally {
    rmSync(outputDir, {recursive: true, force: true});
  }
});

test('an invalid optional payload fails only its requesting consumer', async () => {
  const {outputDir, release} = await makeRelease('optional-failure');
  try {
    const fbxPath = 'payload/fbx-wasm/fbx-wasm.json';
    release.files[fbxPath] = 'corrupted';

    let b2Entered = false;
    const b2 = validate({
      ...validationInput(release, 'b2-self-boot'),
      onValidated() {
        b2Entered = true;
      },
    });
    assert.equal(b2.ok, true);
    assert.equal(b2Entered, true);

    let typecheckEntered = false;
    const typecheck = validate({
      ...validationInput(release, 'typecheck'),
      onValidated() {
        typecheckEntered = true;
      },
    });
    assert.equal(typecheck.ok, true);
    assert.equal(typecheckEntered, true);

    let smokeEntered = false;
    const smoke = validate({
      ...validationInput(release, 'smoke-play'),
      onValidated() {
        smokeEntered = true;
      },
    });
    assert.equal(smoke.ok, false);
    assert.equal(smoke.error.code, 'release-integrity-invalid');
    assert.equal(smoke.error.payloadClass, 'fbx-wasm');
    assert.equal(smoke.error.affectedConsumer, 'smoke-play');
    assert.equal(smokeEntered, false);
  } finally {
    rmSync(outputDir, {recursive: true, force: true});
  }
});
