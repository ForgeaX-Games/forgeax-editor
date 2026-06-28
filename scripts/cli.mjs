#!/usr/bin/env node
// cli.mjs — one-stop entry for the standalone forgeax-editor dev stack.
//
//   node scripts/cli.mjs install   # prepare everything (idempotent, re-runnable)
//   node scripts/cli.mjs run       # start the standalone stack (:15290 + :15280)
//   node scripts/cli.mjs stop      # stop anything cli started (by port)
//
// Why this exists: the standalone editor is a SELF-CONTAINED repo — it must
// behave as if studio does NOT exist next to it. It vendors `engine` and
// `interface` as git submodules under packages/. Unlike the editor's own 5
// source-emit packages, the engine packages are dist-based (exports →
// ./dist/index.mjs) AND need a Rust-built wasm binary
// (wgpu-wasm/pkg/wgpu_wasm_bg.wasm, gitignored). Without that build step the
// stack 500s on startup (vite can't resolve @forgeax/engine-vite-plugin-shader
// / the wasm). `install` does that build once; `run` just launches.
//
// Cross-platform: pure Node (no Git-Bash / lsof / kill) — runs on Windows too.
//
// Ports (see README "Run"):
//   :15290  standalone chrome host (vite, root=standalone/) — the page you open
//   :15280  edit-runtime (panel + viewport iframe source); host proxies /editor → it
//   :15173  play-runtime (Play mode) — only with `run --play`

import { spawnSync } from 'node:child_process';
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
} from './lib/dev-stack.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..'); // scripts/ -> repo root
const ENGINE_DIR = join(ROOT, 'packages', 'engine');
const WASM_DIR = join(ENGINE_DIR, 'packages', 'wgpu-wasm');
const WASM_FILE = join(WASM_DIR, 'pkg', 'wgpu_wasm_bg.wasm');
// 15281 = standalone game-backend (platform-io reuse, R3); only with --game.
const PORTS = [15290, 15280, 15281, 15173];
const GAME_API_PORT = 15281;

/** Run a command synchronously with inherited stdio; die on non-zero exit. */
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: opts.cwd ?? ROOT,
    env: opts.env ?? process.env,
  });
  if (r.status !== 0) die(`command failed: ${cmd} ${args.join(' ')}`);
}

// ── stop ────────────────────────────────────────────────────────────────────
async function stop() {
  step(`stopping editor stack (ports ${PORTS.join(' ')}) ...`);
  const killed = await killByPorts(PORTS);
  if (!killed) ok('nothing to stop');
}

