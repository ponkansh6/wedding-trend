#!/usr/bin/env bash
# check-prompt-version-bump.sh
# Pre-commit check: warns when src/lib/llm/prompts.ts is staged but
# CURATION_PROMPT_VERSION in src/lib/constants.ts has NOT changed.
#
# The curation signature (src/lib/llm/signature.ts) hashes only
# CURATION_PROMPT_VERSION + LLM_MODEL. If prompts.ts changes without
# a version bump, stale curation signatures persist and
# getStaleCurationCandidates() returns 0 rows — silently resuming
# with old classifications.
#
# BLOCKING (non-zero exit) — a missed bump has caused a real incident
# (87 rows left un-rescored). See shared_plan/20-relax-dev-gate-constraints.md P1
# and shared_plan/11-reader-phase-rubric-and-rescore-gap.md §8 Stage 0.
#
# Escape hatch (use only when the prompt change genuinely needs no rescore):
#   ALLOW_PROMPT_WITHOUT_BUMP=1 git commit ...

set -euo pipefail

CONSTANTS_FILE="src/lib/constants.ts"
PROMPTS_FILE="src/lib/llm/prompts.ts"

STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)

if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

# Is prompts.ts staged?
PROMPTS_STAGED=false
if echo "$STAGED_FILES" | grep -qx "$PROMPTS_FILE"; then
  PROMPTS_STAGED=true
fi

if [ "$PROMPTS_STAGED" = false ]; then
  exit 0
fi

if [ "${ALLOW_PROMPT_WITHOUT_BUMP:-0}" = "1" ]; then
  echo "[prompt-version-bump] ⚠ ALLOW_PROMPT_WITHOUT_BUMP=1 によりスキップしました。"
  exit 0
fi

# Is constants.ts also staged?
CONSTANTS_STAGED=false
if echo "$STAGED_FILES" | grep -qx "$CONSTANTS_FILE"; then
  CONSTANTS_STAGED=true
fi

if [ "$CONSTANTS_STAGED" = true ]; then
  # Check whether CURATION_PROMPT_VERSION actually changed in the staged diff
  VERSION_CHANGED=$(git diff --cached -- "$CONSTANTS_FILE" 2>/dev/null \
    | grep -c '^\(+\|-\).*CURATION_PROMPT_VERSION' || true)
  if [ "$VERSION_CHANGED" -gt 0 ]; then
    echo "[prompt-version-bump] ✓ CURATION_PROMPT_VERSION が変更されています。"
    exit 0
  fi
fi

# If we reach here: prompts.ts staged, version NOT bumped
echo ""
echo "┌─────────────────────────────────────────────────────────────┐"
echo "│  ⚠  CURATION_PROMPT_VERSION の bump が必要です             │"
echo "│                                                             │"
echo "│  src/lib/llm/prompts.ts が staged されていますが、         │"
echo "│  src/lib/constants.ts の CURATION_PROMPT_VERSION が          │"
echo "│  変更されていません。                                       │"
echo "│                                                             │"
echo "│  curationSignature は CURATION_PROMPT_VERSION と            │"
echo "│  LLM_MODEL のみから算出されます（signature.ts:31-35）。     │"
echo "│  バージョンを上げないと getStaleCurationCandidates() が    │"
echo "│  対象0件で再スコアが走りません。                            │"
echo "│                                                             │"
echo "│  対処: constants.ts で CURATION_PROMPT_VERSION を           │"
echo "│  bump してください。バージョン履歴は同ファイルの           │"
echo "│  コメントを参照。                                           │"
echo "└─────────────────────────────────────────────────────────────┘"
echo ""
echo "  詳細: shared_plan/11-reader-phase-rubric-and-rescore-gap.md §4, §8"
echo "  再スコア不要な変更の場合のみ: ALLOW_PROMPT_WITHOUT_BUMP=1 git commit ..."
echo ""

exit 1
