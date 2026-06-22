#!/usr/bin/env bash
# bootstrap-worktree.sh — one-shot env bootstrap for git worktrees.
# Builds the engine vite plugin + runtime dist artefacts that vite needs to
# resolve `@forgeax/engine-vite-plugin-{pack,shader}` and friends; the main
# tree has these prebuilt, worktrees do not. Plan §2 D-12, R-9 (R3).
# Idempotent: skips packages whose dist/ already exists.
set -euo pipefail
# ROOT = the editor repo root (scripts/..). Correct for both a standalone
# editor clone and an embedded studio worktree: editor always vendors engine at
# packages/engine and interface at packages/interface relative to this root.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# Pull the vendored submodules (interface + engine) so a fresh standalone clone
# has DockShell/app-kit (interface) and the engine build inputs present.
git submodule update --init --recursive packages/interface packages/engine 2>/dev/null || true
# interface is consumed as TS source via vite — no build step needed, just
# fail loudly if the submodule did not populate.
[ -f packages/interface/src/app-kit.ts ] || { echo "FAIL: packages/interface submodule missing (run: git submodule update --init --recursive)" >&2; exit 1; }
[ -d node_modules ] || bun install
# packages/engine is a pnpm sub-workspace (its own pnpm-workspace.yaml + lockfile);
# tsup / tsc et al come from `pnpm install` there, not the bun-hoisted top tree.
[ -x packages/engine/node_modules/.bin/tsup ] || ( cd packages/engine && pnpm install --frozen-lockfile )
# vite-plugin-shader transitively depends on engine-shader-compiler at runtime;
# building only the three "entry" plugins leaves the import chain broken. Plan
# §2 D-12 explicitly authorises the full `bun run build` (= pnpm -r build)
# fallback. Idempotency: pnpm -r build itself skips packages whose tsup output
# is up-to-date, so re-runs are cheap.
( cd packages/engine && pnpm -r --workspace-concurrency=1 --filter './packages/**' run build )
# wgpu-wasm/pkg/*.wasm is gitignored (wasm-pack ~5 MB output); copy from a
# sibling main-tree checkout if present, else rebuild via build.sh (needs Rust).
WASM="packages/engine/packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm"
[ -f "$WASM" ] || cp "${ROOT%/.worktrees/*}/$WASM" "$WASM" 2>/dev/null \
  || ( cd packages/engine/packages/wgpu-wasm && bash build.sh )
DIST_COUNT=$(find packages/engine/packages -mindepth 2 -maxdepth 3 -type d -name dist | wc -l | tr -d ' ')
[ "$DIST_COUNT" -lt 3 ] && { echo "FAIL: expected >= 3 engine dist dirs, got $DIST_COUNT" >&2; exit 1; }
echo "bootstrap OK: $DIST_COUNT engine dist dirs ready"
