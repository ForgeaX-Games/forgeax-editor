#!/usr/bin/env bun
// fx.ts — one-stop TypeScript entry for the standalone forgeax-editor dev stack.
// Invoke as `bun fx <cmd>` (package.json script) or `bun scripts/fx.ts <cmd>`.
//
//   bun fx setup    # prepare everything (idempotent, re-runnable)   [alias: install]
//   bun fx start    # start the standalone stack (:15290 + :15280)   [alias: run]
//   bun fx stop     # stop anything fx started (by port)
//   bun fx update   # pull root + sync submodules to pins + ff .forgeax-harness
//   bun fx clean    # restore a fully-clean git status (root + submodules)
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
//   :15273  play-runtime (Play mode) — only with `start --play` (NOT 15173 — see
//           PLAY_RUNTIME_PORT below: studio's superrepo stack owns 15173)

import { type ChildProcess, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..'); // scripts/ -> repo root
const ENGINE_DIR = join(ROOT, 'packages', 'engine');
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
const PLAY_RUNTIME_PORT = 15273;
// 15295 = DEV-only live gateway bridge relay (on by default; FORGEAX_BRIDGE=0
// opts out). Listed so `stop`/startup-preflight free a stale relay too.
const PORTS = [15290, 15280, 15281, PLAY_RUNTIME_PORT, 15295];
const GAME_API_PORT = 15281;
// The gateway scripts live under the forgeax-editor-gateway skill (AI-first:
// the AI tools and their harness ship together). ROOT-relative because
// spawnService runs with cwd=ROOT. `ws` still resolves — bun walks up to the
// root node_modules from any depth.
const GATEWAY_RELAY_SCRIPT = 'skills/forgeax-editor-gateway/scripts/gateway-bridge-server.mjs';

const IS_WIN = process.platform === 'win32';

type ShOptions = { cwd?: string; env?: NodeJS.ProcessEnv };

/** Run a command synchronously with inherited stdio; die on non-zero exit. */
function sh(cmd: string, args: string[], opts: ShOptions = {}): void {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: IS_WIN,
    cwd: opts.cwd ?? ROOT,
    env: opts.env ?? process.env,
  });
  if (r.status !== 0) die(`command failed: ${cmd} ${args.join(' ')}`);
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
//     regenerable gitignored runtime products (engine build/, dist, wasm pkg).
// .forgeax-harness (floating loop-state clone, own .git) is ALWAYS preserved.
// --dry-run/-n previews. WARNING: discards ALL uncommitted work — commit first.
function clean(argv: string[]): void {
  requireCmd('git', 'install git first.');
  const dryRun = argv.includes('--dry-run') || argv.includes('-n');
  const deepRoot = argv.includes('--deep') || argv.includes('-x');
  const rootFlags = deepRoot ? '-fdx' : '-fd';
  const subScrub = dryRun ? 'git reset --hard -q && git clean -ffndx' : 'git reset --hard -q && git clean -ffdx';
  const rows: ReportRow[] = [];
  const push = (s: string, result: StepResult, detail?: string): void => {
    rows.push({ step: s, result, detail });
  };

  step(
    `clean: root=${deepRoot ? 'deep (wipes gitignored artefacts — re-run setup after)' : 'standard (keeps node_modules/dist/wasm)'} · submodules=deep${dryRun ? ' · DRY RUN' : ''}`,
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
  run('root-clean', ['clean', rootFlags, '-e', '.forgeax-harness', ...(dryRun ? ['-n'] : [])], 'root untracked removed');

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
  step(`stopping editor stack (ports ${PORTS.join(' ')}) ...`);
  const killed = await killByPorts(PORTS);
  if (!killed) ok('nothing to stop');
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

  warn('pre-built fbx wasm unavailable — falling back to local Emscripten build.');
  requireCmd(
    'emcc',
    'pre-built fbx wasm fetch failed and local build needs Emscripten. Authenticate GitHub with GH_TOKEN/GITHUB_TOKEN or `gh auth login`; otherwise install: brew install emscripten (or activate emsdk)',
  );
  // build:wasm = fetch-ufbx (idempotent, downloads ufbx.c) + emcc. Invoke via
  // the package script so the emcc flag set stays owned by @forgeax/engine-fbx.
  sh('pnpm', ['-F', '@forgeax/engine-fbx', 'build:wasm'], { cwd: ENGINE_DIR });
  if (!existsSync(FBX_WASM_MJS) || !existsSync(FBX_WASM_FILE)) {
    die(`fbx wasm build ran but ${FBX_WASM_MJS} / ${FBX_WASM_FILE} still absent.`);
  }
  ok('fbx wasm built');
}

function install(): void {
  requireCmd('git', 'install git first.');
  requireCmd('bun', 'install bun: https://bun.sh');
  requireCmd('pnpm', 'install pnpm: https://pnpm.io (engine is a pnpm workspace)');

  step('1/6 fetching submodules (engine + interface + platform-io) ...');
  sh('git', ['submodule', 'update', '--init', '--recursive']);
  ok('submodules ready');

  step('2/6 installing editor workspace deps (bun) ...');
  sh('bun', ['install']);
  ok('bun deps ready');

  step('3/6 installing engine deps (pnpm) ...');
  sh('pnpm', ['install'], { cwd: ENGINE_DIR });
  ok('engine deps ready');

  // wasm MUST precede the engine dist build: the engine `app` package's tsup
  // build inlines wgpu-wasm/dist/index.mjs, which `import`s ../pkg/wgpu_wasm.js.
  // If pkg/ is absent (fresh clone — wasm is gitignored, built on demand),
  // esbuild fails to resolve it and the whole `pnpm -r build` aborts.
  // ENFORCED by scripts/lint-wasm-before-dist.mjs (bun run lint) — do not move
  // ensureWasm() below the `pnpm -r ... build` step or CI's typecheck job fails.
  step('4/6 ensuring wgpu wasm binary ...');
  ensureWasm();

  step('5/6 ensuring fbx wasm binary ...');
  ensureFbxWasm();

  step('6/6 building engine library dist (pnpm -r, packages/* only — skips apps) ...');
  // Only the library packages emit the dist/ the editor imports. apps/hello/*
  // are example apps that need extra fixtures and are NOT needed here.
  sh('pnpm', ['-r', '--filter', './packages/*', 'build'], { cwd: ENGINE_DIR });
  ok('engine dist built');

  step('verifying critical artifacts ...');
  let missing = false;
  for (const pkg of ['vite-plugin-shader', 'app', 'runtime', 'ecs', 'types', 'shader', 'gltf']) {
    if (!existsSync(join(ENGINE_DIR, 'packages', pkg, 'dist', 'index.mjs'))) {
      warn(`missing engine dist: packages/${pkg}/dist/index.mjs`);
      missing = true;
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
  if (missing) die("install incomplete — see warnings above. Re-run 'bun fx setup'.");

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
  // spawned vite process makes engine-vite-preset register vite-plugin-rhi-debug
  // (which injects import.meta.env.FORGEAX_ENGINE_RHI_DEBUG=1 + the dev-server
  // /__forgeax-debug endpoints), flipping createApp's guard so the browser gets
  // window.__forgeax.captureFrame(n). Unset by default → zero injection, tree-shaken.
  // DEV-only live gateway bridge: on by default so `fx start` matches
  // `dev:standalone`. It takes both a relay process (:15295) AND a compile-time
  // flag so the editor page dials the relay — mirrors dev-standalone.ts. Opt out
  // with FORGEAX_BRIDGE=0. CRITICAL: the two Vite vars must reach the HOST vite
  // (`bun run dev`, :15290) — the standalone shell imports ViewportComponent
  // IN-PROCESS (standalone/main.tsx, no iframe / no /editor proxy), so the host
  // vite is what inlines `import.meta.env.VITE_FORGEAX_BRIDGE` into the page's
  // bridge-dial code. Giving it only to edit-runtime (:15280) leaves the page's
  // bridgeEnabled=false and connectBridge() never runs. So they go into the base
  // `env` shared by every spawn; the relay reads the runtime FORGEAX_BRIDGE_PORT.
  const bridge = process.env.FORGEAX_BRIDGE !== '0';
  const bridgePort = process.env.FORGEAX_BRIDGE_PORT ?? '15295';
  const bridgeEnv: NodeJS.ProcessEnv = bridge
    ? { VITE_FORGEAX_BRIDGE: '1', VITE_FORGEAX_BRIDGE_PORT: bridgePort }
    : { VITE_FORGEAX_BRIDGE: '0' };

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...bridgeEnv,
    FORGEAX_GAME_DIR: gameDir,
    FORGEAX_GAME_API_PORT: String(GAME_API_PORT),
    // Single SSOT for the editor stack's play-runtime port. Set AFTER the
    // ...process.env spread so it always wins: every spawn inherits this base env,
    // so play-runtime binds PLAY_RUNTIME_PORT AND edit-runtime's /preview proxy
    // targets it — no stale 15173 anywhere in the fx-orchestrated stack, and it
    // stays consistent with the PORTS kill-set (which lists PLAY_RUNTIME_PORT).
    FORGEAX_ENGINE_PORT: String(PLAY_RUNTIME_PORT),
    ...(rhiDebug ? { FORGEAX_ENGINE_RHI_DEBUG: '1' } : {}),
  };
  if (rhiDebug) ok('RHI-debug capture enabled → window.__forgeax.captureFrame(n) in the :15290 console');
  if (bridge) ok(`live gateway bridge enabled → relay :${bridgePort} (node skills/forgeax-editor-gateway/scripts/gateway-live.mjs). Opt out: FORGEAX_BRIDGE=0`);

  // preflight — point at setup if the engine build is missing.
  if (
    !existsSync(join(ENGINE_DIR, 'packages', 'vite-plugin-shader', 'dist', 'index.mjs')) ||
    !existsSync(WASM_FILE)
  ) {
    die('engine not built (dist/wasm missing). Run first: bun fx setup');
  }

  // always start from a clean slate (clears a stale :15290/:15280 from a prior run)
  await stop();

  // bridgeEnv already folded into `env`; edit-runtime just adds the HMR port.
  const editRuntimeEnv: NodeJS.ProcessEnv = { ...env, FORGEAX_INTERFACE_PORT: '15290' };
  const editRuntimeArgs = ['-F', '@forgeax/editor-edit-runtime', 'dev', '--', '--port', '15280', '--strictPort'];

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
    if (bridge)
      // Spawn with `bun`, not `node`: `ws` lives only in bun's isolated store
      // (node_modules/.bun/ws@*), unhoisted, so bare node ERR_MODULE_NOT_FOUNDs.
      spawnService('bun', [GATEWAY_RELAY_SCRIPT], {
        cwd: ROOT,
        env: { ...env, FORGEAX_BRIDGE_PORT: bridgePort },
        detach: true,
        logFd: log('bridge'),
      });
    if (play)
      spawnService('bun', ['-F', '@forgeax/editor-play-runtime', 'dev'], {
        cwd: ROOT,
        // FORGEAX_ENGINE_PORT (= PLAY_RUNTIME_PORT) rides in the base `env`.
        env,
        detach: true,
        logFd: log('play'),
      });
    ok('stack starting in background → http://localhost:15290');
    ok('stop with: bun fx stop');
    return;
  }

  // foreground: trap Ctrl-C to tear the whole stack down
  const children: ChildProcess[] = [];
  installCleanup(children, PORTS);

  if (gameDir) {
    step(`starting game-backend :${GAME_API_PORT} (platform-io reuse, R3) ...`);
    children.push(spawnService('bun', [join(ROOT, 'standalone', 'game-backend.ts')], { cwd: ROOT, env }));
  }

  step('starting edit-runtime :15280 (HMR→15290) ...');
  children.push(spawnService('bun', editRuntimeArgs, { cwd: ROOT, env: editRuntimeEnv }));

  step('starting standalone host :15290 ...');
  children.push(spawnService('bun', ['run', 'dev'], { cwd: ROOT, env }));

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

  if (play) {
    step(`starting play-runtime :${PLAY_RUNTIME_PORT} ...`);
    children.push(
      spawnService('bun', ['-F', '@forgeax/editor-play-runtime', 'dev'], {
        cwd: ROOT,
        // FORGEAX_ENGINE_PORT (= PLAY_RUNTIME_PORT) rides in the base `env`.
        env,
      }),
    );
  }

  ok('open → http://localhost:15290   (Ctrl-C to stop)');
  // Keep the process alive until a child exits or the user hits Ctrl-C.
  await new Promise<void>((resolvePromise) => {
    for (const ch of children) ch.on('exit', () => resolvePromise());
  });
}

function usage(): void {
  console.log(`forgeax-editor — one-stop standalone dev CLI

Usage:
  bun fx <command> [args...]

Lifecycle:
  setup | install               prepare everything (submodules, deps, engine dist + wasm)
  start | run [--play]          start the stack (:15290 host + :15280 edit-runtime
                                [+ :15273 play-runtime with --play]); Ctrl-C stops
  start --game DIR              open a real game (DIR directly contains forge.json)
  start --bg                    start in background, returns immediately
  start --rhi-debug            enable engine RHI frame capture (window.__forgeax.captureFrame)
  stop                          stop everything the CLI started (by port)

  Live gateway bridge (:15295) is ON by default so the forgeax-editor-gateway
  skill's gateway-live.mjs can drive the open window; set FORGEAX_BRIDGE=0 to
  disable, FORGEAX_BRIDGE_PORT to move it.

Repo maintenance:
  update [--dry-run] [--no-stash]
                                pull root code, sync ALL submodules to pins, and
                                fast-forward .forgeax-harness (auto-stash local edits)
  clean [--deep|-x] [--dry-run|-n]
                                restore a fully-clean git status across root + all
                                submodules (scrubs regenerable artefacts). --deep also
                                wipes root node_modules/dist/wasm. Keeps .forgeax-harness.

  help | -h | --help            show this message

First time:  bun fx setup && bun fx start`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? '';
  const rest = process.argv.slice(3);
  switch (cmd) {
    case 'install':
    case 'setup':
      install();
      break;
    case 'run':
    case 'start':
      await run(rest);
      break;
    case 'stop':
      await stop();
      break;
    case 'update':
      update(rest);
      break;
    case 'clean':
      clean(rest);
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
