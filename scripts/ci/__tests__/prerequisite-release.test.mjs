import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { validate } from '../prerequisite-release.mjs';

const fixturePath = resolve('scripts/ci/fixtures/prerequisite-release-cases.json');
const artifactFixturePath = resolve('scripts/ci/fixtures/prerequisite-release-evidence-cases.json');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function inspectBuiltEditorArtifact() {
  const config = readJson(resolve('config/forgeax-extension.build.json'));
  const root = mkdtempSync(join(tmpdir(), 'forgeax-editor-artifact-admission-'));
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

test('prerequisite rejection cases expose structured recovery fields before use', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  for (const mutation of fixture.rejectionCases) {
    let entered = false;
    const result = validate({
      ...mutation.input,
      onValidated() {
        entered = true;
      },
    });

    assert.equal(result.ok, false, mutation.name);
    assert.equal(result.error.code, mutation.expected.code, mutation.name);
    assert.equal(
      result.error.failedField ?? result.error.payloadClass,
      mutation.expected.failedField ?? mutation.expected.payloadClass,
      mutation.name,
    );
    assert.deepEqual(result.error.expected, mutation.expected.expected, mutation.name);
    assert.deepEqual(result.error.observed, mutation.expected.observed, mutation.name);
    assert.equal(result.error.affectedConsumer, mutation.input.consumer, mutation.name);
    assert.equal(result.error.artifactId, mutation.input.manifest.artifactId, mutation.name);
    assert.equal(typeof result.error.hint, 'string', mutation.name);
    assert.ok(result.error.hint.length > 0, mutation.name);
    assert.equal(entered, false, mutation.name);
  }
});

test('producer and attempt failures remain terminal structured errors', () => {
  const fixture = readJson(fixturePath);
  const cases = fixture.rejectionCases.filter(({expected}) => (
    ['producer-failure', 'attempt-mismatch'].includes(expected.code)
  ));

  for (const mutation of cases) {
    const result = validate(mutation.input);
    assert.equal(result.ok, false, mutation.name);
    assert.equal(result.error.code, mutation.expected.code, mutation.name);
    assert.equal(result.error.affectedConsumer, mutation.input.consumer, mutation.name);
    assert.equal(result.error.artifactId, mutation.input.manifest.artifactId, mutation.name);
    assert.notEqual(result.error.expected, undefined, mutation.name);
    assert.notEqual(result.error.observed, undefined, mutation.name);
    assert.equal(typeof result.error.hint, 'string', mutation.name);
  }
});

test('Editor artifact admission requires the released World-backed entry', async () => {
  const fixture = readJson(artifactFixturePath);
  const admission = fixture.editorArtifactAdmission;
  assert.equal(typeof admission, 'object');

  const manifest = readJson(resolve('forgeax-extension.json'));
  const build = readJson(resolve('config/forgeax-extension.build.json'));
  const builder = readFileSync(resolve('scripts/forgeax-extension.ts'), 'utf8');

  assert.equal(manifest.entry?.backend, admission.manifest.entryBackend);
  assert.equal(manifest.runtime?.kind, admission.manifest.runtimeKind);
  assert.equal(manifest.runtime?.owner, admission.manifest.runtimeOwner);
  assert.deepEqual(
    admission.manifest.requiredCapabilities.every((capability) => manifest.contributes?.capabilities?.includes(capability)),
    true,
  );
  assert.equal(build.entry, admission.build.entry);
  for (const token of admission.builder.forbiddenTokens) assert.doesNotMatch(builder, new RegExp(token));

  const artifact = await inspectBuiltEditorArtifact();
  for (const required of admission.archive.requiredEntries) assert.ok(artifact.entries.includes(required), required);
  for (const pattern of admission.archive.forbiddenEntryPatterns) {
    assert.equal(artifact.entries.some((entry) => new RegExp(pattern).test(entry)), false, pattern);
  }
  assert.equal(artifact.manifest.entry.backend, admission.manifest.entryBackend);
  assert.equal(artifact.manifest.runtime.kind, admission.manifest.runtimeKind);
  assert.equal(artifact.manifest.runtime.owner, admission.manifest.runtimeOwner);
  for (const capability of admission.manifest.requiredCapabilities) {
    assert.ok(artifact.manifest.contributes.capabilities.includes(capability), capability);
  }
  for (const token of admission.archive.bundleRequiredTokens) assert.match(artifact.bundle, new RegExp(token));
  for (const token of admission.archive.bundleForbiddenTokens) assert.doesNotMatch(artifact.bundle, new RegExp(token));
  assert.equal(artifact.signature.keyId, admission.archive.signature.keyId);
  assert.equal(artifact.signature.releaseId, admission.archive.signature.releaseId);
  assert.match(artifact.signature.sourceCommit, new RegExp(admission.archive.signature.sourceCommitPattern));
  assert.match(artifact.signature.payloadDigest, new RegExp(admission.archive.signature.payloadDigestPattern));
  assert.equal(artifact.imported.extension.id, artifact.manifest.id);
  assert.equal(artifact.imported.extension.runtimeKind, admission.manifest.runtimeKind);
  assert.equal(typeof artifact.imported.activate, 'function');
});
