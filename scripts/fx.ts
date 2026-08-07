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
//   :15290  standalone chrome host (vite, root=standalone/) — the page you open
//   :15280  edit-runtime (panel + viewport iframe source); host proxies /editor → it
//   :15273  play-runtime (pure engine preview) — with `start --play`, or
//           automatically when `--game` is supplied (NOT 15173 — see
//           PLAY_RUNTIME_PORT below: studio's superrepo stack owns 15173)

import { type ChildProcess, execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  die,
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
  runSupervisedCommand,
} from './lib/setup-process.ts';
import {
  REGRESSION_MANIFEST_VERSION,
  parseFixtureLayer,
  selectRegressionChecks,
  type FixtureLayer,
  type RegressionCheck,
  type RegressionProfile,
} from './regression-manifest.ts';
import {
  WORKTREE_CONFIG_FILE,
  portEnvironment,
  resolveWorktreePorts,
  type PortMap,
} from './lib/worktree-ports.ts';
import { createWorktree } from './worktree.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..'); // scripts/ -> repo root
const ENGINE_DIR = join(ROOT, 'packages', 'engine');
// Gitignored freshness marker shared with forgeax-studio. Engine packages export
// built `dist/`, so a submodule pointer bump after setup otherwise leaves Vite
// happily serving the previous revision's JavaScript.
const ENGINE_DIST_SHA_FILE = join(ENGINE_DIR, '.dist-sha');
const WASM_DIR = join(ENGINE_DIR, 'packages', 'wgpu-wasm');
const WASM_FILE = join(WASM_DIR, 'pkg', 'wgpu_wasm_bg.wasm');
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

type ShOptions = { cwd?: string; env?: NodeJS.ProcessEnv; failureMessage?: string };

/** Run a command synchronously with inherited stdio; die on non-zero exit. */
function sh(cmd: string, args: string[], opts: ShOptions = {}): void {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: IS_WIN,
    cwd: opts.cwd ?? ROOT,
    env: opts.env ?? process.env,
  });
  if (r.status !== 0) die(opts.failureMessage ?? `command failed: ${cmd} ${args.join(' ')}`);
}

/** Run a command synchronously with inherited stdio; return false on failure. */
function trySh(cmd: string, args: string[], opts: ShOptions = {}): boolean {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: IS_WIN,
    cwd: opts.cwd ?? ROOT,
    env: opts.env ?? process.env,
  });
  return r.status === 0;
}

/** Resolve the exact Engine source revision that the current checkout pins. */
function engineHead(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ENGINE_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    die('could not resolve the engine submodule revision. Run: bun fx setup');
  }
}

