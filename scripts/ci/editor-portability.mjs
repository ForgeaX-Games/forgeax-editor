#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import {
  EDITOR_CI_REPORT_SCHEMA_VERSION,
  PORTABILITY_TOOLCHAIN_KEYS,
  validateEditorCiReport,
  validatePortabilityToolchain,
} from './editor-ci-report.mjs';

export const PORTABILITY_PLATFORMS = Object.freeze(['linux', 'windows', 'macos']);
export const PORTABILITY_STAGES = Object.freeze([
  'checkout',
  'install',
  'setup',
  'wasm',
  'zero-binary',
  'type-static',
  'capability-probe',
  'smoke',
]);

const REQUIRED_STAGES = new Set(PORTABILITY_STAGES.slice(0, 6));
const SKIPPABLE_STAGES = new Set(['capability-probe', 'smoke']);
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const REQUIRED_WASM_FILES = Object.freeze([
  'packages/engine/packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm',
  'packages/engine/packages/fbx/pkg/fbx-wasm.mjs',
  'packages/engine/packages/fbx/pkg/fbx-wasm.wasm',
  'packages/engine/packages/codec/pkg/basis_transcoder.mjs',
  'packages/engine/packages/codec/pkg/basis_transcoder.wasm',
  'packages/engine/packages/codec/pkg/encode/basis_encoder.wasm',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function error(code, expected, observed, hint) {
  return { ok: false, error: { code, expected, observed, hint } };
}

function validSourceSha(value) {
  return typeof value === 'string' && SOURCE_SHA.test(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function sameValue(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function normalizeRunnerOs(value) {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized === 'ubuntu' || normalized === 'linux') return 'linux';
  if (normalized === 'windows' || normalized === 'win32') return 'windows';
  if (normalized === 'macos' || normalized === 'darwin' || normalized === 'mac') return 'macos';
  return normalized;
}

function normalizeArchitecture(value) {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized === 'x64' || normalized === 'amd64' || normalized === 'x86_64') return 'x64';
  if (normalized === 'arm64' || normalized === 'aarch64') return 'arm64';
  return normalized;
}

const CAPABILITY_MODES = Object.freeze(['headed', 'headless']);
const EXTERNAL_TRANSPORT_MAX_ATTEMPTS = 2;

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function capabilityFailureFacts(facts) {
  const missing = [];
  if (facts?.navigatorGpu !== true) missing.push('navigator.gpu');
  if (facts?.adapter !== true) missing.push('adapter');
  if (facts?.device !== true) missing.push('device');
  if (!Array.isArray(facts?.features)) missing.push('features');
  if (!nonEmptyString(facts?.backend)) missing.push('backend');
  return missing;
}

function capabilityAttempt(mode, browserChannel, outcome) {
  if (!outcome?.ok) {
    return {
      mode,
      browserChannel,
      available: false,
      error: String(outcome?.error ?? 'browser launch or probe failed'),
    };
  }
  const facts = {
    mode,
    browserChannel,
    ...(outcome.facts ?? {}),
  };
  return {
    ...facts,
    available: capabilityFailureFacts(facts).length === 0,
    missing: capabilityFailureFacts(facts),
  };
}

async function defaultBrowserModeProbe({ mode, browserChannel }) {
  let browser;
  try {
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch({
      ...(nonEmptyString(browserChannel) ? {channel: browserChannel} : {}),
      headless: mode === 'headless',
    });
    const page = await browser.newPage();
    const facts = await page.evaluate(async () => {
      const navigatorGpu = Boolean(globalThis.navigator?.gpu);
      if (!navigatorGpu) return {navigatorGpu, adapter: false, device: false, features: null, backend: null};
      let adapter = null;
      try {
        adapter = await globalThis.navigator.gpu.requestAdapter();
      } catch {
        return {navigatorGpu, adapter: false, device: false, features: null, backend: null};
      }
      if (!adapter) return {navigatorGpu, adapter: false, device: false, features: [], backend: null};
      let device = null;
      try {
        device = await adapter.requestDevice();
      } catch {
        return {
          navigatorGpu,
          adapter: true,
          device: false,
          features: [...adapter.features],
          backend: adapter.info?.backend ?? null,
        };
      }
      return {
        navigatorGpu,
        adapter: true,
        device: Boolean(device),
        features: [...adapter.features],
        backend: adapter.info?.backend ?? null,
      };
    });
    return {ok: true, facts};
  } catch (errorValue) {
    return {ok: false, error: errorValue instanceof Error ? errorValue.message : String(errorValue)};
  } finally {
    await browser?.close().catch(() => {});
  }
}

export async function probeBrowserCapability({
  browserChannel = 'chromium',
  probeMode = defaultBrowserModeProbe,
  modes = CAPABILITY_MODES,
} = {}) {
  const attempts = [];
  for (const mode of modes) {
    if (!CAPABILITY_MODES.includes(mode)) continue;
    const outcome = await probeMode({mode, headless: mode === 'headless', browserChannel});
    const attempt = capabilityAttempt(mode, browserChannel, outcome);
    attempts.push(attempt);
    if (attempt.available) {
      return {
        result: 'supported',
        browserMode: mode,
        browserChannel,
        navigatorGpu: attempt.navigatorGpu,
        adapter: attempt.adapter,
        device: attempt.device,
        features: attempt.features,
        backend: attempt.backend,
        attempts,
      };
    }
  }
  const lastFacts = [...attempts].reverse().find((attempt) => attempt.available !== false && attempt.facts);
  const missing = [...new Set(attempts.flatMap((attempt) => attempt.missing ?? []))];
  return {
    result: 'bounded-non-applicable',
    browserMode: 'unavailable',
    browserChannel,
    navigatorGpu: attempts.some((attempt) => attempt.navigatorGpu === true),
    adapter: attempts.some((attempt) => attempt.adapter === true),
    device: attempts.some((attempt) => attempt.device === true),
    features: lastFacts?.features ?? [],
    backend: lastFacts?.backend ?? null,
    attempts,
    boundary: missing.length > 0
      ? `Runtime capability probe completed, but no browser mode exposed ${missing.join(', ')}.`
      : 'Neither headed nor headless browser mode could be launched for the native smoke.',
    hint: 'Provision the requested browser channel and a usable WebGPU backend, then rerun the native portability job.',
  };
}

export function selectSmokeMode(capability) {
  if (!isObject(capability)) throw new Error('capability facts are required before smoke selection');
  if (capability.result === 'bounded-non-applicable') {
    if (!nonEmptyString(capability.boundary) || !nonEmptyString(capability.hint)) {
      throw new Error('bounded-non-applicable capability requires boundary and hint');
    }
    return {
      mode: 'unavailable',
      terminalStatus: 'skipped',
      boundary: capability.boundary,
      hint: capability.hint,
    };
  }
  if (capability.result !== 'supported') throw new Error('unsupported capability result; use supported or bounded-non-applicable');
  if (!CAPABILITY_MODES.includes(capability.browserMode)) throw new Error('capability facts are required before smoke selection');
  if (!nonEmptyString(capability.browserChannel)
    || capability.navigatorGpu !== true
    || capability.adapter !== true
    || capability.device !== true
    || !Array.isArray(capability.features)
    || !nonEmptyString(capability.backend)) {
    throw new Error('capability facts are required before smoke selection');
  }
  return {
    mode: capability.browserMode,
    terminalStatus: 'pass',
    browserChannel: capability.browserChannel,
  };
}

export function createNativeStagePlan({ platform }) {
  if (!PORTABILITY_PLATFORMS.includes(platform)) {
    throw new Error(`unsupported portability platform: ${platform}`);
  }
  return PORTABILITY_STAGES.map((stage) => ({
    stage,
    required: REQUIRED_STAGES.has(stage),
    allowsSkipped: SKIPPABLE_STAGES.has(stage),
    platform,
  }));
}

function commandResult(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    return { ok: false, status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.error.message };
  }
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

async function runCommand(commandRunner, command, args, options) {
  return await commandRunner(command, args, options);
}

function commandFailure(command, args, result) {
  return {
    ok: false,
    failureClass: 'environment',
    code: 'native-command-failed',
    expected: `${command} ${args.join(' ')} exits successfully`,
    observed: (result.stderr || result.stdout || `exit ${result.status}`).trim(),
    hint: `Repair the native command on the target platform and rerun the portability job.`,
  };
}

async function runCommands(commandRunner, commands, context) {
  const commandIdentities = [];
  for (const [command, args] of commands) {
    const result = await runCommand(commandRunner, command, args, context);
    if (!result?.ok) {
      return {
        ...commandFailure(command, args, result ?? {status: 1}),
        commandIdentities,
      };
    }
    commandIdentities.push({command, args: [...args], stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? 0});
  }
  return {ok: true, commandIdentities};
}

function defaultPlatformIdentity(platform, env) {
  return {
    os: platform,
    architecture: normalizeArchitecture(env.RUNNER_ARCH ?? process.arch),
    runnerImage: env.ImageOS ?? env.RUNNER_IMAGE ?? env.RUNNER_OS ?? '',
    toolchain: {},
  };
}

function defaultRecursivePins(commandRunner, context) {
  const result = commandRunner('git', ['submodule', 'status', '--recursive'], context);
  if (!result?.ok) return error(
    'recursive-pins-command-failed',
    'git submodule status --recursive exits successfully',
    result?.stderr || result?.stdout || 'command failed',
    'Repair recursive submodule checkout or authentication before producing portability evidence.',
  );
  const pins = (result.stdout ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^[-+ ]?([a-f0-9]{40})\s+(.+?)(?:\s+\(.+\))?$/);
      return match ? { path: match[2], pin: match[1] } : null;
    })
    .filter(Boolean);
  return pins.length > 0
    ? {ok: true, value: pins}
    : error('recursive-pins-empty', 'a non-empty recursive submodule pin list', pins, 'Initialize the required recursive submodules before producing portability evidence.');
}

function commandIdentityKey(command, args) {
  return `${command} ${args.join(' ')}`;
}

function toolchainFromCommandIdentities(commandIdentities) {
  const values = new Map((commandIdentities ?? []).map((entry) => [commandIdentityKey(entry.command, entry.args), entry.stdout.trim()]));
  return {
    bun: values.get('bun --version') ?? '',
    bunRevision: values.get('bun --revision') ?? '',
    node: values.get('node --version') ?? '',
    pnpm: values.get('pnpm --version') ?? '',
    rust: values.get('rustc --version') ?? '',
    wasmPack: values.get('wasm-pack --version') ?? '',
    emscripten: values.get('emcc --version') ?? '',
  };
}

function resolveFailureControl(failureControl, env) {
  if (isObject(failureControl)) return structuredClone(failureControl);
  const kind = typeof failureControl === 'string'
    ? failureControl
    : env.FORGEAX_PORTABILITY_FAILURE_CONTROL;
  if (!kind) return null;
  return {
    kind,
    stage: env.FORGEAX_PORTABILITY_FAILURE_STAGE,
  };
}

function controlledFailure(stage, context) {
  const control = context.failureControl;
  if (!control || typeof control.kind !== 'string') return null;
  if (control.kind === 'missing-toolchain' && stage === (control.stage ?? 'setup')) {
    return {
      ok: false,
      failureClass: 'environment',
      code: control.code ?? 'required-toolchain-missing',
      expected: control.expected ?? 'the pinned native toolchain is installed and executable',
      observed: control.observed ?? 'deliberate missing-toolchain control',
      hint: control.hint ?? 'Install the pinned native toolchain on the target runner and rerun the portability job.',
    };
  }
  if (control.kind === 'stage-failure' && stage === (control.stage ?? 'type-static')) {
    return {
      ok: false,
      failureClass: control.failureClass ?? 'environment',
      code: control.code ?? 'deliberate-stage-failure',
      expected: control.expected ?? `stage ${stage} completes successfully`,
      observed: control.observed ?? `deliberate failure control for ${stage}`,
      hint: control.hint ?? 'Repair the failed native stage and rerun the portability job.',
    };
  }
  if (control.kind === 'capability-unavailable' && stage === 'capability-probe') {
    const capability = {
      result: 'bounded-non-applicable',
      browserMode: 'unavailable',
      browserChannel: context.env.FORGEAX_PORTABILITY_BROWSER_CHANNEL ?? 'chromium',
      navigatorGpu: false,
      adapter: false,
      device: false,
      features: [],
      backend: null,
      attempts: [
        {mode: 'headed', available: false, error: 'deliberate capability-unavailable control'},
        {mode: 'headless', available: false, error: 'deliberate capability-unavailable control'},
      ],
      boundary: control.boundary ?? 'The deliberate capability-unavailable control removed both browser smoke paths.',
      hint: control.hint ?? 'Remove the capability-unavailable control and provision a supported browser before rerunning smoke.',
    };
    return {ok: true, terminalStatus: 'skipped', capability};
  }
  return null;
}

async function executeStage(stage, context) {
  const { commandRunner, cwd, env, platform, fsApi } = context;
  const controlled = controlledFailure(stage, context);
  if (controlled) return controlled;
  const commands = {
    checkout: [],
    install: [['bun', ['install', '--frozen-lockfile', '--ignore-scripts']]],
    setup: [
      ['bun', ['--version']],
      ['bun', ['--revision']],
      ['node', ['--version']],
      ['pnpm', ['--version']],
      ['rustc', ['--version']],
      ['wasm-pack', ['--version']],
      ['emcc', ['--version']],
      ['bun', ['fx', 'setup']],
    ],
    'type-static': [
      ['bun', ['run', 'typecheck']],
      ['bun', ['run', 'build']],
    ],
  };

  if (stage === 'checkout') {
    const headResult = await runCommand(commandRunner, 'git', ['rev-parse', '--verify', 'HEAD'], { cwd, env });
    if (!headResult?.ok) return commandFailure('git', ['rev-parse', '--verify', 'HEAD'], headResult ?? {status: 1});
    const observedSha = headResult.stdout.trim();
    if (observedSha !== context.sourceSha) {
      return {
        ok: false,
        failureClass: 'source',
        code: 'checkout-source-sha-mismatch',
        expected: context.sourceSha,
        observed: observedSha,
        hint: 'Checkout the requested GITHUB_SHA before running native portability stages.',
      };
    }
    return runCommands(commandRunner, [['git', ['submodule', 'update', '--init', '--recursive']]], { cwd, env });
  }

  if (stage === 'wasm') {
    const missing = REQUIRED_WASM_FILES.filter((file) => !fsApi.existsSync(resolve(cwd, file)));
    return missing.length === 0
      ? { ok: true }
      : {
          ok: false,
          failureClass: 'environment',
          code: 'required-wasm-missing',
          expected: REQUIRED_WASM_FILES,
          observed: missing,
          hint: 'Run the native wasm producers on this platform before static checks.',
        };
  }
  if (stage === 'zero-binary') {
    const result = await runCommand(commandRunner, 'git', ['ls-files', '--', '*.wasm', '*.bin'], { cwd, env });
    if (!result.ok) return commandFailure('git', ['ls-files', '--', '*.wasm', '*.bin'], result);
    const tracked = result.stdout.split(/\r?\n/).filter(Boolean);
    return tracked.length === 0
      ? { ok: true, trackedBinaryFiles: [] }
      : {
          ok: false,
          failureClass: 'source',
          code: 'zero-binary-violation',
          expected: 'no generated wasm or binary files tracked by Git',
          observed: tracked,
          hint: 'Remove generated binaries from the source tree and keep native outputs ignored.',
          trackedBinaryFiles: tracked,
        };
  }
  if (stage === 'capability-probe') {
    const capability = await probeBrowserCapability({
      browserChannel: env.FORGEAX_PORTABILITY_BROWSER_CHANNEL ?? env.FORGEAX_E2E_BROWSER_CHANNEL ?? 'chromium',
    });
    return {
      ok: true,
      terminalStatus: capability.result === 'bounded-non-applicable' ? 'skipped' : 'pass',
      capability,
    };
  }
  if (stage === 'smoke') {
    const selection = selectSmokeMode(context.capability);
    if (selection.terminalStatus === 'skipped') return {ok: true, ...selection, capability: context.capability};
    if (env.FORGEAX_PORTABILITY_RUN_SMOKE !== '1') {
      return {
        ok: true,
        terminalStatus: 'skipped',
        capability: {
          ...context.capability,
          result: 'bounded-non-applicable',
          boundary: 'The native runner was invoked without the CI smoke execution switch.',
          hint: 'Set FORGEAX_PORTABILITY_RUN_SMOKE=1 in the platform workflow and rerun the smoke stage.',
        },
      };
    }
    return runCommands(commandRunner, [
      ['bun', ['run', 'test:e2e', 'apps/standalone/e2e/__tests__/smoke-boot-play.spec.ts', 'apps/standalone/e2e/__tests__/hierarchy-ui-layout.spec.ts']],
    ], {
      cwd,
      env: {
        ...env,
        FORGEAX_BROWSER_HEADLESS: selection.mode === 'headless' ? '1' : '0',
        FORGEAX_E2E_BROWSER_CHANNEL: selection.browserChannel,
      },
    });
  }
  return runCommands(commandRunner, commands[stage] ?? [], { cwd, env });
}

function stageAttempt(stage, attempt, result) {
  return {
    attempt,
    stage,
    terminalStatus: result.terminalStatus ?? (result.ok ? 'pass' : 'failure'),
    ...(result.failureClass ? {failureClass: result.failureClass} : {}),
    ...(result.code ? {code: result.code} : {}),
    ...(result.expected !== undefined ? {expected: result.expected} : {}),
    ...(result.observed !== undefined ? {observed: result.observed} : {}),
    ...(result.hint !== undefined ? {hint: result.hint} : {}),
  };
}

async function executeStageWithRetry(stage, run) {
  const attempts = [];
  let firstFailure = null;
  let result = null;
  for (let attempt = 1; attempt <= EXTERNAL_TRANSPORT_MAX_ATTEMPTS; attempt += 1) {
    result = await run();
    if (!isObject(result)) {
      result = {
        ok: false,
        failureClass: 'environment',
        code: 'native-stage-invalid-result',
        expected: 'stage handler returns a result object',
        observed: result,
        hint: 'Return a structured stage result from the portability producer.',
      };
    }
    attempts.push(stageAttempt(stage, attempt, result));
    if (result.ok || result.failureClass !== 'external-transport' || attempt === EXTERNAL_TRANSPORT_MAX_ATTEMPTS) break;
    if (!firstFailure) firstFailure = {
      failureClass: result.failureClass,
      code: result.code,
      expected: result.expected,
      observed: result.observed,
      hint: result.hint,
      stage,
    };
  }
  return {
    ...result,
    attempts,
    ...(firstFailure ? {firstFailure} : {}),
  };
}

function stageReport({ sourceSha, platform, stage, result, matrixResults, capability, recursivePins }) {
  const terminalStatus = result.terminalStatus ?? (result.ok ? 'pass' : 'failure');
  const reportCapability = result.capability ?? capability ?? (SKIPPABLE_STAGES.has(stage)
    ? {result: 'bounded-non-applicable', browserMode: 'unavailable', browserChannel: 'unavailable', navigatorGpu: false, adapter: false, device: false, features: [], backend: null, boundary: `The ${stage} stage did not produce supported capability facts.`, hint: result.hint ?? 'Repair the capability or smoke stage and rerun the native portability job.'}
    : terminalStatus === 'failure' ? {result: 'not-applicable', stage} : null);
  const failure = terminalStatus === 'failure'
    ? {
        failureClass: result.failureClass ?? 'environment',
        code: result.code ?? 'native-stage-failed',
        expected: result.expected ?? 'native stage succeeds',
        observed: result.observed ?? 'stage failed',
        hint: result.hint ?? 'Inspect the structured stage report and repair the target platform.',
      }
    : {};
  const firstFailure = terminalStatus === 'failure'
    ? result.firstFailure ?? {
        stage,
        failureClass: failure.failureClass,
        code: failure.code,
        expected: failure.expected,
        observed: failure.observed,
        hint: failure.hint,
      }
    : result.firstFailure ?? null;
  return {
    $schema: EDITOR_CI_REPORT_SCHEMA_VERSION,
    contractVersion: EDITOR_CI_REPORT_SCHEMA_VERSION,
    checkId: 'editor-portability',
    owner: 'editor-ci',
    profile: 'nightly/scheduled',
    executionHome: 'cloud',
    provenance: { kind: 'cloud', timingDomain: 'workflow-execution', recursivePins },
    terminalStatus,
    failureClass: failure.failureClass ?? null,
    code: failure.code ?? null,
    expected: failure.expected ?? null,
    observed: failure.observed ?? null,
    hint: failure.hint ?? null,
    firstFailure,
    attempts: result.attempts ?? [{ attempt: 1, terminalStatus, stage }],
    sloClaim: null,
    prerequisiteRelease: null,
    sourceSha,
    platform,
    stage,
    capability: reportCapability,
    matrix: {
      kind: 'platform',
      sourceSha,
      platforms: [platform.os],
      terminalResults: matrixResults.map((terminal) => ({...terminal, sourceSha})),
    },
  };
}

function preflightFailureReports({ sourceSha, platform, failure, recursivePins = [] }) {
  const firstFailure = {
    ok: false,
    failureClass: failure.failureClass ?? 'environment',
    code: failure.code ?? 'native-preflight-failed',
    expected: failure.expected ?? 'native portability preflight succeeds',
    observed: failure.observed ?? 'native portability preflight failed',
    hint: failure.hint ?? 'Repair the native portability preflight and rerun the platform job.',
    attempts: [{
      attempt: 1,
      stage: PORTABILITY_STAGES[0],
      terminalStatus: 'failure',
      failureClass: failure.failureClass ?? 'environment',
      code: failure.code ?? 'native-preflight-failed',
      expected: failure.expected ?? 'native portability preflight succeeds',
      observed: failure.observed ?? 'native portability preflight failed',
      hint: failure.hint ?? 'Repair the native portability preflight and rerun the platform job.',
    }],
  };
  const matrixResults = PORTABILITY_STAGES.map((stage, index) => ({
    platform: platform.os,
    stage,
    terminalStatus: 'failure',
    sourceSha,
    ...(index === 0 ? {} : { blockedBy: PORTABILITY_STAGES[0] }),
  }));
  const reports = PORTABILITY_STAGES.map((stage, index) => {
    const result = index === 0
      ? firstFailure
      : {
          ok: false,
          failureClass: firstFailure.failureClass,
          code: 'blocked-by-stage-failure',
          expected: `stage ${stage} executes after the preceding stage succeeds`,
          observed: `blocked by ${PORTABILITY_STAGES[0]}`,
          hint: 'Repair the first failed native stage and rerun the portability job.',
          attempts: [{
            attempt: 1,
            stage,
            terminalStatus: 'failure',
            failureClass: firstFailure.failureClass,
            code: 'blocked-by-stage-failure',
            expected: `stage ${stage} executes after the preceding stage succeeds`,
            observed: `blocked by ${PORTABILITY_STAGES[0]}`,
            hint: 'Repair the first failed native stage and rerun the portability job.',
          }],
        };
    return stageReport({
      sourceSha,
      platform,
      stage,
      result,
      matrixResults,
      capability: null,
      recursivePins,
    });
  });
  return {
    reports,
    matrix: {
      kind: 'platform',
      sourceSha,
      platforms: [platform.os],
      terminalResults: matrixResults,
    },
  };
}

function writeNativeReport(reportPath, reports) {
  if (!reportPath) return;
  mkdirSync(dirname(resolve(reportPath)), { recursive: true });
  writeFileSync(resolve(reportPath), `${JSON.stringify(reports, null, 2)}\n`);
}

export async function runNativePortability({
  platform,
  cwd = process.cwd(),
  env = process.env,
  sourceSha = env.GITHUB_SHA,
  recursivePins,
  platformIdentity,
  commandRunner = commandResult,
  fsApi = { existsSync },
  stageHandlers = {},
  failureControl,
  reportPath,
} = {}) {
  createNativeStagePlan({ platform });
  const context = {
    cwd,
    env,
    platform,
    commandRunner,
    fsApi,
    sourceSha: null,
    capability: null,
    failureControl: resolveFailureControl(failureControl, env),
  };
  let resolvedSourceSha = sourceSha;
  if (!validSourceSha(resolvedSourceSha)) {
    const result = await runCommand(commandRunner, 'git', ['rev-parse', 'HEAD'], { cwd, env });
    resolvedSourceSha = result.stdout.trim();
  }
  if (!validSourceSha(resolvedSourceSha)) {
    return { ...error('source-sha-invalid', '40-character lowercase source SHA', resolvedSourceSha, 'Run the portability job from the fixed GITHUB_SHA checkout.'), reports: [] };
  }
  context.sourceSha = resolvedSourceSha;
  const providedPlatformIdentity = platformIdentity !== undefined;
  const identity = platformIdentity ?? defaultPlatformIdentity(platform, env);
  const pinResult = recursivePins === undefined
    ? defaultRecursivePins(commandRunner, {cwd, env})
    : (Array.isArray(recursivePins) && recursivePins.length > 0
      ? {ok: true, value: recursivePins}
      : error('recursive-pins-empty', 'a non-empty recursive submodule pin list', recursivePins, 'Initialize the required recursive submodules before producing portability evidence.'));
  if (!pinResult.ok) {
    const preflight = preflightFailureReports({
      sourceSha: resolvedSourceSha,
      platform: identity,
      failure: pinResult.error,
      recursivePins: [],
    });
    writeNativeReport(reportPath, preflight.reports);
    return {...pinResult, sourceSha: resolvedSourceSha, platform: identity, recursivePins: [], ...preflight};
  }
  const pins = pinResult.value;
  context.recursivePins = pins;
  const raw = [];
  let failed = null;
  for (const { stage } of createNativeStagePlan({ platform })) {
    let result;
    const handler = stageHandlers[stage];
    if (failed) {
      result = {
        ok: false,
        failureClass: failed.failureClass,
        code: 'blocked-by-stage-failure',
        expected: `stage ${stage} executes after the preceding stage succeeds`,
        observed: `blocked by ${failed.stage}`,
        hint: 'Repair the first failed native stage and rerun the platform job.',
        firstFailure: failed.firstFailure ?? {
          stage: failed.stage,
          failureClass: failed.failureClass,
          code: failed.code,
          expected: failed.expected,
          observed: failed.observed,
          hint: failed.hint,
        },
      };
    } else if (stage === 'smoke' && context.capability?.result === 'bounded-non-applicable') {
      result = {
        ok: true,
        terminalStatus: 'skipped',
        capability: context.capability,
      };
    } else {
      result = await executeStageWithRetry(stage, async () => {
        const controlled = controlledFailure(stage, context);
        if (controlled) return controlled;
        if (typeof handler === 'function') {
          return await handler({...context, sourceSha: resolvedSourceSha, recursivePins: pins, platform: identity, stage});
        }
        if (isObject(handler)) return structuredClone(handler);
        return await executeStage(stage, context);
      });
    }
    if (stage === 'setup' && !providedPlatformIdentity) {
      const toolchain = toolchainFromCommandIdentities(result.commandIdentities);
      identity.toolchain = toolchain;
      if (result.ok && Object.values(toolchain).some((value) => !nonEmptyString(value))) {
        result = {
          ok: false,
          failureClass: 'environment',
          code: 'required-toolchain-identity-missing',
          expected: 'all required native toolchain identity commands return non-empty output',
          observed: toolchain,
          hint: 'Capture the actual Bun, Node, pnpm, Rust, wasm-pack, and Emscripten command identities before producing evidence.',
          attempts: result.attempts,
        };
      } else {
        identity.toolchain = toolchain;
      }
    }
    if (stage === 'capability-probe' && result.capability) context.capability = result.capability;
    raw.push({ stage, result });
    if (!result.ok && !failed) failed = { stage, ...result };
  }
  const matrixResults = raw.map(({ stage, result }) => ({
    platform: identity.os,
    stage,
    terminalStatus: result.terminalStatus ?? (result.ok ? 'pass' : 'failure'),
  }));
  const reports = raw.map(({ stage, result }) => stageReport({
    sourceSha: resolvedSourceSha,
    platform: identity,
    stage,
    result,
    matrixResults,
    capability: context.capability,
    recursivePins: pins,
  }));
  writeNativeReport(reportPath, reports);
  const invalidReport = reports.map(validateEditorCiReport).find((result) => !result.ok);
  if (invalidReport) return { ...invalidReport, sourceSha: resolvedSourceSha, platform: identity, recursivePins: pins, reports };
  return {ok: !failed, sourceSha: resolvedSourceSha, platform: identity, recursivePins: pins, reports, trackedBinaryFiles: raw.flatMap(({result}) => result.trackedBinaryFiles ?? []), matrix: {kind: 'platform', sourceSha: resolvedSourceSha, platforms: [identity.os], terminalResults: matrixResults.map((terminal) => ({...terminal, sourceSha: resolvedSourceSha}))}, ...(failed ? {error: reports.find(({stage}) => stage === failed.stage)} : {})};
}

function aggregateError(code, expected, observed, hint) {
  return error(code, expected, observed, hint);
}

function normalizePlatformArtifact(input) {
  const reports = Array.isArray(input) ? input : input?.reports;
  if (!Array.isArray(reports)) return null;
  const first = reports[0];
  return {sourceSha: input?.sourceSha ?? first?.sourceSha, platform: input?.platform ?? first?.platform, reports, recursivePins: input?.recursivePins ?? first?.provenance?.recursivePins, trackedBinaryFiles: input?.trackedBinaryFiles ?? [], cache: input?.cache};
}

export function aggregatePlatformReports(inputs, {workflowRunId = 1, workflowRunAttempt = 1} = {}) {
  if (!Array.isArray(inputs)) return aggregateError('matrix-reports-invalid', 'an array of platform report artifacts', inputs, 'Read one schema-valid report array from every native platform.');
  const reports = inputs.map(normalizePlatformArtifact);
  if (reports.some((report) => !report)) return aggregateError('platform-stage-reports-missing', 'a report array for every platform', reports, 'Download the exact platform artifacts before aggregating the matrix.');
  const platforms = reports.map((report) => report.platform?.os);
  if (platforms.some((platform) => !PORTABILITY_PLATFORMS.includes(platform))) return aggregateError('matrix-platform-invalid', PORTABILITY_PLATFORMS, platforms, 'Use the fixed Linux, Windows, and macOS platform set.');
  if (new Set(platforms).size !== platforms.length) {
    return aggregateError('matrix-platform-duplicate', 'one platform artifact per platform', platforms, 'Remove duplicate platform artifacts before aggregation.');
  }
  if (!sameValue([...platforms].sort(), [...PORTABILITY_PLATFORMS].sort())) return aggregateError('matrix-platform-set-incomplete', [...PORTABILITY_PLATFORMS], platforms, 'Wait for all three native platform producers before declaring matrix state.');
  const sourceSha = reports[0].sourceSha;
  if (!validSourceSha(sourceSha)) return aggregateError('matrix-source-sha-invalid', 'one valid source SHA', sourceSha, 'Bind every platform artifact to the fixed source checkout SHA.');
  const pins = reports[0].recursivePins;
  if (!Array.isArray(pins) || pins.length === 0) return aggregateError('matrix-recursive-pins-missing', 'a non-empty recursive pin list', pins, 'Preserve successful recursive submodule collection in every native platform report.');
  for (const report of reports) {
    if (report.sourceSha !== sourceSha) return aggregateError('matrix-source-sha-mismatch', sourceSha, report.sourceSha, 'Do not combine platform reports from different source SHAs.');
    if (!Array.isArray(report.recursivePins) || report.recursivePins.length === 0) return aggregateError('matrix-recursive-pins-missing', 'a non-empty recursive pin list', report.recursivePins, 'Reject missing recursive provenance instead of treating it as an empty successful checkout.');
    if (!sameValue(report.recursivePins, pins)) return aggregateError('matrix-recursive-pins-mismatch', pins, report.recursivePins, 'Use one recursive submodule checkout identity for the complete source SHA.');
    const toolchainError = validatePortabilityToolchain(report.platform.toolchain);
    if (toolchainError) return aggregateError('matrix-toolchain-identity-missing', PORTABILITY_TOOLCHAIN_KEYS, report.platform.toolchain, 'Capture the complete canonical native command identities before aggregation.');
    if (!sameValue(report.platform.toolchain, reports[0].platform.toolchain)) return aggregateError('matrix-toolchain-identity-mismatch', reports[0].platform.toolchain, report.platform.toolchain, 'Compare the same observed toolchain identity across all native platforms.');
    if (report.trackedBinaryFiles?.length) return aggregateError('zero-binary-violation', [], report.trackedBinaryFiles, 'Remove tracked generated binaries before aggregation.');
    if (report.cache && (report.cache.os !== report.platform.os || report.cache.architecture !== report.platform.architecture)) {
      return aggregateError('platform-cache-provenance-invalid', { os: report.platform.os, architecture: report.platform.architecture }, report.cache, 'A cache may accelerate only the same platform and architecture; it cannot provide provenance.');
    }
  }
  const terminalResults = [];
  const platformReports = [];
  for (const report of reports) {
    if (!Array.isArray(report.reports)) return aggregateError('platform-stage-reports-missing', PORTABILITY_STAGES, report.reports, 'Each platform must publish one report for every declared stage.');
    const stages = report.reports.map((stageReportValue) => stageReportValue.stage);
    if (new Set(stages).size !== stages.length) return aggregateError('platform-stage-duplicate', 'one terminal report per platform-stage unit', stages, 'Remove duplicate stage reports instead of choosing one.');
    if (!sameValue([...stages].sort(), [...PORTABILITY_STAGES].sort())) return aggregateError('platform-stage-set-incomplete', PORTABILITY_STAGES, stages, 'Preserve one terminal result for every stage on every platform.');
    for (const stageReportValue of report.reports) {
      const validation = validateEditorCiReport(stageReportValue);
      if (!validation.ok) return aggregateError('platform-report-invalid', 'schema-valid editor portability report', validation.error, 'Repair the platform producer before aggregating its artifact.');
      if (stageReportValue.sourceSha !== sourceSha || stageReportValue.platform.os !== report.platform.os) return aggregateError('platform-report-provenance-invalid', {sourceSha, platform: report.platform.os}, stageReportValue, 'Keep every nested stage report bound to its native platform and source SHA.');
      if (stageReportValue.terminalStatus === 'failure') return aggregateError('matrix-stage-nonpass', 'no platform stage failure', stageReportValue, 'Required stages and capability/smoke failures must make the aggregate non-pass.');
      if (stageReportValue.terminalStatus === 'skipped' && !SKIPPABLE_STAGES.has(stageReportValue.stage)) return aggregateError('matrix-stage-nonpass', 'only capability-probe or smoke may be bounded skipped', stageReportValue, 'Reject unbounded or required-stage skips.');
      terminalResults.push({platform: report.platform.os, stage: stageReportValue.stage, terminalStatus: stageReportValue.terminalStatus, sourceSha});
    }
    platformReports.push({platform: report.platform.os, sourceSha, reports: report.reports});
  }
  const value = {
    $schema: EDITOR_CI_REPORT_SCHEMA_VERSION,
    contractVersion: EDITOR_CI_REPORT_SCHEMA_VERSION,
    checkId: 'editor-portability',
    owner: 'editor-ci',
    profile: 'nightly/scheduled',
    executionHome: 'cloud',
    provenance: {kind: 'cloud', timingDomain: 'workflow-execution', recursivePins: pins},
    terminalStatus: 'pass',
    failureClass: null,
    code: null,
    expected: null,
    observed: null,
    hint: null,
    firstFailure: null,
    attempts: [{attempt: workflowRunAttempt, attemptId: `workflow-run-${workflowRunId}-attempt-${workflowRunAttempt}`, status: 'pass'}],
    sloClaim: null,
    prerequisiteRelease: null,
    sourceSha,
    matrix: {kind: 'aggregate', sourceSha, workflowRunId, workflowRunAttempt, platforms: [...PORTABILITY_PLATFORMS], terminalResults, platformReports},
  };
  const validation = validateEditorCiReport(value);
  return validation.ok ? {ok: true, value} : aggregateError('aggregate-report-invalid', 'schema-valid editor-ci-report aggregate', validation.error, 'Repair the shared aggregate report projection before publishing the artifact.');
}

export function projectPortabilityRecovery({
  contract,
  aggregate,
  platformReports = [],
  platform,
  stage,
} = {}) {
  const portability = contract?.portability;
  const scheduled = portability?.entries?.scheduled;
  if (!isObject(portability) || portability.checkId !== 'editor-portability' || !isObject(scheduled)) {
    return error('recovery-contract-invalid', 'the editor-portability contract index', portability, 'Read the existing editor-ci contract before projecting a recovery action.');
  }
  const artifactPath = portability.artifact?.path;
  if (!nonEmptyString(artifactPath)) {
    return error('recovery-contract-invalid', 'portability.artifact.path', artifactPath, 'Use the producer-owned portability artifact path from the existing contract index.');
  }
  if (!isObject(aggregate) || aggregate.checkId !== 'editor-portability' || !validSourceSha(aggregate.sourceSha)) {
    return error('recovery-aggregate-invalid', 'a schema-shaped editor-portability aggregate', aggregate, 'Use the aggregate source SHA and check identity to locate the platform evidence.');
  }
  const sourceReports = [
    ...platformReports,
    ...(Array.isArray(aggregate.matrix?.platformReports) ? aggregate.matrix.platformReports : []),
  ];
  const candidate = sourceReports.find((report) => (typeof report?.platform === 'string' ? report.platform : report?.platform?.os) === platform);
  const stageReportValue = candidate?.reports?.find((report) => report.stage === stage);
  if (!stageReportValue || candidate.sourceSha !== aggregate.sourceSha) {
    return error('recovery-stage-not-found', {platform, stage, sourceSha: aggregate.sourceSha}, stageReportValue ?? null, 'Use the exact source SHA, platform, and stage report from the native producer artifact.');
  }
  const required = ['failureClass', 'code', 'expected', 'observed', 'hint'];
  const missing = required.filter((field) => !nonEmptyString(stageReportValue[field]));
  if (stageReportValue.terminalStatus !== 'failure' || missing.length > 0 || !isObject(stageReportValue.firstFailure) || !Array.isArray(stageReportValue.attempts) || stageReportValue.attempts.length === 0) {
    return error(
      'recovery-report-invalid',
      'failure report with failureClass, code, expected, observed, hint, firstFailure, and attempts',
      stageReportValue,
      'Repair the producer report contract; AI recovery must not infer failure state from logs or badges.',
    );
  }
  const retryable = stageReportValue.failureClass === 'external-transport'
    && stageReportValue.attempts.length < EXTERNAL_TRANSPORT_MAX_ATTEMPTS;
  return {
    ok: true,
    value: {
      checkId: portability.checkId,
      profile: scheduled.profile,
      artifactPath,
      sourceSha: aggregate.sourceSha,
      platform,
      stage,
      report: {
        sourceSha: candidate.sourceSha,
        platform: candidate.platform,
        stage: stageReportValue.stage,
      },
      failure: {
        failureClass: stageReportValue.failureClass,
        code: stageReportValue.code,
        expected: stageReportValue.expected,
        observed: stageReportValue.observed,
        hint: stageReportValue.hint,
        firstFailure: stageReportValue.firstFailure,
        attempts: stageReportValue.attempts,
      },
      recovery: {
        retryable,
        action: retryable ? 'retry-once' : 'repair-and-rerun',
        hint: stageReportValue.hint,
      },
    },
  };
}

function aggregateFailureReport(result, workflowRunId, workflowRunAttempt) {
  return {
    $schema: EDITOR_CI_REPORT_SCHEMA_VERSION,
    contractVersion: EDITOR_CI_REPORT_SCHEMA_VERSION,
    checkId: 'editor-portability',
    owner: 'editor-ci',
    profile: 'nightly/scheduled',
    executionHome: 'cloud',
    provenance: {kind: 'cloud', timingDomain: 'workflow-execution', recursivePins: []},
    terminalStatus: 'failure',
    failureClass: 'environment',
    code: result.error?.code ?? 'matrix-aggregate-failed',
    expected: String(result.error?.expected ?? 'a complete native matrix'),
    observed: result.error?.observed ?? 'aggregate producer failed',
    hint: result.error?.hint ?? 'Repair the first native matrix failure and rerun the exact workflow run.',
    firstFailure: {attempt: workflowRunAttempt, attemptId: `workflow-run-${workflowRunId}-attempt-${workflowRunAttempt}`, code: result.error?.code ?? 'matrix-aggregate-failed', expected: String(result.error?.expected ?? 'a complete native matrix'), observed: result.error?.observed ?? 'aggregate producer failed'},
    attempts: [{attempt: workflowRunAttempt, attemptId: `workflow-run-${workflowRunId}-attempt-${workflowRunAttempt}`, status: 'failure'}],
    sloClaim: null,
    prerequisiteRelease: null,
    sourceSha: result.sourceSha ?? null,
    matrix: {kind: 'aggregate', sourceSha: result.sourceSha ?? null, workflowRunId, workflowRunAttempt, platforms: [], terminalResults: [], platformReports: []},
  };
}

export function writeAggregateReport(reports, reportPath, identity = {}) {
  const result = aggregatePlatformReports(reports, identity);
  if (typeof reportPath !== 'string' || reportPath.length === 0) {
    return aggregateError('matrix-report-path-missing', 'a non-empty aggregate report path', reportPath, 'Provide a writable artifact path for the complete native matrix.');
  }
  mkdirSync(dirname(resolve(reportPath)), { recursive: true });
  writeFileSync(resolve(reportPath), `${JSON.stringify(result.ok ? result.value : aggregateFailureReport(result, identity.workflowRunId ?? 0, identity.workflowRunAttempt ?? 0), null, 2)}\n`);
  return result;
}

function inputValues(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1]) values.push(argv[index + 1]);
  }
  return values;
}

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--aggregate')) {
    const reportPath = argumentValue(argv, '--report');
    const inputPaths = inputValues(argv, '--input');
    const workflowRunId = Number(argumentValue(argv, '--run-id'));
    const workflowRunAttempt = Number(argumentValue(argv, '--attempt'));
    const reports = inputPaths.map((path) => JSON.parse(readFileSync(resolve(path), 'utf8')));
    const result = writeAggregateReport(reports, reportPath, {workflowRunId, workflowRunAttempt});
    process.stdout.write(`${JSON.stringify(result.ok ? { checkId: 'editor-portability', terminalStatus: result.value.terminalStatus, report: reportPath } : result)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const platform = argumentValue(argv, '--platform');
  const reportPath = argumentValue(argv, '--report');
  if (!platform || !reportPath) {
    process.stderr.write('Usage: bun scripts/ci/editor-portability.mjs --platform <linux|windows|macos> --report <path>\n');
    process.exitCode = 2;
    return;
  }
  const result = await runNativePortability({ platform, reportPath });
  process.stdout.write(`${JSON.stringify({
    checkId: 'editor-portability',
    sourceSha: result.sourceSha ?? null,
    platform: result.platform ?? null,
    terminalStatus: result.ok ? 'pass' : 'failure',
    report: reportPath,
  })}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.main) main();
