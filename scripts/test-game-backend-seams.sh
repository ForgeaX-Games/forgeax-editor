#!/usr/bin/env bash
# test-game-backend-seams.sh -- curl-level assertion script for M3 game-backend seams
# [w10] AC-08/AC-09: 7 assertions (a-g) covering hemostasis + version + health
#
# Usage:
#   FORGEAX_GAME_DIR=games/sample bash scripts/test-game-backend-seams.sh
#
# Starts game-backend.ts, runs 7 curl assertions, stops the process.
# Exits 0 if all pass, exits 1 with details on first failure.

set -euo pipefail

GAME_DIR="${FORGEAX_GAME_DIR:-}"
if [ -z "$GAME_DIR" ]; then
  echo "ERROR: FORGEAX_GAME_DIR must be set (e.g., 'games/sample')"
  exit 2
fi

PORT="${FORGEAX_GAME_API_PORT:-15281}"
BASE="http://127.0.0.1:${PORT}"
FAILURES=0

# --- helpers ---

pass() { echo "  PASS: $1"; }
fail() { echo "  FAIL: $1"; FAILURES=$((FAILURES + 1)); }

assert_status() {
  local label="$1" expected="$2" actual="$3"
  if [ "${actual}" -eq "${expected}" ]; then
    pass "${label} (status ${actual} == ${expected})"
  else
    fail "${label} (expected status ${expected}, got ${actual})"
  fi
}

# --- start game-backend ---
echo "[w10] Starting game-backend on port ${PORT} with GAME_DIR=${GAME_DIR}..."
FORGEAX_GAME_DIR="${GAME_DIR}" bun run standalone/game-backend.ts &
BACKEND_PID=$!
sleep 2  # give it time to bind

# Verify the process is actually running
if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
  echo "ERROR: game-backend failed to start"
  exit 2
fi
echo "[w10] game-backend PID=${BACKEND_PID}"

