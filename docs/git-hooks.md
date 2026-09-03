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
- **Hook bypass is prohibited**: Do not use `--no-verify`, `-n`, or `HUSKY=0`. Fix the reported failure before committing.

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
3. **Quality Gates**: Runs the checks in `scripts/gates/verify.mjs`, including lint, spec references, format, security, migration safety, and type-checking.
4. **Targeted Tests & Contract Smoke**: If relevant files changed, runs Vitest coverage tiers and `bash scripts/gates/smoke-test.sh`. This is a rendered DOM contract test and is safe in the Codex sandbox: it does not build, spawn a process, bind a port, or make HTTP requests.

### Two-layer smoke testing

`bash scripts/gates/smoke-test.sh` (`pnpm smoke:contract`) is the pre-push/Codex-safe layer. It renders the real public shell with the empty feed and checks the header, empty state, AI disclosure, and GitHub Issues removal-contact link.

`bash scripts/gates/smoke-test-http.sh` (`pnpm smoke:http`) is the production layer. It performs a production build, starts `next start` with an in-memory DB, and makes an HTTP request. It catches build, RSC, runtime, and cookie-write failures that the contract layer cannot catch. Codex sandbox restrictions may prevent this command from running locally, but CI runs it as a required quality step; do not skip it or add an automatic fallback.

### Migrations ownership gate (`scripts/check-migrations-additive.mjs`)

**Why this exists**: the production Turso DB is shared with another project
(news-watch, 8 tables, hundreds of rows). The invariant that must never break
is **ownership**: a wedding-trend migration must never create, alter, or
collide with a news-watch table. `scripts/apply-migrations-remote.mjs` is the
runtime safety net that enforces this against the real DB.

The gate used to approximate that invariant with "statement kind" (allow only
`CREATE TABLE` / `CREATE INDEX` / `CREATE UNIQUE INDEX`, reject everything
else). That approximation was simultaneously **too broad and too narrow**:

- **Too broad**: a `CREATE TABLE`/`CREATE INDEX` whose name happened to
  collide with a news-watch table was allowed through as long as the
  statement _kind_ matched — the check never looked at _which_ table was
  being touched. Worse, a migration file with multiple statements but no
  drizzle `--> statement-breakpoint` marker between them was extracted as a
  single "statement" and matched against the allow regex with a prefix test
  (`ALLOWED.test(statement)`), so a payload like
  `CREATE TABLE probe (...); DROP TABLE articles;` (no marker) passed the
  gate whole — the leading `CREATE TABLE` satisfied the prefix match and the
  trailing `DROP TABLE articles` was invisible to the checker.
