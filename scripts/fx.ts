#!/usr/bin/env bun
// fx.ts — one-stop TypeScript entry for the standalone forgeax-editor dev stack.
// Invoke as `bun fx <cmd>` (package.json script) or `bun scripts/fx.ts <cmd>`.
//
//   bun fx setup    # prepare everything (idempotent, re-runnable)   [alias: install]
//   bun fx start    # start the standalone stack (:15290 + :15280)   [alias: run]
//   bun fx stop     # stop anything fx started (by port)
//   bun fx update   # pull root + sync submodules to pins + ff .forgeax-harness
//   bun fx clean    # restore a fully-clean git status (root + submodules)
//   bun fx ci       # run the PR CI surface locally (including frozen install)
//   bun fx help     # show usage
//
// This mirrors forgeax-studio's `bun fx` verbs (setup/start/stop/update/clean/help)
// so the two repos share one muscle-memory command vocabulary.
//
// Why this exists: the standalone editor is a SELF-CONTAINED repo — it must
// behave as if studio does NOT exist next to it. It vendors `engine` and
// `interface` as git submodules under packages/. Unlike the editor's own 5
// source-emit packages, the engine packages are dist-based (exports →
// ./dist/index.mjs) AND need a Rust-built wasm binary
// (wgpu-wasm/pkg/wgpu_wasm_bg.wasm, gitignored). Without that build step the
// stack 500s on startup (vite can't resolve @forgeax/engine-vite-plugin-shader
// / the wasm). `setup` does that build once; `start` just launches.
//
// Cross-platform: pure Node APIs (no Git-Bash / lsof / kill in the hot path
// beyond the dev-stack helpers) — runs on Windows too.
//
// Ports (see README "Run"):
//   :15290  standalone chrome host (vite, root=apps/standalone/) — the page you open
//   :15280  edit-runtime (panel + viewport iframe source); host proxies /editor → it
//   :15273  play-runtime (pure engine preview) — with `start --play`, or
//           automatically when `--game` is supplied (NOT 15173 — see
//           PLAY_RUNTIME_PORT below: studio's superrepo stack owns 15173)

