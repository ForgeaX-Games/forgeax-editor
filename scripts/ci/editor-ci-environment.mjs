#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const CI_ENVIRONMENT_CONTRACT = 'forgeax-editor-linux-x64-v2';
export const DEFAULT_BUN_VERSION = '1.3.14';

function valueOrUnknown(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'unknown';
}

export function buildEnvironmentRecord(overrides = {}) {
  const cpu = cpus()[0];
  return {
    contract: overrides.contract ?? CI_ENVIRONMENT_CONTRACT,
    runner: overrides.runner ?? valueOrUnknown(process.env.RUNNER_NAME),
    pool: overrides.pool ?? valueOrUnknown(process.env.CI_RUNNER_POOL),
    runnerOs: overrides.runnerOs ?? valueOrUnknown(process.env.RUNNER_OS),
    runnerArch: overrides.runnerArch ?? valueOrUnknown(process.env.RUNNER_ARCH),
    osRelease: overrides.osRelease ?? valueOrUnknown(process.env.CI_OS_RELEASE),
    platform: overrides.platform ?? `${platform()} ${release()}`,
    arch: overrides.arch ?? process.arch,
    bun: overrides.bun ?? (globalThis.Bun?.version ?? valueOrUnknown(process.env.BUN_VERSION)),
    bunRevision: overrides.bunRevision ?? valueOrUnknown(process.env.CI_BUN_REVISION),
    bunSource: overrides.bunSource ?? valueOrUnknown(process.env.CI_BUN_SOURCE_TYPE),
    bunSha256: overrides.bunSha256 ?? valueOrUnknown(process.env.CI_BUN_BINARY_SHA256),
    node: overrides.node ?? process.versions.node,
    configuredNode: overrides.configuredNode ?? valueOrUnknown(process.env.CI_NODE_VERSION),
    configuredPnpm: overrides.configuredPnpm ?? valueOrUnknown(process.env.CI_PNPM_VERSION),
    configuredRust: overrides.configuredRust ?? valueOrUnknown(process.env.CI_RUST_TOOLCHAIN),
    configuredWasmPack: overrides.configuredWasmPack ?? valueOrUnknown(process.env.CI_WASM_PACK_VERSION),
    compilerCommand: overrides.compilerCommand ?? valueOrUnknown(process.env.CI_COMPILER_COMMAND),
    compiler: overrides.compiler ?? valueOrUnknown(process.env.CI_COMPILER_VERSION),
    cpuModel: overrides.cpuModel ?? valueOrUnknown(cpu?.model),
    cpuCount: overrides.cpuCount ?? cpus().length,
    memoryBytes: overrides.memoryBytes ?? totalmem(),
    targetSha: overrides.targetSha ?? valueOrUnknown(process.env.GITHUB_SHA),
    event: overrides.event ?? valueOrUnknown(process.env.GITHUB_EVENT_NAME),
  };
}

function cacheIdentity(record) {
  return {
    contract: record.contract,
    pool: record.pool,
    runner: record.runner,
    runnerOs: record.runnerOs,
    runnerArch: record.runnerArch,
    osRelease: record.osRelease,
    platform: record.platform,
    arch: record.arch,
    bun: record.bun,
    bunRevision: record.bunRevision,
    bunSource: record.bunSource,
    bunSha256: record.bunSha256,
    node: record.node,
    configuredNode: record.configuredNode,
    configuredPnpm: record.configuredPnpm,
    configuredRust: record.configuredRust,
    configuredWasmPack: record.configuredWasmPack,
    compilerCommand: record.compilerCommand,
    compiler: record.compiler,
    cpuModel: record.cpuModel,
    cpuCount: record.cpuCount,
    memoryBytes: record.memoryBytes,
  };
}

export function environmentFingerprint(record) {
  return createHash('sha256')
    .update(JSON.stringify(cacheIdentity(record)))
    .digest('hex')
    .slice(0, 16);
}

