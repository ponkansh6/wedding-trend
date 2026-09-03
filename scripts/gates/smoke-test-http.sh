#!/usr/bin/env bash
# Production HTTP smoke: build + start + curl /. This must run in Linux CI.
# It intentionally uses child processes and a loopback port, so it is not a
# Codex sandbox gate; use smoke-test.sh there for the DOM contract instead.
set -euo pipefail

PORT="${SMOKE_PORT:-3100}"
LOG_FILE="$(mktemp)"

if ss -tlnp 2>/dev/null | grep -q ":${PORT} "; then
  echo "❌ [smoke:http] port ${PORT} is already in use (leftover server from a previous run?)"
  echo "   Tip: try running 'lsof -i :${PORT}' or 'pkill -f next-server' to clean up."
  exit 1
fi

echo "[smoke:http] Building..."
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
PATH="$ROOT/node_modules/.bin:$PATH"
export PATH
BUILD_LOG="$(mktemp)"
# This test specifically verifies empty-DB fail-soft rendering. Next.js gives
# .env.local precedence over the shell, so temporarily move local dev data away.
ENV_LOCAL="$ROOT/.env.local"
ENV_LOCAL_BAK="$ROOT/.env.local.smoke-bak"
if [ -f "$ENV_LOCAL" ]; then
  mv "$ENV_LOCAL" "$ENV_LOCAL_BAK"
fi
SERVER_PID=""
BODY_FILE=""

# Keep every cleanup action in one trap so .env.local is always restored.
cleanup() {
  [ -n "$SERVER_PID" ] && kill -- "-$SERVER_PID" 2>/dev/null || true
  [ -n "$BODY_FILE" ] && rm -f "$BODY_FILE"
  if [ -f "$ENV_LOCAL_BAK" ]; then
    mv "$ENV_LOCAL_BAK" "$ENV_LOCAL"
  fi
}
trap cleanup EXIT INT TERM

if ! TURSO_DATABASE_URL=":memory:" TURSO_AUTH_TOKEN="" next build > "$BUILD_LOG" 2>&1; then
  echo "❌ [smoke:http] build failed"
  cat "$BUILD_LOG"
  rm -f "$BUILD_LOG"
  exit 1
fi
rm -f "$BUILD_LOG"

echo "[smoke:http] Starting server on :${PORT} (in-memory DB)..."
TURSO_DATABASE_URL=":memory:" TURSO_AUTH_TOKEN="" PORT="$PORT" setsid next start > "$LOG_FILE" 2>&1 &
SERVER_PID=$!

READY=0
for _ in $(seq 1 30); do
  if curl -sf "http://localhost:${PORT}/" > /dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  echo "❌ [smoke:http] server did not become ready"
  tail -20 "$LOG_FILE"
  exit 1
fi

# Write the response first: a grep early exit otherwise makes printf SIGPIPE
# under pipefail and can turn a successful assertion into a false failure.
BODY_FILE="$(mktemp)"
curl -s "http://localhost:${PORT}/" > "$BODY_FILE"

if grep -q 'E{"digest"' "$BODY_FILE"; then
  echo "❌ [smoke:http] RSC error digest found in response body"
  exit 1
fi
if grep -q "Cookies can only be modified" "$LOG_FILE"; then
  echo "❌ [smoke:http] cookie write error in server log"
  exit 1
fi
if ! grep -q "ウエディング・トレンド" "$BODY_FILE"; then
  echo "❌ [smoke:http] page did not render (missing 'ウエディング・トレンド' heading)"
  exit 1
fi
if ! grep -q "定番の体験談はまだありません" "$BODY_FILE"; then
  echo "❌ [smoke:http] empty-state not rendered (missing '定番の体験談はまだありません')"
  exit 1
fi
if ! grep -q "AIによる自動処理" "$BODY_FILE"; then
  echo "❌ [smoke:http] automated-judgment disclosure missing (expected 'AIによる自動処理')"
  exit 1
fi
if ! grep -q "github.com/ponkansh6/wedding-trend/issues" "$BODY_FILE"; then
  echo "❌ [smoke:http] contact / takedown link missing (expected GitHub Issues link)"
  exit 1
fi

echo "✅ [smoke:http] passed"
