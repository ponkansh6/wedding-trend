# Developer Tooling & Pipeline

This guide details the developer tooling, scripts, formatting, linting, testing, CI, and security gates used in the `wedding-trend` project.

## Package Manager

- **pnpm** is pinned via the `packageManager` field in `package.json` and `.npmrc`.
- Always use `pnpm install` (never `npm` or `yarn`).
- Use `pnpm exec <command>` to run binaries locally without global installations.

## Linting & Formatting

We use blazing fast, Rust-based tools (`oxlint` and `oxfmt`) alongside ESLint.

- **Fast Lint**: `pnpm run lint:fast` runs `oxlint`.
- **Full ESLint**: `pnpm run lint` runs standard ESLint checks.
- **Format Verification**: `pnpm run format:check` verifies formatting via `oxfmt`.
- **Auto-Formatting**: `pnpm run format:fast` formats files using `oxfmt`.

## Type Checking

- Run `pnpm run type-check` to execute `tsc --noEmit`.
- Note: We deliberately do **not** use `tsgo` or `@typescript/native-preview` to avoid unpinned/unstable dev dependencies.

## Testing & Coverage

- **Unit & Integration Tests**: Run `pnpm test` (executes `vitest run`).
- **Coverage Reports**: Run `pnpm exec vitest run --coverage` to output reports to `coverage/`.
- **Coverage Tiers**: Enforced automatically by `node scripts/check-coverage-tiers.mjs` (refer to `openspec/specs/wedding-trend/spec.md` §7.1).

## Smoke Test

- Run `bash scripts/smoke-test.sh`.
- This script builds the application, starts `next start` on an in-memory database at port `3100`, curls `/`, and asserts that:
  1. The page renders successfully **without** an RSC error digest.
  2. The expected empty-state text appears.
- It is designed to catch regressions where the app builds successfully but renders broken at runtime.

## Security & Dependency Checks

- **Security Check**: `pnpm run security-check` runs production-blocking `pnpm audit --prod` and `secretlint`.
- **Dependency Health**: `pnpm run check:deps` runs `depcheck`.

## CI Pipeline (`.github/workflows/ci.yml`)

Runs automatically on pushes to `main` and on all Pull Requests:

1. `pnpm install --frozen-lockfile`
2. `pnpm run lint:fast` & `pnpm run lint`
3. `pnpm run type-check`
4. `pnpm run format:check`
5. `pnpm test -- --coverage`
6. Coverage tier verification (`node scripts/check-coverage-tiers.mjs`)
7. Spec references check (`pnpm run spec-refs` or equivalent)
8. Security checks (`pnpm run security-check`)
9. Smoke test (`bash scripts/smoke-test.sh`)

_Note: CI is the ultimate compliance gate; local git hooks are a convenience and developer aid._

## Weekly Monitoring (`.github/workflows/weekly-monitor.yml`)

Automated background checks including:

- `pnpm run check:sources`
- `pnpm run check:oembed`
- `pnpm run eval:llm`
