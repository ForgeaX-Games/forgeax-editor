#!/usr/bin/env bash
# cli.sh — one-stop entry for the standalone forgeax-editor dev stack.
#
#   bash cli.sh install   # prepare everything (idempotent, re-runnable)
#   bash cli.sh run       # start the standalone stack (:15290 + :15280)
#   bash cli.sh stop      # stop anything cli.sh started (by port)
#
# Why this exists: the standalone editor is a SELF-CONTAINED repo — it must
# behave as if studio does NOT exist next to it. It vendors `engine` and
# `interface` as git submodules under packages/. Unlike the editor's own 5
# source-emit packages, the engine packages are dist-based (exports →
# ./dist/index.mjs) AND need a Rust-built wasm binary
# (wgpu-wasm/pkg/wgpu_wasm_bg.wasm, gitignored). Without that build step the
# stack 500s on startup (vite can't resolve @forgeax/engine-vite-plugin-shader
# / the wasm). `install` does that build once; `run` just launches.
#
# Ports (see README "Run"):
#   :15290  standalone chrome host (vite, root=standalone/) — the page you open
#   :15280  edit-runtime (panel + viewport iframe source); host proxies /editor → it
#   :15173  play-runtime (Play mode) — only with `run --play`
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

ENGINE_DIR="$ROOT/packages/engine"
WASM_DIR="$ENGINE_DIR/packages/wgpu-wasm"
WASM_FILE="$WASM_DIR/pkg/wgpu_wasm_bg.wasm"
PORTS=(15290 15280 15173)

# ── pretty logging ─────────────────────────────────────────────────────────
c_blue='\033[0;34m'; c_green='\033[0;32m'; c_yellow='\033[0;33m'; c_red='\033[0;31m'; c_reset='\033[0m'
step() { printf "${c_blue}[cli]${c_reset} %s\n" "$*"; }
ok()   { printf "${c_green}[cli] ✓${c_reset} %s\n" "$*"; }
warn() { printf "${c_yellow}[cli] !${c_reset} %s\n" "$*"; }
die()  { printf "${c_red}[cli] ✗${c_reset} %s\n" "$*" >&2; exit 1; }

require() { command -v "$1" >/dev/null 2>&1 || die "missing '$1' on PATH. $2"; }