import { type ChildProcess, execFileSync, spawnSync } from 'node:child_process';
import {
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  die,
  has,
  installCleanup,
  killByPorts,
  ok,
  require as requireCmd,
  spawnService,
  step,
  warn,
} from './lib/dev-stack.ts';
import {
  DEFAULT_PNPM_NETWORK_CONCURRENCY,
  engineInstallEnv,
  isHarnessSyncFailure,
  isSimpleGitHooksEnoent,
  resolveSetupEnvironment,
  type SetupEnvironmentSnapshot,
  runSupervisedCommand,
} from './lib/setup-process.ts';
import {
  REGRESSION_CONTRACT_VERSION,
  parseFixtureLayer,
  selectPrerequisiteConsumers,
  selectPrerequisitePayloadClasses,
  selectRegressionChecks,
  type FixtureLayer,
  type RegressionCheck,
  type RegressionProfile,
} from './regression-manifest.ts';
import {
  EDITOR_CI_REPORT_SCHEMA_VERSION,
  validateEditorCiReport,
} from './ci/editor-ci-report.mjs';
// @ts-ignore The baseline owner is intentionally source-first JavaScript.
import { validateBaselineEvidence } from './ci/ci-baseline.mjs';
import { resolveBunExecutable } from './ci/bun-runtime.mjs';
import {
  WORKTREE_CONFIG_FILE,
  portEnvironment,
  resolveWorktreePorts,
  type PortMap,
} from './lib/worktree-ports.ts';
import { createWorktree } from './worktree.ts';
import {
  ENGINE_CRITICAL_PACKAGES,
  ENGINE_DECLARATION_ARTIFACTS,
  hasTrustedEngineDeclarations,
} from './lib/engine-declarations.ts';
import { runDdcCli } from './ddc.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..'); // scripts/ -> repo root
const BASELINE_CONTRACT_INDEX = JSON.parse(
  readFileSync(join(ROOT, 'scripts', 'ci', 'editor-ci-contract.json'), 'utf8'),
).baselineEvidence as {
  schemaVersion: string;
  topIndex: {fields: readonly string[]; layers: readonly string[]};
};
const BASELINE_EVIDENCE_SCHEMA_VERSION = BASELINE_CONTRACT_INDEX.schemaVersion;
const BASELINE_TOP_INDEX_FIELDS = BASELINE_CONTRACT_INDEX.topIndex.fields;
const BASELINE_TOP_INDEX_LAYERS = BASELINE_CONTRACT_INDEX.topIndex.layers;
const ENGINE_DIR = join(ROOT, 'packages', 'engine');
// Gitignored freshness marker shared with forgeax-studio. Engine packages export
// built `dist/`, so a submodule pointer bump after setup otherwise leaves Vite
// happily serving the previous revision's JavaScript.
const ENGINE_DIST_SHA_FILE = join(ENGINE_DIR, '.dist-sha');
const WASM_DIR = join(ENGINE_DIR, 'packages', 'wgpu-wasm');
const WASM_FILE = join(WASM_DIR, 'pkg', 'wgpu_wasm_bg.wasm');
// `pkg/` is gitignored and survives setup/clean, so presence alone cannot prove
// that the generated binary matches the currently pinned Rust sources. Keep the
// source content key beside the generated bundle; it is written only after a
// successful setup-owned build and is ignored with the rest of `pkg/`.
const WASM_CONTENT_KEY_SCRIPT = join(WASM_DIR, 'scripts', 'content-key.mjs');
const WASM_CONTENT_KEY_FILE = join(WASM_DIR, 'pkg', '.forgeax-wgpu-wasm-content-key');
// fbx wasm: ufbx compiled by emcc; pkg/ is gitignored (zero-binary invariant)
// like wgpu, so it must be built here. Both emcc outputs (.mjs glue + .wasm)
// are needed — editor-core's fbx-cook lazily imports the .mjs, which fetches the
// .wasm at runtime. NOTE the engine's collapse-fbx-to-ufbx refactor (#603) folded
// the old packages/fbx-wasm/ into packages/fbx/ (@forgeax/engine-fbx); the build
// output + package name moved with it.
const FBX_WASM_DIR = join(ENGINE_DIR, 'packages', 'fbx');
const FBX_WASM_MJS = join(FBX_WASM_DIR, 'pkg', 'fbx-wasm.mjs');
const FBX_WASM_FILE = join(FBX_WASM_DIR, 'pkg', 'fbx-wasm.wasm');
// codec wasm: basis_universal transcoder + encoder compiled by emcc; pkg/ is
// gitignored (zero-binary invariant) like fbx/wgpu. The editor RUNTIME lazily
// imports pkg/basis_transcoder.mjs to transcode KTX2 textures at scene load —
// a missing pkg/ 404s that module and every KTX2-backed material fails with
// "asset-parse-failed" (feedback: 2026-08-05 codec-pkg-wiped-by-clean). The
// encoder half (pkg/encode/) serves the import/cook pipeline. Presence markers
// mirror the engine package's own scripts/ensure-wasm.mjs (transcoder + encoder
// .wasm), plus the transcoder .mjs glue the runtime actually fetches.
const CODEC_WASM_DIR = join(ENGINE_DIR, 'packages', 'codec');
const CODEC_WASM_MJS = join(CODEC_WASM_DIR, 'pkg', 'basis_transcoder.mjs');
const CODEC_WASM_FILE = join(CODEC_WASM_DIR, 'pkg', 'basis_transcoder.wasm');
const CODEC_ENCODER_WASM_FILE = join(CODEC_WASM_DIR, 'pkg', 'encode', 'basis_encoder.wasm');
// 15281 = standalone game-backend (platform-io reuse, R3); only with --game.
// Editor's OWN play-runtime port. Deliberately NOT 15173: the studio superrepo
// stack (forgeax-studio scripts/run.ts) launches THIS package's play-runtime on
// 15173 (its PORT_ENGINE default, via `bun x vite` with no FORGEAX_ENGINE_PORT),
// so if the editor stack managed/killed 15173 its port-based killByPorts would
// SIGTERM studio's engine (feedback 2026-07-13-editor-studio-15173-port-collision).
// Keeping our own stack on 15273 lets both coexist. NOTE: the raw
// `bun -F @forgeax/editor-play-runtime dev` path still defaults to 15173
// (play-runtime/vite.config.ts default — unchanged, so studio keeps working);
// only fx orchestration pins 15273 (fed via the base `env` FORGEAX_ENGINE_PORT).
let WORKTREE_PORTS: PortMap;
try {
  WORKTREE_PORTS = resolveWorktreePorts(ROOT);
} catch (error) {
  console.error(`[fx] invalid worktree port configuration: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const STANDALONE_PORT = WORKTREE_PORTS.standalone;
const EDIT_RUNTIME_PORT = WORKTREE_PORTS.editRuntime;
const PLAY_RUNTIME_PORT = WORKTREE_PORTS.playRuntime;
// The RHI reviewer is a separate dev-only engine app. It receives capture
// artifacts by URL from the editor host, so opening a frame needs no file picker.
const RHI_REVIEWER_PORT = WORKTREE_PORTS.rhiReviewer;
// 15296 = editor standalone's DEV-only live gateway bridge relay. Studio's
// superrepo stack owns :15295; do not reuse it here.
// These are editor-owned service ports. The bridge port is appended dynamically
// below so FORGEAX_BRIDGE_PORT overrides are cleaned up without sweeping a
// hard-coded Studio port.
const GAME_API_PORT = WORKTREE_PORTS.gameApi;
const PORTS = [STANDALONE_PORT, EDIT_RUNTIME_PORT, GAME_API_PORT, PLAY_RUNTIME_PORT, RHI_REVIEWER_PORT];
// The gateway scripts live under the forgeax-editor-gateway skill (AI-first:
// the AI tools and their harness ship together). ROOT-relative because
// spawnService runs with cwd=ROOT. `ws` still resolves — bun walks up to the
// root node_modules from any depth.
const GATEWAY_RELAY_SCRIPT = 'skills/forgeax-editor-gateway/scripts/gateway-bridge-server.mjs';

const IS_WIN = process.platform === 'win32';

export type SetupInstallFailure = {
  phase: string;
  code: string;
  expected: string;
  observed: unknown;
  hint: string;
};

type SetupFailureContext = Pick<SetupInstallFailure, 'phase' | 'code' | 'expected' | 'hint'>;
type ShOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  failureMessage?: string;
  failure?: SetupFailureContext;
};

export function projectSetupCommandFailure(
  command: string,
  args: readonly string[],
  status: number,
  context: SetupFailureContext,
): SetupInstallFailure {
  return {
    ...context,
    observed: {command, args, status},
  };
}

class SetupExecutionError extends Error {
  constructor(readonly failure: SetupInstallFailure) {
    super(failure.hint);
    this.name = 'SetupExecutionError';
  }
}

let setupExecutionActive = false;

function setupFailure(
  phase: string,
  code: string,
  expected: string,
  observed: unknown,
  hint: string,
): SetupExecutionError {
  return new SetupExecutionError({phase, code, expected, observed, hint});
}

/** Run a command synchronously with inherited stdio; die on non-zero exit. */
function sh(cmd: string, args: string[], opts: ShOptions = {}): void {
  const env = opts.env ?? process.env;
  const r = spawnSync(resolveBunExecutable(cmd, env), args, {
    stdio: 'inherit',
    shell: IS_WIN,
    cwd: opts.cwd ?? ROOT,
    env,
  });
  if (r.status !== 0) {
    if (setupExecutionActive) {
      throw new SetupExecutionError(projectSetupCommandFailure(
        cmd,
        args,
        r.status ?? 1,
        opts.failure ?? {
          phase: 'setup-command',
          code: 'setup-command-failed',
          expected: 'setup command exits with status 0',
          hint: opts.failureMessage ?? `command failed: ${cmd} ${args.join(' ')}`,
        },
      ));
    }
    die(opts.failureMessage ?? `command failed: ${cmd} ${args.join(' ')}`);
  }
}

/** Run a command synchronously with inherited stdio; return false on failure. */
function trySh(cmd: string, args: string[], opts: ShOptions = {}): boolean {
  const env = opts.env ?? process.env;
  const r = spawnSync(resolveBunExecutable(cmd, env), args, {
    stdio: 'inherit',
    shell: IS_WIN,
    cwd: opts.cwd ?? ROOT,
    env,
  });
  return r.status === 0;
}

export type CapturedCommandResult = {status: number; output: string};

function runCaptured(cmd: string, args: string[], opts: ShOptions = {}): CapturedCommandResult {
  const env = opts.env ?? process.env;
  const result = spawnSync(resolveBunExecutable(cmd, env), args, {
    cwd: opts.cwd ?? ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    shell: IS_WIN,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  const stdout = `${result.stdout ?? ''}`;
  const stderr = `${result.stderr ?? ''}`;
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const spawnError = result.error instanceof Error ? `\n${result.error.message}` : '';
  return {status: result.status ?? 1, output: `${stdout}\n${stderr}${spawnError}`};
}

export type SetupCommandRunner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => CapturedCommandResult;

export type SetupInstallTrace = {
  setupEnv: SetupEnvironmentSnapshot;
  engineEnv?: NodeJS.ProcessEnv;
  editorInstallSkipped: boolean;
  fallbacks: string[];
  terminalStatus: 'success' | 'failure';
  failure?: SetupInstallFailure;
};

function dependencyFailure(
  phase: string,
  code: string,
  result: CapturedCommandResult,
  hint: string,
): SetupInstallFailure {
  return {
    phase,
    code,
    expected: 'setup dependency command exits with status 0',
    observed: {status: result.status, output: result.output},
    hint,
  };
}

/** Run Bun and Engine dependency installs from one immutable setup snapshot. */
export function runSetupDependencyInstalls(options: {
  env: NodeJS.ProcessEnv;
  run: SetupCommandRunner;
  beforeEngineInstall?: () => void;
} & ({skipEditorInstall?: false} | {skipEditorInstall: true})): SetupInstallTrace {
  const setupEnv = resolveSetupEnvironment(options.env);
  const fallbacks: string[] = [];
  let installEnv = setupEnv.env;
  const editorInstallSkipped = options.skipEditorInstall === true || options.env.FORGEAX_SKIP_EDITOR_BUN_INSTALL === '1';

  if (!editorInstallSkipped) {
    const first = options.run('bun', ['install'], {...installEnv});
    if (first.status !== 0) {
      if (isSimpleGitHooksEnoent(first.output)) {
        fallbacks.push('simple-git-hooks-enoent-retry');
        const retry = options.run('bun', ['install'], {...installEnv});
        if (retry.status !== 0) {
          return {
            setupEnv,
            editorInstallSkipped,
            fallbacks,
            terminalStatus: 'failure',
            failure: dependencyFailure(
              'editor-bun-install',
              'bun-install-failed',
              retry,
              'Check network access and rerun bun fx setup.',
            ),
          };
        }
      } else if (isHarnessSyncFailure(first.output)) {
        fallbacks.push('harness-divergence');
        installEnv = {...installEnv, FORGEAX_SKIP_HARNESS_SYNC: '1'};
        const retry = options.run('bun', ['install'], {...installEnv});
        if (retry.status !== 0) {
          return {
            setupEnv,
            editorInstallSkipped,
            fallbacks,
            terminalStatus: 'failure',
            failure: dependencyFailure(
              'editor-bun-install-fallback',
              'bun-install-fallback-failed',
              retry,
              'Reconcile the Harness checkout or rerun with FORGEAX_SKIP_HARNESS_SYNC=1.',
            ),
          };
        }
      } else {
        return {
          setupEnv,
          editorInstallSkipped,
          fallbacks,
          terminalStatus: 'failure',
          failure: dependencyFailure(
            'editor-bun-install',
            'bun-install-failed',
            first,
            'Check network access and rerun bun fx setup.',
          ),
        };
      }
    }
  }

  options.beforeEngineInstall?.();
  const engineEnv = engineInstallEnv(installEnv);
  const engine = options.run('pnpm', ['install'], {...engineEnv});
  if (engine.status !== 0) {
    return {
      setupEnv,
      engineEnv,
      editorInstallSkipped,
      fallbacks,
      terminalStatus: 'failure',
      failure: dependencyFailure(
        'engine-pnpm-install',
        'pnpm-install-failed',
        engine,
        'Check Engine dependency access and rerun bun fx setup.',
      ),
    };
  }

  return {
    setupEnv,
    engineEnv,
    editorInstallSkipped,
    fallbacks,
    terminalStatus: 'success',
  };
}

export type SetupHarnessMode = 'sparse' | 'full' | 'skip' | 'fallback-skip' | 'unknown';

export type SetupEnvelope = {
  // Keep this list aligned with the stdout fx-setup/v1 contract tests.
  schemaVersion: 'fx-setup/v1';
  terminalStatus: 'success' | 'failure';
  phase: string;
  code: string;
  expected: string;
  observed: unknown;
  hint: string;
  effectiveSparseValue: string;
  valueSource: 'default' | 'explicit';
  requestedEditorHarnessMode: SetupHarnessMode;
  requestedEngineHarnessMode: SetupHarnessMode;
  actualEditorHarnessMode: SetupHarnessMode;
  actualEngineHarnessMode: SetupHarnessMode;
  fallbacks: string[];
  artifactsVerified: boolean;
};

export type SetupEnvelopeInput = Omit<SetupEnvelope, 'schemaVersion'>;

/** Build the single machine-readable terminal result for `bun fx setup`. */
export function createSetupEnvelope(input: SetupEnvelopeInput): SetupEnvelope {
  return {
    schemaVersion: 'fx-setup/v1',
    terminalStatus: input.terminalStatus,
    phase: input.phase,
    code: input.code,
    expected: input.expected,
    observed: input.observed,
    hint: input.hint,
    effectiveSparseValue: input.effectiveSparseValue,
    valueSource: input.valueSource,
    requestedEditorHarnessMode: input.requestedEditorHarnessMode,
    requestedEngineHarnessMode: input.requestedEngineHarnessMode,
    actualEditorHarnessMode: input.actualEditorHarnessMode,
    actualEngineHarnessMode: input.actualEngineHarnessMode,
    fallbacks: input.fallbacks,
    artifactsVerified: input.artifactsVerified,
  };
}

export function formatSetupEnvelope(envelope: SetupEnvelope): string {
  return JSON.stringify(envelope);
}

function printSetupEnvelope(envelope: SetupEnvelope): void {
  console.log(formatSetupEnvelope(envelope));
}

function requestedHarnessMode(
  env: NodeJS.ProcessEnv,
  fallback: boolean,
): SetupHarnessMode {
  if (fallback) return 'fallback-skip';
  if (env.FORGEAX_SKIP_HARNESS_SYNC === '1') return 'skip';
  return env.FORGEAX_HARNESS_SPARSE_DOCS === '0' ? 'full' : 'sparse';
}

/**
 * Read the materialized Harness shape without treating a request as a fact.
 * A missing/inaccessible clone is deliberately unknown: setup can continue
 * after an offline best-effort sync, but the terminal envelope must not claim
 * that a sparse/full checkout exists when it does not.
 */
function actualHarnessMode(dir: string): SetupHarnessMode {
  try {
    const isWorktree = execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (isWorktree !== 'true') return 'unknown';
    const sparseResult = spawnSync('git', ['-C', dir, 'config', '--get', 'core.sparseCheckout'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Git exits 1 for a missing optional config key; that is the normal full
    // checkout shape, not a probe failure.
    if (sparseResult.error || (sparseResult.status !== 0 && sparseResult.status !== 1)) {
      return 'unknown';
    }
    const sparse = sparseResult.stdout.trim();
    if (sparse !== 'true') return 'full';
    const patterns = execFileSync('git', ['-C', dir, 'sparse-checkout', 'list'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split(/\r?\n/).filter(Boolean);
    return patterns.length === 1 && patterns[0] === 'docs' ? 'sparse' : 'unknown';
  } catch {
    return 'unknown';
  }
}

function setupEnvelopeFromTrace(
  trace: SetupInstallTrace,
  input: Pick<SetupEnvelopeInput, 'terminalStatus' | 'phase' | 'code' | 'expected' | 'observed' | 'hint' | 'artifactsVerified'>,
): SetupEnvelope {
  const editorEnv = trace.setupEnv.env;
  const engineEnv = trace.engineEnv ?? editorEnv;
  const fallback = trace.fallbacks.includes('harness-divergence');
  return createSetupEnvelope({
    ...input,
    effectiveSparseValue: trace.setupEnv.effectiveSparseValue,
    valueSource: trace.setupEnv.valueSource,
    requestedEditorHarnessMode: requestedHarnessMode(editorEnv, fallback),
    requestedEngineHarnessMode: requestedHarnessMode(engineEnv, fallback),
    actualEditorHarnessMode: actualHarnessMode(join(ROOT, '.forgeax-harness')),
    actualEngineHarnessMode: actualHarnessMode(join(ENGINE_DIR, '.forgeax-harness')),
    fallbacks: [...trace.fallbacks],
  });
}

/** Resolve the exact Engine source revision that the current checkout pins. */
function engineHead(): string {
  const head = gitOut(['-C', ENGINE_DIR, 'rev-parse', 'HEAD']);
  if (!head) die('could not resolve the engine submodule revision. Run: bun fx setup');
  return head;
}

/** Record that every Engine dist artifact was built for the current gitlink. */
function writeEngineDistSha(): void {
  writeFileSync(ENGINE_DIST_SHA_FILE, `${engineHead()}\n`);
}

/**
 * Use the Engine root compiler for every recursive declaration pass.
 *
 * Engine's workspace packages intentionally carry a few older TypeScript
 * ranges for their package-local tooling, while the Engine root owns the
 * declaration graph compiler.  Resolving `tsc` through `pnpm -r exec` lets a
 * consumer package select one of those older binaries; that breaks as soon as
 * a newer package tsconfig uses an option introduced by the root compiler
 * (for example `ignoreDeprecations: "6.0"`).  Keep setup and CI on the same
 * producer-owned compiler by invoking its absolute binary explicitly.
 */
function engineTypeScriptBin(): string {
  return join(ENGINE_DIR, 'node_modules', 'typescript', 'bin', 'tsc');
}

/** Generated Engine output is reusable only when its source provenance is trustworthy. */
function engineDeclarationsAreTrusted(): boolean {
  const current = gitOut(['-C', ENGINE_DIR, 'rev-parse', 'HEAD']);
  if (!current) return false;

  let sourceStatus: string;
  try {
    sourceStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: ENGINE_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return false;
  }
  if (sourceStatus) return false;

  const builtFor = existsSync(ENGINE_DIST_SHA_FILE)
    ? readFileSync(ENGINE_DIST_SHA_FILE, 'utf8').trim()
    : '';
  if (builtFor !== current) return false;

  return hasTrustedEngineDeclarations({
    engineDir: ENGINE_DIR,
    currentHead: current,
    builtFor,
    sourceStatus,
  });
}

/** Refuse to start/CI against dist emitted for a different Engine revision. */
function requireFreshEngineDist(failurePrefix?: string): void {
  const current = engineHead();
  const builtFor = existsSync(ENGINE_DIST_SHA_FILE)
    ? readFileSync(ENGINE_DIST_SHA_FILE, 'utf8').trim()
    : '';
  if (builtFor !== current) {
    const message =
      'engine dist is stale for the current submodule pin. Run: bun fx setup ' +
      `(built ${builtFor || 'unknown'}, current ${current}).`;
    die(failurePrefix ? `${failurePrefix} — ${message}` : message);
  }
}

// ── git helpers (update / clean) ─────────────────────────────────────────────
// Mirrors forgeax-studio's `bun fx update`/`clean`. Pure Node so the standalone
// editor's cross-platform invariant holds (no bash/lsof/kill dependency).

type StepResult = 'ok' | 'failed' | 'skipped';
type ReportRow = { step: string; result: StepResult; detail?: string };

/** git → trimmed stdout; '' on any failure (never throws). */
function gitOut(args: string[]): string {
  try {
    // stderr → 'ignore' so expected failures (e.g. `rev-parse stash@{0}` with no
    // stash) don't leak a scary `fatal:` line; we signal failure via '' return.
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** git with inherited stdio; returns exit status (0 = ok). dry-run just logs. */
function gitRun(args: string[], dryRun = false): number {
  if (dryRun) {
    console.log(`  [dry-run] git ${args.join(' ')}`);
    return 0;
  }
  const r = spawnSync('git', args, { cwd: ROOT, stdio: 'inherit' });
  return r.status ?? 1;
}

function isDirty(): boolean {
  return gitOut(['status', '--porcelain']) !== '';
}

function currentBranch(): string {
  return gitOut(['rev-parse', '--abbrev-ref', 'HEAD']) || '?';
}

function upstream(): string {
  return gitOut(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
}

/** Parse `git config --get-regexp` output → submodule paths (SSOT: .gitmodules). */
function submodulePaths(): string[] {
  const raw = gitOut(['config', '--file', '.gitmodules', '--get-regexp', 'path']);
  return raw
    .split('\n')
    .map((line) => line.trim().split(/\s+/).slice(1).join(' ').trim())
    .filter(Boolean);
}

/** Render an aligned RESULT/STEP/DETAIL report (mirrors studio's update table). */
function report(rows: ReportRow[]): string {
  const header = ['RESULT', 'STEP', 'DETAIL'];
  const cells = rows.map((r) => [r.result.toUpperCase(), r.step, r.detail ?? '']);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => (c[i] ?? '').length)));
  const color = (txt: string, result: StepResult): string => {
    if (result === 'ok') return `\x1b[32m${txt}\x1b[0m`;
    if (result === 'failed') return `\x1b[31m${txt}\x1b[0m`;
    return txt;
  };
  const line = (c: string[], result?: StepResult): string =>
    c
      .map((cell, i) => (i === 0 && result ? color(cell.padEnd(widths[i] ?? 0), result) : cell.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [
    line(header),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...rows.map((r, i) => line(cells[i] ?? [], r.result)),
  ].join('\n');
}

// ── update ───────────────────────────────────────────────────────────────────
// Pull latest root code, then sync EVERY submodule (engine + interface +
// platform-io + assets, recursively) to their recorded pins, then fast-forward
// the .forgeax-harness floating clone. Local edits are auto-stashed and restored
// (opt out with --no-stash). --dry-run previews without touching anything.
function update(argv: string[]): void {
  requireCmd('git', 'install git first.');
  const dryRun = argv.includes('--dry-run') || argv.includes('-n');
  const stash = !argv.includes('--no-stash');
  const rows: ReportRow[] = [];
  const push = (s: string, result: StepResult, detail?: string): void => {
    rows.push({ step: s, result, detail });
  };

  step('update: checking working tree ...');
  let stashed = false;
  if (isDirty()) {
    if (!stash) die('local changes detected; commit/stash them or drop --no-stash.');
    const msg = `forgeax pre-update ${new Date().toISOString()}`;
    const before = gitOut(['rev-parse', '--verify', 'stash@{0}']);
    gitRun(['stash', 'push', '-u', '-m', msg], dryRun);
    const after = dryRun ? before : gitOut(['rev-parse', '--verify', 'stash@{0}']);
    stashed = dryRun || (after !== '' && after !== before);
    push('stash', stashed ? 'ok' : 'skipped', stashed ? 'stashed local changes' : 'nothing stashed');
  } else {
    ok('working tree clean');
  }

  // root pull (ff-only, never recurse — submodules are handled explicitly below)
  step(`update: pulling ${currentBranch()} ...`);
  let rootOk: boolean;
  if (upstream()) {
    rootOk = gitRun(['pull', '--ff-only', '--no-recurse-submodules'], dryRun) === 0;
    push('root', rootOk ? 'ok' : 'failed', rootOk ? 'pulled latest' : 'git pull --ff-only failed');
  } else {
    warn('no upstream — fetching origin/main and rebasing');
    const fetched = gitRun(['fetch', '--no-recurse-submodules', 'origin', 'main'], dryRun) === 0;
    rootOk = fetched && gitRun(['rebase', 'origin/main'], dryRun) === 0;
    push('root', rootOk ? 'ok' : 'failed', rootOk ? 'rebased onto origin/main' : 'fetch/rebase failed');
  }

  // submodules → recorded pins
  if (rootOk) {
    const paths = submodulePaths();
    if (paths.length === 0) push('submodules', 'skipped', 'none configured');
    for (const p of paths) {
      step(`update: submodule ${p} ...`);
      const okStatus = gitRun(['submodule', 'update', '--init', '--recursive', '--', p], dryRun) === 0;
      push(`sub:${p}`, okStatus ? 'ok' : 'failed', okStatus ? 'synced to recorded pin' : 'submodule update failed');
    }
  } else {
    push('submodules', 'skipped', 'root update failed');
  }

  // .forgeax-harness floating clone (gitignored, not a submodule)
  step('update: syncing .forgeax-harness ...');
  if (dryRun) {
    console.log('  [dry-run] node scripts/sync-harness.mjs');
    push('harness', 'skipped', 'dry-run');
  } else {
    const r = spawnSync('node', [join(HERE, 'sync-harness.mjs')], { cwd: ROOT, stdio: 'inherit' });
    const okStatus = (r.status ?? 1) === 0;
    push('harness', okStatus ? 'ok' : 'failed', okStatus ? 'fast-forwarded floating clone' : 'sync-harness exited nonzero');
  }

  // restore stash
  if (stashed && !dryRun) {
    step('update: restoring pre-update stash ...');
    const okStatus = gitRun(['stash', 'pop']) === 0;
    push('unstash', okStatus ? 'ok' : 'failed', okStatus ? 'restored local changes' : 'stash pop conflicted — resolve manually');
  }

  console.log(`\n${report(rows)}`);
  if (rows.some((r) => r.result === 'failed')) die('update: one or more steps failed — see report above.');
  ok('update complete');
}

// ── clean ────────────────────────────────────────────────────────────────────
// Restore a fully-clean `git status` across root + every submodule (recursively,
// incl. the editor→engine nesting). Root/submodule asymmetry (mirrors studio):
//   • ROOT keeps gitignored artefacts (node_modules / dist / wasm pkg) by default
//     so no re-install is needed. --deep/-x wipes those too (re-run setup after).
//   • SUBMODULES are always deep-scrubbed (-ffdx) — a submodule reports "modified"
//     to the superproject on ANY untracked content, and the only leftovers are
//     regenerable gitignored runtime products (engine build/, dist, node_modules).
//     EXCEPTION: the toolchain-gated wasm pkg/ dirs (engine packages/fbx/pkg,
//     packages/wgpu-wasm/pkg, packages/codec/pkg) are preserved — they are
//     gitignored (so they never dirty the superproject's submodule status) but
//     NOT freely regenerable: fbx/codec need the prebuilt GitHub release
//     (network + auth) or a local Emscripten toolchain, wgpu needs
//     Rust/wasm-pack. Wiping them made every `clean` → `setup` fail offline
//     (feedback: clean-scrub-wipes-fbx-wasm); a wiped codec/pkg additionally
//     slipped through setup silently (codec's postinstall is best-effort) and
//     404'd basis_transcoder.mjs at runtime, failing every KTX2 material
//     (feedback: 2026-08-05 codec-pkg-wiped-by-clean).
//     Gated by scripts/lint-clean-preserves-wasm.mjs (bun run lint).
// .forgeax-harness (floating loop-state clone, own .git) is ALWAYS preserved.
// --dry-run/-n previews. WARNING: discards ALL uncommitted work — commit first.
function clean(argv: string[]): void {
  requireCmd('git', 'install git first.');
  const dryRun = argv.includes('--dry-run') || argv.includes('-n');
  const deepRoot = argv.includes('--deep') || argv.includes('-x');
  const rootFlags = deepRoot ? '-fdx' : '-fd';
  const keepWasm = "-e 'packages/fbx/pkg/' -e 'packages/wgpu-wasm/pkg/' -e 'packages/codec/pkg/'";
  const subScrub = dryRun
    ? `git reset --hard -q && git clean -ffndx ${keepWasm}`
    : `git reset --hard -q && git clean -ffdx ${keepWasm}`;
  const rows: ReportRow[] = [];
  const push = (s: string, result: StepResult, detail?: string): void => {
    rows.push({ step: s, result, detail });
  };

  step(
    `clean: root=${deepRoot ? 'deep (wipes gitignored artefacts — re-run setup after)' : 'standard (keeps node_modules/dist/wasm)'} · submodules=deep (keeps toolchain-gated wasm pkg)${dryRun ? ' · DRY RUN' : ''}`,
  );

  const run = (s: string, args: string[], okDetail: string): void => {
    const okStatus = gitRun(args, dryRun) === 0;
    push(
      s,
      dryRun ? 'skipped' : okStatus ? 'ok' : 'failed',
      dryRun ? `git ${args.join(' ')}` : okStatus ? okDetail : `git ${args.join(' ')} failed`,
    );
  };

  // 1. discard tracked edits + reset submodule pointers to recorded pins.
  run('reset', ['reset', '--hard'], 'reset tracked changes');
  // 2. sync submodule checkouts to pins (init any missing / nested).
  run('sub-sync', ['submodule', 'update', '--init', '--recursive', '--force'], 'checkouts synced to pins');
  // 3. scrub every submodule tree to bare pin state (tracked + untracked + ignored).
  run('sub-scrub', ['submodule', 'foreach', '--recursive', subScrub], 'submodule trees scrubbed');
  // 4. remove root untracked, always preserving the harness floating clone.
  run(
    'root-clean',
    ['clean', rootFlags, '-e', '.forgeax-harness', '-e', WORKTREE_CONFIG_FILE, ...(dryRun ? ['-n'] : [])],
    'root untracked removed (worktree port assignment preserved)',
  );

  console.log(`\n${report(rows)}`);
  if (!dryRun) {
    const remaining = gitOut(['status', '--porcelain']);
    if (remaining === '') ok('working tree is now completely clean ✓');
    else {
      warn('remaining after clean (inspect manually):');
      console.log(remaining);
    }
  }
  if (rows.some((r) => r.result === 'failed')) die('clean: one or more steps failed — see report above.');
}

// ── stop ────────────────────────────────────────────────────────────────────
async function stop(): Promise<void> {
  const bridgeEnabled = process.env.FORGEAX_BRIDGE !== '0';
  const ports = managedPorts(editorBridgePort(), bridgeEnabled);
  step(`stopping editor stack (ports ${ports.join(' ')}) ...`);
  const killed = await killByPorts(ports);
  if (!killed) ok('nothing to stop');
}

function editorBridgePort(): number {
  return WORKTREE_PORTS.bridge;
}

function managedPorts(bridgePort: number, bridgeEnabled: boolean): number[] {
  return bridgeEnabled ? [...PORTS, bridgePort] : [...PORTS];
}

// ── setup (install) ─────────────────────────────────────────────────────────
function readWasmContentKeyMarker(): string {
  try {
    return readFileSync(WASM_CONTENT_KEY_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

/** Resolve the wgpu-wasm source key through the Engine package's SSOT helper. */
function currentWasmContentKey(): string {
  try {
    const output = execFileSync(process.execPath, [WASM_CONTENT_KEY_SCRIPT], {
      cwd: WASM_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const key = output.trim().split(/\r?\n/, 1)[0] ?? '';
    if (!/^[0-9a-f]{64}$/.test(key)) {
      throw new Error(`content-key script returned an invalid SHA-256: ${key || '<empty>'}`);
    }
    return key;
  } catch (error) {
    throw setupFailure(
      'wgpu-wasm',
      'wgpu-wasm-content-key-failed',
      'wgpu-wasm content key resolves from the current source inputs',
      {
        path: WASM_CONTENT_KEY_SCRIPT,
        error: error instanceof Error ? error.message : String(error),
      },
      'Ensure the wgpu-wasm source checkout is complete, then rerun bun fx setup.',
    );
  }
}

function ensureWasm(): void {
  const marker = readWasmContentKeyMarker();
  if (existsSync(WASM_FILE) && marker) {
    const currentKey = currentWasmContentKey();
    if (marker === currentKey) {
      ok(`wasm present (skip build): packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm (${currentKey.slice(0, 12)})`);
      return;
    }
    step(
      `wasm stale (source ${currentKey.slice(0, 12)}, artifact ${marker.slice(0, 12)}) — rebuilding from Rust ...`,
    );
  } else if (existsSync(WASM_FILE)) {
    step('wasm provenance missing — rebuilding from Rust (wgpu-wasm build:wasm, ~1-2 min) ...');
  } else {
    step('wasm missing — building from Rust (wgpu-wasm build:wasm, ~1-2 min) ...');
  }

  // Do not leave a stale marker behind if the build fails. A failed build must
  // make the next setup attempt rebuild instead of trusting an old provenance.
  rmSync(WASM_CONTENT_KEY_FILE, {force: true});
  if (!has('rustc')) {
    throw setupFailure('wgpu-wasm', 'rust-toolchain-missing', 'rustc is available', {}, 'Install Rust from https://rustup.rs.');
  }
  if (!has('wasm-pack')) {
    throw setupFailure(
      'wgpu-wasm',
      'wasm-pack-missing',
      'wasm-pack is available',
      {},
      'Install wasm-pack with cargo install wasm-pack.',
    );
  }
  // The wgpu-wasm Rust→wasm build stays bash (toolchain wrapper); invoke via its
  // package script so we never hard-code the script path.
  sh('pnpm', ['-F', '@forgeax/engine-wgpu-wasm', 'build:wasm'], {
    cwd: ENGINE_DIR,
    failure: {
      phase: 'wgpu-wasm-build',
      code: 'wgpu-wasm-build-failed',
      expected: 'wgpu wasm build exits with status 0',
      hint: 'Install Rust and wasm-pack, then rerun bun fx setup.',
    },
  });
  if (!existsSync(WASM_FILE)) {
    throw setupFailure(
      'wgpu-wasm',
      'wgpu-wasm-missing',
      'wgpu wasm output exists after the build',
      {path: WASM_FILE},
      'Rerun bun fx setup and inspect the wgpu-wasm build output.',
    );
  }
  const builtKey = currentWasmContentKey();
  writeFileSync(WASM_CONTENT_KEY_FILE, `${builtKey}\n`);
  ok(`wasm built (${builtKey.slice(0, 12)})`);
}

function ensureFbxWasm(): void {
  if (existsSync(FBX_WASM_MJS) && existsSync(FBX_WASM_FILE)) {
    ok('fbx wasm present (skip build): packages/fbx/pkg/fbx-wasm.{mjs,wasm}');
    return;
  }

  step('fbx wasm missing — fetching pre-built release bundle ...');
  const fetched = trySh('pnpm', ['-F', '@forgeax/engine-fbx', 'fetch-wasm'], { cwd: ENGINE_DIR });
  if (fetched && existsSync(FBX_WASM_MJS) && existsSync(FBX_WASM_FILE)) {
    ok('fbx wasm fetched: packages/fbx/pkg/fbx-wasm.{mjs,wasm}');
    return;
  }

  // fetch-wasm inherits stdio, so its own diagnosis is already on screen. Point
  // at it instead of asserting a cause: a fetch that downloaded the asset and
  // then died unpacking it is not an auth failure, and claiming otherwise sends
  // people installing an Emscripten toolchain they don't need.
  warn('pre-built fbx wasm unavailable — the real cause is in the fetch-wasm output above. Common ones:');
  warn('  · GitHub auth — set GH_TOKEN/GITHUB_TOKEN or run `gh auth login`');
  warn('  · `Cannot connect to <drive>: resolve failed` — GNU tar (Git for Windows) sits ahead of');
  warn('    bsdtar on PATH and reads the drive letter as an rsh host; put %SystemRoot%\\System32 first');
  warn('falling back to local Emscripten build.');
  if (!has('emcc')) {
    throw setupFailure(
      'fbx-wasm-build',
      'emcc-missing',
      'Emscripten emcc is available',
      {},
      'Install Emscripten with brew install emscripten or activate emsdk.',
    );
  }
  // build:wasm = fetch-ufbx (idempotent, downloads ufbx.c) + emcc. Invoke via
  // the package script so the emcc flag set stays owned by @forgeax/engine-fbx.
  sh('pnpm', ['-F', '@forgeax/engine-fbx', 'build:wasm'], {
    cwd: ENGINE_DIR,
    failure: {
      phase: 'fbx-wasm-build',
      code: 'fbx-wasm-build-failed',
      expected: 'fbx wasm build exits with status 0',
      hint: 'Install Emscripten emcc, then rerun bun fx setup.',
    },
  });
  if (!existsSync(FBX_WASM_MJS) || !existsSync(FBX_WASM_FILE)) {
    throw setupFailure(
      'fbx-wasm-build',
      'fbx-wasm-missing',
      'FBX wasm outputs exist after the build',
      {paths: [FBX_WASM_MJS, FBX_WASM_FILE]},
      'Rerun bun fx setup and inspect the FBX wasm build output.',
    );
  }
  ok('fbx wasm built');
}

function codecWasmPresent(): boolean {
  return existsSync(CODEC_WASM_MJS) && existsSync(CODEC_WASM_FILE) && existsSync(CODEC_ENCODER_WASM_FILE);
}

// Mirrors ensureFbxWasm: the codec package's own postinstall (scripts/ensure-wasm.mjs)
// is deliberately best-effort and soft-fails offline, so setup must own the hard
// guarantee — otherwise a wiped/missing pkg/ slips through install() and only
// surfaces at runtime as a basis_transcoder.mjs 404 + KTX2 material failures.
function ensureCodecWasm(): void {
  if (codecWasmPresent()) {
    ok('codec wasm present (skip build): packages/codec/pkg/basis_transcoder.{mjs,wasm}');
    return;
  }

  step('codec wasm missing — fetching pre-built release bundle ...');
  const fetched = trySh('pnpm', ['-F', '@forgeax/engine-codec', 'fetch-wasm'], { cwd: ENGINE_DIR });
  if (fetched && codecWasmPresent()) {
    ok('codec wasm fetched: packages/codec/pkg/basis_transcoder.{mjs,wasm} + encode/');
    return;
  }

  warn('pre-built codec wasm unavailable — the real cause is in the fetch-wasm output above. Common ones:');
  warn('  · GitHub auth — set GH_TOKEN/GITHUB_TOKEN or run `gh auth login`');
  warn('  · `Cannot connect to <drive>: resolve failed` — GNU tar (Git for Windows) sits ahead of');
  warn('    bsdtar on PATH and reads the drive letter as an rsh host; put %SystemRoot%\\System32 first');
  warn('falling back to local Emscripten build.');
  if (!has('emcc')) {
    throw setupFailure(
      'codec-wasm-build',
      'emcc-missing',
      'Emscripten emcc is available',
      {},
      'Install Emscripten with brew install emscripten or activate emsdk.',
    );
  }
  // build:wasm = fetch-basis (idempotent, downloads pinned basis_universal
  // source) + emcc -O3 compile. Invoke via the package script so the emcc flag
  // set stays owned by @forgeax/engine-codec. NOTE: multi-minute compile.
  sh('pnpm', ['-F', '@forgeax/engine-codec', 'build:wasm'], {
    cwd: ENGINE_DIR,
    failure: {
      phase: 'codec-wasm-build',
      code: 'codec-wasm-build-failed',
      expected: 'codec wasm build exits with status 0',
      hint: 'Install Emscripten emcc and rerun bun fx setup.',
    },
  });
  if (!codecWasmPresent()) {
    throw setupFailure(
      'codec-wasm-build',
      'codec-wasm-missing',
      'codec wasm outputs exist after the build',
      {paths: [CODEC_WASM_MJS, CODEC_WASM_FILE, CODEC_ENCODER_WASM_FILE]},
      'Rerun bun fx setup and inspect the codec wasm build output.',
    );
  }
  ok('codec wasm built');
}

/**
 * Bun sees the engine's nested packages as editor workspaces and can rewrite
 * engine/node_modules links to its own store. The engine's test helpers then
 * import a second Vitest instance from pnpm, so property suites lose their
 * active test context. Recreate only this generated directory before pnpm
 * installs its authoritative dependency graph. This is a normal package-manager
 * handoff, not an install warning: Bun owns the editor graph and pnpm owns the
 * nested engine graph.
 */
export type EngineNodeModulesResetOptions = {
  editorRoot?: string;
  engineDir?: string;
};

function hasFilesystemEntry(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function readDirectory(path: string): Dirent[] | undefined {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

function engineNodeModulesPaths(engineDir: string): string[] {
  const candidates = new Set<string>([join(engineDir, 'node_modules')]);
  const packagesDir = join(engineDir, 'packages');
  const packageEntries = readDirectory(packagesDir) ?? [];

  for (const packageEntry of packageEntries) {
    if (!packageEntry.isDirectory()) continue;
    const packageDir = join(packagesDir, packageEntry.name);
    candidates.add(join(packageDir, 'node_modules'));

    if (!packageEntry.name.startsWith('@')) continue;
    for (const scopedPackage of readDirectory(packageDir) ?? []) {
      if (scopedPackage.isDirectory()) {
        candidates.add(join(packageDir, scopedPackage.name, 'node_modules'));
      }
    }
  }

  return [...candidates].filter(hasFilesystemEntry);
}

function pointsIntoBunStore(path: string, bunStore: string): boolean {
  try {
    const target = realpathSync(path);
    return target === bunStore || target.startsWith(`${bunStore}${sep}`);
  } catch {
    return true;
  }
}

function nodeModulesHasBunOrBrokenLink(nodeModules: string, bunStore: string): boolean {
  if (pointsIntoBunStore(nodeModules, bunStore)) return true;

  const entries = readDirectory(nodeModules);
  if (!entries) return true;

  for (const entry of entries) {
    const entryPath = join(nodeModules, entry.name);
    if (entry.isSymbolicLink() && pointsIntoBunStore(entryPath, bunStore)) return true;

    // pnpm exposes scoped packages as a directory containing one more layer
    // of package links. Inspect that layer without walking pnpm's private tree.
    if (!entry.isDirectory() || !entry.name.startsWith('@')) continue;
    const scopedEntries = readDirectory(entryPath);
    if (!scopedEntries) return true;
    for (const scopedEntry of scopedEntries) {
      if (scopedEntry.isSymbolicLink() && pointsIntoBunStore(join(entryPath, scopedEntry.name), bunStore)) {
        return true;
      }
    }
  }

  return false;
}

export function resetEngineNodeModulesIfBunLinked(
  options: EngineNodeModulesResetOptions = {},
): void {
  const editorRoot = options.editorRoot ?? ROOT;
  const engineDir = options.engineDir ?? ENGINE_DIR;
  const bunStorePath = resolve(editorRoot, 'node_modules', '.bun');
  let bunStore = bunStorePath;
  try {
    bunStore = realpathSync(bunStorePath);
  } catch {
    // A missing Bun store cannot be the target of a generated link.
  }
  const nodeModulesPaths = engineNodeModulesPaths(engineDir);

  if (!nodeModulesPaths.some((path) => nodeModulesHasBunOrBrokenLink(path, bunStore))) return;

  for (const path of nodeModulesPaths) {
    rmSync(path, { force: true, recursive: true });
  }
}

/** Build the Engine root TypeScript project-reference graph after the library dist pass. */
function buildEngineDeclarations(): void {
  if (!engineDeclarationsAreTrusted()) {
    warn('Engine declaration provenance is untrusted; cleaning the root project-reference outputs ...');
    sh('pnpm', ['exec', 'node', engineTypeScriptBin(), '-b', '--clean', '--pretty', 'false'], {
      cwd: ENGINE_DIR,
      failure: {
        phase: 'declaration-clean',
        code: 'declaration-clean-failed',
        expected: 'Engine declaration clean exits with status 0',
        hint: 'Inspect the Engine declaration graph and rerun bun fx setup.',
      },
    });
  } else {
    ok('Engine declaration provenance is trusted; using the incremental graph');
  }

  sh('pnpm', ['exec', 'node', engineTypeScriptBin(), '-b', '--pretty', 'false'], {
    cwd: ENGINE_DIR,
    failure: {
      phase: 'declaration',
      code: 'declaration-build-failed',
      expected: 'Engine declaration build exits with status 0',
      hint: 'Inspect the Engine declaration graph and rerun bun fx setup.',
    },
  });
}

async function install(): Promise<void> {
  let trace: SetupInstallTrace = {
    setupEnv: resolveSetupEnvironment(process.env),
    editorInstallSkipped: false,
    fallbacks: [],
    terminalStatus: 'failure',
  };
  setupExecutionActive = true;
  try {
    if (!has('git')) throw setupFailure('preflight', 'git-missing', 'git is available', {}, 'Install Git and rerun bun fx setup.');
    if (!has('bun')) throw setupFailure('preflight', 'bun-missing', 'bun is available', {}, 'Install Bun from https://bun.sh.');
    if (!has('pnpm')) throw setupFailure('preflight', 'pnpm-missing', 'pnpm is available', {}, 'Install pnpm from https://pnpm.io.');

    step('1/8 fetching submodules (engine + interface + platform-io) ...');
    sh('git', ['submodule', 'update', '--init', '--recursive'], {
      failure: {
        phase: 'submodules',
        code: 'submodules-fetch-failed',
        expected: 'recursive submodule update exits with status 0',
        hint: 'Check submodule remotes and access, then rerun bun fx setup.',
      },
    });
    ok('submodules ready');

    const skipEditorInstall = process.env.FORGEAX_SKIP_EDITOR_BUN_INSTALL === '1';
    if (skipEditorInstall && !existsSync(join(ROOT, 'node_modules', '.bin', 'tsc'))) {
      throw setupFailure(
        'editor-bun-install',
        'editor-install-missing',
        'the frozen editor install exists when Bun installation is skipped',
        {path: join(ROOT, 'node_modules', '.bin', 'tsc')},
        'Run bun install first, then rerun bun fx setup.',
      );
    }

    step('2/8 installing editor workspace deps (bun) ...');
    const runDependencyCommand: SetupCommandRunner = (command, args, env) =>
      runCaptured(command, [...args], {
        cwd: command === 'pnpm' ? ENGINE_DIR : ROOT,
        env,
      });
    trace = runSetupDependencyInstalls({
      env: process.env,
      run: runDependencyCommand,
      skipEditorInstall,
      beforeEngineInstall: resetEngineNodeModulesIfBunLinked,
    });
    if (trace.editorInstallSkipped) {
      ok('bun deps already ready (reused frozen worktree install)');
    } else {
      ok('bun deps ready');
    }
    if (trace.fallbacks.includes('harness-divergence')) {
      warn('[fx] harness divergence detected; dependency setup continued with Harness sync deferred.');
    }
    if (trace.fallbacks.includes('simple-git-hooks-enoent-retry')) {
      warn('[fx] simple-git-hooks ENOENT detected; retried Bun installation once.');
    }
    if (trace.terminalStatus !== 'success' || !trace.engineEnv) {
      throw new SetupExecutionError(
        trace.failure ?? {
          phase: 'dependencies',
          code: 'dependency-setup-failed',
          expected: 'Bun and Engine dependency installs exit with status 0',
          observed: trace,
          hint: 'Rerun bun fx setup after resolving the failed dependency stage.',
        },
      );
    }

    step(
      `3/8 installing engine deps (pnpm, network concurrency ${trace.engineEnv.PNPM_CONFIG_NETWORK_CONCURRENCY ?? DEFAULT_PNPM_NETWORK_CONCURRENCY}) ...`,
    );
    ok('engine deps ready');

    // wasm MUST precede the engine dist build: the engine `app` package's tsup
    // build inlines wgpu-wasm/dist/index.mjs, which `import`s ../pkg/wgpu_wasm.js.
    // ENFORCED by scripts/lint-wasm-before-dist.mjs; keep this order intact.
    step('4/8 ensuring wgpu wasm binary ...');
    ensureWasm();

    step('5/8 ensuring fbx wasm binary ...');
    ensureFbxWasm();

    step('6/8 ensuring codec wasm binaries ...');
    ensureCodecWasm();

    step('7/8 building engine library dist (pnpm -r, packages/* only — skips apps) ...');
    sh('pnpm', ['-r', '--filter', './packages/*', 'build', '--silent'], {
      cwd: ENGINE_DIR,
      failure: {
        phase: 'engine-dist',
        code: 'engine-dist-build-failed',
        expected: 'Engine dist build exits with status 0',
        hint: 'Inspect the Engine dist build output and rerun bun fx setup.',
      },
    });
    ok('engine dist built');
    buildEngineDeclarations();
    ok('engine declarations built');

    step('verifying critical artifacts ...');
    const missing: string[] = [];
    for (const pkg of ENGINE_CRITICAL_PACKAGES) {
      for (const artifact of ['index.mjs', ...ENGINE_DECLARATION_ARTIFACTS]) {
        const path = join(ENGINE_DIR, 'packages', pkg, 'dist', artifact);
        if (!existsSync(path)) {
          warn(`missing engine dist: packages/${pkg}/dist/${artifact}`);
          missing.push(path);
        }
      }
    }
    if (!existsSync(WASM_FILE)) {
      warn(`missing wasm: ${WASM_FILE}`);
      missing.push(WASM_FILE);
    }
    if (!existsSync(FBX_WASM_MJS) || !existsSync(FBX_WASM_FILE)) {
      warn('missing fbx wasm: packages/fbx/pkg/fbx-wasm.{mjs,wasm}');
      missing.push(FBX_WASM_MJS, FBX_WASM_FILE);
    }
    if (!codecWasmPresent()) {
      warn('missing codec wasm: packages/codec/pkg/basis_transcoder.{mjs,wasm} + encode/basis_encoder.wasm');
      missing.push(CODEC_WASM_MJS, CODEC_WASM_FILE, CODEC_ENCODER_WASM_FILE);
    }
    if (missing.length > 0) {
      throw setupFailure(
        'critical-artifact-verify',
        'critical-artifact-missing',
        'all critical Engine artifacts exist',
        {missing},
        "Rerun bun fx setup; do not create a placeholder artifact.",
      );
    }

    writeEngineDistSha();
    ok(`engine dist matches ${engineHead().slice(0, 12)}`);
    printSetupEnvelope(
      setupEnvelopeFromTrace(trace, {
        terminalStatus: 'success',
        phase: 'complete',
        code: 'setup-complete',
        expected: 'all setup gates complete',
        observed: {gates: ['engine-pnpm', 'wgpu-wasm', 'fbx-wasm', 'codec-wasm', 'engine-dist', 'declaration', 'critical-artifact-verify']},
        hint: 'Setup is ready for bun fx start.',
        artifactsVerified: true,
      }),
    );
    ok('install complete — run: bun fx start');
  } catch (error) {
    const failure = error instanceof SetupExecutionError
      ? error.failure
      : {
          phase: 'setup',
          code: 'setup-failed',
          expected: 'all setup gates complete',
          observed: {error: error instanceof Error ? error.message : String(error)},
          hint: 'Resolve the reported setup failure and rerun bun fx setup.',
        };
    printSetupEnvelope(setupEnvelopeFromTrace(trace, {
      terminalStatus: 'failure',
      phase: failure.phase,
      code: failure.code,
      expected: failure.expected,
      observed: failure.observed,
      hint: failure.hint,
      artifactsVerified: false,
    }));
    die(error instanceof Error ? error.message : String(error));
  } finally {
    setupExecutionActive = false;
  }
}

// ── start (run) ─────────────────────────────────────────────────────────────
async function run(argv: string[]): Promise<void> {
  let play = false;
  let bg = false;
  let game = '';
  let rhiDebug = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--play') play = true;
    else if (a === '--bg') bg = true;
    else if (a === '--rhi-debug') rhiDebug = true;
    else if (a === '--game') {
      game = argv[++i] ?? '';
      if (!game) die('--game needs a path');
    } else if (a.startsWith('--game=')) game = a.slice('--game='.length);
    else die(`unknown start flag: ${a} (supported: --play, --bg, --rhi-debug, --game <path>)`);
  }

  // --game <dir>: open a REAL game by reusing the @forgeax/platform-io backend.
  let gameDir = '';
  if (game) {
    if (!existsSync(game)) die(`--game path is not a directory: ${game}`);
    gameDir = resolve(game);
    if (!existsSync(join(gameDir, 'forge.json'))) die(`--game dir has no forge.json: ${gameDir}`);
    ok(`reusing platform-io for game '${gameDir.split(/[/\\]/).pop()}' from ${gameDir}`);
  }
  const manualLogDir = resolve(ROOT, '..', '.forgeax-debug', 'manual-runs');
  const manualGameName = basename(gameDir || 'standalone');
  const manualRunId = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const manualLogFile = join(manualLogDir, `${manualGameName}-${manualRunId}.log`);
  mkdirSync(manualLogDir, { recursive: true });
  step(`manual run log → ${manualLogFile}`);
  // --rhi-debug: opt-in the engine's RHI frame capture. Setting the env for every
  // spawned vite process makes engine-vite-preset register vite-plugin-rhi-debug
  // (which injects import.meta.env.FORGEAX_ENGINE_RHI_DEBUG=1 + the dev-server
  // /__forgeax-debug endpoints), flipping createApp's guard so the browser gets
  // window.__forgeax.captureFrame(n). Unset by default → zero injection, tree-shaken.
  // DEV-only live gateway bridge: on by default so `fx start` matches
  // `dev:standalone`. It takes both a relay process (:15296) AND a compile-time
  // flag so the editor page dials the relay — mirrors dev-standalone.ts. Opt out
  // with FORGEAX_BRIDGE=0. CRITICAL: the two Vite vars must reach the HOST vite
  // (`bun run dev`, :15290) — the standalone shell imports ViewportComponent
  // IN-PROCESS (apps/standalone/main.tsx, no iframe / no /editor proxy), so the host
  // vite is what inlines `import.meta.env.VITE_FORGEAX_BRIDGE` into the page's
  // bridge-dial code. Giving it only to edit-runtime (:15280) leaves the page's
  // bridgeEnabled=false and connectBridge() never runs. So they go into the base
  // `env` shared by every spawn; the relay reads the runtime FORGEAX_BRIDGE_PORT.
  const bridge = process.env.FORGEAX_BRIDGE !== '0';
  const bridgePort = String(editorBridgePort());
  const bridgeEnv: NodeJS.ProcessEnv = bridge
    ? { VITE_FORGEAX_BRIDGE: '1', VITE_FORGEAX_BRIDGE_PORT: bridgePort }
    : { VITE_FORGEAX_BRIDGE: '0' };

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...portEnvironment(WORKTREE_PORTS),
    ...bridgeEnv,
    FORGEAX_GAME_DIR: gameDir,
    FORGEAX_GAME_API_PORT: String(GAME_API_PORT),
    // The pure preview is proxied through the standalone host. Play Runtime
    // receives one exact game root and exposes it through a stable URL mount;
    // no parent directory is ever an asset producer input.
    ...(gameDir
      ? {
          FORGEAX_GAME_ID: basename(gameDir),
          FORGEAX_RUNTIME_SCOPE_ID: `standalone-${basename(gameDir)}`,
          FORGEAX_RUNTIME_GENERATION: '1',
          FORGEAX_GAMES_URL_PREFIX: 'host-games',
        }
      : {}),
    // Play Runtime's HMR client is also behind the standalone host proxy; the
    // default 18920 target belongs to the studio embed and returns 400 here.
    FORGEAX_HMR_CLIENT_PORT: String(STANDALONE_PORT),
    // Single SSOT for the editor stack's play-runtime port. Set AFTER the
    // ...process.env spread so it always wins: every spawn inherits this base env,
    // so play-runtime binds PLAY_RUNTIME_PORT AND edit-runtime's /preview proxy
    // targets it — no stale 15173 anywhere in the fx-orchestrated stack, and it
    // stays consistent with the PORTS kill-set (which lists PLAY_RUNTIME_PORT).
    FORGEAX_ENGINE_PORT: String(PLAY_RUNTIME_PORT),
    ...(rhiDebug ? { FORGEAX_ENGINE_RHI_DEBUG: '1' } : {}),
  };
  if (rhiDebug) ok(`RHI-debug capture enabled → viewport capture button opens reviewer :${RHI_REVIEWER_PORT}`);
  if (bridge) ok(`gateway bridge enabled → relay :${bridgePort} (node skills/forgeax-editor-gateway/scripts/gateway.mjs). Opt out: FORGEAX_BRIDGE=0`);

  // preflight — point at setup if the engine build is missing.
  if (
    !existsSync(join(ENGINE_DIR, 'packages', 'vite-plugin-shader', 'dist', 'index.mjs')) ||
    !existsSync(WASM_FILE)
  ) {
    die('engine not built (dist/wasm missing). Run first: bun fx setup');
  }
  requireFreshEngineDist();
  const engineRevision = engineHead();
  const ddcHostRoot = gameDir === ''
    ? undefined
    : resolve(gameDir, '.forgeax', 'ddc', 'v2', 'hosts', `engine-${engineRevision}`);
  const hostDdcRoot = ddcHostRoot === undefined
    ? undefined
    : resolve(ddcHostRoot, `standalone-host-${STANDALONE_PORT}`);
  const editRuntimeDdcRoot = ddcHostRoot === undefined
    ? undefined
    : resolve(ddcHostRoot, `edit-runtime-${EDIT_RUNTIME_PORT}`);
  const playRuntimeDdcRoot = ddcHostRoot === undefined
    ? undefined
    : resolve(ddcHostRoot, `play-runtime-${PLAY_RUNTIME_PORT}`);
  const viteCacheRoot = process.env.FORGEAX_VITE_CACHE_ROOT
    ?? resolve(gameDir || ROOT, '.forgeax', 'vite-cache', `engine-${engineRevision}`);
  const baseDdcBuildCacheRoot = hostDdcRoot === undefined
    ? undefined
    : resolve(hostDdcRoot, 'build');

  // A stale Vite/DDC graph can still report "ready" while serving material
  // publication output from a different Engine compiler. Namespace both
  // caches by the exact Engine pin so restarting the same game after an Engine
  // update starts from a compatible derived graph without deleting authored
  // state or the previous cache.
  env.FORGEAX_VITE_CACHE_ROOT = viteCacheRoot;
  if (hostDdcRoot !== undefined && baseDdcBuildCacheRoot !== undefined) {
    env.FORGEAX_DDC_PROJECT_ROOT = hostDdcRoot;
    env.FORGEAX_DDC_BUILD_CACHE_ROOT = baseDdcBuildCacheRoot;
  }

  // Always start from a clean slate, but only sweep editor-owned ports. In
  // particular, never use Studio's :15295 as the editor relay default.
  const editorPorts = managedPorts(Number(bridgePort), bridge);
  step(`stopping editor stack (ports ${editorPorts.join(' ')}) ...`);
  const killed = await killByPorts(editorPorts);
  if (!killed) ok('nothing to stop');

  // bridgeEnv already folded into `env`; edit-runtime just adds the HMR port.
  const editRuntimeEnv: NodeJS.ProcessEnv = {
    ...env,
    FORGEAX_INTERFACE_PORT: String(STANDALONE_PORT),
    ...(editRuntimeDdcRoot === undefined
      ? {}
      : {
          FORGEAX_DDC_PROJECT_ROOT: editRuntimeDdcRoot,
          FORGEAX_DDC_BUILD_CACHE_ROOT: resolve(editRuntimeDdcRoot, 'build'),
        }),
  };
  const playRuntimeEnv: NodeJS.ProcessEnv = playRuntimeDdcRoot === undefined
    ? env
    : {
        ...env,
        FORGEAX_DDC_PROJECT_ROOT: playRuntimeDdcRoot,
        FORGEAX_DDC_BUILD_CACHE_ROOT: resolve(playRuntimeDdcRoot, 'build'),
      };
  const editRuntimeArgs = ['-F', '@forgeax/editor-edit-runtime', 'dev', '--', '--port', String(EDIT_RUNTIME_PORT), '--strictPort'];

  if (bg) {
    // Background mode: detached + unref'd so children outlive this process on
    // every platform (mirrors the old `nohup … &`). Logs go to the temp dir.
    const log = (): number => openSync(manualLogFile, 'a');
    step(`starting stack in background (logs → ${manualLogFile}) ...`);
    if (gameDir)
      spawnService('bun', [join(ROOT, 'apps/standalone', 'game-backend.ts')], {
        cwd: ROOT,
        env,
        detach: true,
        logFd: log(),
      });
    spawnService('bun', editRuntimeArgs, {
      cwd: ROOT,
      env: editRuntimeEnv,
      detach: true,
      logFd: log(),
    });
    spawnService('bun', ['run', 'dev'], { cwd: ROOT, env, detach: true, logFd: log() });
    if (rhiDebug)
      spawnService('pnpm', ['-F', '@forgeax/engine-rhi-debug-viewer', 'exec', 'vite', '--port', String(RHI_REVIEWER_PORT), '--strictPort'], {
        cwd: ENGINE_DIR,
        env,
        detach: true,
        logFd: log(),
      });
    if (bridge)
      // Spawn with `bun`, not `node`: `ws` lives only in bun's isolated store
      // (node_modules/.bun/ws@*), unhoisted, so bare node ERR_MODULE_NOT_FOUNDs.
      spawnService('bun', [GATEWAY_RELAY_SCRIPT], {
        cwd: ROOT,
        env: { ...env, FORGEAX_BRIDGE_PORT: bridgePort },
        detach: true,
        logFd: log(),
      });
    if (play || gameDir)
      spawnService('bun', ['-F', '@forgeax/editor-play-runtime', 'dev'], {
        cwd: ROOT,
        // FORGEAX_ENGINE_PORT (= PLAY_RUNTIME_PORT) rides in the base `env`.
        env: playRuntimeEnv,
        detach: true,
        logFd: log(),
      });
    ok(`stack starting in background → http://localhost:${STANDALONE_PORT}`);
    ok('stop with: bun fx stop');
    return;
  }

  // foreground: trap Ctrl-C to tear the whole stack down
  const children: ChildProcess[] = [];
  installCleanup(children, editorPorts);

  if (gameDir) {
    step(`starting game-backend :${GAME_API_PORT} (platform-io reuse, R3) ...`);
    children.push(spawnService('bun', [join(ROOT, 'apps/standalone', 'game-backend.ts')], {
      cwd: ROOT,
      env,
      teeLogPath: manualLogFile,
    }));
  }

  step(`starting edit-runtime :${EDIT_RUNTIME_PORT} (HMR→${STANDALONE_PORT}) ...`);
  children.push(spawnService('bun', editRuntimeArgs, {
    cwd: ROOT,
    env: editRuntimeEnv,
    teeLogPath: manualLogFile,
  }));

  step(`starting standalone host :${STANDALONE_PORT} ...`);
  children.push(spawnService('bun', ['run', 'dev'], {
    cwd: ROOT,
    env,
    teeLogPath: manualLogFile,
  }));

  if (rhiDebug) {
    step(`starting RHI reviewer :${RHI_REVIEWER_PORT} ...`);
    children.push(
      spawnService('pnpm', ['-F', '@forgeax/engine-rhi-debug-viewer', 'exec', 'vite', '--port', String(RHI_REVIEWER_PORT), '--strictPort'], {
        cwd: ENGINE_DIR,
        env,
        teeLogPath: manualLogFile,
      }),
    );
  }

  if (bridge) {
    step(`starting gateway bridge relay :${bridgePort} (live editing; FORGEAX_BRIDGE=0 to disable) ...`);
    children.push(
      // `bun` not `node`: `ws` is only in bun's isolated store, unhoisted.
      spawnService('bun', [GATEWAY_RELAY_SCRIPT], {
        cwd: ROOT,
        env: { ...env, FORGEAX_BRIDGE_PORT: bridgePort },
        teeLogPath: manualLogFile,
      }),
    );
  }

  if (play || gameDir) {
    step(`starting play-runtime :${PLAY_RUNTIME_PORT} ...`);
    children.push(
      spawnService('bun', ['-F', '@forgeax/editor-play-runtime', 'dev'], {
        cwd: ROOT,
        // FORGEAX_ENGINE_PORT (= PLAY_RUNTIME_PORT) rides in the base `env`.
        env: playRuntimeEnv,
        teeLogPath: manualLogFile,
      }),
    );
  }

  ok(`open → http://localhost:${STANDALONE_PORT}   (Ctrl-C to stop)`);
  // Keep the process alive until a child exits or the user hits Ctrl-C.
  await new Promise<void>((resolvePromise) => {
    for (const ch of children) ch.on('exit', () => resolvePromise());
  });
}

// ── build (static single-game artifact) ─────────────────────────────────────
// The dev stack deliberately keeps game modules host-injected and reloadable.
// Shipping has a different contract: select one game, bundle its entry, stage
// its persisted project facts, and leave a directory that a plain static HTTP
// server can mount at /preview/.
function build(argv: string[]): void {
  let game = '';
  let out = '';
  let maxBytes = '';
  let maxEntities = '';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--game') game = argv[++i] ?? '';
    else if (arg.startsWith('--game=')) game = arg.slice('--game='.length);
    else if (arg === '--out') out = argv[++i] ?? '';
    else if (arg.startsWith('--out=')) out = arg.slice('--out='.length);
    else if (arg === '--max-bytes') maxBytes = argv[++i] ?? '';
    else if (arg.startsWith('--max-bytes=')) maxBytes = arg.slice('--max-bytes='.length);
    else if (arg === '--max-entities') maxEntities = argv[++i] ?? '';
    else if (arg.startsWith('--max-entities=')) maxEntities = arg.slice('--max-entities='.length);
    else die(`unknown build flag: ${arg} (supported: --game <dir>, --out <dir>, --max-bytes N, --max-entities N)`);
  }
  if (!game) die('build needs --game <dir> (the directory containing forge.json)');
  const gameDir = resolve(ROOT, game);
  if (!existsSync(gameDir)) die(`build game directory does not exist: ${gameDir}`);
  const forgePath = join(gameDir, 'forge.json');
  if (!existsSync(forgePath)) die(`build game directory has no forge.json: ${gameDir}`);
  const gameId = gameDir.split(sep).pop() ?? '';
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(gameId)) die(`build game directory name is not a valid game id: ${gameId}`);

  let manifest: { entry?: unknown };
  try {
    manifest = JSON.parse(readFileSync(forgePath, 'utf8')) as { entry?: unknown };
  } catch {
    die(`build cannot parse ${forgePath}`);
  }
  const entry = typeof manifest.entry === 'string' && manifest.entry.length > 0 ? manifest.entry : 'main.ts';
  const entryPath = resolve(gameDir, entry);
  if (!entryPath.startsWith(`${gameDir}${sep}`) || !existsSync(entryPath)) {
    die(`build game entry does not exist inside the game directory: ${entry}`);
  }
  const outDir = out ? resolve(ROOT, out) : resolve(ROOT, 'packages/play-runtime/dist');
  const validationArgs = [join(ROOT, 'scripts/game-validation.mjs'), gameDir];
  if (maxBytes) validationArgs.push(`--max-bytes=${maxBytes}`);
  if (maxEntities) validationArgs.push(`--max-entities=${maxEntities}`);
  step(`validating game content before build (${gameId}) ...`);
  sh('bun', validationArgs, {
    failureMessage: `build blocked by game validation for '${gameId}'`,
  });
  requireFreshEngineDist('build');
  ok(`building static game '${gameId}' from ${gameDir}`);
  sh('bun', ['-F', '@forgeax/editor-play-runtime', 'build'], {
    env: {
      ...process.env,
      FORGEAX_GAME_DIR: gameDir,
      FORGEAX_GAME_ID: gameId,
      FORGEAX_GAMES_URL_PREFIX: 'host-games',
      FORGEAX_STATIC_GAME_DIR: gameDir,
      FORGEAX_STATIC_GAME_ID: gameId,
      FORGEAX_STATIC_GAME_ENTRY: entry,
      FORGEAX_BUILD_OUT_DIR: outDir,
    },
    failureMessage: `build failed for game '${gameId}'`,
  });
  ok(`static artifact ready: ${outDir}`);
}

// ── ci ──────────────────────────────────────────────────────────────────────
// Local projection of the required editor PR surface. The command manifest is
// shared by fast PR checks and the complete periodic run; the workflow still
// owns runner provisioning and artifact caching. A local checkout must have
// completed `bun fx setup` before these checks execute.
type CiProfile = RegressionProfile;
type CiOptions = { readonly profile: CiProfile; readonly fixtureLayer?: FixtureLayer; readonly reportPath?: string };
type CiFailureClass = 'admission' | 'environment' | 'source' | 'external-transport';
type CiCheckResult = {
  readonly id: string;
  readonly name: string;
  readonly roadmapId: string;
  readonly journey: string;
  readonly gate: string;
  readonly fixtureLayer: FixtureLayer;
  readonly status: 'pass' | 'failure';
  readonly failureClass: CiFailureClass | null;
  readonly durationMs: number;
  readonly exitCode: number;
};
type CiReport = {
  readonly $schema: typeof EDITOR_CI_REPORT_SCHEMA_VERSION;
  readonly contractVersion: typeof REGRESSION_CONTRACT_VERSION;
  readonly checkId: string;
  readonly owner: string;
  readonly profile: CiProfile;
  readonly executionHome: 'local-fast' | 'local-full';
  readonly provenance: { readonly kind: 'local'; readonly timingDomain: 'local-execution'; readonly editorCommit: string };
  readonly terminalStatus: 'pass' | 'failure';
  readonly failureClass: CiFailureClass | null;
  readonly code: string | null;
  readonly expected: string | null;
  readonly observed: string | null;
  readonly hint: string;
  readonly attempts: readonly { readonly attempt: number; readonly attemptId: string; readonly status: 'pass' | 'failure' }[];
  readonly sloClaim: null;
  readonly prerequisiteRelease: CiPrerequisiteRelease | null;
  readonly fixtureLayer: FixtureLayer | 'all';
  readonly editorCommit: string;
  readonly checks: readonly CiCheckResult[];
  readonly firstFailure: {
    readonly attempt: number;
    readonly attemptId: string;
    readonly code: string;
    readonly expected: string;
    readonly observed: string;
    readonly hint: string;
    readonly id: string;
    readonly roadmapId: string;
    readonly journey: string;
    readonly gate: string;
    readonly fixtureLayer: FixtureLayer;
    readonly exitCode: number;
  } | null;
};

type CiPrerequisiteRelease = {
  readonly artifactId: string;
  readonly releaseDigest: string;
  readonly schemaVersion: string;
  readonly producerRunId: string;
  readonly producerAttempt: number;
  readonly sourceSha: string;
  readonly recursivePins: readonly { readonly path: string; readonly pin: string }[];
  readonly producerSuccess: boolean;
  readonly compatibility: { readonly status: string; readonly expected?: unknown; readonly observed?: unknown };
  readonly validation: {
    readonly status: 'pass' | 'failure';
    readonly consumer: string;
    readonly payloadClasses?: readonly string[];
    readonly code?: string;
    readonly failedField?: string;
    readonly expected?: unknown;
    readonly observed?: unknown;
    readonly affectedConsumer?: string;
    readonly artifactId?: string | null;
    readonly hint?: string;
  };
};

const CI_CONTEXT = 'epic=R3-07 work package=R3-07E gates=C1,C2,C3,C4,C5,C6,C7';

function ciRoute(profile: CiProfile, check?: Pick<RegressionCheck, 'roadmapId' | 'fixtureLayer' | 'journey' | 'gate'>): string {
  const route = check ?? { roadmapId: 'R3-07E', fixtureLayer: 'R0' as const, journey: 'J0/J1/J2/J3/J4/J5', gate: 'C1-C7' };
  return `profile=${profile} ${CI_CONTEXT} roadmap=${route.roadmapId} fixtureLayer=${route.fixtureLayer} journey=${route.journey} gate=${route.gate}`;
}

function parseCiOptions(argv: string[]): CiOptions {
  let profile: CiProfile = 'full';
  let fixtureLayer: FixtureLayer | undefined;
  let reportPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fast') profile = 'fast';
    else if (arg === '--full') profile = 'full';
    else if (arg === '--layer' || arg === '--fixture-layer') {
      const value = argv[++index];
      if (!value) die(`${arg} needs R0, R1, or R2`);
      try {
        fixtureLayer = parseFixtureLayer(value);
      } catch (error) {
        die(error instanceof Error ? error.message : String(error));
      }
    } else if (arg === '--report') {
      reportPath = argv[++index];
      if (!reportPath) die('--report needs a file path');
    } else {
      die(`unknown ci flag '${arg}'; expected --fast, --full, --layer R0|R1|R2, or --report <path>`);
    }
  }
  return { profile, fixtureLayer, reportPath };
}

function defaultCiReportPath(profile: CiProfile, editorCommit: string): string {
  return join(ROOT, '.forgeax-harness', 'ci-reports', `r3-07-${profile}-${editorCommit.slice(0, 12)}.json`);
}

function writeCiReport(path: string, report: CiReport): void {
  const validation = validateEditorCiReport(report);
  if (!validation.ok) {
    const { code, expected, observed, hint } = validation.error;
    die(`CI report contract failure: code=${code} expected=${expected} observed=${observed} hint=${hint}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[fx] regression report: ${path}`);
}

type CiFailure = {
  readonly failureClass: CiFailureClass;
  readonly code: string;
  readonly expected: string;
  readonly observed: string;
  readonly hint: string;
  readonly exitCode?: number;
};

function ciExecutionHome(profile: CiProfile): 'local-fast' | 'local-full' {
  return profile === 'fast' ? 'local-fast' : 'local-full';
}

function displayValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function prerequisiteFailureClass(code: string): CiFailureClass {
  if (code === 'compatibility-mismatch') return 'environment';
  if (code === 'source-mismatch' || code === 'pin-mismatch' || code === 'attempt-mismatch') return 'source';
  return 'admission';
}

function projectLocalPrerequisiteRelease(
  manifest: Record<string, unknown> | null,
  validation: { readonly ok: boolean; readonly error?: Record<string, unknown>; readonly consumer?: string; readonly payloadClasses?: readonly string[] },
  profile: CiProfile,
  payloadClasses: readonly string[],
): CiPrerequisiteRelease | null {
  if (!manifest || typeof manifest.artifactId !== 'string' || typeof manifest.releaseDigest !== 'string' ||
      typeof manifest.schemaVersion !== 'string' || typeof manifest.producerRunId !== 'string' ||
      !Number.isInteger(manifest.producerAttempt) || typeof manifest.sourceSha !== 'string' ||
      !Array.isArray(manifest.recursivePins) || typeof manifest.producerSuccess !== 'boolean' ||
      !manifest.compatibility || typeof manifest.compatibility !== 'object') return null;
  const error = validation.ok ? {} : (validation.error ?? {});
  return {
    artifactId: manifest.artifactId,
    releaseDigest: manifest.releaseDigest,
    schemaVersion: manifest.schemaVersion,
    producerRunId: manifest.producerRunId,
    producerAttempt: manifest.producerAttempt as number,
    sourceSha: manifest.sourceSha,
    recursivePins: manifest.recursivePins as { readonly path: string; readonly pin: string }[],
    producerSuccess: manifest.producerSuccess,
    compatibility: {
      status: validation.ok ? 'compatible' : 'rejected',
      expected: error.expected ?? null,
      observed: error.observed ?? null,
    },
    validation: validation.ok
      ? { status: 'pass', consumer: profile, payloadClasses: validation.payloadClasses ?? payloadClasses }
      : {
          status: 'failure',
          consumer: profile,
          payloadClasses,
          code: String(error.code ?? 'prerequisite-validation-failed'),
          failedField: error.failedField as string | undefined,
          expected: error.expected,
          observed: error.observed,
          affectedConsumer: error.affectedConsumer as string | undefined,
          artifactId: error.artifactId as string | null | undefined,
          hint: String(error.hint ?? 'Fix the prerequisite release before rerunning local CI.'),
        },
  };
}

function runLocalPrerequisiteRelease(profile: CiProfile, editorCommit: string): {
  readonly ok: true;
  readonly report: CiPrerequisiteRelease;
} | {
  readonly ok: false;
  readonly failure: CiFailure;
  readonly report: CiPrerequisiteRelease | null;
} {
  const consumers = selectPrerequisiteConsumers(profile);
  const payloadClasses = selectPrerequisitePayloadClasses(profile);
  const outputDir = mkdtempSync(join(tmpdir(), 'forgeax-local-prerequisite-'));
  const producerRunId = `local-${editorCommit.slice(0, 12)}`;
  const bun = resolveBunExecutable('bun');
  const command = (args: readonly string[]) => spawnSync(bun, [...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  try {
    const producer = command([
      'scripts/ci/prerequisite-release.mjs',
      'produce',
      '--output', outputDir,
      '--profile', 'complete',
      '--source-sha', editorCommit,
      '--run-id', producerRunId,
      '--attempt', '1',
    ]);
    let producerSummary: Record<string, unknown>;
    try {
      producerSummary = JSON.parse(producer.stdout) as Record<string, unknown>;
    } catch (error) {
      return {
        ok: false,
        report: null,
        failure: {
          failureClass: 'environment',
          code: 'prerequisite-producer-output-invalid',
          expected: 'JSON producer summary',
          observed: error instanceof Error ? error.message : String(error),
          hint: 'Inspect the local prerequisite producer output before running local CI checks.',
          exitCode: producer.status ?? 1,
        },
      };
    }
    if (producer.status !== 0 || producerSummary.ok !== true) {
      const error = (producerSummary.error ?? {}) as Record<string, unknown>;
      return {
        ok: false,
        report: null,
        failure: {
          failureClass: prerequisiteFailureClass(String(error.code ?? 'producer-failure')),
          code: String(error.code ?? 'producer-failure'),
          expected: displayValue(error.expected ?? 'complete local prerequisite release'),
          observed: displayValue(error.observed ?? (producer.stderr.trim() || 'producer exited unsuccessfully')),
          hint: String(error.hint ?? 'Fix local prerequisite materialization and rerun the selected profile.'),
          exitCode: producer.status ?? 1,
        },
      };
    }
    const manifest = JSON.parse(readFileSync(join(outputDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    let lastValidation: Record<string, unknown> | null = null;
    for (const consumer of consumers) {
      const validation = command([
        'scripts/ci/prerequisite-release.mjs',
        'validate',
        '--manifest', join(outputDir, 'manifest.json'),
        '--consumer', consumer,
        '--source-sha', editorCommit,
        '--run-id', producerRunId,
        '--attempt', '1',
      ]);
      let result: Record<string, unknown>;
      try {
        result = JSON.parse(validation.stdout) as Record<string, unknown>;
      } catch (error) {
        return {
          ok: false,
          report: projectLocalPrerequisiteRelease(manifest, {ok: false, error: {code: 'prerequisite-validator-output-invalid', observed: error instanceof Error ? error.message : String(error), hint: 'Inspect the local validator output.'}}, profile, payloadClasses),
          failure: {
            failureClass: 'environment',
            code: 'prerequisite-validator-output-invalid',
            expected: 'JSON validator result',
            observed: error instanceof Error ? error.message : String(error),
            hint: 'Inspect the local prerequisite validator output before running local CI checks.',
            exitCode: validation.status ?? 1,
          },
        };
      }
      if (validation.status !== 0 || result.ok !== true) {
        const error = (result.error ?? {}) as Record<string, unknown>;
        const report = projectLocalPrerequisiteRelease(manifest, {ok: false, error}, profile, payloadClasses);
        return {
          ok: false,
          report,
          failure: {
            failureClass: prerequisiteFailureClass(String(error.code ?? 'prerequisite-validation-failed')),
            code: String(error.code ?? 'prerequisite-validation-failed'),
            expected: displayValue(error.expected ?? 'validated local prerequisite payloads'),
            observed: displayValue(error.observed ?? 'validation failed'),
            hint: String(error.hint ?? 'Fix the local prerequisite release before running the consumer.'),
            exitCode: validation.status ?? 1,
          },
        };
      }
      lastValidation = result;
    }
    const report = projectLocalPrerequisiteRelease(manifest, {
      ok: true,
      consumer: profile,
      payloadClasses: payloadClasses,
    }, profile, payloadClasses);
    if (!report || !lastValidation) {
      return {
        ok: false,
        report,
        failure: {
          failureClass: 'environment',
          code: 'prerequisite-validation-empty',
          expected: 'at least one local prerequisite consumer validation',
          observed: displayValue(consumers),
          hint: 'Keep local profile prerequisite consumers aligned with the producer-owned contract.',
        },
      };
    }
    return {ok: true, report};
  } finally {
    rmSync(outputDir, {recursive: true, force: true});
  }
}

function makeCiReport(
  profile: CiProfile,
  editorCommit: string,
  checks: readonly CiCheckResult[],
  failure?: CiFailure & { readonly check?: RegressionCheck },
  prerequisiteRelease: CiPrerequisiteRelease | null = null,
): CiReport {
  const attemptId = `local-${editorCommit.slice(0, 12)}-${checks.length + 1}`;
  const firstFailure = failure
    ? {
        attempt: 1,
        attemptId,
        code: failure.code,
        expected: failure.expected,
        observed: failure.observed,
        hint: failure.hint,
        id: failure.check?.id ?? 'ci-admission',
        roadmapId: failure.check?.roadmapId ?? 'R3-07',
        journey: failure.check?.journey ?? 'J0/J1',
        gate: failure.check?.gate ?? 'C1-C7',
        fixtureLayer: failure.check?.fixtureLayer ?? 'R0',
        exitCode: failure.exitCode ?? 1,
      }
    : undefined;
  return {
    $schema: EDITOR_CI_REPORT_SCHEMA_VERSION,
    contractVersion: REGRESSION_CONTRACT_VERSION,
    checkId: failure?.check?.id ?? 'ci-profile',
    owner: failure?.check?.owner ?? 'editor-ci',
    profile,
    executionHome: ciExecutionHome(profile),
    provenance: { kind: 'local', timingDomain: 'local-execution', editorCommit },
    terminalStatus: failure ? 'failure' : 'pass',
    failureClass: failure?.failureClass ?? null,
    code: failure?.code ?? null,
    expected: failure?.expected ?? null,
    observed: failure?.observed ?? null,
    hint: failure?.hint ?? 'No recovery action is required.',
    attempts: [{ attempt: 1, attemptId, status: failure ? 'failure' : 'pass' }],
    sloClaim: null,
    prerequisiteRelease,
    fixtureLayer: 'all',
    editorCommit,
    checks,
    firstFailure: firstFailure ?? null,
  };
}

function writeAdmissionReport(
  reportPath: string,
  profile: CiProfile,
  editorCommit: string,
  failure: CiFailure,
): never {
  writeCiReport(reportPath, makeCiReport(profile, editorCommit, [], failure));
  die(`CI admission failure: code=${failure.code} report=${reportPath}`);
}

function discoverContract(): void {
  const validation = spawnSync(
    resolveBunExecutable('bun'),
    [
      'scripts/ci/editor-ci-contract.mjs',
      '--workflows-dir',
      '.github/workflows',
      '--ruleset-file',
      'scripts/ci/fixtures/ruleset.json',
    ],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (validation.status !== 0) {
    die(`contract discovery admission failed: ${validation.stderr || validation.stdout}`);
  }
  const contract = JSON.parse(readFileSync(join(ROOT, 'scripts', 'ci', 'editor-ci-contract.json'), 'utf8')) as {
    readonly version: string;
    readonly checks: readonly {
      readonly checkId: string;
      readonly owner: string;
      readonly command: string;
      readonly executionHome: Readonly<Record<string, boolean>>;
    }[];
    readonly profiles: Readonly<Record<string, readonly string[]>>;
    readonly requiredContexts: readonly { readonly context: string; readonly checkId: string }[];
    readonly baselineEvidence: unknown;
    readonly prerequisiteRelease: unknown;
  };
  console.log(JSON.stringify({
    schemaVersion: contract.version,
    checks: contract.checks,
    profiles: contract.profiles,
    requiredContexts: contract.requiredContexts,
    baselineEvidence: contract.baselineEvidence,
    prerequisiteRelease: contract.prerequisiteRelease,
    recovery: {
      dirtyWorktree: 'commit or stash changes before executing a local CI profile',
      missingSetup: 'run bun fx setup before executing engine-backed checks',
      unsafeBoundary: 'stop when trusted workflow admission cannot be proven',
    },
  }, null, 2));
}

type BaselineEvidenceInput = {
  readonly schemaVersion?: string;
  readonly attemptProvenance?: Record<string, unknown>;
  readonly criticalPath?: unknown;
  readonly requiredContexts?: unknown;
  readonly costFacts?: unknown;
  readonly readiness?: unknown;
  readonly budgetClaim?: unknown;
  readonly noClaim?: unknown;
  readonly rawPacket?: unknown;
};

function baselineCliError(
  code: string,
  expected: unknown,
  observed: unknown,
  hint: string,
  affectedProvenance: unknown = null,
): Record<string, unknown> {
  return {ok: false, status: 'no-claim', error: {code, expected, observed, hint, affectedProvenance}};
}

function readBaselineEvidence(inputPath: string): Record<string, unknown> {
  let input: BaselineEvidenceInput & {baselineInput?: BaselineEvidenceInput};
  try {
    input = JSON.parse(readFileSync(resolve(ROOT, inputPath), 'utf8')) as BaselineEvidenceInput & {baselineInput?: BaselineEvidenceInput};
  } catch (error) {
    return baselineCliError(
      'baseline-input-unreadable',
      'a readable baseline evidence JSON file',
      error instanceof Error ? error.message : String(error),
      'Provide the exact current attempt baseline JSON; do not substitute a local editor CI report or a historical fixture.',
    );
  }
  const evidence = input.baselineInput ?? input;
  try {
    validateBaselineEvidence(evidence);
  } catch (error) {
    return baselineCliError(
      error instanceof Error && 'code' in error ? String(error.code) : 'baseline-evidence-invalid',
      error instanceof Error && 'expected' in error ? error.expected : {schemaVersion: BASELINE_EVIDENCE_SCHEMA_VERSION, attemptProvenance: 'complete'},
      error instanceof Error && 'observed' in error ? error.observed : {schemaVersion: evidence.schemaVersion ?? null, attemptProvenance: evidence.attemptProvenance ?? null},
      error instanceof Error && 'hint' in error ? String(error.hint) : 'Read a collector-produced attempt evidence packet with source, run, attempt, topology, roster, and workflow provenance.',
      error instanceof Error && 'affectedProvenance' in error ? error.affectedProvenance : evidence.attemptProvenance ?? null,
    );
  }
  const noClaims = Array.isArray(evidence.noClaim) ? evidence.noClaim : evidence.noClaim ? [evidence.noClaim] : [];
  const facts = {
    criticalPath: evidence.criticalPath ?? null,
    requiredContexts: evidence.requiredContexts ?? null,
    costFacts: evidence.costFacts ?? null,
    readiness: evidence.readiness ?? null,
  };
  const budgetClaim = evidence.budgetClaim ?? null;
  const summary = {
    status: budgetClaim ? 'observed' : 'no-claim',
    schema: evidence.schemaVersion,
    provenance: evidence.attemptProvenance,
    claim: budgetClaim ? 'budgetClaim' : 'no-claim',
  };
  const packetlessError = evidence.attemptProvenance == null
    ? noClaims[0] ?? {
      code: 'attempt-packet-missing',
      expected: 'a complete current attempt packet or an explicit rejection envelope',
      observed: 'no attempt provenance and no no-claim envelope',
      hint: 'Collect the exact current attempt packet before using this baseline projection.',
      affectedProvenance: null,
    }
    : null;
  return {
    ok: packetlessError === null,
    status: summary.status,
    ...(packetlessError ? {error: packetlessError} : {}),
    summary,
    schema: {
      version: evidence.schemaVersion,
      fields: [...BASELINE_TOP_INDEX_FIELDS],
      layers: [...BASELINE_TOP_INDEX_LAYERS],
      errorFields: ['code', 'expected', 'observed', 'hint', 'affectedProvenance'],
    },
    provenance: {attemptProvenance: structuredClone(evidence.attemptProvenance)},
    facts,
    claims: {budgetClaim},
    noClaims,
    rawPacket: evidence.rawPacket ?? {available: false, path: null},
    attemptProvenance: structuredClone(evidence.attemptProvenance),
    criticalPath: facts.criticalPath,
    requiredContexts: facts.requiredContexts,
    costFacts: facts.costFacts,
    readiness: facts.readiness,
    budgetClaim,
    noClaim: noClaims,
  };
}

function discoverBaseline(args: readonly string[]): void {
  const inputIndex = args.indexOf('--input');
  const inputPath = inputIndex >= 0 ? args[inputIndex + 1] : undefined;
  const invalidFlags = args.filter((arg, index) => (
    arg !== '--json' && arg !== '--input' && !(inputIndex >= 0 && index === inputIndex + 1)
  ));
  if (!args.includes('--json')) {
    console.log(JSON.stringify(baselineCliError('baseline-json-required', '--json', 'missing', 'Request JSON output so facts, claims, no-claims, provenance, and recovery fields remain machine-readable.'), null, 2));
    process.exitCode = 1;
    return;
  }
  if (invalidFlags.length > 0 || !inputPath) {
    console.log(JSON.stringify(baselineCliError('baseline-input-missing', '--input PATH', inputPath ?? 'missing', 'Pass the exact collector baseline evidence JSON; this front door does not invent cloud facts locally.'), null, 2));
    process.exitCode = 1;
    return;
  }
  const result = readBaselineEvidence(inputPath);
  console.log(JSON.stringify(result, null, 2));
  if (result.ok !== true) process.exitCode = 1;
}

function requiredCiArtifacts(): readonly string[] {
  return [
    join(ENGINE_DIR, 'packages', 'vite-plugin-shader', 'dist', 'index.mjs'),
    join(ENGINE_DIR, 'packages', 'wgpu-wasm', 'pkg', 'wgpu_wasm_bg.wasm'),
  ];
}

function ensureCiAdmission(profile: CiProfile, reportPath: string, editorCommit: string): void {
  if (isDirty()) {
    writeAdmissionReport(reportPath, profile, editorCommit, {
      failureClass: 'admission',
      code: 'dirty-worktree',
      expected: 'clean worktree before local CI execution',
      observed: 'git status --porcelain is non-empty',
      hint: 'Commit or stash changes, then rerun the selected local CI profile.',
    });
  }
  if (requiredCiArtifacts().some((path) => !existsSync(path))) {
    writeAdmissionReport(reportPath, profile, editorCommit, {
      failureClass: 'admission',
      code: 'setup-required',
      expected: 'engine dist and wasm artifacts are present',
      observed: 'one or more setup artifacts are missing',
      hint: 'Run bun fx setup before executing engine-backed checks.',
    });
  }
  const currentEngine = gitOut(['-C', ENGINE_DIR, 'rev-parse', 'HEAD']);
  const builtEngine = existsSync(ENGINE_DIST_SHA_FILE)
    ? readFileSync(ENGINE_DIST_SHA_FILE, 'utf8').trim()
    : '';
  if (!currentEngine || builtEngine !== currentEngine) {
    writeAdmissionReport(reportPath, profile, editorCommit, {
      failureClass: 'admission',
      code: 'stale-engine-dist',
      expected: currentEngine || 'readable engine submodule revision',
      observed: builtEngine || 'missing engine dist freshness marker',
      hint: 'Run bun fx setup to rebuild engine artifacts for the pinned submodule.',
    });
  }
}

function runCiCheck(check: RegressionCheck): CiCheckResult {
  const started = Date.now();
  // The producer-owned contract is a command line, not only an executable plus
  // argv. Keep shell operators such as `&&` meaningful for chained checks while
  // retaining one cross-platform execution boundary for every local profile.
  const commandLine = [check.command, ...check.args].join(' ');
  const shell = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
  const shellArgs = process.platform === 'win32'
    ? ['/d', '/s', '/c', commandLine]
    : ['-c', commandLine];
  const result = spawnSync(shell, shellArgs, {
    stdio: 'inherit',
    cwd: ROOT,
    env: process.env,
  });
  const failed = result.status !== 0;
  return {
    id: check.id,
    name: check.name,
    roadmapId: check.roadmapId,
    journey: check.journey,
    gate: check.gate,
    fixtureLayer: check.fixtureLayer,
    status: failed ? 'failure' : 'pass',
    failureClass: failed ? (result.error || result.status === null ? 'environment' : 'source') : null,
    durationMs: Date.now() - started,
    exitCode: result.status ?? 1,
  };
}

function runFreshCloneStep(
  profile: CiProfile,
  stage: string,
  command: string,
  args: readonly string[],
  cwd: string,
  expected: string,
): CiFailure | undefined {
  const result = spawnSync(command, [...args], {
    stdio: 'inherit',
    shell: IS_WIN,
    cwd,
    env: process.env,
  });
  if (result.status === 0) return undefined;
  const observed = result.status === null
    ? result.error?.message ?? 'process did not exit normally'
    : `process exited with code ${result.status}`;
  return {
    failureClass: 'environment',
    code: `fresh-${stage}`,
    expected,
    observed,
    hint: `Repair the fresh-clone environment and rerun ${ciRoute(profile)}.`,
    exitCode: result.status ?? 1,
  };
}

function verifyFreshFrozenInstall(profile: CiProfile): CiFailure | undefined {
  const branch = gitOut(['branch', '--show-current']);
  const head = gitOut(['rev-parse', 'HEAD']);
  if (!head) {
    return {
      failureClass: 'admission',
      code: 'commit-unavailable',
      expected: 'the current editor commit is resolvable',
      observed: 'git rev-parse HEAD returned no commit',
      hint: 'Run the local CI command from a valid editor checkout.',
    };
  }
  if (gitOut(['status', '--porcelain']) !== '') {
    return {
      failureClass: 'admission',
      code: 'dirty-worktree',
      expected: 'clean worktree before fresh-clone verification',
      observed: 'git status --porcelain is non-empty',
      hint: 'Commit or stash changes, then rerun the selected local CI profile.',
    };
  }
  const origin = gitOut(['remote', 'get-url', 'origin']);
  if (!origin) {
    return {
      failureClass: 'admission',
      code: 'origin-unavailable',
      expected: 'an origin remote is available for fresh-clone verification',
      observed: 'git remote get-url origin returned no URL',
      hint: 'Configure the editor origin remote, then rerun the selected local CI profile.',
    };
  }
  const tempRoot = mkdtempSync(join(tmpdir(), 'forgeax-editor-ci-'));
  const cloneDir = join(tempRoot, 'repo');
  try {
    // Match actions/checkout's clean recursive checkout. A same-worktree Bun
    // install can reuse parent workspace links and pass even when the committed
    // lock fails on GitHub, as happened with the engine-ui upgrade.
    const cloneFailure = runFreshCloneStep(
      profile,
      'clone',
      'git',
      ['clone', '--recurse-submodules', ...(branch ? ['--branch', branch] : []), origin, cloneDir],
      ROOT,
      'the editor repository and recursive submodules can be cloned',
    );
    if (cloneFailure) return cloneFailure;
    if (!branch) {
      // Studio consumes editor as a detached gitlink. Re-check out that exact
      // commit in the clean clone, then realign nested pins before frozen Bun
      // validates the same source tree Studio will ship.
      const checkoutFailure = runFreshCloneStep(
        profile,
        'exact-checkout',
        'git',
        ['checkout', '--detach', head],
        cloneDir,
        'the exact editor commit can be checked out in the clean clone',
      );
      if (checkoutFailure) return checkoutFailure;
      const submoduleFailure = runFreshCloneStep(
        profile,
        'submodule-checkout',
        'git',
        ['submodule', 'update', '--init', '--recursive'],
        cloneDir,
        'recursive submodules can be materialized for the exact editor commit',
      );
      if (submoduleFailure) return submoduleFailure;
    }
    return runFreshCloneStep(
      profile,
      'frozen-install',
      'npx',
      ['--yes', 'bun@1.3.14', 'install', '--frozen-lockfile', '--ignore-scripts'],
      cloneDir,
      'Bun 1.3.14 frozen install succeeds in a fresh clone',
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runCiProfile(
  profile: CiProfile,
  checks: readonly RegressionCheck[],
  editorCommit: string,
  reportPath: string,
  prerequisiteRelease: CiPrerequisiteRelease,
): readonly CiCheckResult[] {
  const results: CiCheckResult[] = [];
  const route = ciRoute(profile, checks[0]);
  step(`CI: ${route} stage=fresh-clone ...`);
  const freshFailure = verifyFreshFrozenInstall(profile);
  if (freshFailure) {
    writeCiReport(reportPath, makeCiReport(profile, editorCommit, [], freshFailure, prerequisiteRelease));
    die(`CI failure: ${route} stage=${freshFailure.code} report=${reportPath}`);
  }
  for (const check of checks) {
    const stepRoute = ciRoute(profile, check);
    step(`CI: ${stepRoute} stage=${check.name} ...`);
    const result = runCiCheck(check);
    results.push(result);
    if (result.status === 'failure') {
      const report = makeCiReport(profile, editorCommit, results, {
        failureClass: result.failureClass ?? 'source',
        code: 'check-failed',
        expected: 'selected check exits with code 0',
        observed: `${check.id} exited with code ${result.exitCode}`,
        hint: 'Inspect the first failed check and follow its structured recovery boundary.',
        check,
      }, prerequisiteRelease);
      writeCiReport(reportPath, report);
      die(`CI failure: ${stepRoute} stage=${check.name} command=${check.command} ${check.args.join(' ')} report=${reportPath}`);
    }
  }
  return results;
}

function ci(argv: string[]): void {
  if (argv[0] === 'baseline') {
    discoverBaseline(argv.slice(1));
    return;
  }
  if (argv[0] === 'contract') {
    if (argv.slice(1).some((arg) => arg !== '--json')) {
      die("unknown contract flag; expected --json");
    }
    discoverContract();
    return;
  }
  const options = parseCiOptions(argv);
  const profile = options.profile;
  const checks = selectRegressionChecks(profile, options.fixtureLayer);
  const route = ciRoute(profile, checks[0]);
  if (checks.length === 0) {
    die(`${route} has no checks; fast profile only contains R0, while R1/R2 require --full`);
  }
  const editorCommit = gitOut(['rev-parse', 'HEAD']);
  const reportPath = options.reportPath ?? defaultCiReportPath(profile, editorCommit);
  ensureCiAdmission(profile, reportPath, editorCommit);
  const prerequisite = runLocalPrerequisiteRelease(profile, editorCommit);
  if (!prerequisite.ok) {
    writeCiReport(reportPath, makeCiReport(profile, editorCommit, [], prerequisite.failure, prerequisite.report));
    die(`CI prerequisite failure: code=${prerequisite.failure.code} report=${reportPath}`);
  }
  const results = runCiProfile(profile, checks, editorCommit, reportPath, prerequisite.report);
  const report = makeCiReport(profile, editorCommit, results, undefined, prerequisite.report);
  writeCiReport(reportPath, report);
  ok(`local CI passed: ${route} checks=${results.length} report=${reportPath}`);
}

function usage(): void {
  console.log(`forgeax-editor — one-stop standalone dev CLI

Usage:
  bun fx <command> [args...]

Lifecycle:
  setup | install               prepare everything (submodules, deps, engine dist + wasm)
                                default: FORGEAX_HARNESS_SPARSE_DOCS=1 when unset
                                explicit full: FORGEAX_HARNESS_SPARSE_DOCS=0
                                skip Harness sync only: FORGEAX_SKIP_HARNESS_SYNC=1
                                terminal line: fx-setup/v1 JSON with requested/actual Harness modes;
                                existing full/sparse clones are not auto-migrated
  start | run [--play]          start the stack (:${STANDALONE_PORT} host + :${EDIT_RUNTIME_PORT} edit-runtime
                                [+ :${PLAY_RUNTIME_PORT} play-runtime with --play/--game]); Ctrl-C stops
  start --game DIR              open a real game (DIR directly contains forge.json)
  start --bg                    start in background, returns immediately
  start --rhi-debug            enable viewport RHI capture + reviewer (:${RHI_REVIEWER_PORT})
  stop                          stop everything the CLI started (by port)

Shipping:
  build --game DIR [--out DIR]  validate and bundle one game into a static
                                artifact; serve it with any plain HTTP server at
                                /preview/. Optional budgets: --max-bytes N,
                                --max-entities N.

  Gateway bridge (:${editorBridgePort()} for this checkout) is ON so the forgeax-editor-gateway
  skill's gateway.mjs can drive the open window; set FORGEAX_BRIDGE=0 to
  disable, FORGEAX_BRIDGE_PORT to move it.

Repo maintenance:
  update [--dry-run] [--no-stash]
                                pull root code, sync ALL submodules to pins, and
                                fast-forward .forgeax-harness (auto-stash local edits)
  clean [--deep|-x] [--dry-run|-n]
                                restore a fully-clean git status across root + all
                                submodules (scrubs regenerable artefacts; keeps the
                                toolchain-gated engine wasm pkg dirs). --deep also
                                wipes root node_modules/dist/wasm. Keeps .forgeax-harness.
  ci [--fast|--full] [--layer R0|R1|R2] [--report PATH]
                                run the tiered R0–R2 regression manifest with
                                stable Roadmap/journey/C1-C7 routing labels.
                                --fast is the R0 PR subset; --full is the
                                complete periodic set; --layer narrows it.
  ci:fast / ci:full             package-script aliases for the two profiles;
                                both require bun fx setup; --full also needs
                                installed Playwright Chromium.
  ci contract --json             read and validate the producer-owned CI
                                contract without executing a check.
  ci baseline --json --input PATH
                                progressively discover one attempt's facts,
                                claims, no-claims, provenance, and raw packet.
                                The input must be collector evidence; local
                                editor CI reports are not cloud fact producers.
  JSON layers: summary -> schema -> facts / claims / no-claims -> raw-packet;
  public vocabulary: facts / claims / no-claims / provenance.

  ddc status|rebuild|prune --game DIR --json
                                inspect or recover project-local DDC state;
                                prune is dry-run unless --execute is explicit.

  worktree <name> [flags]      create .worktrees/<name> with shallow recursive
                                submodules, shared/sparse harness, frozen Bun
                                dependencies, setup, and a persistent port slot.
                                --from REF       use another commit/ref
                                --jobs N          shallow fetch jobs (1..8)
                                --no-setup/--fast skip engine dist/wasm setup
                                --keep-on-failure retain failed bootstrap
                                --dry-run/-n      print the plan only
                                Alias: wt. Run bun fx start inside the result.

  help | -h | --help            show this message

First time:  bun fx setup && bun fx start`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? '';
  const rest = process.argv.slice(3);
  switch (cmd) {
    case 'install':
    case 'setup':
      await install();
      break;
    case 'run':
    case 'start':
      await run(rest);
      break;
    case 'stop':
      await stop();
      break;
    case 'build':
      build(rest);
      break;
    case 'update':
      update(rest);
      break;
    case 'clean':
      clean(rest);
      break;
    case 'ci':
      ci(rest);
      break;
    case 'ddc':
      process.exitCode = await runDdcCli(rest);
      break;
    case 'worktree':
    case 'wt':
      try {
        await createWorktree(rest);
      } catch (error) {
        die(error instanceof Error ? error.message : String(error));
      }
      break;
    case '':
    case '-h':
    case '--help':
    case 'help':
      usage();
      break;
    default:
      usage();
      die(`unknown command: ${cmd}`);
  }
}

if (import.meta.main) await main();
