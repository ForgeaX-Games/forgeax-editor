#!/usr/bin/env node
// bootstrap-worktree.mjs — one-shot env bootstrap for git worktrees.
// Builds the engine vite plugin + runtime dist artefacts that vite needs to
// resolve `@forgeax/engine-vite-plugin-{pack,shader}` and friends; the main
// tree has these prebuilt, worktrees do not. Plan §2 D-12, R-9 (R3).
// Idempotent: skips packages whose dist/ already exists.
//
// Cross-platform: pure Node (no Git-Bash / find / cp) — runs on Windows too.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ROOT = the editor repo root (scripts/..). Correct for both a standalone
// editor clone and an embedded studio worktree.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    stdio: opts.quiet ? 'ignore' : 'inherit',
    shell: IS_WIN,
    cwd: opts.cwd ?? ROOT,
  });
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const ENGINE = join(ROOT, 'packages', 'engine');

// Pull the vendored submodules (interface + engine + platform-io) so a fresh
// standalone clone has DockShell/app-kit (interface), the engine build inputs,
// and the @forgeax/platform-io backend (B2 selfcheck reuses it) present.
sh('git', ['submodule', 'update', '--init', '--recursive', 'packages/interface', 'packages/engine', 'packages/platform-io'], {
  quiet: true,
});

// interface is consumed as TS source via vite — no build step, just fail loudly
// if the submodule did not populate.
if (!existsSync(join(ROOT, 'packages', 'interface', 'src', 'app-kit.ts'))) {
  fail('packages/interface submodule missing (run: git submodule update --init --recursive)');
}

if (!existsSync(join(ROOT, 'node_modules'))) sh('bun', ['install']);

// packages/engine is a pnpm sub-workspace; tsup/tsc come from its own install.
const tsupBin = join(ENGINE, 'node_modules', '.bin', IS_WIN ? 'tsup.cmd' : 'tsup');
if (!existsSync(tsupBin)) sh('pnpm', ['install', '--frozen-lockfile'], { cwd: ENGINE });

// vite-plugin-shader transitively depends on engine-shader-compiler at runtime;
// building only the three "entry" plugins leaves the import chain broken. Plan
// §2 D-12 authorises the full `pnpm -r build` fallback (idempotent: tsup skips
// up-to-date output, so re-runs are cheap).
sh('pnpm', ['-r', '--workspace-concurrency=1', '--filter', './packages/**', 'run', 'build'], {
  cwd: ENGINE,
});

// wgpu-wasm/pkg/*.wasm is gitignored (~5 MB). Copy from the sibling main-tree
// checkout if present, else rebuild via the package's build:wasm script.
const WASM_REL = join('packages', 'engine', 'packages', 'wgpu-wasm', 'pkg', 'wgpu_wasm_bg.wasm');
const wasmDst = join(ROOT, WASM_REL);
if (!existsSync(wasmDst)) {
  // ROOT minus the trailing /.worktrees/<name> segment = the main checkout.
  const mainTree = ROOT.replace(/[/\\]\.worktrees[/\\][^/\\]+$/, '');
  const wasmSrc = join(mainTree, WASM_REL);
  if (mainTree !== ROOT && existsSync(wasmSrc)) {
    copyFileSync(wasmSrc, wasmDst);
  } else {
    sh('pnpm', ['-F', '@forgeax/engine-wgpu-wasm', 'build:wasm'], { cwd: ENGINE });
  }
}

// Count engine dist dirs (depth 2..3 under packages/engine/packages).
let distCount = 0;
const pkgsRoot = join(ENGINE, 'packages');
for (const e of readdirSync(pkgsRoot, { withFileTypes: true })) {
  if (!e.isDirectory()) continue;
  if (existsSync(join(pkgsRoot, e.name, 'dist'))) distCount++;
}
if (distCount < 3) fail(`expected >= 3 engine dist dirs, got ${distCount}`);
console.log(`bootstrap OK: ${distCount} engine dist dirs ready`);
