import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, test } from 'node:test';
import {
  admitBunRuntime,
  decideBunAdmission,
  DOWNLOAD_SOURCE,
  sha256File,
  stageTrustedBun,
  TRUSTED_SOURCE,
  verifyBunRuntime,
} from '../bun-runtime-admission.mjs';

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-bun-admission-'));
  temporaryRoots.push(root);
  return root;
}

function fakeBun(root, version = '1.3.14', revision = 'revision-a', name = 'bun') {
  mkdirSync(root, { recursive: true });
  const path = join(root, name);
  writeFileSync(
    path,
    [
      '#!/usr/bin/env node',
      'const argument = process.argv[2];',
      `if (argument === '--version') process.stdout.write(${JSON.stringify(version)});`,
      `else if (argument === '--revision') process.stdout.write(${JSON.stringify(revision)});`,
      'else process.exitCode = 1;',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
  return path;
}

function baseEnvironment(root, trustedPath) {
  return {
    CI_BUN_VERSION: '1.3.14',
    CI_TRUSTED_BUN_PATH: trustedPath,
    BUN_INSTALL: join(root, 'run-scoped', '.bun'),
    HOME: '/persistent-runner-home-must-not-be-read',
    GITHUB_ENV: join(root, 'github-env'),
  };
}

test('exact trusted Bun is copied into BUN_INSTALL and the download fallback is not used', () => {
  const root = temporaryRoot();
  const trustedPath = fakeBun(join(root, 'persistent', '.bun', 'bin'));
  const env = baseEnvironment(root, trustedPath);

  const result = admitBunRuntime({
    env,
    downloadFallback: () => {
      throw new Error('download fallback must not run for an exact trusted runtime');
    },
  });

  assert.equal(result.mode, 'reused');
  assert.equal(result.sourceType, TRUSTED_SOURCE);
  assert.notEqual(result.executablePath, trustedPath);
  assert.match(result.executablePath, /run-scoped\/\.bun\/bin\/bun$/);
  assert.equal(result.version, '1.3.14');
  assert.equal(result.revision, 'revision-a');
  assert.equal(result.binarySha256, sha256File(result.executablePath));
  const published = readFileSync(env.GITHUB_ENV, 'utf8');
  assert.match(published, /CI_BUN_SOURCE_TYPE=trusted-runner-preinstalled/);
  assert.match(published, /CI_BUN_REVISION=revision-a/);
  assert.match(published, new RegExp(`CI_BUN_BINARY_SHA256=${result.binarySha256}`));
});

test('missing trusted Bun selects the normal setup-bun download plan', () => {
  const root = temporaryRoot();
  const env = baseEnvironment(root, join(root, 'persistent', '.bun', 'bin', 'bun'));
  const result = admitBunRuntime({
    env,
    downloadFallback: (decision) => ({
      mode: 'download',
      sourceType: DOWNLOAD_SOURCE,
      reason: decision.reason,
    }),
  });

  assert.equal(result.mode, 'download');
  assert.equal(result.sourceType, DOWNLOAD_SOURCE);
  assert.equal(result.reason, 'trusted-bun-missing');
  assert.match(readFileSync(env.GITHUB_ENV, 'utf8'), /CI_BUN_ADMISSION_MODE=download/);
});

test('mismatched trusted Bun also selects the normal setup-bun download plan', () => {
  const root = temporaryRoot();
  const trustedPath = fakeBun(join(root, 'persistent', '.bun', 'bin'), '1.3.13');
  const decision = decideBunAdmission({ trustedPath, expectedVersion: '1.3.14' });

  assert.equal(decision.mode, 'download');
  assert.equal(decision.sourceType, DOWNLOAD_SOURCE);
  assert.equal(decision.reason, 'trusted-bun-version-mismatch');
});

test('download unavailability is injected as a structured fail-closed error', () => {
  const root = temporaryRoot();
  const env = baseEnvironment(root, join(root, 'missing', 'bun'));

  assert.throws(
    () => admitBunRuntime({
      env,
      downloadFallback: () => {
        throw new Error('socket hang up');
      },
    }),
    (error) => error.code === 'ci-bun-download-unavailable' && /socket hang up/.test(error.message),
  );
});

test('a staged version or revision mismatch fails closed before publication', () => {
  const root = temporaryRoot();
  const trustedPath = fakeBun(join(root, 'persistent', '.bun', 'bin'));
  const decision = decideBunAdmission({ trustedPath, expectedVersion: '1.3.14' });
  const destinationPath = join(root, 'run-scoped', '.bun', 'bin', 'bun');

  assert.throws(
    () => stageTrustedBun({
      decision,
      destinationPath,
      expectedVersion: '1.3.14',
      copy: (_source, destination) => fakeBun(dirname(destination), '1.3.13', 'revision-wrong', basename(destination)),
    }),
    (error) => error.code === 'ci-bun-staging-mismatch',
  );
});

test('final verification records source, revision, and hash without reading persistent HOME', () => {
  const root = temporaryRoot();
  const installRoot = join(root, 'run-scoped', '.bun');
  const executablePath = fakeBun(join(installRoot, 'bin'), '1.3.14', 'revision-download');
  const env = {
    CI_BUN_VERSION: '1.3.14',
    CI_BUN_PATH: executablePath,
    CI_BUN_SOURCE_TYPE: DOWNLOAD_SOURCE,
    CI_BUN_EXPECTED_REVISION: '',
    BUN_INSTALL: installRoot,
    HOME: '/persistent-runner-home-must-not-be-read',
    GITHUB_ENV: join(root, 'github-env'),
  };

  const result = verifyBunRuntime({ env });

  assert.equal(result.sourceType, DOWNLOAD_SOURCE);
  assert.equal(result.revision, 'revision-download');
  assert.equal(result.binarySha256, sha256File(executablePath));
  assert.match(readFileSync(env.GITHUB_ENV, 'utf8'), /CI_BUN_SOURCE_TYPE=setup-bun-download/);
  assert.match(readFileSync(env.GITHUB_ENV, 'utf8'), /CI_BUN_REVISION=revision-download/);
});
