#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const PINNED_WASM_PACK_VERSION = '0.14.0';
export const PINNED_WASM_PACK_TARGET = 'x86_64-unknown-linux-musl';
export const TRUSTED_SOURCE = 'trusted-runner-preinstalled';
export const OFFICIAL_SOURCE = 'official-release-download';
export const OFFICIAL_CRATE_SOURCE = 'official-crates-io-source-build';
export const OFFICIAL_ARCHIVE_SHA256 = '278a8d668085821f4d1a637bd864f1713f872b0ae3a118c77562a308c0abfe8d';
export const OFFICIAL_CRATE_SHA256 = '85514fc651c557cd0d26b39ef72cfbdbdb490adf1a4abf1d33bf38b58db8f252';
export const OFFICIAL_CRATE_URL = `https://static.crates.io/crates/wasm-pack/wasm-pack-${PINNED_WASM_PACK_VERSION}.crate`;

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

function parseVersion(output) {
  const text = outputText(output);
  const match = text.match(/(?:^|\s)wasm-pack\s+v?(\d+\.\d+\.\d+)(?:\s|$)/i) ??
    text.match(/^v?(\d+\.\d+\.\d+)$/);
  return match?.[1] ?? '';
}

export function inspectWasmPackRuntime(executablePath, { run = runExecutable } = {}) {
  if (typeof executablePath !== 'string' || executablePath.length === 0 || !existsSync(executablePath)) {
    return { status: 'missing', executablePath };
  }

  try {
    const versionOutput = run(executablePath, ['--version']);
    const version = parseVersion(versionOutput);
    if (!version) {
      return {
        status: 'unusable',
        executablePath,
        error: `unparseable wasm-pack version: ${outputText(versionOutput)}`,
      };
    }
    return { status: 'ready', executablePath, version };
  } catch (cause) {
    return {
      status: 'unusable',
      executablePath,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export function runtimeTarget({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === 'linux' && arch === 'x64') return PINNED_WASM_PACK_TARGET;
  throw errorWithCode(
    'ci-wasm-pack-platform-unsupported',
    'the pinned CI wasm-pack archive only supports Linux x64',
    { platform, arch, expectedTarget: PINNED_WASM_PACK_TARGET },
  );
}

function resolveRelease({ expectedVersion, expectedTarget }) {
  if (expectedVersion !== PINNED_WASM_PACK_VERSION) {
    throw errorWithCode(
      'ci-wasm-pack-version-not-pinned',
      `expected pinned wasm-pack ${PINNED_WASM_PACK_VERSION}, observed ${expectedVersion}`,
      { expectedVersion, pinnedVersion: PINNED_WASM_PACK_VERSION },
    );
  }
  if (expectedTarget !== PINNED_WASM_PACK_TARGET) {
    throw errorWithCode(
      'ci-wasm-pack-target-not-pinned',
      `expected pinned target ${PINNED_WASM_PACK_TARGET}, observed ${expectedTarget}`,
      { expectedTarget, pinnedTarget: PINNED_WASM_PACK_TARGET },
    );
  }
  return {
    version: PINNED_WASM_PACK_VERSION,
    target: PINNED_WASM_PACK_TARGET,
    archiveSha256: OFFICIAL_ARCHIVE_SHA256,
    archiveUrl: `https://github.com/rustwasm/wasm-pack/releases/download/v${PINNED_WASM_PACK_VERSION}/wasm-pack-v${PINNED_WASM_PACK_VERSION}-${PINNED_WASM_PACK_TARGET}.tar.gz`,
  };
}

export function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function downloadPlan(decision) {
  return {
    mode: 'download',
    sourceType: OFFICIAL_SOURCE,
    reason: decision.reason,
  };
}

export function decideWasmPackAdmission({
  trustedPath,
  expectedVersion = PINNED_WASM_PACK_VERSION,
  expectedTarget = PINNED_WASM_PACK_TARGET,
  platform = process.platform,
  arch = process.arch,
  run = runExecutable,
} = {}) {
  const observedTarget = runtimeTarget({ platform, arch });
  if (observedTarget !== expectedTarget) {
    throw errorWithCode(
      'ci-wasm-pack-target-mismatch',
      `runner target ${observedTarget} does not match ${expectedTarget}`,
      { observedTarget, expectedTarget },
    );
  }
  resolveRelease({ expectedVersion, expectedTarget });

  const trusted = inspectWasmPackRuntime(trustedPath, { run });
  if (trusted.status !== 'ready') {
    return {
      ...downloadPlan({
        reason: trusted.status === 'missing'
          ? 'trusted-wasm-pack-missing'
          : 'trusted-wasm-pack-unusable',
      }),
      trusted,
      target: expectedTarget,
    };
  }

  if (trusted.version !== expectedVersion) {
    return {
      ...downloadPlan({ reason: 'trusted-wasm-pack-version-mismatch' }),
      trusted,
      target: expectedTarget,
    };
  }

  return {
    mode: 'reuse',
    sourceType: TRUSTED_SOURCE,
    reason: 'trusted-wasm-pack-exact-version',
    trusted,
    target: expectedTarget,
  };
}

function assertFreshRoot(rootPath) {
  if (!existsSync(rootPath)) {
    mkdirSync(rootPath, { recursive: true });
    return;
  }
  if (readdirSync(rootPath).length !== 0) {
    throw errorWithCode(
      'ci-wasm-pack-staging-destination-not-fresh',
      'run-scoped wasm-pack destination already contains files',
      { rootPath },
    );
  }
}

function defaultCopyExecutable(sourcePath, destinationPath) {
  writeFileSync(destinationPath, readFileSync(sourcePath), { flag: 'wx', mode: 0o755 });
}

function assertIsolatedDestination(sourcePath, destinationPath) {
  if (resolve(sourcePath) === resolve(destinationPath)) {
    throw errorWithCode(
      'ci-wasm-pack-staging-not-isolated',
      'trusted wasm-pack path and run-scoped destination are the same file',
      { sourcePath, destinationPath },
    );
  }
}

export function stageTrustedWasmPack({
  decision,
  installRoot,
  expectedVersion = PINNED_WASM_PACK_VERSION,
  expectedTarget = PINNED_WASM_PACK_TARGET,
  platform = process.platform,
  arch = process.arch,
  run = runExecutable,
  copy = defaultCopyExecutable,
} = {}) {
  if (!decision || decision.mode !== 'reuse' || decision.trusted?.status !== 'ready') {
    throw errorWithCode('ci-wasm-pack-staging-input-invalid', 'only an exact trusted wasm-pack admission may be staged');
  }
  if (typeof installRoot !== 'string' || installRoot.length === 0) {
    throw errorWithCode('ci-wasm-pack-staging-root-missing', 'run-scoped wasm-pack destination is required');
  }
  const sourcePath = decision.trusted.executablePath;
  const destinationPath = resolve(installRoot, 'wasm-pack');
  assertIsolatedDestination(sourcePath, destinationPath);
  assertFreshRoot(installRoot);
  copy(sourcePath, destinationPath);
  chmodSync(destinationPath, 0o755);

  const verified = verifyStagedWasmPack({
    executablePath: destinationPath,
    installRoot,
    expectedVersion,
    expectedTarget,
    sourceType: TRUSTED_SOURCE,
    platform,
    arch,
    run,
  });
  return {
    ...verified,
    mode: 'reused',
    sourceType: TRUSTED_SOURCE,
    reason: decision.reason,
    target: expectedTarget,
    archiveSha256: '',
    sourceArtifactSha256: '',
  };
}

function defaultDownload({ url, destinationPath }) {
  execFileSync(
    'curl',
    ['--fail', '--location', '--silent', '--show-error', '--output', destinationPath, url],
    { stdio: 'inherit' },
  );
}

function defaultExtract({ archivePath, installRoot }) {
  execFileSync(
    'tar',
    ['-xzf', archivePath, '-C', installRoot, '--strip-components=1'],
    { stdio: 'inherit' },
  );
}

function defaultExtractCrate({ cratePath, sourceRoot }) {
  mkdirSync(sourceRoot, { recursive: true });
  execFileSync(
    'tar',
    ['-xzf', cratePath, '-C', sourceRoot, '--strip-components=1'],
    { stdio: 'inherit' },
  );
}

function defaultCargoInstall({ sourceRoot, installRoot }) {
  execFileSync(
    'cargo',
    ['install', '--path', sourceRoot, '--locked', '--root', installRoot],
    { stdio: 'inherit' },
  );
}

export function installOfficialWasmPack({
  release,
  installRoot,
  expectedVersion = PINNED_WASM_PACK_VERSION,
  expectedTarget = PINNED_WASM_PACK_TARGET,
  platform = process.platform,
  arch = process.arch,
  run = runExecutable,
  download = defaultDownload,
  extract = defaultExtract,
} = {}) {
  if (!release || release.version !== expectedVersion || release.target !== expectedTarget) {
    throw errorWithCode('ci-wasm-pack-release-invalid', 'official wasm-pack release does not match the pinned contract', {
      expectedVersion,
      expectedTarget,
      release,
    });
  }
  if (typeof installRoot !== 'string' || installRoot.length === 0) {
    throw errorWithCode('ci-wasm-pack-staging-root-missing', 'run-scoped wasm-pack destination is required');
  }
  assertFreshRoot(installRoot);
  const archivePath = resolve(installRoot, 'wasm-pack.tar.gz');
  try {
    download({ url: release.archiveUrl, destinationPath: archivePath });
  } catch (cause) {
    throw errorWithCode(
      'ci-wasm-pack-download-unavailable',
      cause instanceof Error ? cause.message : String(cause),
      { url: release.archiveUrl },
    );
  }

  const archiveSha256 = sha256File(archivePath);
  if (archiveSha256 !== release.archiveSha256) {
    throw errorWithCode(
      'ci-wasm-pack-archive-checksum-mismatch',
      'official wasm-pack archive failed the pinned SHA-256 check',
      { expected: release.archiveSha256, observed: archiveSha256, archivePath },
    );
  }

  try {
    extract({ archivePath, installRoot });
  } catch (cause) {
    throw errorWithCode(
      'ci-wasm-pack-extraction-failed',
      cause instanceof Error ? cause.message : String(cause),
      { archivePath, installRoot },
    );
  }

  const executablePath = resolve(installRoot, 'wasm-pack');
  const verified = verifyStagedWasmPack({
    executablePath,
    installRoot,
    expectedVersion,
    expectedTarget,
    sourceType: OFFICIAL_SOURCE,
    platform,
    arch,
    run,
  });
  return {
    ...verified,
    mode: 'downloaded',
    sourceType: OFFICIAL_SOURCE,
    reason: 'official-release-archive-verified',
    target: expectedTarget,
    archiveSha256,
    sourceArtifactSha256: archiveSha256,
    archiveUrl: release.archiveUrl,
  };
}

export function installOfficialCrateWasmPack({
  installRoot,
  expectedVersion = PINNED_WASM_PACK_VERSION,
  expectedTarget = PINNED_WASM_PACK_TARGET,
  platform = process.platform,
  arch = process.arch,
  crateUrl = OFFICIAL_CRATE_URL,
  crateSha256 = OFFICIAL_CRATE_SHA256,
  download = defaultDownload,
  extract = defaultExtractCrate,
  cargoInstall = defaultCargoInstall,
  run = runExecutable,
} = {}) {
  if (expectedVersion !== PINNED_WASM_PACK_VERSION || expectedTarget !== PINNED_WASM_PACK_TARGET) {
    throw errorWithCode('ci-wasm-pack-crate-release-invalid', 'official crates.io wasm-pack source does not match the pinned contract', {
      expectedVersion,
      expectedTarget,
      pinnedVersion: PINNED_WASM_PACK_VERSION,
      pinnedTarget: PINNED_WASM_PACK_TARGET,
    });
  }
  if (typeof installRoot !== 'string' || installRoot.length === 0) {
    throw errorWithCode('ci-wasm-pack-staging-root-missing', 'run-scoped wasm-pack destination is required');
  }
  assertFreshRoot(installRoot);
  const cratePath = resolve(installRoot, `wasm-pack-${expectedVersion}.crate`);
  try {
    download({ url: crateUrl, destinationPath: cratePath });
  } catch (cause) {
    throw errorWithCode(
      'ci-wasm-pack-crate-download-unavailable',
      cause instanceof Error ? cause.message : String(cause),
      { url: crateUrl },
    );
  }

  const sourceArtifactSha256 = sha256File(cratePath);
  if (sourceArtifactSha256 !== crateSha256) {
    throw errorWithCode(
      'ci-wasm-pack-crate-checksum-mismatch',
      'official crates.io wasm-pack source failed the pinned SHA-256 check',
      { expected: crateSha256, observed: sourceArtifactSha256, cratePath },
    );
  }

  const sourceRoot = resolve(installRoot, 'source');
  try {
    extract({ cratePath, sourceRoot });
  } catch (cause) {
    throw errorWithCode(
      'ci-wasm-pack-crate-extraction-failed',
      cause instanceof Error ? cause.message : String(cause),
      { cratePath, sourceRoot },
    );
  }

  try {
    cargoInstall({ sourceRoot, installRoot });
  } catch (cause) {
    throw errorWithCode(
      'ci-wasm-pack-source-build-failed',
      cause instanceof Error ? cause.message : String(cause),
      { sourceRoot, installRoot },
    );
  }

  const executablePath = resolve(installRoot, 'bin', 'wasm-pack');
  const verified = verifyStagedWasmPack({
    executablePath,
    installRoot,
    expectedVersion,
    expectedTarget,
    sourceType: OFFICIAL_CRATE_SOURCE,
    platform,
    arch,
    run,
  });
  return {
    ...verified,
    mode: 'source-built',
    sourceType: OFFICIAL_CRATE_SOURCE,
    reason: 'official-crates-io-source-built',
    target: expectedTarget,
    archiveSha256: '',
    sourceArtifactSha256,
    crateUrl,
  };
}

export function verifyStagedWasmPack({
  executablePath,
  installRoot,
  expectedVersion = PINNED_WASM_PACK_VERSION,
  expectedTarget = PINNED_WASM_PACK_TARGET,
  sourceType,
  platform = process.platform,
  arch = process.arch,
  run = runExecutable,
} = {}) {
  if (typeof executablePath !== 'string' || executablePath.length === 0) {
    throw errorWithCode('ci-wasm-pack-runtime-path-missing', 'final wasm-pack executable path is missing');
  }
  if (typeof installRoot !== 'string' || installRoot.length === 0) {
    throw errorWithCode('ci-wasm-pack-staging-root-missing', 'run-scoped wasm-pack destination is required');
  }

  const observedTarget = runtimeTarget({ platform, arch });
  if (observedTarget !== expectedTarget) {
    throw errorWithCode('ci-wasm-pack-target-mismatch', 'final wasm-pack target is not the pinned Linux x64 target', {
      observedTarget,
      expectedTarget,
    });
  }
  const finalPath = resolve(executablePath);
  const root = resolve(installRoot);
  if (!(finalPath === root || finalPath.startsWith(`${root}${sep}`))) {
    throw errorWithCode(
      'ci-wasm-pack-runtime-outside-run-root',
      'final wasm-pack executable is outside the run-scoped install root',
      { executablePath, installRoot },
    );
  }
  if (![TRUSTED_SOURCE, OFFICIAL_SOURCE, OFFICIAL_CRATE_SOURCE].includes(sourceType)) {
    throw errorWithCode('ci-wasm-pack-source-unknown', 'final wasm-pack source type is not admitted', { sourceType });
  }

  const observed = inspectWasmPackRuntime(executablePath, { run });
  if (observed.status !== 'ready' || observed.version !== expectedVersion) {
    throw errorWithCode(
      'ci-wasm-pack-staged-runtime-mismatch',
      'final run-scoped wasm-pack is missing or has the wrong version',
      { expectedVersion, observed },
    );
  }
  const binarySha256 = sha256File(executablePath);
  if (!/^[0-9a-f]{64}$/.test(binarySha256)) {
    throw errorWithCode('ci-wasm-pack-binary-hash-invalid', 'final wasm-pack SHA-256 is malformed', { binarySha256 });
  }
  return {
    mode: 'verified',
    sourceType,
    executablePath,
    version: observed.version,
    target: expectedTarget,
    binarySha256,
  };
}

function appendEnvironment(env, name, value) {
  if (env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `${name}=${value}\n`);
}

function appendOutput(env, name, value) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function publishAdmission(result, env, installRoot) {
  appendEnvironment(env, 'CI_WASM_PACK_ADMISSION_MODE', result.mode);
  appendEnvironment(env, 'CI_WASM_PACK_SOURCE_TYPE', result.sourceType);
  appendEnvironment(env, 'CI_WASM_PACK_PATH', result.executablePath ?? '');
  appendEnvironment(env, 'CI_WASM_PACK_VERSION', result.version ?? '');
  appendEnvironment(env, 'CI_WASM_PACK_TARGET', result.target ?? '');
  appendEnvironment(env, 'CI_WASM_PACK_INSTALL_ROOT', installRoot ?? '');
  appendEnvironment(env, 'CI_WASM_PACK_ARCHIVE_SHA256', result.archiveSha256 ?? '');
  appendEnvironment(env, 'CI_WASM_PACK_SOURCE_SHA256', result.sourceArtifactSha256 ?? result.archiveSha256 ?? '');
  appendEnvironment(env, 'CI_WASM_PACK_BINARY_SHA256', result.binarySha256 ?? '');
  appendEnvironment(env, 'CI_WASM_PACK_FALLBACK_REASON', result.fallbackReason ?? '');
  appendEnvironment(env, 'CI_WASM_PACK_CARGO_VERSION', result.cargoVersion ?? env.CI_CARGO_VERSION ?? '');
  appendEnvironment(env, 'CI_WASM_PACK_RUST_VERSION', result.rustVersion ?? env.CI_RUST_VERSION ?? '');
  if (env.GITHUB_PATH && result.executablePath) appendFileSync(env.GITHUB_PATH, `${dirname(result.executablePath)}\n`);
  appendOutput(env, 'path', result.executablePath ?? '');
  appendOutput(env, 'source_type', result.sourceType ?? '');
  appendOutput(env, 'version', result.version ?? '');
  appendOutput(env, 'target', result.target ?? '');
  appendOutput(env, 'archive-sha256', result.archiveSha256 ?? '');
  appendOutput(env, 'source_sha256', result.sourceArtifactSha256 ?? result.archiveSha256 ?? '');
  appendOutput(env, 'binary_sha256', result.binarySha256 ?? '');
  appendOutput(env, 'fallback_reason', result.fallbackReason ?? '');
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, [
      '## wasm-pack admission',
      '',
      `- mode: \`${result.mode}\``,
      `- source: \`${result.sourceType}\``,
      `- version: \`${result.version}\``,
      `- target: \`${result.target}\``,
      `- archive sha256: \`${result.archiveSha256 || 'not-applicable'}\``,
      `- source sha256: \`${result.sourceArtifactSha256 || result.archiveSha256 || 'not-applicable'}\``,
      `- binary sha256: \`${result.binarySha256}\``,
      ...(result.fallbackReason ? [`- fallback reason: \`${result.fallbackReason}\``] : []),
      ...(result.cargoVersion ? [`- cargo: \`${result.cargoVersion}\``] : []),
      ...(result.rustVersion ? [`- rust: \`${result.rustVersion}\``] : []),
      '',
    ].join('\n'));
  }
}

export function admitWasmPackRuntime({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  run = runExecutable,
  copy = defaultCopyExecutable,
  download = defaultDownload,
  extract = defaultExtract,
  crateExtract = defaultExtractCrate,
  cargoInstall = defaultCargoInstall,
  crateUrl = OFFICIAL_CRATE_URL,
  crateSha256 = OFFICIAL_CRATE_SHA256,
} = {}) {
  const expectedVersion = env.CI_WASM_PACK_VERSION || PINNED_WASM_PACK_VERSION;
  const expectedTarget = env.CI_WASM_PACK_TARGET || PINNED_WASM_PACK_TARGET;
  const installRoot = env.CI_WASM_PACK_INSTALL_ROOT ||
    (env.CI_ENVIRONMENT_STATE_DIR ? resolve(env.CI_ENVIRONMENT_STATE_DIR, 'wasm-pack') : '');
  if (!installRoot) {
    throw errorWithCode('ci-wasm-pack-staging-root-missing', 'CI_ENVIRONMENT_STATE_DIR or CI_WASM_PACK_INSTALL_ROOT is required');
  }

  const decision = decideWasmPackAdmission({
    trustedPath: env.CI_TRUSTED_WASM_PACK_PATH,
    expectedVersion,
    expectedTarget,
    platform,
    arch,
    run,
  });
  let result;
  if (decision.mode === 'reuse') {
    result = stageTrustedWasmPack({
      decision,
      installRoot,
      expectedVersion,
      expectedTarget,
      platform,
      arch,
      run,
      copy,
    });
  } else {
    const release = resolveRelease({ expectedVersion, expectedTarget });
    try {
      result = installOfficialWasmPack({
        release,
        installRoot,
        expectedVersion,
        expectedTarget,
        platform,
        arch,
        run,
        download,
        extract,
      });
    } catch (error) {
      if (error?.code !== 'ci-wasm-pack-download-unavailable') throw error;
      // Only a release-asset transport failure may use the source fallback.
      // Integrity, extraction, and version failures remain fail-closed.
      rmSync(resolve(installRoot, 'wasm-pack.tar.gz'), { force: true });
      result = installOfficialCrateWasmPack({
        installRoot,
        expectedVersion,
        expectedTarget,
        platform,
        arch,
        crateUrl,
        crateSha256,
        download,
        extract: crateExtract,
        cargoInstall,
        run,
      });
      result = {
        ...result,
        fallbackReason: error.code,
        fallbackDetail: error.message,
      };
    }
  }
  const enrichedResult = {
    ...result,
    cargoVersion: env.CI_CARGO_VERSION ?? '',
    rustVersion: env.CI_RUST_VERSION ?? '',
  };
  publishAdmission(enrichedResult, env, installRoot);
  return enrichedResult;
}

export function verifyWasmPackRuntime({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  run = runExecutable,
} = {}) {
  const expectedVersion = env.CI_WASM_PACK_VERSION || PINNED_WASM_PACK_VERSION;
  const expectedTarget = env.CI_WASM_PACK_TARGET || PINNED_WASM_PACK_TARGET;
  const installRoot = env.CI_WASM_PACK_INSTALL_ROOT ||
    (env.CI_ENVIRONMENT_STATE_DIR ? resolve(env.CI_ENVIRONMENT_STATE_DIR, 'wasm-pack') : '');
  const result = verifyStagedWasmPack({
    executablePath: env.CI_WASM_PACK_PATH,
    installRoot,
    expectedVersion,
    expectedTarget,
    sourceType: env.CI_WASM_PACK_SOURCE_TYPE,
    platform,
    arch,
    run,
  });
  const enrichedResult = {
    ...result,
    archiveSha256: env.CI_WASM_PACK_ARCHIVE_SHA256 || '',
    sourceArtifactSha256: env.CI_WASM_PACK_SOURCE_SHA256 || env.CI_WASM_PACK_ARCHIVE_SHA256 || '',
    fallbackReason: env.CI_WASM_PACK_FALLBACK_REASON || '',
    cargoVersion: env.CI_WASM_PACK_CARGO_VERSION || env.CI_CARGO_VERSION || '',
    rustVersion: env.CI_WASM_PACK_RUST_VERSION || env.CI_RUST_VERSION || '',
  };
  publishAdmission(enrichedResult, env, installRoot);
  return enrichedResult;
}

function main(argv = process.argv.slice(2), env = process.env) {
  try {
    const result = argv[0] === '--verify'
      ? verifyWasmPackRuntime({ env })
      : admitWasmPackRuntime({ env });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code ?? 'ci-wasm-pack-admission'}: ${error.message ?? error}\n`);
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invoked) main();
