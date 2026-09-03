#!/usr/bin/env bash
# Sandbox-safe DOM contract smoke. It intentionally does not build, spawn,
# listen, start a server, or make HTTP requests. Production build/RSC/runtime
# coverage belongs to smoke-test-http.sh, which CI invokes explicitly.
set -euo pipefail

echo "[smoke:contract] Running rendered DOM contract (sandbox-safe; no build or HTTP)..."
pnpm exec vitest run tests/ui/smoke-contract.test.tsx
echo "✅ [smoke:contract] passed"
