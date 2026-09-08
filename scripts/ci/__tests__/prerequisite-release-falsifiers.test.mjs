import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
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

async function inspectBuiltEditorArtifact() {
  const config = JSON.parse(readFileSync(resolve('config/forgeax-extension.build.json'), 'utf8'));
  const root = mkdtempSync(join(tmpdir(), 'forgeax-editor-artifact-falsifier-'));
  const output = join(root, 'forgeax-editor-edit.fxe');
  const stage = join(root, 'stage');
  const configPath = join(root, 'build.json');
  writeFileSync(configPath, JSON.stringify({
    ...config,
    input: resolve(config.input),
    entry: resolve(config.entry),
    output,
  }));
  try {
    execFileSync(process.execPath, ['scripts/forgeax-extension.ts', '--config', configPath], {
      cwd: resolve('.'),
      env: { ...process.env, FORGEAX_EXTENSION_STAGE: stage },
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entries = execFileSync('unzip', ['-Z1', output], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
    const readEntry = (name) => execFileSync('unzip', ['-p', output, name], { maxBuffer: 64 * 1024 * 1024 });
    const bundle = readEntry('dist/editor-runtime.js');
    const entryPath = join(root, 'editor-runtime.mjs');
    writeFileSync(entryPath, bundle);
    const imported = await import(pathToFileURL(entryPath).href);
    return {
      entries,
      manifest: JSON.parse(readEntry('forgeax-extension.json').toString('utf8')),
      signature: JSON.parse(readEntry('signature.json').toString('utf8')),
      bundle: bundle.toString('utf8'),
      imported,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test('baseline-only Editor artifacts are explicit falsification failures', async () => {
  const fixture = JSON.parse(readFileSync(resolve('scripts/ci/fixtures/prerequisite-release-evidence-cases.json'), 'utf8'));
  const falsifiers = fixture.editorArtifactFalsifiers;
  assert.ok(Array.isArray(falsifiers) && falsifiers.length > 0);

  const manifest = JSON.parse(readFileSync(resolve('forgeax-extension.json'), 'utf8'));
  const builder = readFileSync(resolve('scripts/forgeax-extension.ts'), 'utf8');
  const artifact = await inspectBuiltEditorArtifact();
  for (const falsifier of falsifiers) {
    const observed = falsifier.subject === 'manifest'
      ? `${manifest.entry?.backend ?? ''}\n${JSON.stringify(manifest.runtime ?? null)}\n${JSON.stringify(manifest.contributes ?? {})}`
      : falsifier.subject === 'builder'
        ? builder
        : artifact.entries.join('\n');
    for (const token of falsifier.forbiddenTokens) {
      assert.doesNotMatch(observed, new RegExp(token), falsifier.name);
    }
  }
  const admission = fixture.editorArtifactAdmission;
  for (const required of admission.archive.requiredEntries) assert.ok(artifact.entries.includes(required), required);
  for (const pattern of admission.archive.forbiddenEntryPatterns) {
    assert.equal(artifact.entries.some((entry) => new RegExp(pattern).test(entry)), false, pattern);
  }
  for (const token of admission.archive.bundleRequiredTokens) assert.match(artifact.bundle, new RegExp(token));
  for (const token of admission.archive.bundleForbiddenTokens) assert.doesNotMatch(artifact.bundle, new RegExp(token));
  assert.equal(artifact.imported.extension.runtimeKind, admission.manifest.runtimeKind);
  assert.equal(typeof artifact.imported.activate, 'function');
});
