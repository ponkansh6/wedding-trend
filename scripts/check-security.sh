#!/usr/bin/env bash
set -uo pipefail

# secretlint は pnpm ラッパー経由で呼ばない（依存状態チェックで暗黙に
# install が走り、TTY 無しで失敗するため）。フック/CI からも効くよう直 bin を使う。
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
PATH="$ROOT/node_modules/.bin:$PATH"
export PATH

# --prod: blocking 判定は本番依存だけを見る。devDependency の推移依存は
# ビルド成果物に乗らないため、blocking にすると着地直後から全 push が
# 失敗し --no-verify の常用を誘発する。自力で直せない上流の推移依存を
# blocking にするのは設計方針に反する。
#
# pnpm audit にはタイムアウトが無い（registry fetch-timeout × retry でハングし得る）。
# タイムアウトで包み、タイムアウト時は PARSE_ERROR パス（ローカルはスキップ・CI は fail）に倒す。
AUDIT_JSON=$(timeout 20 pnpm audit --prod --audit-level=high --json 2>/dev/null || true)

HAS_VULN_RESULT=$(node -e '
try {
  const data = JSON.parse(process.argv[1]);
  const vuln = data.metadata?.vulnerabilities;
  if (vuln && typeof vuln === "object") {
    const high = vuln.high || 0;
    const critical = vuln.critical || 0;
    console.log(high + critical > 0 ? "YES" : "NO");
  } else {
    console.log("NO");
  }
} catch {
  console.log("PARSE_ERROR");
}
' "$AUDIT_JSON")

if [ "$HAS_VULN_RESULT" = "PARSE_ERROR" ]; then
  if [ -n "${CI:-}" ]; then
    echo "[security] ❌ pnpm audit の解析に失敗しました (CI 環境)"
    exit 1
  else
    echo "[security] ⚠ pnpm audit を実行できませんでした（ネットワーク/レジストリ到達不能、または timeout）。ローカルではスキップします。"
  fi
elif [ "$HAS_VULN_RESULT" = "YES" ]; then
  echo ""
  echo "[security] ❌ 本番依存(--prod) に High/Critical 脆弱性が検出されました"
  pnpm audit --prod --audit-level=high
  exit 1
else
  echo "[security] ✅ 本番依存(--prod) に High/Critical 脆弱性なし"
fi

# --- devDependency 側は advisory（非ブロッキング）---
DEV_AUDIT_JSON=$(timeout 20 pnpm audit --audit-level=high --json 2>/dev/null || true)
DEV_HAS_VULN=$(node -e '
try {
  const data = JSON.parse(process.argv[1]);
  const vuln = data.metadata?.vulnerabilities;
  if (vuln && typeof vuln === "object") {
    const high = vuln.high || 0;
    const critical = vuln.critical || 0;
    console.log(high + critical > 0 ? "YES" : "NO");
  } else {
    console.log("NO");
  }
} catch {
  console.log("PARSE_ERROR");
}
' "$DEV_AUDIT_JSON")
if [ "$DEV_HAS_VULN" = "YES" ]; then
  echo ""
  echo "[warn] devDependency に High/Critical 脆弱性があります（advisory・push はブロックしません）"
  echo "       詳細: pnpm audit --audit-level=high"
fi

echo "[security] Running secretlint..."
if ! secretlint "**/*"; then
  echo "[security] ❌ secretlint 検出エラー"
  exit 1
fi

echo "[security] ✅ OK"
exit 0