// ── install ───────────────────────────────────────────────────────────────
function ensureWasm() {
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

function install() {
  requireCmd('git', 'install git first.');
  requireCmd('bun', 'install bun: https://bun.sh');
  requireCmd('pnpm', 'install pnpm: https://pnpm.io (engine is a pnpm workspace)');

  step('1/5 fetching submodules (engine + interface) ...');
  sh('git', ['submodule', 'update', '--init', '--recursive']);
  ok('submodules ready');

  step('2/5 installing editor workspace deps (bun) ...');
  sh('bun', ['install']);
  ok('bun deps ready');

  step('3/5 installing engine deps (pnpm) ...');
  sh('pnpm', ['install'], { cwd: ENGINE_DIR });
  ok('engine deps ready');

  step('4/5 building engine library dist (pnpm -r, packages/* only — skips apps) ...');
  // Only the library packages emit the dist/ the editor imports. apps/hello/*
  // are example apps that need extra fixtures and are NOT needed here.
  sh('pnpm', ['-r', '--filter', './packages/*', 'build'], { cwd: ENGINE_DIR });
  ok('engine dist built');

  step('5/5 ensuring wgpu wasm binary ...');
  ensureWasm();

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
  if (missing) die("install incomplete — see warnings above. Re-run 'node scripts/cli.mjs install'.");

  ok('install complete — run: node scripts/cli.mjs run');
}

// ── run ───────────────────────────────────────────────────────────────────
async function run(argv) {
  let play = false;
  let bg = false;
  let game = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--play') play = true;
    else if (a === '--bg') bg = true;
    else if (a === '--game') {
      game = argv[++i] ?? '';
      if (!game) die('--game needs a path');
    } else if (a.startsWith('--game=')) game = a.slice('--game='.length);
    else die(`unknown run flag: ${a} (supported: --play, --bg, --game <path>)`);
  }

  // --game <dir>: open a REAL game by reusing the @forgeax/platform-io backend.
  let gameDir = '';
  if (game) {
    if (!existsSync(game)) die(`--game path is not a directory: ${game}`);
    gameDir = resolve(game);
    if (!existsSync(join(gameDir, 'forge.json'))) die(`--game dir has no forge.json: ${gameDir}`);
    ok(`reusing platform-io for game '${gameDir.split(/[/\\]/).pop()}' from ${gameDir}`);
  }
  const env = { ...process.env, FORGEAX_GAME_DIR: gameDir, FORGEAX_GAME_API_PORT: String(GAME_API_PORT) };

  // preflight — point at install if the engine build is missing.
  if (
    !existsSync(join(ENGINE_DIR, 'packages', 'vite-plugin-shader', 'dist', 'index.mjs')) ||
    !existsSync(WASM_FILE)
  ) {
    die('engine not built (dist/wasm missing). Run first: node scripts/cli.mjs install');
  }

  // always start from a clean slate (clears a stale :15290/:15280 from a prior run)
  await stop();

  const editRuntimeEnv = { ...env, FORGEAX_INTERFACE_PORT: '15290' };
  const editRuntimeArgs = ['-F', '@forgeax/editor-edit-runtime', 'dev', '--', '--port', '15280', '--strictPort'];

  if (bg) {
    // Background mode: detached + unref'd so children outlive this process on
    // every platform (mirrors the old `nohup … &`). Logs go to the temp dir.
    const logDir = tmpdir();
    const log = (name) => openSync(join(logDir, `forgeax-editor-${name}.log`), 'a');
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
    if (play)
      spawnService('bun', ['-F', '@forgeax/editor-play-runtime', 'dev'], {
        cwd: ROOT,
        env: { ...env, FORGEAX_ENGINE_PORT: '15173' },
        detach: true,
        logFd: log('play'),
      });
    ok('stack starting in background → http://localhost:15290');
    ok('stop with: node scripts/cli.mjs stop');
    return;
  }

  // foreground: trap Ctrl-C to tear the whole stack down
  const children = [];
  installCleanup(children, PORTS);

  if (gameDir) {
    step(`starting game-backend :${GAME_API_PORT} (platform-io reuse, R3) ...`);
    children.push(spawnService('bun', [join(ROOT, 'standalone', 'game-backend.ts')], { cwd: ROOT, env }));
  }

  step('starting edit-runtime :15280 (HMR→15290) ...');
  children.push(spawnService('bun', editRuntimeArgs, { cwd: ROOT, env: editRuntimeEnv }));

  step('starting standalone host :15290 ...');
  children.push(spawnService('bun', ['run', 'dev'], { cwd: ROOT, env }));

  if (play) {
    step('starting play-runtime :15173 ...');
    children.push(
      spawnService('bun', ['-F', '@forgeax/editor-play-runtime', 'dev'], {
        cwd: ROOT,
        env: { ...env, FORGEAX_ENGINE_PORT: '15173' },
      }),
    );
  }

  ok('open → http://localhost:15290   (Ctrl-C to stop)');
  // Keep the process alive until a child exits or the user hits Ctrl-C.
  await new Promise((resolvePromise) => {
    for (const ch of children) ch.on('exit', resolvePromise);
  });
}

function usage() {
  console.log(`forgeax-editor cli — one-stop standalone dev stack

  node scripts/cli.mjs install         prepare everything (submodules, deps, engine dist + wasm)
  node scripts/cli.mjs run [--play]    start the stack (:15290 host + :15280 edit-runtime
                                       [+ :15173 play-runtime with --play]); Ctrl-C stops
  node scripts/cli.mjs run --game DIR  open a real game (DIR directly contains forge.json)
  node scripts/cli.mjs run --bg        start in background, returns immediately
  node scripts/cli.mjs stop            stop everything cli started (by port)

First time:  node scripts/cli.mjs install && node scripts/cli.mjs run`);
}

const cmd = process.argv[2] ?? '';
const rest = process.argv.slice(3);
switch (cmd) {
  case 'install':
    install();
    break;
  case 'run':
    await run(rest);
    break;
  case 'stop':
    await stop();
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