export function assertBunVersion(actual, expected = DEFAULT_BUN_VERSION) {
  if (actual !== expected) {
    const error = new Error(`ci-environment-bun-mismatch: expected ${expected}, observed ${actual}`);
    error.code = 'ci-environment-bun-mismatch';
    throw error;
  }
}

export function assertRunnerContract(record, { strict = false } = {}) {
  if (!strict) return;
  const violations = [];
  if (record.runnerOs !== 'Linux') violations.push(`runnerOs expected Linux, observed ${record.runnerOs}`);
  if (record.runnerArch !== 'X64') violations.push(`runnerArch expected X64, observed ${record.runnerArch}`);
  if (!['standard', 'heavy'].includes(record.pool)) {
    violations.push(`pool expected standard or heavy, observed ${record.pool}`);
  }
  if (violations.length === 0) return;
  const error = new Error(`ci-environment-contract-mismatch: ${violations.join('; ')}`);
  error.code = 'ci-environment-contract-mismatch';
  throw error;
}

function appendOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) appendFileSync(outputFile, `${name}=${value}\n`);
}

function appendEnvironment(name, value) {
  const environmentFile = process.env.GITHUB_ENV;
  if (environmentFile) appendFileSync(environmentFile, `${name}=${value}\n`);
}

function appendSummary(record, fingerprint) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  appendFileSync(summaryFile, [
    '## CI environment',
    '',
    `- contract: \`${record.contract}\``,
    `- pool: \`${record.pool}\``,
    `- runner: \`${record.runner}\``,
    `- platform: \`${record.platform}\` (${record.runnerOs}/${record.runnerArch}); OS: \`${record.osRelease}\``,
    `- Bun: \`${record.bun}\` (revision \`${record.bunRevision}\`, source \`${record.bunSource}\`, sha256 \`${record.bunSha256}\`)`,
    `- Node ABI: \`${record.node}\`; configured Node: \`${record.configuredNode}\``,
    `- configured pnpm/Rust/wasm-pack: \`${record.configuredPnpm}\` / \`${record.configuredRust}\` / \`${record.configuredWasmPack}\``,
    `- C compiler: \`${record.compilerCommand}\` — \`${record.compiler}\``,
    `- CPU: \`${record.cpuModel}\` x ${record.cpuCount}`,
    `- memory: \`${record.memoryBytes}\` bytes`,
    `- fingerprint: \`${fingerprint}\``,
    '',
  ].join('\n'));
}

export function runEnvironmentCheck({ env = process.env } = {}) {
  const actualBun = valueOrUnknown(env.BUN_VERSION) !== 'unknown'
    ? env.BUN_VERSION
    : (globalThis.Bun?.version ?? 'unknown');
  const expectedBun = env.CI_BUN_VERSION ?? DEFAULT_BUN_VERSION;
  assertBunVersion(actualBun, expectedBun);

  const record = buildEnvironmentRecord({
    runner: env.RUNNER_NAME,
    bun: actualBun,
    pool: env.CI_RUNNER_POOL,
    runnerOs: env.RUNNER_OS,
    runnerArch: env.RUNNER_ARCH,
    osRelease: env.CI_OS_RELEASE,
    bunRevision: env.CI_BUN_REVISION,
    bunSource: env.CI_BUN_SOURCE_TYPE,
    bunSha256: env.CI_BUN_BINARY_SHA256,
    compilerCommand: env.CI_COMPILER_COMMAND,
    targetSha: env.GITHUB_SHA,
    event: env.GITHUB_EVENT_NAME,
  });
  assertRunnerContract(record, { strict: env.GITHUB_ACTIONS === 'true' });
  const fingerprint = environmentFingerprint(record);
  return { record, fingerprint };
}

function main() {
  const result = runEnvironmentCheck();
  const serialized = JSON.stringify({ ...result.record, fingerprint: result.fingerprint });
  process.stdout.write(`[ci-environment] ${serialized}\n`);
  appendOutput('fingerprint', result.fingerprint);
  appendEnvironment('CI_ENVIRONMENT_FINGERPRINT', result.fingerprint);
  appendSummary(result.record, result.fingerprint);
}

const invoked = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (invoked) main();
