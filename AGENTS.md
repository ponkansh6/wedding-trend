<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project Guidelines & Governance

- **Git Hooks & Bypassing**: Git hooks must NOT be bypassed with `--no-verify` as a habit. If used in a genuine emergency, it must be followed immediately by a clean fix commit.
- **Single Source of Truth**: `openspec/specs/wedding-trend/spec.md` is the SINGLE SOURCE OF TRUTH for all technical and behavioral specifications. Do not duplicate spec details in `AGENTS.md` or elsewhere — link to `spec.md` instead.
- **Legal Constraints**: Legal constraints (original-source linkage, author credit, no reproduction of original creative expression) are specification requirements, not aspirational goals — they must be honored strictly in both prompts and UI.
- **Definition of Done**: Before claiming a feature is complete, all relevant CI gates (lint, type-check, test, coverage tiers, spec-refs, smoke test) must pass locally or in CI.
