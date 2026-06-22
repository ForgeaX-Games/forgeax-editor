#!/usr/bin/env bash
# One-command standalone editor dev stack.
#
# Starts the two servers the standalone editor needs, wired correctly:
#   :15290  standalone chrome host (vite, root=standalone/) — proxies /editor → :15280
#   :15280  edit-runtime (panel + viewport iframe source)
#
# The crucial bit is FORGEAX_INTERFACE_PORT=15290: edit-runtime's vite HMR
# clientPort defaults to 18920 (the studio-embed host). In standalone the host
# is :15290, so without this override the HMR websocket hammers a dead :18920
# and floods the console with ERR_CONNECTION_REFUSED. See edit-runtime
# vite.config.ts `hmr.clientPort` and playwright.config.ts webServer env.
set -euo pipefail
cd "$(dirname "$0")/.."

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "[dev-standalone] starting edit-runtime :15280 (HMR→15290) ..."
FORGEAX_INTERFACE_PORT=15290 bun -F @forgeax/editor-edit-runtime dev -- --port 15280 --strictPort &

echo "[dev-standalone] starting standalone host :15290 ..."
bun run dev &

wait
