#!/usr/bin/env bash
# bootstrap-worktree.sh — one-shot env bootstrap for git worktrees.
# Builds the engine vite plugin + runtime dist artefacts that vite needs to
# resolve `@forgeax/engine-vite-plugin-{pack,shader}` and friends; the main
# tree has these prebuilt, worktrees do not. Plan §2 D-12, R-9 (R3).
# Idempotent: skips packages whose dist/ already exists.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
[ -d node_modules ] || bun install
# packages/engine is a pnpm sub-workspace (its own pnpm-workspace.yaml + lockfile);
# tsup / tsc et al come from `pnpm install` there, not the bun-hoisted top tree.
[ -x packages/engine/node_modules/.bin/tsup ] || ( cd packages/engine && pnpm install --frozen-lockfile )
build_pkg() {
  local rel="packages/engine/packages/$1"
  if [ -d "$rel/dist" ]; then echo "skip $1 (dist exists)"; return 0; fi
  echo "building $1"
  ( cd packages/engine && pnpm --filter "@forgeax/engine-$1" run build )
}
# Topological order — vite plugins compile first, then runtime.
build_pkg vite-plugin-pack
build_pkg vite-plugin-shader
build_pkg runtime
DIST_COUNT=$(find packages/engine/packages -mindepth 2 -maxdepth 3 -type d -name dist | wc -l | tr -d ' ')
[ "$DIST_COUNT" -lt 3 ] && { echo "FAIL: expected >= 3 engine dist dirs, got $DIST_COUNT" >&2; exit 1; }
echo "bootstrap OK: $DIST_COUNT engine dist dirs ready"
