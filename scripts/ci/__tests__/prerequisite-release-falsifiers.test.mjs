import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { producePrerequisiteRelease, validate } from '../prerequisite-release.mjs';

const fixturePath = resolve('scripts/ci/fixtures/prerequisite-release-evidence-cases.json');

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
  return mkdtempSync(join(tmpdir(), `forgeax-evidence-${name}-`));
}

function applyMutation(input, mutation) {
  const next = structuredClone(input);
  if (!mutation) return next;
  if (mutation.kind === 'file') next.files[mutation.path] = mutation.value;
  if (mutation.kind === 'add-file') next.files[mutation.path] = mutation.value;
  if (mutation.kind === 'input') next[mutation.field] = mutation.value;
  if (mutation.kind === 'manifest') next.manifest[mutation.field] = mutation.value;
  if (mutation.kind === 'pin') next.recursivePins[0].pin = mutation.value;
  if (mutation.kind === 'environment') next.environment[mutation.field] = mutation.value;
  return next;
}

async function makeValidationInput() {
  const outputDir = makeOutputDir('matrix-base');
  const release = await producePrerequisiteRelease({
    outputDir,
    profile: 'PR',
    sourceSha: 'a'.repeat(40),
    producerRunId: '100',
    producerAttempt: 1,
    recursivePins: [{path: 'packages/engine', pin: 'b'.repeat(40)}],
    environment,
    producerEnvironmentFingerprint: 'linux-x64-standard',
    materializePayload: ({payloadClass}) => ({
      [`${payloadClass}.json`]: JSON.stringify({payloadClass}),
    }),
  });
  assert.equal(release.ok, true);
  return {
    outputDir,
    input: {
      ...release.validationInput,
      consumer: 'smoke-play',
      environment,
    },
  };
}

test('controlled prerequisite evidence matrix records pass and fail-closed observations', async () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const {outputDir, input: baseInput} = await makeValidationInput();
  try {
    for (const scenario of fixture.cases) {
      assert.equal(typeof scenario.expectation, 'string', scenario.name);
      assert.equal(typeof scenario.observation, 'object', scenario.name);
      assert.ok(['pass', 'nonpass'].includes(scenario.verdict), scenario.name);
      assert.equal(typeof scenario.code, 'string', scenario.name);
      const input = applyMutation(baseInput, scenario.mutation);
      let entered = false;
      const result = validate({
        ...input,
        onValidated() {
          entered = true;
        },
      });

      if (scenario.validation === 'required') {
        assert.equal(result.ok, scenario.verdict === 'pass', scenario.name);
        assert.equal(entered, scenario.verdict === 'pass', scenario.name);
        if (scenario.verdict !== 'pass') {
          assert.equal(result.error.code, scenario.code, scenario.name);
          assert.equal(result.error.affectedConsumer, input.consumer, scenario.name);
          assert.equal(typeof result.error.hint, 'string', scenario.name);
        }
      } else {
        assert.equal(scenario.observation.checkBodyEntered, false, scenario.name);
      }
    }
  } finally {
    rmSync(outputDir, {recursive: true, force: true});
  }
});
