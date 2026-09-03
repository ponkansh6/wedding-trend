# Developer Tooling & Pipeline

This guide details the developer tooling, scripts, formatting, linting, testing, CI, and security gates used in the `wedding-trend` project.

## Package Manager

- **pnpm** is pinned via the `packageManager` field in `package.json` and `.npmrc`.
- Always use `pnpm install` (never `npm` or `yarn`).
- Use `pnpm exec <command>` to run binaries locally without global installations.

## Linting & Formatting

We use blazing fast, Rust-based tools (`oxlint` and `oxfmt`).

- **Fast & Full Lint**: `pnpm run lint` and `pnpm run lint:fast` run `oxlint` (`--nextjs-plugin --react-plugin --react-perf-plugin src/` and over the whole repository respectively).
- **Format Verification**: `pnpm run format:check` verifies formatting via `oxfmt`.
- **Auto-Formatting**: `pnpm run format:fast` formats files using `oxfmt`.

## Type Checking

- Run `pnpm run type-check` to execute `next typegen && tsc --noEmit`.
- `next typegen` generates `next-env.d.ts` and `.next/types/` (route types such as `LayoutProps`). These are gitignored, so they must be regenerated before `tsc --noEmit` can pass on a fresh clone or in CI.
- Note: We deliberately do **not** use `tsgo` or `@typescript/native-preview` to avoid unpinned/unstable dev dependencies.

## Testing & Coverage

- **Unit & Integration Tests**: Run `pnpm test` (executes `vitest run`).
- **Memory & Concurrency Constraints**: デフォルトでテストは直列実行（`fileParallelism: false`, `maxWorkers: 1`）されるように設定されている。これは RAM 7.4GiB というマシン制約下で `happy-dom` 環境のテストファイルを多数並列実行した際に OOM killer が発動し、エディタやエージェントプロセスごと kill される事故を防ぐためである。
- **ワーカーヒープ上限**: 各テストワーカーには `execArgv: ["--max-old-space-size=1536"]`（Vitest 4 ではトップレベルの `test.execArgv`）により 1.5GiB の V8 ヒープ上限が設定されている。テストの暴走時はシステム OOM killer ではなく V8 のヒープ不足エラーとして検知できる。
- **並列実行のエスケープハッチ**: 一時的に並列化したい場合のみ `VITEST_MAX_WORKERS=2 pnpm test` のように環境変数を指定する。
- **安全な部分実行**: 特定のファイルだけを検証したい場合は `pnpm exec vitest run tests/url.test.ts` のように個別実行する。
- **lint-staged 連携**: コミット時の `lint-staged` で走る `vitest related` もこのメモリ制限・直列実行設定の恩恵を受け、安全に動作する。
- **Coverage Reports**: Run `pnpm exec vitest run --coverage` to output reports to `coverage/`.
- **Coverage Tiers**: Enforced automatically by `node scripts/gates/check-coverage-tiers.mjs` (refer to `openspec/specs/wedding-trend/spec.md` §7.1).

## Smoke Test

- Run `bash scripts/gates/smoke-test.sh` (or `pnpm smoke:contract`) for the sandbox-safe DOM contract. It renders the actual public site shell with the empty feed without building, starting a server, binding a port, or issuing HTTP requests.
- Run `bash scripts/gates/smoke-test-http.sh` (or `pnpm smoke:http`) where process spawning and loopback networking are available. It builds the application, starts `next start` on an in-memory database at port `3100`, curls `/`, and checks for runtime/RSC/cookie-write failures.
- The contract smoke is used by pre-push; the HTTP smoke is a required CI step. The former does not replace production build and runtime verification.

## Migrations (Shared Production DB)

The production Turso DB is shared with another project (news-watch, 9 tables,
hundreds of rows). Because of this, migrations must be **additive-only**:
only `CREATE TABLE`, `CREATE INDEX`, and `CREATE UNIQUE INDEX` statements are
allowed in `src/lib/db/migrations/*.sql`. `drizzle-kit push` is never used
against production for the same reason — it treats anything absent from the
current schema as deletable, which would delete the other project's tables.

- **Static gate (creation-time)**: `node scripts/gates/check-migrations-additive.mjs`
  scans all migration files and fails if any statement is not additive-only.
  It does not touch the network or a DB, so it runs in the `pre-push` hook and
  can run in CI. This is what catches a non-additive migration (e.g. one
  containing `ALTER TABLE`) before it merges — previously this was only
  discovered when someone tried to deploy, by which point
  `scripts/ops/apply-migrations-remote.mjs` had already permanently blocked applying any
  migration after the offending one.
- **Runtime safety net (apply-time)**: `scripts/ops/apply-migrations-remote.mjs`
  re-checks the same rule immediately before applying to Turso, and also
  queries `sqlite_master` beforehand to list any table/index names that
  already exist in production and would collide with names the migration
  plan is about to create. Because table and index names share a single
  namespace across both projects in the same DB, a same-named table already
  belonging to news-watch would otherwise be silently read/written by
  wedding-trend. This collision list is informational only (name collisions
  cannot be resolved automatically — the script cannot tell "ours from a past
  run" apart from "the other project's"), so a human must review it before
  passing `--apply`.
- Both scripts import the actual additive-only rule (the `ALLOWED` regex and
  the `--> statement-breakpoint` splitting logic) from the shared module
  `scripts/migrations-additive.mjs`, so the rule cannot drift between the two
  call sites.

## Security & Dependency Checks

- **Security Check**: `pnpm run security-check` runs production-blocking `pnpm audit --prod` and `secretlint`.
- **Dependency Health**: `pnpm run check:deps` runs `depcheck`.

## CI Pipeline (`.github/workflows/ci.yml`)

Runs automatically on pushes to `main` and on all Pull Requests:

1. `pnpm install --frozen-lockfile`
2. `pnpm verify` (which executes `node scripts/gates/verify.mjs` running type-check, lint, formatting check, unit/coverage tests, spec references check, security checks, and the sandbox-safe contract smoke)
3. `bash scripts/gates/smoke-test-http.sh` (required production build and HTTP smoke)

_Note: Pre-push runs `pnpm verify`; CI additionally runs the required HTTP smoke._

## Weekly Monitoring (`.github/workflows/weekly-monitor.yml`)

Automated background checks including:

- `pnpm run check:sources`
- `pnpm run check:oembed`
- `pnpm run eval:llm`
