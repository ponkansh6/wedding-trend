#!/usr/bin/env bash
# check-spec-refs.sh
# Pre-push / CI check: verifies that all `src/` and `tests/` file references
# in spec.md actually exist in the working tree.
#
# Exit 1 if any reference points to a non-existent file or directory.
# This prevents spec.md from accumulating stale/rotten references when
# modules are renamed or removed.

set -euo pipefail

SPEC_FILE="openspec/specs/wedding-trend/spec.md"

if [ ! -f "$SPEC_FILE" ]; then
  echo "[spec-refs] spec.md not found — skipping validation."
  exit 0
fi

echo "[spec-refs] Checking spec.md file references..."

# ── Extract file/dir references from spec.md ────────────────────────────
# Matches backtick-quoted paths starting with src/ or tests/.
REFS_TICK=$(grep -oP '`((src|tests)/[^`]+)' "$SPEC_FILE" | sed 's/`//g' || true)
REFS_BARE=$(grep -oP '(?<![`\w/])(src|tests)/[\w./\[\]{},*-]+\.(ts|tsx|css|sql|mjs)\b' "$SPEC_FILE" || true)
REFS=$(printf '%s\n%s\n' "$REFS_TICK" "$REFS_BARE" | sed '/^$/d')

if [ -z "$REFS" ]; then
  echo "[spec-refs] No source references found in spec.md."
  exit 0
fi

# ── Validate each reference ─────────────────────────────────────────────
MISSING=0
declare -A SEEN

while IFS= read -r ref; do
  if [ "${SEEN[$ref]:-}" = "1" ]; then
    continue
  fi
  SEEN[$ref]="1"

  # Handle brace expansion patterns (e.g., `lib/sources/{hatena-bookmark,...}.ts`)
  if [[ "$ref" == *\{* ]]; then
    base="${ref%%\{*}"
    brace_part="${ref#*\{}"
    brace_part="${brace_part%\}}"
    suffix="${ref##*\}}"
    IFS=',' read -ra items <<< "$brace_part"
    for item in "${items[@]}"; do
      expanded="${base}${item}${suffix}"
      if [ ! -f "$expanded" ] && [ ! -d "$expanded" ]; then
        echo "  ❌ Stale reference: \`$expanded\` (expanded from \`$ref\`)"
        MISSING=$((MISSING + 1))
      fi
    done
    continue
  fi

  # Handle glob patterns (e.g., `components/**/*.tsx`) — intentional, skip
  if [[ "$ref" == *\** ]]; then
    continue
  fi

  # Strip line-number suffix (e.g., `file.ts:31-36` → `file.ts`) before existence check
  file_ref="${ref%%:[0-9]*}"

  if [ -f "$file_ref" ] || [ -d "$file_ref" ]; then
    continue
  fi

  echo "  ❌ Stale reference: \`$ref\""
  MISSING=$((MISSING + 1))
done <<< "$REFS"

# ── Summary ─────────────────────────────────────────────────────────────
if [ "$MISSING" -gt 0 ]; then
  echo ""
  echo "╔════════════════════════════════════════════════════════════════╗"
  echo "║  spec.md contains $MISSING reference(s) to non-existent files.        ║"
  echo "║  Update spec.md to remove or fix stale references.             ║"
  echo "╚════════════════════════════════════════════════════════════════╝"
  echo ""
  echo "Tip: These references may be leftover from renamed/removed modules."
  echo "     Search spec.md for the file paths above and update them."
  exit 1
fi

echo "[spec-refs] ✅ All spec.md file references are valid."
exit 0
