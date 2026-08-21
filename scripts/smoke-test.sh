#!/usr/bin/env bash
# Smoke test: build + start + curl /, verify the page renders without RSC errors.
# Catches runtime errors that `next build` passes through (e.g. cookie writes
# during RSC rendering, or a broken empty-DB fail-soft path).
#
# 本プロジェクト固有の検証:
#   - 初回起動時は DB にテーブルが無く、getFeedCards がフェイルソフトで []
#     を返す。この経路が壊れるとトップページが 500 になる。そのため空状態の
#     文言「速報はまだありません」まで検証する（shared_plan/01-dev-pipeline-gap.md §2）。
set -euo pipefail

PORT="${SMOKE_PORT:-3100}"
LOG_FILE="$(mktemp)"

# 1. Port occupancy pre-check before building
if ss -tlnp 2>/dev/null | grep -q ":${PORT} "; then
  echo "❌ [smoke] port ${PORT} is already in use (leftover server from a previous run?)"
  echo "   Tip: try running 'lsof -i :${PORT}' or 'pkill -f next-server' to clean up."
  exit 1
fi

echo "[smoke] Building..."
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
PATH="$ROOT/node_modules/.bin:$PATH"
export PATH
BUILD_LOG="$(mktemp)"
if ! next build > "$BUILD_LOG" 2>&1; then
  echo "❌ [smoke] build failed"
  cat "$BUILD_LOG"
  rm -f "$BUILD_LOG"
  exit 1
fi
rm -f "$BUILD_LOG"

echo "[smoke] Starting server on :${PORT} (in-memory DB)..."
TURSO_DATABASE_URL=":memory:" TURSO_AUTH_TOKEN="" PORT="$PORT" setsid next start > "$LOG_FILE" 2>&1 &
SERVER_PID=$!
trap 'kill -- "-$SERVER_PID" 2>/dev/null || true' EXIT

# Wait for the server to accept connections (max 30s)
READY=0
for _ in $(seq 1 30); do
  if curl -sf "http://localhost:${PORT}/" > /dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  echo "❌ [smoke] server did not become ready"
  tail -20 "$LOG_FILE"
  exit 1
fi

BODY="$(curl -s "http://localhost:${PORT}/")"

# Assertions (HTTP 200 is NOT a valid success signal — the broken state also
# returns 200 with an RSC error digest in the body).
if echo "$BODY" | grep -q 'E{"digest"'; then
  echo "❌ [smoke] RSC error digest found in response body"
  exit 1
fi
if grep -q "Cookies can only be modified" "$LOG_FILE"; then
  echo "❌ [smoke] cookie write error in server log"
  exit 1
fi
if ! echo "$BODY" | grep -q "ウエディング・トレンド"; then
  echo "❌ [smoke] page did not render (missing 'ウエディング・トレンド' heading)"
  exit 1
fi
if ! echo "$BODY" | grep -q "速報はまだありません"; then
  echo "❌ [smoke] empty-state not rendered (missing '速報はまだありません')"
  exit 1
fi

echo "✅ [smoke] passed"
