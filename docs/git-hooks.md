# Git Hooks & Troubleshooting

We use Husky to manage local Git hooks. These hooks provide rapid feedback before code reaches CI.

---

## 1. `.husky/pre-commit`

Runs `lint-staged` on staged files, followed by full repository checks:

- **Lint-staged actions**: `oxfmt` auto-formatting, related `vitest` unit tests, and `secretlint`.
- **Global checks**: `oxlint` and `pnpm run type-check` (`next typegen` + `tsc --noEmit`).

### Common Failures & Solutions

- **Lint Errors**: Run `pnpm run lint:fast` or fix issues reported by `oxlint`.
- **Type Errors**: Run `pnpm run type-check` and resolve TypeScript errors.
- **Secretlint Hits**: Remove accidental secrets (API keys, tokens) or use placeholder configuration / `.secretlintignore`.
- **Emergency Bypass**: `--no-verify` (`git commit --no-verify`) may be used in extreme emergencies, but **must** be immediately followed by a clean, compliant fix commit. Do not make bypassing a habit.

---

## 2. `.husky/commit-msg`

Enforces the Conventional Commits specification.

- **Format**: `type(scope): subject` or `type: subject`
- **Allowed Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- **Special Commits**: `merge`, `revert`, `fixup!`, and `squash!` commits are permitted.

---

## 3. `.husky/pre-push`

Guards pushes to remote repositories:

1. **Uncommitted/Untracked Guard**: Fails if there are uncommitted or untracked changes in `src/` or `tests/`. Commit your changes first.
2. **Lockfile Sync**: Ensures `pnpm-lock.yaml` is in sync.
3. **Quality Gates**: Runs `pnpm run lint`, `pnpm run spec-refs`, `pnpm run format:check`, `pnpm run security-check`, and `node scripts/check-migrations-additive.mjs`.
4. **Targeted Tests & Smoke**: If `src/` or `tests/` files have changed relative to the target branch, runs vitest coverage tiers and `bash scripts/smoke-test.sh`.

### Migrations additive-only gate (`scripts/check-migrations-additive.mjs`)

**Why this exists**: the production Turso DB is shared with another project
(news-watch, 9 tables, hundreds of rows). `scripts/apply-migrations-remote.mjs`
only ever executes `CREATE TABLE` / `CREATE INDEX` / `CREATE UNIQUE INDEX`
statements against it — anything else (`ALTER`, `DROP`, `DELETE`, `UPDATE`, ...)
makes it abort the **entire** apply plan on the spot, and because it aborts as
soon as it hits the first non-additive statement, every migration file after
the offending one becomes permanently inapplicable to production until the
offending file is fixed or removed.

This constraint was violated in practice once: a migration containing
`ALTER TABLE` was created and merged, and nobody noticed until someone tried to
deploy it — by which point the fix required an out-of-band edit to migration
history. That is the failure mode this gate closes: it makes the check run at
migration-creation time (pre-push), not at deploy time, so a non-additive
statement can never reach `main` in the first place.

The additive-only rule lives in one place, `scripts/migrations-additive.mjs`,
imported by both `check-migrations-additive.mjs` (this gate) and
`apply-migrations-remote.mjs` (the runtime safety net) — duplicating the
regex in two files would eventually let them drift apart, which is exactly
the kind of silent failure this gate exists to prevent. The check is a pure
static read of `src/lib/db/migrations/*.sql` — no network or DB access — so
it is safe to run on every push and in CI.

If this check fails: rewrite the offending migration file so it only adds
new tables/indexes (a new table + a backfill script, rather than `ALTER
TABLE ... ADD COLUMN`, for example), or drop it if it was created in error.
Do not bypass this hook to get a non-additive migration through — see
"Emergency Bypass" above; the whole point of this check is that this specific
class of mistake must not reach `main`.

### How to Resolve Pre-Push Failures

- **Uncommitted Changes**: Stage and commit your work (`git add . && git commit -m "..."`).
- **Test/Lint/Format Failures**: Run the respective scripts (`pnpm test`, `pnpm run format:fast`, `pnpm run lint`) locally, fix the issues, and push again.

---

_Remember: Local git hooks are a developer convenience. CI is the ultimate enforcement gate._