cleanup() {
  echo "[w10] Stopping game-backend (PID=${BACKEND_PID})..."
  kill "$BACKEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT

# --- (a) GET unmounted endpoint /api/sessions -> 200 + unavailable envelope ---
echo ""
echo "--- (a) GET /api/sessions (unmounted) ---"
RESP_A=$(curl -s -o /tmp/w10_resp_a_body.txt -w "%{http_code}" "${BASE}/api/sessions" || echo "000")
BODY_A=$(cat /tmp/w10_resp_a_body.txt 2>/dev/null || echo "{}")
assert_status "(a) GET /api/sessions" 200 "$RESP_A"
UNAVAILABLE_A=$(echo "${BODY_A}" | jq -r '.unavailable // "ABSENT"' 2>/dev/null || echo "ABSENT")
REASON_A=$(echo "${BODY_A}" | jq -r '.reason // "ABSENT"' 2>/dev/null || echo "ABSENT")
HINT_A=$(echo "${BODY_A}" | jq -r '.hint // "ABSENT"' 2>/dev/null || echo "ABSENT")
if [ "${UNAVAILABLE_A}" = "true" ]; then
  pass "(a) unavailable == true"
else
  fail "(a) unavailable (expected true, got '${UNAVAILABLE_A}')"
fi
if [ "${REASON_A}" = "standalone" ]; then
  pass "(a) reason == standalone"
else
  fail "(a) reason (expected standalone, got '${REASON_A}')"
fi
if [ -n "${HINT_A}" ] && [ "${HINT_A}" != "ABSENT" ]; then
  pass "(a) hint present: ${HINT_A}"
else
  fail "(a) hint is missing or empty"
fi

# --- (b) POST same unmounted endpoint -> same 200 + unavailable (boundary #8) ---
echo ""
echo "--- (b) POST /api/sessions (unmounted, any method) ---"
RESP_B=$(curl -s -o /tmp/w10_resp_b_body.txt -w "%{http_code}" -X POST "${BASE}/api/sessions" -H 'Content-Type: application/json' -d '{}' || echo "000")
BODY_B=$(cat /tmp/w10_resp_b_body.txt 2>/dev/null || echo "{}")
assert_status "(b) POST /api/sessions" 200 "$RESP_B"
UNAVAILABLE_B=$(echo "${BODY_B}" | jq -r '.unavailable // "ABSENT"' 2>/dev/null || echo "ABSENT")
if [ "${UNAVAILABLE_B}" = "true" ]; then
  pass "(b) unavailable == true"
else
  fail "(b) unavailable (expected true, got '${UNAVAILABLE_B}')"
fi

# --- (c) GET /api/version -> 200 + valid JSON ---
echo ""
echo "--- (c) GET /api/version ---"
RESP_C=$(curl -s -o /tmp/w10_resp_c_body.txt -w "%{http_code}" "${BASE}/api/version" || echo "000")
BODY_C=$(cat /tmp/w10_resp_c_body.txt 2>/dev/null || echo "{}")
assert_status "(c) GET /api/version" 200 "$RESP_C"
VERSION_C=$(echo "${BODY_C}" | jq -r '.version // "ABSENT"' 2>/dev/null || echo "ABSENT")
if [ -n "${VERSION_C}" ] && [ "${VERSION_C}" != "ABSENT" ] && [ "${VERSION_C}" != "null" ]; then
  pass "(c) version field present: ${VERSION_C}"
else
  fail "(c) version field (missing or null)"
fi

# --- (d) GET /api/health -> 200 + valid JSON ---
echo ""
echo "--- (d) GET /api/health ---"
RESP_D=$(curl -s -o /tmp/w10_resp_d_body.txt -w "%{http_code}" "${BASE}/api/health" || echo "000")
BODY_D=$(cat /tmp/w10_resp_d_body.txt 2>/dev/null || echo "{}")
assert_status "(d) GET /api/health" 200 "$RESP_D"
OK_D=$(echo "${BODY_D}" | jq -r '.ok // "ABSENT"' 2>/dev/null || echo "ABSENT")
if [ "${OK_D}" = "true" ]; then
  pass "(d) ok == true"
else
  fail "(d) ok (expected true, got '${OK_D}')"
fi

# --- (e) GET /api/files/... (mounted) -> behavior unchanged (not shadowed, boundary #4) ---
echo ""
echo "--- (e) GET /api/files/tree (mounted) ---"
RESP_E=$(curl -s -o /dev/null -w "%{http_code}" "${BASE}/api/files/tree" || echo "000")
assert_status "(e) GET /api/files/tree (mounted, 2xx)" 200 "$RESP_E"

# --- (f) GET /api/prefs/... (mounted) -> behavior unchanged ---
echo ""
echo "--- (f) GET /api/prefs/workspace-layout (mounted) ---"
RESP_F=$(curl -s -o /tmp/w10_resp_f_body.txt -w "%{http_code}" "${BASE}/api/prefs/workspace-layout" || echo "000")
BODY_F=$(cat /tmp/w10_resp_f_body.txt 2>/dev/null || echo "{}")
UNAVAILABLE_F=$(echo "${BODY_F}" | jq -r '.unavailable // "ABSENT"' 2>/dev/null || echo "ABSENT")
if [ "${UNAVAILABLE_F}" = "true" ]; then
  fail "(f) /api/prefs/workspace-layout should NOT be shadowed by unavailable envelope"
else
  pass "(f) /api/prefs/workspace-layout (not shadowed by unavailable)"
fi

# --- (g) error path on mounted route -> original status code preserved (B2 selfcheck :183) ---
echo ""
echo "--- (g) GET /api/files/nonexistent-slug/no-file (error path) ---"
RESP_G=$(curl -s -o /tmp/w10_resp_g_body.txt -w "%{http_code}" "${BASE}/api/files/nonexistent-slug/no-file" || echo "000")
BODY_G=$(cat /tmp/w10_resp_g_body.txt 2>/dev/null || echo "{}")
# This MUST NOT be 200 with unavailable envelope (it's a mounted prefix but bad path)
if [ "${RESP_G}" = "200" ]; then
  UNAVAILABLE_G=$(echo "${BODY_G}" | jq -r '.unavailable // "ABSENT"' 2>/dev/null || echo "ABSENT")
  if [ "${UNAVAILABLE_G}" = "true" ]; then
    fail "(g) error path on mounted route was shadowed by 200 unavailable envelope (B2 selfcheck violation)"
  else
    pass "(g) error path status=${RESP_G} (not shadowed by unavailable, original code preserved)"
  fi
else
  pass "(g) error path status=${RESP_G} (original status preserved, not 200)"
fi

# --- summary ---
echo ""
echo "=== w10 results ==="
if [ "$FAILURES" -eq 0 ]; then
  echo "ALL 7 assertions PASSED"
  exit 0
else
  echo "${FAILURES} assertion(s) FAILED (expected in TDD red phase before w11)"
  exit 1
fi