- **Too narrow**: `ALTER TABLE ... ADD COLUMN` on a table wedding-trend
  itself owns was banned outright, forcing every "add one column" change
  into a brand-new side table (see `post_publication_kind`, which exists
  solely because `posts.hash_kind` couldn't be added directly). Every reader
  of that data now has to `JOIN` and tolerate missing rows — a real,
  permanent cost paid for a rule that was never actually about columns.

The gate is now **ownership-based**, not statement-kind-based:

1. **Statement splitting is robust**, not marker-dependent.
   `splitStatements()` in `scripts/migrations-additive.mjs` strips
   `--> statement-breakpoint` markers and then splits on top-level `;`,
   tracking string-literal quoting (`'...'` with `''` escapes), quoted
   identifiers (`` `...` ``/`"..."`/`[...]`), and `BEGIN ... END` trigger
   bodies so it never splits inside them. A file with multiple statements is
   always seen as multiple statements, marker or no marker — the hole above
   is closed structurally, not by policy.
2. **Every statement is matched against its full shape**, anchored with
   `^...$`, not a prefix test — trailing garbage after a valid `CREATE
TABLE (...)` no longer slips through.
3. **The owned-table set is derived from `src/lib/db/schema.ts`**
   (`loadOwnedTables()` extracts every `sqliteTable("name", ...)` first
   argument) — there is no hand-maintained "our tables" list to drift out of
   sync with the schema. A small, explicitly-commented denylist of known
   news-watch table names (`EXTERNAL_DENYLIST` in
   `scripts/migrations-additive.mjs`) exists only to break the circularity
   that "writing to our schema.ts would otherwise make us own anything" — if
   the derived owned set ever intersects the denylist, `loadOwnedTables()`
   throws immediately rather than silently trusting either side.
4. **`CREATE TABLE`, `CREATE INDEX`, and `ALTER TABLE` are all
   ownership-checked** against that set. Previously only the statement kind
   was checked and ownership was ignored entirely for `CREATE` statements —
   that was the more dangerous gap, because `apply-migrations-remote.mjs`
   silently treats "table already exists" as success, so a colliding
   `CREATE TABLE` for a news-watch table name would have failed quietly and
   never been noticed.
5. **`ALTER TABLE <owned-table> ADD COLUMN ...` is allowed**, but only in a
   narrowly, exactly-matched safe shape: `ADD COLUMN <name> <type>` with an
   optional `DEFAULT <literal>`, `NOT NULL DEFAULT <literal>`, or
   `REFERENCES <table>(<column>)` clause — nothing else. `UNIQUE` /
   `PRIMARY KEY` on the new column, non-constant defaults (function calls),
   `DROP COLUMN`, `RENAME`, and any `ALTER` against a non-owned table are all
   rejected. **Policy**: add new columns as nullable and enforce any
   "required" semantics in the application layer (Zod / repository code) —
   SQLite's `ALTER TABLE` cannot add a `NOT NULL` column without a constant
   default, and anything that requires a real table rebuild (dropping a
   column, changing a type, adding a `UNIQUE`/`PRIMARY KEY` constraint) is
   **not** something this gate will ever automate. Do that out-of-band: take
   the DB offline to news-watch traffic (or coordinate a maintenance window),
   run the rebuild by hand against a fresh export/import, verify row counts
   match before and after, and only then land a migration file that reflects
   the new shape going forward — never ask this gate to do a rebuild live
   against the shared production DB.

The ownership rule lives in one place, `scripts/migrations-additive.mjs`,
imported by both `check-migrations-additive.mjs` (this gate, pre-push /
create-time) and `apply-migrations-remote.mjs` (the runtime safety net,
deploy-time) — duplicating the logic in two files would eventually let them
drift apart, which is exactly the kind of silent failure this gate exists to
prevent. `apply-migrations-remote.mjs` additionally re-checks the live
`sqlite_master` state before applying and aborts if a planned `CREATE
TABLE`/`CREATE INDEX` would collide with an _existing_ denylisted (news-watch)
object — schema.ts and the real DB are independent sources of truth, and
either one can catch what the other misses. The check itself is a pure
static read of `src/lib/db/migrations/*.sql` and `src/lib/db/schema.ts` — no
network or DB access — so it is safe to run on every push and in CI.

`tests/migrations-additive.test.ts` pins this behavior with destructive
fixtures: it asserts that all 11 existing migrations still pass (regression
guard — if this ever fails, the gate itself broke), that the marker-less
multi-statement hole (`CREATE TABLE x; DROP TABLE articles;`) is rejected,
that every denylisted-table CREATE/ALTER/INDEX form is rejected, that unsafe
`ADD COLUMN` shapes (`UNIQUE`, `PRIMARY KEY`, non-constant `DEFAULT`) are
rejected, and that the newly-allowed safe `ADD COLUMN` shapes pass.

If this check fails: either the migration touches a table this project
doesn't own (fix the table name, or if it's genuinely new, add it to
`schema.ts` first), or it uses an `ALTER TABLE` shape outside the allowed
`ADD COLUMN` form (split it into an out-of-band rebuild as described above),
or drop the migration file if it was created in error. Do not bypass this
hook to get a non-additive migration through — see "Emergency Bypass" above;
the whole point of this check is that this specific class of mistake must
not reach `main`.

### How to Resolve Pre-Push Failures

- **Uncommitted Changes**: Stage and commit your work (`git add . && git commit -m "..."`).
- **Test/Lint/Format Failures**: Run the respective scripts (`pnpm test`, `pnpm run format:fast`, `pnpm run lint`) locally, fix the issues, and push again.

---

_Remember: Local git hooks are a developer convenience. CI is the ultimate enforcement gate._
