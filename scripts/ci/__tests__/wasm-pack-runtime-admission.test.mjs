import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, test } from 'node:test';
import {
  admitWasmPackRuntime,
  decideWasmPackAdmission,
  OFFICIAL_CRATE_SOURCE,
  installOfficialCrateWasmPack,
  installOfficialWasmPack,
  OFFICIAL_SOURCE,
  PINNED_WASM_PACK_TARGET,
  PINNED_WASM_PACK_VERSION,
  sha256File,
  stageTrustedWasmPack,
  TRUSTED_SOURCE,
} from '../wasm-pack-runtime-admission.mjs';

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-wasm-pack-admission-'));
  temporaryRoots.push(root);
  return root;
}

function fakeWasmPack(root, version = PINNED_WASM_PACK_VERSION) {
  mkdirSync(root, { recursive: true });
  const path = join(root, 'wasm-pack');
  writeFileSync(
    path,
    [
      '#!/usr/bin/env node',
      `if (process.argv[2] === "--version") process.stdout.write("wasm-pack ${version}");`,
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
    CI_WASM_PACK_VERSION: PINNED_WASM_PACK_VERSION,
    CI_WASM_PACK_TARGET: PINNED_WASM_PACK_TARGET,
    CI_TRUSTED_WASM_PACK_PATH: trustedPath,
    CI_WASM_PACK_INSTALL_ROOT: join(root, 'run-scoped', 'wasm-pack'),
    HOME: '/persistent-runner-home-must-not-be-read',
    GITHUB_ENV: join(root, 'github-env'),
    GITHUB_OUTPUT: join(root, 'github-output'),
    GITHUB_PATH: join(root, 'github-path'),
    GITHUB_STEP_SUMMARY: join(root, 'summary'),
  };
}

test('exact trusted wasm-pack is staged into the run root and fallback is not used', () => {
  const root = temporaryRoot();
  const trustedPath = fakeWasmPack(join(root, 'persistent', '.cargo', 'bin'));
  const env = baseEnvironment(root, trustedPath);

  const result = admitWasmPackRuntime({
    env,
    platform: 'linux',
    arch: 'x64',
    download: () => {
      throw new Error('official download must not run for an exact trusted runtime');
    },
  });

  assert.equal(result.mode, 'reused');
  assert.equal(result.sourceType, TRUSTED_SOURCE);
  assert.notEqual(result.executablePath, trustedPath);
  assert.match(result.executablePath, /run-scoped\/wasm-pack\/wasm-pack$/);
  assert.equal(result.version, PINNED_WASM_PACK_VERSION);
  assert.equal(result.target, PINNED_WASM_PACK_TARGET);
  assert.equal(result.binarySha256, sha256File(result.executablePath));
  const published = readFileSync(env.GITHUB_ENV, 'utf8');
  assert.match(published, /CI_WASM_PACK_SOURCE_TYPE=trusted-runner-preinstalled/);
  assert.match(published, /CI_WASM_PACK_TARGET=x86_64-unknown-linux-musl/);
  assert.match(published, new RegExp(`CI_WASM_PACK_BINARY_SHA256=${result.binarySha256}`));
  assert.match(readFileSync(env.GITHUB_PATH, 'utf8'), /run-scoped\/wasm-pack/);
});

test('missing or mismatched trusted wasm-pack selects the official fallback plan', () => {
  const root = temporaryRoot();
  const missing = decideWasmPackAdmission({
    trustedPath: join(root, 'missing', 'wasm-pack'),
    platform: 'linux',
    arch: 'x64',
  });
  assert.equal(missing.mode, 'download');
  assert.equal(missing.sourceType, OFFICIAL_SOURCE);
  assert.equal(missing.reason, 'trusted-wasm-pack-missing');

  const mismatchedPath = fakeWasmPack(join(root, 'persistent', 'wrong'), '0.13.1');
  const mismatched = decideWasmPackAdmission({
    trustedPath: mismatchedPath,
    platform: 'linux',
    arch: 'x64',
  });
  assert.equal(mismatched.mode, 'download');
  assert.equal(mismatched.reason, 'trusted-wasm-pack-version-mismatch');
});

test('official fallback verifies the archive and records both archive and binary hashes', () => {
  const root = temporaryRoot();
  const installRoot = join(root, 'run-scoped', 'wasm-pack');
  const archiveBytes = Buffer.from('deterministic wasm-pack archive fixture');
  const release = {
    version: PINNED_WASM_PACK_VERSION,
    target: PINNED_WASM_PACK_TARGET,
    archiveSha256: createHash('sha256').update(archiveBytes).digest('hex'),
    archiveUrl: 'https://example.invalid/wasm-pack.tar.gz',
  };
  const result = installOfficialWasmPack({
    release,
    installRoot,
    platform: 'linux',
    arch: 'x64',
    download: ({ destinationPath }) => writeFileSync(destinationPath, archiveBytes),
    extract: ({ installRoot: destinationRoot }) => fakeWasmPack(destinationRoot),
  });

  assert.equal(result.mode, 'downloaded');
  assert.equal(result.sourceType, OFFICIAL_SOURCE);
  assert.equal(result.archiveSha256, release.archiveSha256);
  assert.equal(result.binarySha256, sha256File(result.executablePath));
  assert.equal(result.version, PINNED_WASM_PACK_VERSION);
});

test('release transport failure falls back to the pinned crates.io source build', () => {
  const root = temporaryRoot();
  const env = baseEnvironment(root, join(root, 'missing', 'wasm-pack'));
  const crateBytes = Buffer.from('deterministic wasm-pack crate fixture');
  const crateSha256 = createHash('sha256').update(crateBytes).digest('hex');

  const result = admitWasmPackRuntime({
    env: {
      ...env,
      CI_CARGO_VERSION: 'cargo 1.93.1',
      CI_RUST_VERSION: 'rustc 1.93.1',
    },
    platform: 'linux',
    arch: 'x64',
    crateUrl: 'https://static.crates.io/wasm-pack.crate',
    crateSha256,
    download: ({ url, destinationPath }) => {
      if (!url.includes('static.crates.io')) throw new Error('release asset transport unavailable');
      writeFileSync(destinationPath, crateBytes);
    },
    crateExtract: ({ sourceRoot }) => {
      mkdirSync(sourceRoot, { recursive: true });
      writeFileSync(join(sourceRoot, 'Cargo.toml'), '[package]\nname = "wasm-pack"\nversion = "0.14.0"\n');
    },
    cargoInstall: ({ installRoot }) => fakeWasmPack(join(installRoot, 'bin')),
  });

  assert.equal(result.mode, 'source-built');
  assert.equal(result.sourceType, OFFICIAL_CRATE_SOURCE);
  assert.equal(result.sourceArtifactSha256, crateSha256);
  assert.equal(result.fallbackReason, 'ci-wasm-pack-download-unavailable');
  assert.equal(result.cargoVersion, 'cargo 1.93.1');
  assert.equal(result.rustVersion, 'rustc 1.93.1');
  assert.match(readFileSync(env.GITHUB_ENV, 'utf8'), new RegExp(`CI_WASM_PACK_SOURCE_SHA256=${crateSha256}`));
});

test('corrupt official archive fails the checksum gate before extraction', () => {
  const root = temporaryRoot();
  const installRoot = join(root, 'run-scoped', 'wasm-pack');
  const release = {
    version: PINNED_WASM_PACK_VERSION,
    target: PINNED_WASM_PACK_TARGET,
    archiveSha256: '0'.repeat(64),
    archiveUrl: 'https://example.invalid/wasm-pack.tar.gz',
  };

  assert.throws(
    () => installOfficialWasmPack({
      release,
      installRoot,
      platform: 'linux',
      arch: 'x64',
      download: ({ destinationPath }) => writeFileSync(destinationPath, 'corrupt archive'),
      extract: () => {
        throw new Error('extract must not run after checksum failure');
      },
    }),
    (error) => error.code === 'ci-wasm-pack-archive-checksum-mismatch',
  );
});

test('corrupt crates.io source fails the checksum gate before building', () => {
  const root = temporaryRoot();
  const installRoot = join(root, 'run-scoped', 'wasm-pack');

  assert.throws(
    () => installOfficialCrateWasmPack({
      installRoot,
      platform: 'linux',
      arch: 'x64',
      crateSha256: '0'.repeat(64),
      download: ({ destinationPath }) => writeFileSync(destinationPath, 'corrupt crate'),
      extract: () => {
        throw new Error('extract must not run after crate checksum failure');
      },
      cargoInstall: () => {
        throw new Error('build must not run after crate checksum failure');
      },
    }),
    (error) => error.code === 'ci-wasm-pack-crate-checksum-mismatch',
  );
});

test('trusted staging mismatch fails closed', () => {
  const root = temporaryRoot();
  const trustedPath = fakeWasmPack(join(root, 'persistent', '.cargo', 'bin'));
  const decision = decideWasmPackAdmission({ trustedPath, platform: 'linux', arch: 'x64' });

  assert.throws(
    () => stageTrustedWasmPack({
      decision,
      installRoot: join(root, 'run-scoped', 'wasm-pack'),
      platform: 'linux',
      arch: 'x64',
      copy: (_source, destination) => {
        const wrong = fakeWasmPack(join(dirname(destination), 'wrong'), '0.13.1');
        writeFileSync(destination, readFileSync(wrong));
      },
    }),
    (error) => error.code === 'ci-wasm-pack-staged-runtime-mismatch',
  );
});

test('when both official transports are unavailable, the error remains structured and fail-closed', () => {
  const root = temporaryRoot();
  const env = baseEnvironment(root, join(root, 'missing', 'wasm-pack'));

  assert.throws(
    () => admitWasmPackRuntime({
      env,
      platform: 'linux',
      arch: 'x64',
      download: () => {
        throw new Error('curl: (56) Connection died');
      },
    }),
    (error) => error.code === 'ci-wasm-pack-crate-download-unavailable' && /Connection died/.test(error.message),
  );
});

test('wrong pinned version and platform are rejected before provisioning', () => {
  const root = temporaryRoot();
  assert.throws(
    () => decideWasmPackAdmission({
      trustedPath: join(root, 'missing', 'wasm-pack'),
      expectedVersion: '0.13.1',
      platform: 'linux',
      arch: 'x64',
    }),
    (error) => error.code === 'ci-wasm-pack-version-not-pinned',
  );
  assert.throws(
    () => decideWasmPackAdmission({
      trustedPath: join(root, 'missing', 'wasm-pack'),
      platform: 'darwin',
      arch: 'arm64',
    }),
    (error) => error.code === 'ci-wasm-pack-platform-unsupported',
  );
});

test('workflow binds the same action exactly once in each cache-miss build job', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const action = readFileSync('.github/actions/wasm-pack-runtime-admission/action.yml', 'utf8');
  const environment = readFileSync('.github/actions/editor-ci-environment/action.yml', 'utf8');

  assert.match(workflow, /CI_WASM_PACK_VERSION:\s+0\.14\.0/);
  assert.match(workflow, /CI_WASM_PACK_TARGET:\s+x86_64-unknown-linux-musl/);
  assert.equal(
    workflow.match(/uses:\s+\.\/\.github\/actions\/wasm-pack-runtime-admission/g)?.length,
    3,
  );
  assert.doesNotMatch(workflow, /taiki-e\/install-action/);
  assert.match(action, /CI_ENVIRONMENT_STATE_DIR\/wasm-pack/);
  assert.match(action, /CARGO_TARGET_DIR/);
  assert.match(action, /cargo --version/);
  assert.match(action, /rustc --version/);
  assert.match(action, /source_sha256/);
  assert.match(action, /wasm-pack-runtime-admission\.mjs --verify/);
  assert.match(environment, /CI_TRUSTED_WASM_PACK_PATH=/);
  assert.match(environment, /CARGO_TARGET_DIR=\$state_root\/cargo-target/);
});