# ── stop: kill whatever is on our ports (precise, never `pkill vite`) ────────
stop() {
  step "stopping editor stack (ports ${PORTS[*]}) ..."
  local killed=0
  for p in "${PORTS[@]}"; do
    # lsof may exit non-zero when nothing listens — tolerate under `set -e`.
    local pids; pids="$(lsof -ti ":$p" 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      # shellcheck disable=SC2086
      kill $pids 2>/dev/null || true
      sleep 0.3
      # SIGKILL any survivor
      pids="$(lsof -ti ":$p" 2>/dev/null || true)"
      # shellcheck disable=SC2086
      [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
      ok "freed :$p"
      killed=1
    fi
  done
  [ "$killed" = 0 ] && ok "nothing to stop"
}

# ── install: prepare everything, idempotent ─────────────────────────────────
install() {
  require git "install git first."
  require bun "install bun: https://bun.sh"
  require pnpm "install pnpm: https://pnpm.io (engine is a pnpm workspace)"

  step "1/5 fetching submodules (engine + interface) ..."
  git submodule update --init --recursive
  ok "submodules ready"

  step "2/5 installing editor workspace deps (bun) ..."
  bun install
  ok "bun deps ready"

  step "3/5 installing engine deps (pnpm) ..."
  ( cd "$ENGINE_DIR" && pnpm install )
  ok "engine deps ready"

  step "4/5 building engine library dist (pnpm -r, packages/* only — skips apps) ..."
  # Only the library packages emit the dist/ the editor imports. apps/hello/*
  # are example apps that need extra fixtures and are NOT needed here, so filter
  # to ./packages/* to keep the build fast and green.
  ( cd "$ENGINE_DIR" && pnpm -r --filter "./packages/*" build )
  ok "engine dist built"

  step "5/5 ensuring wgpu wasm binary ..."
  ensure_wasm

  # final sanity — fail loudly if a critical artifact is still missing
  step "verifying critical artifacts ..."
  local missing=0
  for pkg in vite-plugin-shader app runtime ecs types shader gltf; do
    if [ ! -f "$ENGINE_DIR/packages/$pkg/dist/index.mjs" ]; then
      warn "missing engine dist: packages/$pkg/dist/index.mjs"; missing=1
    fi
  done
  [ -f "$WASM_FILE" ] || { warn "missing wasm: $WASM_FILE"; missing=1; }
  [ "$missing" = 0 ] || die "install incomplete — see warnings above. Re-run 'bash cli.sh install'."

  ok "install complete — run: bash cli.sh run"
}

# wasm is gitignored and editor must NOT assume studio exists, so the only path
# is a local Rust build via the engine's own build.sh.
ensure_wasm() {
  if [ -f "$WASM_FILE" ]; then
    ok "wasm present (skip build): packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm"
    return
  fi
  step "wasm missing — building from Rust (wgpu-wasm/build.sh, ~1-2 min) ..."
  command -v rustc     >/dev/null 2>&1 || die "wasm build needs Rust. install: https://rustup.rs"
  command -v wasm-pack >/dev/null 2>&1 || die "wasm build needs wasm-pack. install: cargo install wasm-pack"
  bash "$WASM_DIR/build.sh"
  [ -f "$WASM_FILE" ] || die "wasm build ran but $WASM_FILE is still absent."
  ok "wasm built"
}

# ── run: launch the standalone stack (foreground; Ctrl-C cleans up) ──────────
run() {
  local play=0 bg=0
  for arg in "$@"; do
    case "$arg" in
      --play) play=1 ;;
      --bg)   bg=1 ;;
      *) die "unknown run flag: $arg (supported: --play, --bg)" ;;
    esac
  done

  # preflight — if the engine build is missing, point at install (don't silently
  # build: install is the explicit, slow, one-time step).
  if [ ! -f "$ENGINE_DIR/packages/vite-plugin-shader/dist/index.mjs" ] || [ ! -f "$WASM_FILE" ]; then
    die "engine not built (dist/wasm missing). Run first: bash cli.sh install"
  fi

  # always start from a clean slate (clears a stale :15290/:15280 from a prior run)
  stop

  if [ "$bg" = 1 ]; then
    step "starting stack in background (logs → /tmp/forgeax-editor-*.log) ..."
    FORGEAX_INTERFACE_PORT=15290 bun -F @forgeax/editor-edit-runtime dev -- --port 15280 --strictPort \
      > /tmp/forgeax-editor-edit-runtime.log 2>&1 &
    bun run dev > /tmp/forgeax-editor-host.log 2>&1 &
    [ "$play" = 1 ] && FORGEAX_ENGINE_PORT=15173 bun -F @forgeax/editor-play-runtime dev \
      > /tmp/forgeax-editor-play.log 2>&1 &
    sleep 1
    ok "stack starting in background → http://localhost:15290"
    ok "stop with: bash cli.sh stop"
    return
  fi

  # foreground: trap Ctrl-C to tear the whole process group down
  cleanup() { echo; step "shutting down ..."; kill 0 2>/dev/null || true; }
  trap cleanup EXIT INT TERM

  step "starting edit-runtime :15280 (HMR→15290) ..."
  FORGEAX_INTERFACE_PORT=15290 bun -F @forgeax/editor-edit-runtime dev -- --port 15280 --strictPort &

  step "starting standalone host :15290 ..."
  bun run dev &

  if [ "$play" = 1 ]; then
    step "starting play-runtime :15173 ..."
    FORGEAX_ENGINE_PORT=15173 bun -F @forgeax/editor-play-runtime dev &
  fi

  ok "open → http://localhost:15290   (Ctrl-C to stop)"
  wait
}

usage() {
  cat <<EOF
forgeax-editor cli — one-stop standalone dev stack

  bash cli.sh install         prepare everything (submodules, deps, engine dist + wasm)
  bash cli.sh run [--play]    start the stack (:15290 host + :15280 edit-runtime
                              [+ :15173 play-runtime with --play]); Ctrl-C stops
  bash cli.sh run --bg        start in background (logs in /tmp), returns immediately
  bash cli.sh stop            stop everything cli.sh started (by port)

First time:  bash cli.sh install && bash cli.sh run
EOF
}

cmd="${1:-}"; shift || true
case "$cmd" in
  install) install "$@" ;;
  run)     run "$@" ;;
  stop)    stop "$@" ;;
  ""|-h|--help|help) usage ;;
  *) usage; die "unknown command: $cmd" ;;
esac