/** Record that every Engine dist artifact was built for the current gitlink. */
function writeEngineDistSha(): void {
  writeFileSync(ENGINE_DIST_SHA_FILE, `${engineHead()}\n`);
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
function ensureWasm(): void {
  if (existsSync(WASM_FILE)) {
    ok('wasm present (skip build): packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm');
    return;
  }
  step('wasm missing — building from Rust (wgpu-wasm build:wasm, ~1-2 min) ...');
  requireCmd('rustc', 'wasm build needs Rust. install: https://rustup.rs');
  requireCmd('wasm-pack', 'wasm build needs wasm-pack. install: cargo install wasm-pack');
  // The wgpu-wasm Rust→wasm build stays bash (toolchain wrapper); invoke via its
  // package script so we never hard-code the script path.
  sh('pnpm', ['-F', '@forgeax/engine-wgpu-wasm', 'build:wasm'], { cwd: ENGINE_DIR });
  if (!existsSync(WASM_FILE)) die(`wasm build ran but ${WASM_FILE} is still absent.`);
  ok('wasm built');
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
  requireCmd('emcc', 'the local fbx wasm build needs Emscripten. install: brew install emscripten (or activate emsdk)');
  // build:wasm = fetch-ufbx (idempotent, downloads ufbx.c) + emcc. Invoke via
  // the package script so the emcc flag set stays owned by @forgeax/engine-fbx.
  sh('pnpm', ['-F', '@forgeax/engine-fbx', 'build:wasm'], { cwd: ENGINE_DIR });
  if (!existsSync(FBX_WASM_MJS) || !existsSync(FBX_WASM_FILE)) {
    die(`fbx wasm build ran but ${FBX_WASM_MJS} / ${FBX_WASM_FILE} still absent.`);
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
  requireCmd('emcc', 'the local codec wasm build needs Emscripten. install: brew install emscripten (or activate emsdk)');
  // build:wasm = fetch-basis (idempotent, downloads pinned basis_universal
  // source) + emcc -O3 compile. Invoke via the package script so the emcc flag
  // set stays owned by @forgeax/engine-codec. NOTE: multi-minute compile.
  sh('pnpm', ['-F', '@forgeax/engine-codec', 'build:wasm'], { cwd: ENGINE_DIR });
  if (!codecWasmPresent()) {
    die(`codec wasm build ran but ${CODEC_WASM_MJS} / ${CODEC_WASM_FILE} / ${CODEC_ENCODER_WASM_FILE} still absent.`);
  }
  ok('codec wasm built');
}

/**
 * Bun sees the engine's nested packages as editor workspaces and can rewrite
 * engine/node_modules links to its own store. The engine's test helpers then
 * import a second Vitest instance from pnpm, so property suites lose their
 * active test context. Recreate only this generated directory before pnpm
 * installs its authoritative dependency graph.
 */
function resetEngineNodeModulesIfBunLinked(): void {
  const nodeModules = join(ENGINE_DIR, 'node_modules');
  const vitest = join(nodeModules, 'vitest');
  const bunStore = join(ROOT, 'node_modules', '.bun');

  if (!existsSync(vitest)) return;

  try {
    if (!realpathSync(vitest).startsWith(`${bunStore}${sep}`)) return;
  } catch {
    // A broken generated link is equally safe to replace with pnpm's graph.
  }

  warn('Bun linked engine dependencies into the editor store; recreating engine node_modules with pnpm.');
  rmSync(nodeModules, { force: true, recursive: true });
}

async function install(): Promise<void> {
  requireCmd('git', 'install git first.');
  requireCmd('bun', 'install bun: https://bun.sh');
  requireCmd('pnpm', 'install pnpm: https://pnpm.io (engine is a pnpm workspace)');

  step('1/8 fetching submodules (engine + interface + platform-io) ...');
  sh('git', ['submodule', 'update', '--init', '--recursive']);
  ok('submodules ready');

  step('2/8 installing editor workspace deps (bun) ...');
  sh('bun', ['install']);
  ok('bun deps ready');

  step(
    `3/8 installing engine deps (pnpm, network concurrency ${process.env.PNPM_CONFIG_NETWORK_CONCURRENCY ?? DEFAULT_PNPM_NETWORK_CONCURRENCY}) ...`,
  );
  resetEngineNodeModulesIfBunLinked();
  let installResult;
  try {
    installResult = await runSupervisedCommand('pnpm', ['install'], {
      cwd: ENGINE_DIR,
      env: engineInstallEnv(process.env),
      stdio: 'inherit',
    });
  } catch (error) {
    die(`could not start pnpm install: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (installResult.interrupted) {
    die('pnpm install interrupted; its child process tree was cleaned up.');
  }
  if (installResult.status !== 0) {
    die(`command failed: pnpm install (exit ${installResult.status})`);
  }
  ok('engine deps ready');

  // wasm MUST precede the engine dist build: the engine `app` package's tsup
  // build inlines wgpu-wasm/dist/index.mjs, which `import`s ../pkg/wgpu_wasm.js.
  // If pkg/ is absent (fresh clone — wasm is gitignored, built on demand),
  // esbuild fails to resolve it and the whole `pnpm -r build` aborts.
  // ENFORCED by scripts/lint-wasm-before-dist.mjs (bun run lint) — do not move
  // ensureWasm() below the `pnpm -r ... build` step or CI's typecheck job fails.
  step('4/8 ensuring wgpu wasm binary ...');
  ensureWasm();

  step('5/8 ensuring fbx wasm binary ...');
  ensureFbxWasm();

  step('6/8 ensuring codec wasm binaries ...');
  ensureCodecWasm();

  step('7/8 building engine library dist (pnpm -r, packages/* only — skips apps) ...');
  // Only the library packages emit the dist/ the editor imports. apps/hello/*
  // are example apps that need extra fixtures and are NOT needed here.
  sh('pnpm', ['-r', '--filter', './packages/*', 'build'], { cwd: ENGINE_DIR });
  ok('engine dist built');
  // Some package declarations share their dist/ directory with tsup's JS
  // output.  A repeated setup must clear only the prior TypeScript emit before
  // rebuilding declarations, otherwise tsc treats those .d.ts files as inputs
  // and fails with TS5055 (cannot overwrite input file).
  sh('pnpm', ['exec', 'tsc', '-b', '--clean'], { cwd: ENGINE_DIR });
  sh('pnpm', ['exec', 'tsc', '-b'], { cwd: ENGINE_DIR });
  ok('engine declarations built');

  step('8/8 rebuilding engine declaration graph ...');
  sh('pnpm', ['tsc', '-b', '--clean'], { cwd: ENGINE_DIR });
  sh('pnpm', ['tsc', '-b'], { cwd: ENGINE_DIR });
  ok('engine declarations built');

  step('verifying critical artifacts ...');
  let missing = false;
  for (const pkg of ['vite-plugin-shader', 'app', 'runtime', 'ecs', 'types', 'shader', 'gltf', 'npc']) {
    for (const artifact of ['index.mjs', 'index.d.ts', 'index.d.ts.map']) {
      if (!existsSync(join(ENGINE_DIR, 'packages', pkg, 'dist', artifact))) {
        warn(`missing engine dist: packages/${pkg}/dist/${artifact}`);
        missing = true;
      }
    }
  }
  if (!existsSync(WASM_FILE)) {
    warn(`missing wasm: ${WASM_FILE}`);
    missing = true;
  }
  if (!existsSync(FBX_WASM_MJS) || !existsSync(FBX_WASM_FILE)) {
    warn('missing fbx wasm: packages/fbx/pkg/fbx-wasm.{mjs,wasm}');
    missing = true;
  }
  if (!codecWasmPresent()) {
    warn('missing codec wasm: packages/codec/pkg/basis_transcoder.{mjs,wasm} + encode/basis_encoder.wasm');
    missing = true;
  }
  if (missing) die("install incomplete — see warnings above. Re-run 'bun fx setup'.");

  writeEngineDistSha();
  ok(`engine dist matches ${engineHead().slice(0, 12)}`);

  ok('install complete — run: bun fx start');
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
  // --rhi-debug: opt-in the engine's RHI frame capture. Setting the env for every
  // spawned vite process makes runtime-vite-preset register vite-plugin-rhi-debug
  // (which injects import.meta.env.FORGEAX_ENGINE_RHI_DEBUG=1 + the dev-server
  // /__forgeax-debug endpoints), flipping createApp's guard so the browser gets
  // window.__forgeax.captureFrame(n). Unset by default → zero injection, tree-shaken.
  // DEV-only live gateway bridge: on by default so `fx start` matches
  // `dev:standalone`. It takes both a relay process (:15296) AND a compile-time
  // flag so the editor page dials the relay — mirrors dev-standalone.ts. Opt out
  // with FORGEAX_BRIDGE=0. CRITICAL: the two Vite vars must reach the HOST vite
  // (`bun run dev`, :15290) — the standalone shell imports ViewportComponent
  // IN-PROCESS (standalone/main.tsx, no iframe / no /editor proxy), so the host
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
    // play-runtime serves games as sibling slugs under host-games; --game
    // supplies one slug directory, so inject its parent as the scan root.
    FORGEAX_PREVIEW_GAMES_DIR: gameDir ? dirname(gameDir) : '',
    FORGEAX_GAME_API_PORT: String(GAME_API_PORT),
    // The pure preview is proxied through the standalone host. Play Runtime
    // serves game files from an in-root `host-games/<slug>` farm, so a direct
    // --game path is exposed through its parent directory and the stable URL
    // prefix instead of falling through to the preview SPA HTML.
    ...(gameDir
      ? {
          FORGEAX_PREVIEW_GAMES_DIR: dirname(gameDir),
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

  // Always start from a clean slate, but only sweep editor-owned ports. In
  // particular, never use Studio's :15295 as the editor relay default.
  const editorPorts = managedPorts(Number(bridgePort), bridge);
  step(`stopping editor stack (ports ${editorPorts.join(' ')}) ...`);
  const killed = await killByPorts(editorPorts);
  if (!killed) ok('nothing to stop');

  // bridgeEnv already folded into `env`; edit-runtime just adds the HMR port.
  const editRuntimeEnv: NodeJS.ProcessEnv = { ...env, FORGEAX_INTERFACE_PORT: String(STANDALONE_PORT) };
  const editRuntimeArgs = ['-F', '@forgeax/editor-edit-runtime', 'dev', '--', '--port', String(EDIT_RUNTIME_PORT), '--strictPort'];

  if (bg) {
    // Background mode: detached + unref'd so children outlive this process on
    // every platform (mirrors the old `nohup … &`). Logs go to the temp dir.
    const logDir = tmpdir();
    const log = (name: string): number => openSync(join(logDir, `forgeax-editor-${name}.log`), 'a');
    step(`starting stack in background (logs → ${join(logDir, 'forgeax-editor-*.log')}) ...`);
    if (gameDir)
      spawnService('bun', [join(ROOT, 'standalone', 'game-backend.ts')], {
        cwd: ROOT,
        env,
        detach: true,
        logFd: log('game-backend'),
      });
    spawnService('bun', editRuntimeArgs, {
      cwd: ROOT,
      env: editRuntimeEnv,
      detach: true,
      logFd: log('edit-runtime'),
    });
    spawnService('bun', ['run', 'dev'], { cwd: ROOT, env, detach: true, logFd: log('host') });
    if (rhiDebug)
      spawnService('pnpm', ['-F', '@forgeax/engine-rhi-debug-viewer', 'exec', 'vite', '--port', String(RHI_REVIEWER_PORT), '--strictPort'], {
        cwd: ENGINE_DIR,
        env,
        detach: true,
        logFd: log('rhi-debug-reviewer'),
      });
    if (bridge)
      // Spawn with `bun`, not `node`: `ws` lives only in bun's isolated store
      // (node_modules/.bun/ws@*), unhoisted, so bare node ERR_MODULE_NOT_FOUNDs.
      spawnService('bun', [GATEWAY_RELAY_SCRIPT], {
        cwd: ROOT,
        env: { ...env, FORGEAX_BRIDGE_PORT: bridgePort },
        detach: true,
        logFd: log('bridge'),
      });
    if (play || gameDir)
      spawnService('bun', ['-F', '@forgeax/editor-play-runtime', 'dev'], {
        cwd: ROOT,
        // FORGEAX_ENGINE_PORT (= PLAY_RUNTIME_PORT) rides in the base `env`.
        env,
        detach: true,
        logFd: log('play'),
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
    children.push(spawnService('bun', [join(ROOT, 'standalone', 'game-backend.ts')], { cwd: ROOT, env }));
  }

  step(`starting edit-runtime :${EDIT_RUNTIME_PORT} (HMR→${STANDALONE_PORT}) ...`);
  children.push(spawnService('bun', editRuntimeArgs, { cwd: ROOT, env: editRuntimeEnv }));

  step(`starting standalone host :${STANDALONE_PORT} ...`);
  children.push(spawnService('bun', ['run', 'dev'], { cwd: ROOT, env }));

  if (rhiDebug) {
    step(`starting RHI reviewer :${RHI_REVIEWER_PORT} ...`);
    children.push(
      spawnService('pnpm', ['-F', '@forgeax/engine-rhi-debug-viewer', 'exec', 'vite', '--port', String(RHI_REVIEWER_PORT), '--strictPort'], {
        cwd: ENGINE_DIR,
        env,
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
      }),
    );
  }

  if (play || gameDir) {
    step(`starting play-runtime :${PLAY_RUNTIME_PORT} ...`);
    children.push(
      spawnService('bun', ['-F', '@forgeax/editor-play-runtime', 'dev'], {
        cwd: ROOT,
        // FORGEAX_ENGINE_PORT (= PLAY_RUNTIME_PORT) rides in the base `env`.
        env,
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
      FORGEAX_PREVIEW_GAMES_DIR: dirname(gameDir),
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
type CiCheckResult = {
  readonly id: string;
  readonly name: string;
  readonly roadmapId: string;
  readonly journey: string;
  readonly gate: string;
  readonly fixtureLayer: FixtureLayer;
  readonly status: 'passed' | 'failed';
  readonly durationMs: number;
  readonly exitCode: number;
};
type CiReport = {
  readonly schemaVersion: typeof REGRESSION_MANIFEST_VERSION;
  readonly profile: CiProfile;
  readonly fixtureLayer: FixtureLayer | 'all';
  readonly editorCommit: string;
  readonly status: 'passed' | 'failed';
  readonly checks: readonly CiCheckResult[];
  readonly firstFailure?: {
    readonly id: string;
    readonly roadmapId: string;
    readonly journey: string;
    readonly gate: string;
    readonly fixtureLayer: FixtureLayer;
    readonly exitCode: number;
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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[fx] regression report: ${path}`);
}

function runCiCheck(check: RegressionCheck): CiCheckResult {
  const started = Date.now();
  const result = spawnSync(check.command, [...check.args], {
    stdio: 'inherit',
    shell: IS_WIN,
    cwd: ROOT,
    env: process.env,
  });
  return {
    id: check.id,
    name: check.name,
    roadmapId: check.roadmapId,
    journey: check.journey,
    gate: check.gate,
    fixtureLayer: check.fixtureLayer,
    status: result.status === 0 ? 'passed' : 'failed',
    durationMs: Date.now() - started,
    exitCode: result.status ?? 1,
  };
}

function verifyFreshFrozenInstall(profile: CiProfile): void {
  const route = ciRoute(profile);
  const branch = gitOut(['branch', '--show-current']);
  const head = gitOut(['rev-parse', 'HEAD']);
  if (!head) die(`CI failure: ${route} stage=commit — could not resolve the editor commit to verify.`);
  if (gitOut(['status', '--porcelain']) !== '') {
    die(`CI failure: ${route} stage=clean-worktree — commit changes first so the fresh clone verifies the exact PR commit.`);
  }
  const origin = gitOut(['remote', 'get-url', 'origin']);
  if (!origin) die(`CI failure: ${route} stage=origin — an origin remote is required to reproduce the PR checkout.`);
  const tempRoot = mkdtempSync(join(tmpdir(), 'forgeax-editor-ci-'));
  const cloneDir = join(tempRoot, 'repo');
  try {
    // Match actions/checkout's clean recursive checkout. A same-worktree Bun
    // install can reuse parent workspace links and pass even when the committed
    // lock fails on GitHub, as happened with the engine-ui upgrade.
    sh('git', ['clone', '--recurse-submodules', ...(branch ? ['--branch', branch] : []), origin, cloneDir], {
      failureMessage: `CI failure: ${route} stage=fresh-clone`,
    });
    if (!branch) {
      // Studio consumes editor as a detached gitlink. Re-check out that exact
      // commit in the clean clone, then realign nested pins before frozen Bun
      // validates the same source tree Studio will ship.
      sh('git', ['checkout', '--detach', head], {
        cwd: cloneDir,
        failureMessage: `CI failure: ${route} stage=exact-checkout`,
      });
      sh('git', ['submodule', 'update', '--init', '--recursive'], {
        cwd: cloneDir,
        failureMessage: `CI failure: ${route} stage=submodule-checkout`,
      });
    }
    sh('npx', ['--yes', 'bun@1.3.14', 'install', '--frozen-lockfile', '--ignore-scripts'], {
      cwd: cloneDir,
      failureMessage: `CI failure: ${route} stage=frozen-install`,
    });
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function ci(argv: string[]): void {
  const options = parseCiOptions(argv);
  const profile = options.profile;
  const checks = selectRegressionChecks(profile, options.fixtureLayer);
  const route = ciRoute(profile, checks[0]);
  if (checks.length === 0) {
    die(`${route} has no checks; fast profile only contains R0, while R1/R2 require --full`);
  }
  const requiredArtifacts = [
    join(ENGINE_DIR, 'packages', 'vite-plugin-shader', 'dist', 'index.mjs'),
    join(ENGINE_DIR, 'packages', 'wgpu-wasm', 'pkg', 'wgpu_wasm_bg.wasm'),
  ];
  if (requiredArtifacts.some((path) => !existsSync(path))) {
    die(`CI failure: ${route} stage=setup — engine dist/wasm artefacts missing. Run \`bun fx setup\`.`);
  }
  requireFreshEngineDist(`CI failure: ${route} stage=engine-dist`);

  const editorCommit = gitOut(['rev-parse', 'HEAD']);
  const reportPath = options.reportPath ?? defaultCiReportPath(profile, editorCommit);
  const results: CiCheckResult[] = [];
  step(`CI: ${route} stage=fresh-clone ...`);
  verifyFreshFrozenInstall(profile);
  for (const check of checks) {
    const stepRoute = ciRoute(profile, check);
    step(`CI: ${stepRoute} stage=${check.name} ...`);
    const result = runCiCheck(check);
    results.push(result);
    if (result.status === 'failed') {
      const report: CiReport = {
        schemaVersion: REGRESSION_MANIFEST_VERSION,
        profile,
        fixtureLayer: options.fixtureLayer ?? 'all',
        editorCommit,
        status: 'failed',
        checks: results,
        firstFailure: {
          id: check.id,
          roadmapId: check.roadmapId,
          journey: check.journey,
          gate: check.gate,
          fixtureLayer: check.fixtureLayer,
          exitCode: result.exitCode,
        },
      };
      writeCiReport(reportPath, report);
      die(`CI failure: ${stepRoute} stage=${check.name} command=${check.command} ${check.args.join(' ')} report=${reportPath}`);
    }
  }
  const report: CiReport = {
    schemaVersion: REGRESSION_MANIFEST_VERSION,
    profile,
    fixtureLayer: options.fixtureLayer ?? 'all',
    editorCommit,
    status: 'passed',
    checks: results,
  };
  writeCiReport(reportPath, report);
  ok(`local CI passed: ${route} checks=${results.length} report=${reportPath}`);
}

function usage(): void {
  console.log(`forgeax-editor — one-stop standalone dev CLI

Usage:
  bun fx <command> [args...]

Lifecycle:
  setup | install               prepare everything (submodules, deps, engine dist + wasm)
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

  worktree <name> [--from REF]  create .worktrees/<name>, initialize recursive
                                submodules, install dependencies, run setup,
                                and allocate a persistent isolated port slot.
                                --no-setup skips the engine dist/wasm build.
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

await main();
