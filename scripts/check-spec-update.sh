#!/usr/bin/env bash
# check-spec-update.sh
# Pre-commit check: if spec-sensitive files are staged, warn if spec.md is not.
# Non-blocking — always exits 0.
#
# Two-layer detection:
#   1) STATIC PATTERNS — manually curated list of spec-critical paths
#   2) DYNAMIC EXTRACTION — parses spec.md for `src/...` and `tests/...` references
#
# If any staged file matches either layer, and spec.md is NOT staged, a warning
# is printed.

set -euo pipefail

SPEC_FILE="openspec/specs/wedding-trend/spec.md"

# ── Layer 1: Static spec-sensitive patterns ──────────────────────────────
SPEC_SENSITIVE_PATTERNS=(
  "src/lib/constants.ts"
  "src/lib/types.ts"
  "src/lib/auth.ts"
  "src/lib/url.ts"
  "src/lib/db/"
  "src/lib/embed/"
  "src/lib/llm/"
  "src/lib/pipeline/"
  "src/lib/scoring/"
  "src/lib/sources/"
  "src/app/api/"
  "src/app/admin/"
  "src/components/"
  "src/middleware.ts"
  "src/app/page.tsx"
  "src/app/layout.tsx"
)

STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)

if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

SENSITIVE_STAGED=false

for pattern in "${SPEC_SENSITIVE_PATTERNS[@]}"; do
  if echo "$STAGED_FILES" | grep -q "^${pattern}"; then
    SENSITIVE_STAGED=true
    break
  fi
done

if [ "$SENSITIVE_STAGED" = false ] && [ -f "$SPEC_FILE" ]; then
  SPEC_REFS=$(grep -oP '`((src|tests)/[^`]+)' "$SPEC_FILE" 2>/dev/null | sed 's/`//g' || true)
  if [ -n "$SPEC_REFS" ]; then
    while IFS= read -r ref; do
      if echo "$STAGED_FILES" | grep -q "^${ref}"; then
        SENSITIVE_STAGED=true
        break
      fi
    done <<< "$SPEC_REFS"
  fi
fi

if [ "$SENSITIVE_STAGED" = false ]; then
  exit 0
fi

if echo "$STAGED_FILES" | grep -q "^${SPEC_FILE}$"; then
  echo "[spec-check] ✓ spec.md is staged alongside spec-sensitive changes."
  exit 0
fi

echo ""
echo "┌─────────────────────────────────────────────────────────────┐"
echo "│  ⚠  spec.md 更新の確認が必要です                          │"
echo "│                                                             │"
echo "│  以下のファイルが staged されていますが、                  │"
echo "│  openspec/specs/wedding-trend/spec.md が含まれていません。  │"
echo "│                                                             │"

ALL_PATTERNS=("${SPEC_SENSITIVE_PATTERNS[@]}")
if [ -f "$SPEC_FILE" ]; then
  SPEC_REFS=$(grep -oP '`((src|tests)/[^`]+)' "$SPEC_FILE" 2>/dev/null | sed 's/`//g' || true)
  while IFS= read -r ref; do
    ALL_PATTERNS+=("$ref")
  done <<< "$SPEC_REFS"
fi

MATCHED_FILES=$(echo "$STAGED_FILES" | grep -f <(printf "%s\n" "${ALL_PATTERNS[@]}" | sed 's/^/^/') || true)
if [ -n "$MATCHED_FILES" ]; then
  while IFS= read -r f; do
    echo "│    • $f"
  done <<< "$MATCHED_FILES"
fi

echo "│                                                             │"
echo "│  スキーマ・スコアリング・収集パイプライン・API の変更には   │"
echo "│  spec.md の更新が推奨されます。現状は warn のみで           │"
echo "│  commit は阻止しません。                                    │"
echo "└─────────────────────────────────────────────────────────────┘"
echo ""

exit 0
