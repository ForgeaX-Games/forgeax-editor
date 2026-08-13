#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BUN_VERSION = '1.3.14';
export const TRUSTED_SOURCE = 'trusted-runner-preinstalled';
export const DOWNLOAD_SOURCE = 'setup-bun-download';

function errorWithCode(code, message, details = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.details = details;
  return error;
}

function outputText(value) {
  return String(value).trim();
}

function runExecutable(executablePath, args) {
  return execFileSync(executablePath, args, { encoding: 'utf8' });
}

export function inspectBunRuntime(executablePath, { run = runExecutable } = {}) {
  if (typeof executablePath !== 'string' || executablePath.length === 0 || !existsSync(executablePath)) {
    return { status: 'missing', executablePath };
  }

  try {
    return {
      status: 'ready',
      executablePath,
      version: outputText(run(executablePath, ['--version'])),
      revision: outputText(run(executablePath, ['--revision'])),
    };
  } catch (cause) {
    return {
      status: 'unusable',
      executablePath,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function downloadPlan(decision) {
  return {
    mode: 'download',
    sourceType: DOWNLOAD_SOURCE,
    reason: decision.reason,
  };
}

export function decideBunAdmission({
  trustedPath,
  expectedVersion = DEFAULT_BUN_VERSION,
  run = runExecutable,
} = {}) {
  const trusted = inspectBunRuntime(trustedPath, { run });
  if (trusted.status !== 'ready') {
    return {
      ...downloadPlan({
        reason: trusted.status === 'missing'
          ? 'trusted-bun-missing'
          : 'trusted-bun-unusable',
      }),
      trusted,
    };
  }

  if (trusted.version !== expectedVersion) {
    return {
      ...downloadPlan({ reason: 'trusted-bun-version-mismatch' }),
      trusted,
    };
  }

  return {
    mode: 'reuse',
    sourceType: TRUSTED_SOURCE,
    reason: 'trusted-bun-exact-version',
    trusted,
  };
}

function defaultCopyExecutable(sourcePath, destinationPath) {
  // Reading and writing the bytes deliberately dereferences a runner-home
  // symlink. The staged file must be an independent run-scoped executable.
  writeFileSync(destinationPath, readFileSync(sourcePath), { flag: 'wx', mode: 0o755 });
}

function assertIsolatedDestination(sourcePath, destinationPath) {
  if (resolve(sourcePath) === resolve(destinationPath)) {
    throw errorWithCode(
      'ci-bun-staging-not-isolated',
      'trusted Bun path and run-scoped destination are the same file',
      { sourcePath, destinationPath },
    );
  }
}

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

export function stageTrustedBun({
  decision,
  destinationPath,
  expectedVersion = DEFAULT_BUN_VERSION,
  run = runExecutable,
  copy = defaultCopyExecutable,
} = {}) {
  if (!decision || decision.mode !== 'reuse' || decision.trusted?.status !== 'ready') {
    throw errorWithCode('ci-bun-staging-input-invalid', 'only an exact trusted Bun admission may be staged');
  }
  if (typeof destinationPath !== 'string' || destinationPath.length === 0) {
    throw errorWithCode('ci-bun-staging-destination-missing', 'run-scoped Bun destination is required');
  }

  const sourcePath = decision.trusted.executablePath;
  assertIsolatedDestination(sourcePath, destinationPath);
  mkdirSync(dirname(destinationPath), { recursive: true });
  if (existsSync(destinationPath)) {
    throw errorWithCode(
      'ci-bun-staging-destination-not-fresh',
      'run-scoped Bun destination already exists',
      { destinationPath },
    );
  }

  copy(sourcePath, destinationPath);
  chmodSync(destinationPath, 0o755);

  const staged = inspectBunRuntime(destinationPath, { run });
  if (
    staged.status !== 'ready'
    || staged.version !== expectedVersion
    || staged.revision !== decision.trusted.revision
  ) {
    throw errorWithCode(
      'ci-bun-staging-mismatch',
      'staged Bun does not exactly match the admitted trusted runtime',
      { expectedVersion, expectedRevision: decision.trusted.revision, staged },
    );
  }

  return {
    mode: 'reused',
    sourceType: TRUSTED_SOURCE,
    reason: decision.reason,
    executablePath: destinationPath,
    version: staged.version,
    revision: staged.revision,
    binarySha256: sha256File(destinationPath),
  };
}

export function verifyStagedBun({
  executablePath,
  installRoot,
  expectedVersion = DEFAULT_BUN_VERSION,
  expectedRevision,
  sourceType,
  run = runExecutable,
} = {}) {
  if (typeof executablePath !== 'string' || executablePath.length === 0) {
    throw errorWithCode('ci-bun-runtime-path-missing', 'final Bun executable path is missing');
  }
  if (typeof installRoot !== 'string' || installRoot.length === 0) {
    throw errorWithCode('ci-bun-install-root-missing', 'run-scoped BUN_INSTALL is missing');
  }

  const finalPath = resolve(executablePath);
  const root = resolve(installRoot);
  if (!(finalPath === root || finalPath.startsWith(`${root}${sep}`))) {
    throw errorWithCode(
      'ci-bun-runtime-outside-run-root',
      'final Bun executable is outside the run-scoped BUN_INSTALL',
      { executablePath, installRoot },
    );
  }

  if (![TRUSTED_SOURCE, DOWNLOAD_SOURCE].includes(sourceType)) {
    throw errorWithCode('ci-bun-source-unknown', 'final Bun source type is not admitted', { sourceType });
  }

  const observed = inspectBunRuntime(executablePath, { run });
  if (observed.status !== 'ready' || observed.version !== expectedVersion) {
    throw errorWithCode(
      'ci-bun-staged-runtime-mismatch',
      'final run-scoped Bun is missing or has the wrong version',
      { expectedVersion, observed },
    );
  }
  if (expectedRevision && observed.revision !== expectedRevision) {
    throw errorWithCode(
      'ci-bun-staged-runtime-mismatch',
      'final run-scoped Bun has the wrong revision',
      { expectedRevision, observed },
    );
  }

  return {
    mode: 'verified',
    sourceType,
    executablePath,
    version: observed.version,
    revision: observed.revision,
    binarySha256: sha256File(executablePath),
  };
}

function appendEnvironment(env, name, value) {
  if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `${name}=${value}\n`);
}

function publishAdmission(result, env) {
  appendEnvironment(env, 'CI_BUN_ADMISSION_MODE', result.mode === 'reuse' ? 'reused' : result.mode);
  appendEnvironment(env, 'CI_BUN_SOURCE_TYPE', result.sourceType);
  appendEnvironment(env, 'CI_BUN_PATH', result.executablePath ?? '');
  appendEnvironment(env, 'CI_BUN_REVISION', result.revision ?? '');
  appendEnvironment(env, 'CI_BUN_EXPECTED_REVISION', result.revision ?? '');
  appendEnvironment(env, 'CI_BUN_BINARY_SHA256', result.binarySha256 ?? '');
}

export function admitBunRuntime({
  env = process.env,
  run = runExecutable,
  stage = stageTrustedBun,
  downloadFallback = downloadPlan,
} = {}) {
  const expectedVersion = env.CI_BUN_VERSION || DEFAULT_BUN_VERSION;
  const installRoot = env.BUN_INSTALL;
  if (!installRoot) {
    throw errorWithCode('ci-bun-install-root-missing', 'run-scoped BUN_INSTALL is missing');
  }

  const decision = decideBunAdmission({
    trustedPath: env.CI_TRUSTED_BUN_PATH,
    expectedVersion,
    run,
  });
  if (decision.mode === 'download') {
    let result;
    try {
      result = downloadFallback(decision);
    } catch (cause) {
      throw errorWithCode(
        'ci-bun-download-unavailable',
        cause instanceof Error ? cause.message : String(cause),
        { reason: decision.reason },
      );
    }
    if (!result || result.mode !== 'download' || result.sourceType !== DOWNLOAD_SOURCE) {
      throw errorWithCode(
        'ci-bun-download-fallback-invalid',
        'normal setup-bun download fallback did not return an admitted download plan',
        { result },
      );
    }
    publishAdmission(result, env);
    return result;
  }

  const result = stage({
    decision,
    destinationPath: resolve(installRoot, 'bin', 'bun'),
    expectedVersion,
    run,
  });
  publishAdmission(result, env);
  return result;
}

export function verifyBunRuntime({ env = process.env, run = runExecutable } = {}) {
  const result = verifyStagedBun({
    executablePath: env.CI_BUN_PATH,
    installRoot: env.BUN_INSTALL,
    expectedVersion: env.CI_BUN_VERSION || DEFAULT_BUN_VERSION,
    expectedRevision: env.CI_BUN_EXPECTED_REVISION || undefined,
    sourceType: env.CI_BUN_SOURCE_TYPE,
    run,
  });
  publishAdmission(result, env);
  return result;
}

function main(argv = process.argv.slice(2), env = process.env) {
  const result = argv[0] === '--verify'
    ? verifyBunRuntime({ env })
    : admitBunRuntime({ env });
  process.stdout.write(`[ci-bun-admission] ${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(`[ci-bun-admission] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
