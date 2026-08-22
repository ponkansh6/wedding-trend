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
# このゲートが検証するのは「DB が空のときにフェイルソフトして正しく描画されるか」。
# Next.js は .env.local をシェルの環境変数より優先するため、ローカル開発用の
# .env.local(file:./local.db) があると開発データが静的HTMLに焼き込まれ、
# 空状態の検証にならない。実行中だけ退避し、終了時に必ず戻す。
ENV_LOCAL="$ROOT/.env.local"
ENV_LOCAL_BAK="$ROOT/.env.local.smoke-bak"
if [ -f "$ENV_LOCAL" ]; then
  mv "$ENV_LOCAL" "$ENV_LOCAL_BAK"
fi
SERVER_PID=""
BODY_FILE=""

# trap EXIT は後勝ちで上書きされるため、後始末は必ずこの 1 箇所に集約する。
cleanup() {
  [ -n "$SERVER_PID" ] && kill -- "-$SERVER_PID" 2>/dev/null || true
  [ -n "$BODY_FILE" ] && rm -f "$BODY_FILE"
  if [ -f "$ENV_LOCAL_BAK" ]; then
    mv "$ENV_LOCAL_BAK" "$ENV_LOCAL"
  fi
}
trap cleanup EXIT INT TERM

if ! TURSO_DATABASE_URL=":memory:" TURSO_AUTH_TOKEN="" next build > "$BUILD_LOG" 2>&1; then
  echo "❌ [smoke] build failed"
  cat "$BUILD_LOG"
  rm -f "$BUILD_LOG"
  exit 1
fi
rm -f "$BUILD_LOG"

echo "[smoke] Starting server on :${PORT} (in-memory DB)..."
TURSO_DATABASE_URL=":memory:" TURSO_AUTH_TOKEN="" PORT="$PORT" setsid next start > "$LOG_FILE" 2>&1 &
SERVER_PID=$!

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

# NOTE: 本文はファイルに落としてから grep する。
# `printf '%s' "$BODY" | grep -q` は grep が一致時に早期終了してパイプを閉じるため
# printf が SIGPIPE で死に、`set -o pipefail` によって「一致したのに失敗」になる。
BODY_FILE="$(mktemp)"
curl -s "http://localhost:${PORT}/" > "$BODY_FILE"

# Assertions (HTTP 200 is NOT a valid success signal — the broken state also
# returns 200 with an RSC error digest in the body).
if grep -q 'E{"digest"' "$BODY_FILE"; then
  echo "❌ [smoke] RSC error digest found in response body"
  exit 1
fi
if grep -q "Cookies can only be modified" "$LOG_FILE"; then
  echo "❌ [smoke] cookie write error in server log"
  exit 1
fi
if ! grep -q "ウエディング・トレンド" "$BODY_FILE"; then
  echo "❌ [smoke] page did not render (missing 'ウエディング・トレンド' heading)"
  exit 1
fi
if ! grep -q "速報はまだありません" "$BODY_FILE"; then
  echo "❌ [smoke] empty-state not rendered (missing '速報はまだありません')"
  exit 1
fi

echo "✅ [smoke] passed"
